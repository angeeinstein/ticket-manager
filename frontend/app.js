/*
 * Cable car ticket checker — PWA logic (the only operator interface).
 *
 * Everything works offline against an IndexedDB cache:
 *   - scan a barcode -> validate on-device -> record a redemption
 *   - control the live delay (start/stop/catch-up/reset)
 *   - see live statistics for the current slot / no-shows / day totals
 * The network is used only to sync the dataset, delay state, and redemptions.
 */
(function () {
  "use strict";

  // --------------------------------------------------------------- small helpers
  const $ = (id) => document.getElementById(id);
  const nowDate = () => new Date();
  const iso = (d) => d.toISOString();
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  const LS = {
    get deviceId() {
      let id = localStorage.getItem("tc_device_id");
      if (!id) { id = "dev-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random()); localStorage.setItem("tc_device_id", id); }
      return id;
    },
    get version() { return parseInt(localStorage.getItem("tc_data_version") || "0", 10); },
    set version(v) { localStorage.setItem("tc_data_version", String(v)); },
    // Auth is handled by Cloudflare Access in front of the app — no scanner token.
    get eventDate() { return localStorage.getItem("tc_event_date") || ""; },
    set eventDate(v) { localStorage.setItem("tc_event_date", v || ""); },
    get lastSync() { return localStorage.getItem("tc_last_sync") || ""; },
    set lastSync(v) { localStorage.setItem("tc_last_sync", v); },
    get delay() { try { return JSON.parse(localStorage.getItem("tc_delay") || "null") || defaultDelay(); } catch (e) { return defaultDelay(); } },
    set delay(v) { localStorage.setItem("tc_delay", JSON.stringify(v)); },
    get delayDirty() { return localStorage.getItem("tc_delay_dirty") === "1"; },
    set delayDirty(v) { localStorage.setItem("tc_delay_dirty", v ? "1" : "0"); },
    get settings() { try { return Object.assign(defaultSettings(), JSON.parse(localStorage.getItem("tc_settings") || "null")); } catch (e) { return defaultSettings(); } },
    set settings(v) { localStorage.setItem("tc_settings", JSON.stringify(v)); },
    get settingsDirty() { return localStorage.getItem("tc_settings_dirty") === "1"; },
    set settingsDirty(v) { localStorage.setItem("tc_settings_dirty", v ? "1" : "0"); },
    get queue() { try { return JSON.parse(localStorage.getItem("tc_redeem_queue") || "[]"); } catch (e) { return []; } },
    set queue(v) { localStorage.setItem("tc_redeem_queue", JSON.stringify(v)); },
  };

  function defaultDelay() {
    return {
      delay_base_minutes: 0,
      delay_running_since: null,
      updated_at: new Date(0).toISOString(),
      updated_by: "init",
    };
  }

  function defaultSettings() {
    return {
      grace_before_minutes: 0,
      grace_after_minutes: 0,
      max_capacity_per_slot: 0, // 0 = unlimited / not set
      slot_length_minutes: 15,
      walkup_mode: false,
      manual_entry: false, // show the manual barcode-entry field on the scan screen
      slots: [], // event schedule: [{start:"HH:MM", end:"HH:MM"}, ...]
      updated_at: new Date(0).toISOString(),
      updated_by: "init",
    };
  }

  // Validity needs the grace window; build the dict it expects from delay + settings.
  function delayForValidity() {
    const d = LS.delay, s = LS.settings;
    return {
      delay_base_minutes: d.delay_base_minutes,
      delay_running_since: d.delay_running_since,
      grace_before_minutes: s.grace_before_minutes,
      grace_after_minutes: s.grace_after_minutes,
    };
  }

  // -------------------------------------------------------------------- IndexedDB
  const DB_NAME = "ticketchecker";
  const DB_VERSION = 1;
  let _db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("tickets")) db.createObjectStore("tickets", { keyPath: "barcode" });
        if (!db.objectStoreNames.contains("redemptions")) db.createObjectStore("redemptions", { keyPath: "key" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) { return _db.transaction(store, mode).objectStore(store); }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  async function replaceTickets(list) {
    const store = _db.transaction("tickets", "readwrite").objectStore("tickets");
    await reqP(store.clear());
    for (const t of list) store.put(t);
    return new Promise((res) => { store.transaction.oncomplete = () => res(); });
  }
  async function getTicket(barcode) { return reqP(tx("tickets", "readonly").get(barcode)); }
  async function getAllTickets() { return reqP(tx("tickets", "readonly").getAll()); }
  async function getAllRedemptions() { return reqP(tx("redemptions", "readonly").getAll()); }

  function redemptionKey(r) { return r.barcode + "|" + r.device_id + "|" + r.scanned_at; }

  async function putRedemptions(list) {
    const store = _db.transaction("redemptions", "readwrite").objectStore("redemptions");
    for (const r of list) { const rec = Object.assign({}, r); rec.key = redemptionKey(rec); store.put(rec); }
    return new Promise((res) => { store.transaction.oncomplete = () => res(); });
  }

  // ----------------------------------------------------------------------- API
  async function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    const res = await fetch(path, opts);
    if (!res.ok) { const err = new Error("HTTP " + res.status); err.status = res.status; throw err; }
    return res.json();
  }

  // ---------------------------------------------------------------------- sync
  let lastSlotEndCache = null; // Date — max ticket slot_end (offset applied at compute time)

  async function recomputeLastSlotEnd() {
    const tickets = await getAllTickets();
    let max = null;
    for (const t of tickets) {
      const e = new Date(t.slot_end);
      if (!max || e > max) max = e;
    }
    lastSlotEndCache = max;
  }

  // We POLL (no websockets) with an adaptive interval: a steady cadence when healthy,
  // exponential backoff while reconnecting. Polling is the robust choice for an offline-
  // first app — each poll is cheap (the server replies {unchanged:true} when our
  // data_version is current) and it recovers from any number of disconnects with no socket
  // to keep alive. `conn` drives the on-screen status; `syncing` prevents overlap.
  const SYNC_OK_MS = 10000;       // cadence when the last sync succeeded
  const SYNC_BACKOFF_BASE = 2000; // first retry delay after a failure
  const SYNC_BACKOFF_MAX = 30000; // backoff ceiling
  const conn = { state: "init", failures: 0, lastOkAt: 0 };
  let syncing = false;
  let syncTimer = null;

  function scheduleNextSync() {
    clearTimeout(syncTimer);
    let delay = SYNC_OK_MS;
    if (conn.state !== "online") {
      const n = Math.min(conn.failures, 5);
      delay = Math.min(SYNC_BACKOFF_MAX, SYNC_BACKOFF_BASE * Math.pow(2, Math.max(0, n - 1)));
    }
    syncTimer = setTimeout(() => { syncNow(); }, delay);
  }

  async function syncNow() {
    if (syncing) return;
    syncing = true;
    if (conn.state !== "online") setConn("syncing"); // avoid badge flicker on healthy polls
    try {
      // 1) Push anything pending first so our local changes aren't overwritten.
      await flushQueue();
      await pushDelayIfDirty();
      await pushSettingsIfDirty();

      // 2) Pull the snapshot (skips the body when our version is current).
      const data = await apiFetch("/api/sync?since=" + LS.version);
      if (!data.unchanged) {
        if (data.event_date) LS.eventDate = data.event_date;
        await replaceTickets(data.tickets || []);
        await putRedemptions(data.redemptions || []);

        const serverDelay = data.delay || defaultDelay();
        if (!LS.delayDirty && (serverDelay.updated_at || "") >= (LS.delay.updated_at || "")) {
          LS.delay = serverDelay;
        }
        const serverSettings = data.settings || defaultSettings();
        if (!LS.settingsDirty && (serverSettings.updated_at || "") >= (LS.settings.updated_at || "")) {
          LS.settings = Object.assign(defaultSettings(), serverSettings);
        }
        LS.version = data.data_version || LS.version;
        await recomputeLastSlotEnd();
        renderAll();
      }
      conn.failures = 0;
      conn.lastOkAt = Date.now();
      LS.lastSync = iso(nowDate());
      setConn("online");
    } catch (e) {
      conn.failures++;
      setConn("offline");
      console.warn("sync failed", e);
    } finally {
      syncing = false;
      renderSyncMeta();
      scheduleNextSync();
    }
  }

  async function flushQueue() {
    const q = LS.queue;
    if (!q.length) return;
    await apiFetch("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redemptions: q }),
    });
    LS.queue = [];
  }

  async function pushDelayIfDirty() {
    if (!LS.delayDirty) return;
    const d = LS.delay;
    await apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delay_base_minutes: d.delay_base_minutes,
        delay_running_since: d.delay_running_since,
        updated_at: d.updated_at,
        updated_by: d.updated_by,
      }),
    });
    LS.delayDirty = false;
  }

  async function pushSettingsIfDirty() {
    if (!LS.settingsDirty) return;
    const s = LS.settings;
    await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grace_before_minutes: s.grace_before_minutes,
        grace_after_minutes: s.grace_after_minutes,
        max_capacity_per_slot: s.max_capacity_per_slot,
        slot_length_minutes: s.slot_length_minutes,
        walkup_mode: s.walkup_mode,
        manual_entry: s.manual_entry,
        slots: s.slots || [],
        updated_at: s.updated_at,
        updated_by: s.updated_by,
      }),
    });
    LS.settingsDirty = false;
  }

  function touchSettings(mutator) {
    const s = LS.settings;
    mutator(s);
    s.updated_at = iso(nowDate());
    s.updated_by = LS.deviceId;
    LS.settings = s;
    LS.settingsDirty = true;
    renderAll();
    pushSettingsIfDirty().catch(() => {}); // best-effort; queued via dirty flag otherwise
  }

  // ------------------------------------------------------------ delay controls
  function touchDelay(mutator) {
    const d = LS.delay;
    mutator(d);
    d.updated_at = iso(nowDate());
    d.updated_by = LS.deviceId;
    LS.delay = d;
    LS.delayDirty = true;
    renderAll();
    pushDelayIfDirty().catch(() => {}); // best-effort; queued via dirty flag otherwise
  }

  function startDelay() {
    touchDelay((d) => { if (!d.delay_running_since) d.delay_running_since = iso(nowDate()); });
  }
  function stopDelay() {
    touchDelay((d) => {
      if (d.delay_running_since) {
        const elapsed = (nowDate().getTime() - new Date(d.delay_running_since).getTime()) / 60000;
        d.delay_base_minutes = Math.max(0, Math.round((Number(d.delay_base_minutes) || 0) + elapsed));
        d.delay_running_since = null;
      }
    });
  }
  function catchUp(mins) {
    touchDelay((d) => {
      // Fold any running delay into the base first so the number is concrete, then trim.
      if (d.delay_running_since) {
        const elapsed = (nowDate().getTime() - new Date(d.delay_running_since).getTime()) / 60000;
        d.delay_base_minutes = Math.round((Number(d.delay_base_minutes) || 0) + elapsed);
        d.delay_running_since = null;
      }
      d.delay_base_minutes = Math.max(0, (Number(d.delay_base_minutes) || 0) - mins);
    });
  }
  function resetDelay() {
    touchDelay((d) => { d.delay_base_minutes = 0; d.delay_running_since = null; });
  }

  // ------------------------------------------------------------------ scanning
  let detector = null;
  let stream = null;
  let scanning = false;
  let lastHandled = { value: null, at: 0 };

  async function startCamera() {
    if (stream) return;
    try {
      // Prefer the rear camera at a decent resolution — enough detail for small 1-D
      // barcodes without making each detect() call slow.
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      const video = $("video");
      video.srcObject = stream;
      video.setAttribute("playsinline", "");
      await video.play();
      $("btn-camera").textContent = "Stop camera";
      if ("BarcodeDetector" in window) {
        // Request every format the device supports (QR + the common 1-D symbologies:
        // code_128, ean_13/8, upc_a/e, code_39, itf, codabar, …) so any ticket scans.
        let formats;
        try { formats = await window.BarcodeDetector.getSupportedFormats(); } catch (e) { formats = undefined; }
        detector = formats && formats.length ? new window.BarcodeDetector({ formats: formats }) : new window.BarcodeDetector();
        scanning = true;
        requestAnimationFrame(scanFrame); // self-scheduling: scans as fast as the device allows
      } else {
        showResult("info", "Camera scanning not supported", "Use manual entry below (BarcodeDetector unavailable on this browser).", null);
      }
    } catch (e) {
      showResult("info", "Camera unavailable", String(e.message || e) + " — use manual entry.", null);
    }
  }

  function stopCamera() {
    scanning = false;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    detector = null;
    $("btn-camera").textContent = "Start camera";
  }

  // Continuous detect loop. Awaiting each detect() before scheduling the next frame avoids
  // overlapping calls (which would slow detection), so it runs at the device's max rate.
  async function scanFrame() {
    if (!scanning || !detector) return;
    const video = $("video");
    if (video && video.readyState >= 2 && video.videoWidth) {
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) handleScan(codes[0].rawValue);
      } catch (e) { /* transient detect errors are expected */ }
    }
    if (scanning) requestAnimationFrame(scanFrame);
  }

  let pendingOverride = null; // {barcode}

  async function handleScan(rawValue) {
    const value = (rawValue || "").trim();
    if (!value) return;
    const t = nowDate().getTime();
    if (value === lastHandled.value && t - lastHandled.at < 2500) return; // debounce
    lastHandled = { value: value, at: t };
    if (navigator.vibrate) navigator.vibrate(40);

    const ticket = await getTicket(value);
    if (!ticket) {
      pendingOverride = null;
      // Walk-up mode: no imported data. Record the scan (one-time use) instead of rejecting,
      // so the database is built from scans and capacity is still tracked.
      if (LS.settings.walkup_mode) {
        if (await alreadyScanned(value)) {
          showResult("warn", "ALREADY SCANNED", "Walk-up ticket already used · " + value, null);
        } else {
          await recordRedemption(value, "valid", null);
          showResult("valid", "RECORDED", "New walk-up ticket · " + value, null);
        }
      } else {
        showResult("blocked", "UNKNOWN TICKET", "No ticket with this barcode. " + value, null);
      }
      renderStats();
      return;
    }

    const delay = delayForValidity();
    const res = Validity.computeValidity(
      new Date(ticket.slot_start), new Date(ticket.slot_end),
      lastSlotEndCache || new Date(ticket.slot_end), delay, nowDate()
    );
    const slotLabel = fmtSlot(ticket.slot_start, ticket.slot_end);

    if (res.status === Validity.VALID) {
      const already = await alreadyScanned(value);
      if (already) {
        showResult("warn", "ALREADY SCANNED", slotLabel + " · " + res.reason, ticket);
      } else {
        await recordRedemption(value, "valid", null);
        showResult("valid", "VALID", slotLabel + " · " + res.reason, ticket);
      }
      pendingOverride = null;
    } else {
      // EARLY or BLOCKED — offer manual override.
      pendingOverride = { barcode: value };
      const head = res.status === Validity.EARLY ? "TOO EARLY" : "BLOCKED";
      showResult("blocked", head, slotLabel + " · " + res.reason, ticket, true);
    }
    renderStats();
  }

  async function alreadyScanned(barcode) {
    const all = await getAllRedemptions();
    return all.some((r) => r.barcode === barcode && (r.result === "valid" || r.result === "override"));
  }

  async function recordRedemption(barcode, result, reason) {
    const r = {
      barcode: barcode,
      scanned_at: iso(nowDate()),
      device_id: LS.deviceId,
      result: result,
      override_reason: reason || null,
    };
    await putRedemptions([r]);
    const q = LS.queue; q.push(r); LS.queue = q;
    flushQueue().catch(() => {}); // best-effort; stays queued otherwise
  }

  async function doOverride() {
    if (!pendingOverride) return;
    const bc = pendingOverride.barcode;
    pendingOverride = null;
    if (await alreadyScanned(bc)) { showResult("warn", "ALREADY SCANNED", bc, null); return; }
    await recordRedemption(bc, "override", "manual override");
    showResult("valid", "OVERRIDDEN", "Allowed manually · " + bc, null);
    renderStats();
  }

  // ------------------------------------------------------------- slot helpers
  function pad2(n) { return ("0" + n).slice(-2); }
  function hhmmToMin(s) { const p = String(s || "").split(":"); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); }
  function minToHHMM(m) { m = ((m % 1440) + 1440) % 1440; return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60); }

  // Build a Date for an "HH:MM" on the event day (falls back to today when unknown).
  function eventBaseMidnight() {
    if (LS.eventDate) return new Date(LS.eventDate + "T00:00:00");
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  // A schedule may cross midnight (e.g. 21:00 → 01:00). We find the chronological start of
  // the schedule (the slot following the biggest gap on a 24h circle) and treat any time
  // before it as belonging to the NEXT day. `anchor` is that start, in minutes-of-day.
  function scheduleAnchorMin(slots) {
    const starts = (slots || []).map((s) => hhmmToMin(s.start)).sort((a, b) => a - b);
    if (!starts.length) return 0;
    let anchor = starts[0], maxGap = -1;
    for (let i = 0; i < starts.length; i++) {
      const prev = starts[(i - 1 + starts.length) % starts.length];
      const gap = i === 0 ? starts[i] + 1440 - prev : starts[i] - prev;
      if (gap > maxGap) { maxGap = gap; anchor = starts[i]; }
    }
    return anchor;
  }

  // Minutes from the event base midnight, rolling times before the anchor to the next day.
  function slotAbsMin(m, anchor) { return m >= anchor ? m : m + 1440; }

  function slotDate(hhmm, anchor) {
    return new Date(eventBaseMidnight().getTime() + slotAbsMin(hhmmToMin(hhmm), anchor) * 60000);
  }

  // Slots in chronological order, accounting for midnight crossing.
  function sortedSlots() {
    const slots = (LS.settings.slots || []).slice();
    const anchor = scheduleAnchorMin(slots);
    slots.sort((a, b) => slotAbsMin(hhmmToMin(a.start), anchor) - slotAbsMin(hhmmToMin(b.start), anchor));
    return { slots: slots, anchor: anchor };
  }

  // -------------------------------------------------------------------- stats
  // Real wall-clock throughput window (NOT offset-adjusted): capacity is a physical limit
  // of the cable car right now, so we bucket actual scans into fixed windows anchored at
  // local midnight (e.g. 15-min -> :00/:15/:30/:45). Used when no schedule is defined.
  function autoWindow(now, lenMin) {
    const len = Math.max(1, lenMin || 15);
    const minsOfDay = now.getHours() * 60 + now.getMinutes();
    const startMin = Math.floor(minsOfDay / len) * len;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    start.setMinutes(startMin);
    const end = new Date(start.getTime() + len * 60000);
    return { start, end, label: minToHHMM(startMin) + "–" + minToHHMM(startMin + len) };
  }

  // The configured slot (real wall-clock) that `now` falls in, or null if between slots.
  function scheduleWindow(now) {
    const { slots, anchor } = sortedSlots();
    for (const s of slots) {
      const start = slotDate(s.start, anchor);
      let end = slotDate(s.end, anchor);
      if (end <= start) end = new Date(end.getTime() + 86400000); // safety for a wrapped end
      if (now >= start && now < end) return { start, end, label: s.start + "–" + s.end };
    }
    return null;
  }

  // Which window capacity is measured against right now.
  function capacityWindow(now) {
    const slots = LS.settings.slots || [];
    if (slots.length) return scheduleWindow(now); // may be null between slots
    return autoWindow(now, LS.settings.slot_length_minutes);
  }

  async function computeStats() {
    const tickets = await getAllTickets();
    const redemptions = await getAllRedemptions();
    const settings = LS.settings;
    const now = nowDate();
    const offset = Validity.effectiveOffsetMinutes(LS.delay, now);

    const scanned = new Set();
    for (const r of redemptions) if (r.result === "valid" || r.result === "override") scanned.add(r.barcode);

    // Assigned-slot attendance (only meaningful when tickets were imported).
    let slotTotal = 0, slotScanned = 0, noShows = 0;
    for (const t of tickets) {
      const start = Validity.addMinutes(new Date(t.slot_start), offset);
      const end = Validity.addMinutes(new Date(t.slot_end), offset);
      const isScanned = scanned.has(t.barcode);
      if (now >= start && now < end) {
        slotTotal++;
        if (isScanned) slotScanned++;
      }
      if (now >= end && !isScanned) noShows++;
    }

    // Capacity / throughput in the current real-time window (configured slot if any).
    const cap = Number(settings.max_capacity_per_slot) || 0;
    const win = capacityWindow(now);
    let capUsed = 0;
    if (win) {
      for (const r of redemptions) {
        if (r.result !== "valid" && r.result !== "override") continue;
        const at = new Date(r.scanned_at);
        if (at >= win.start && at < win.end) capUsed++;
      }
    }

    return {
      offset: Math.round(offset),
      slotTotal, slotScanned,
      slotNotYet: slotTotal - slotScanned,
      slotPct: pct(slotScanned, slotTotal),
      noShows,
      noShowPct: pct(noShows, tickets.length),
      dayTotal: tickets.length,
      dayScanned: scanned.size,
      dayPct: pct(scanned.size, tickets.length),
      capSet: cap > 0,
      cap: cap,
      capUsed: capUsed,
      capPct: cap > 0 ? Math.round((capUsed / cap) * 100) : 0,
      capWindow: win ? win.label : "no active slot",
      hasSchedule: (settings.slots || []).length > 0,
    };
  }

  // --------------------------------------------------------------- rendering
  function fmtTime(isoStr) {
    const d = new Date(isoStr);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function fmtSlot(s, e) { return fmtTime(s) + "–" + fmtTime(e); }

  function showResult(kind, status, detail, ticket, showOverride) {
    const panel = $("result");
    panel.className = "result result-" + kind;
    $("result-status").textContent = status;
    $("result-detail").textContent = detail;
    $("override-row").style.display = showOverride ? "block" : "none";
  }

  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

  async function renderStats() {
    const s = await computeStats();
    const ob = $("offset-badge");
    if (ob) {
      ob.textContent = s.offset > 0 ? "+" + s.offset + "m" : "on time";
      ob.className = "badge " + (s.offset > 0 ? "badge-warn" : "badge-ok");
    }

    setText("stat-slot-scanned", s.slotScanned);
    setText("stat-slot-total", s.slotTotal);
    setText("stat-day-scanned", s.dayScanned);
    setText("stat-day-total", s.dayTotal);
    setText("stat-noshows", s.noShows);

    setText("cap-window", s.capWindow);
    setText("stat-cap-used", s.capUsed);
    setText("stat-cap-max", s.capSet ? s.cap : "∞");
    setText("stat-cap-pct", s.capSet ? s.capPct + "%" : "—");
    const bar = $("stat-cap-bar");
    if (bar) {
      bar.style.width = (s.capSet ? Math.min(100, s.capPct) : 0) + "%";
      const over = s.capSet && s.capUsed > s.cap;
      bar.classList.toggle("bar-over", over);
      const pe = $("stat-cap-pct"); if (pe) pe.classList.toggle("pct-over", over);
    }
  }

  function renderSettings() {
    const s = LS.settings;
    $("set-capacity").value = s.max_capacity_per_slot || 0;
    $("set-slotlen").value = s.slot_length_minutes || 15;
    $("set-walkup").checked = !!s.walkup_mode;
    const sm = $("set-manual"); if (sm) sm.checked = !!s.manual_entry;
    $("set-grace-before").value = s.grace_before_minutes || 0;
    $("set-grace-after").value = s.grace_after_minutes || 0;
    const wb = $("walkup-banner");
    if (wb) wb.style.display = s.walkup_mode ? "block" : "none";
    const mr = $("manual-row"); if (mr) mr.style.display = s.manual_entry ? "flex" : "none";
    renderSlots();
  }

  function renderSlots() {
    const slots = sortedSlots().slots;
    $("slot-count").textContent = slots.length ? slots.length + " slot(s)" : "none — using auto " + (LS.settings.slot_length_minutes || 15) + "-min windows";
    const ul = $("slot-list");
    ul.innerHTML = "";
    slots.forEach((sl, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = sl.start + " – " + sl.end;
      const del = document.createElement("button");
      del.className = "btn-x"; del.textContent = "✕";
      del.onclick = () => deleteSlot(i);
      li.appendChild(span); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function setSlots(slots) {
    const anchor = scheduleAnchorMin(slots);
    slots.sort((a, b) => slotAbsMin(hhmmToMin(a.start), anchor) - slotAbsMin(hhmmToMin(b.start), anchor));
    touchSettings((s) => { s.slots = slots; });
  }

  function generateSlots() {
    const start = hhmmToMin($("gen-start").value || "09:00");
    const len = Math.max(1, parseInt($("gen-len").value || LS.settings.slot_length_minutes || "15", 10));
    let count = 0;
    if ($("gen-count").value) {
      count = Math.max(0, parseInt($("gen-count").value, 10) || 0);
    } else if ($("gen-end").value) {
      let end = hhmmToMin($("gen-end").value);
      if (end <= start) end += 1440; // schedule crosses midnight (e.g. 21:00 → 01:00)
      count = Math.max(0, Math.floor((end - start) / len));
    }
    if (!count) { alert("Enter an end time or a number of slots."); return; }
    const slots = [];
    for (let i = 0; i < count; i++) {
      const a = start + i * len;
      slots.push({ start: minToHHMM(a), end: minToHHMM(a + len) });
    }
    // Keep the capacity window length in step with the generated slot length.
    touchSettings((s) => { s.slots = slots; s.slot_length_minutes = len; });
  }

  function addSlotManual() {
    const a = $("add-slot-start").value, b = $("add-slot-end").value;
    if (!a || !b) { alert("Enter both a start and end time."); return; }
    const slots = (LS.settings.slots || []).slice();
    slots.push({ start: a, end: b });
    setSlots(slots);
    $("add-slot-start").value = ""; $("add-slot-end").value = "";
  }

  function deleteSlot(i) {
    const slots = (LS.settings.slots || []).slice();
    slots.splice(i, 1);
    setSlots(slots);
  }

  function clearSlots() {
    if (!confirm("Remove all configured slots?")) return;
    setSlots([]);
  }

  function renderDelayButtons() {
    const running = !!LS.delay.delay_running_since;
    $("btn-start-delay").style.display = running ? "none" : "inline-block";
    $("btn-stop-delay").style.display = running ? "inline-block" : "none";
    $("delay-state").textContent = running
      ? "Delay running since " + fmtTime(LS.delay.delay_running_since)
      : "Base delay " + (LS.delay.delay_base_minutes || 0) + " min";
  }

  function relTime(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  }

  function renderStatus() {
    renderSyncMeta();
    const d = $("device-id"); if (d) d.textContent = LS.deviceId;
  }

  // Lightweight: safe to call on a timer.
  function renderSyncMeta() {
    const v = $("ticket-count"); if (v) v.textContent = LS.version ? "v" + LS.version : "—";
    const ls = $("last-sync"); if (ls) ls.textContent = relTime(LS.lastSync);
    renderConn();
  }

  function setConn(state) { conn.state = state; renderConn(); }

  function renderConn() {
    const b = $("online-badge");
    if (!b) return;
    let txt = "offline", cls = "badge-warn";
    switch (conn.state) {
      case "online":  txt = "● online"; cls = "badge-ok"; break;
      case "syncing": txt = "⟳ syncing"; cls = "badge-sync"; break;
      case "offline": txt = conn.failures > 1 ? "⟳ reconnecting" : "○ offline"; cls = "badge-warn"; break;
      default:        txt = "…"; cls = "badge-sync";
    }
    b.textContent = txt;
    b.className = "badge " + cls;
  }

  function renderAll() {
    renderDelayButtons();
    renderStatus();
    renderSettings();
    renderStats();
  }

  // ----------------------------------------------------------------- uploads
  async function uploadPdfs(files) {
    const out = $("ingest-results");
    if (!files || !files.length) return;
    out.textContent = "Uploading " + files.length + " file(s)…";
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    try {
      const data = await apiFetch("/api/ingest", { method: "POST", body: fd });
      out.innerHTML = "<strong>" + data.ingested + "/" + data.total + " ingested</strong>";
      const ul = document.createElement("ul");
      for (const r of data.results) {
        const li = document.createElement("li");
        li.className = r.status === "ok" ? "ok" : "review";
        li.textContent = r.status === "ok"
          ? r.filename + " → " + r.barcode + " (" + fmtSlot(r.slot_start, r.slot_end) + ")"
          : r.filename + " → needs review: " + (r.error || "");
        ul.appendChild(li);
      }
      out.appendChild(ul);
      await syncNow();
    } catch (e) {
      out.textContent = "Upload failed (offline?). It will need connectivity: " + (e.message || e);
    }
  }

  // -------------------------------------------------------------------- wiring
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tabbtn").forEach((b) => b.classList.remove("active"));
    $("tab-" + name).classList.add("active");
    $("tabbtn-" + name).classList.add("active");
  }

  // Attach a handler only if the element exists, so one missing/renamed element can never
  // abort the rest of the wiring (which previously left every button dead).
  function on(id, evt, fn) {
    const el = $(id);
    if (el) el.addEventListener(evt, fn);
    else console.warn("wire: missing #" + id);
  }

  function wire() {
    on("tabbtn-scan", "click", () => showTab("scan"));
    on("tabbtn-settings", "click", () => showTab("settings"));
    on("online-badge", "click", () => showTab("settings")); // tap status → fix token/sync

    on("btn-camera", "click", () => (stream ? stopCamera() : startCamera()));
    on("btn-manual", "click", () => { handleScan($("manual-input").value); $("manual-input").value = ""; });
    on("manual-input", "keydown", (e) => { if (e.key === "Enter") $("btn-manual").click(); });
    on("btn-override", "click", doOverride);

    on("btn-start-delay", "click", startDelay);
    on("btn-stop-delay", "click", stopDelay);
    on("btn-catchup-1", "click", () => catchUp(1));
    on("btn-catchup-5", "click", () => catchUp(5));
    on("btn-reset-delay", "click", resetDelay);

    on("btn-upload", "click", () => uploadPdfs($("pdf-input").files));
    on("btn-sync", "click", () => syncNow());
    on("btn-reset-app", "click", () => {
      if (confirm("Reset the app? Clears the cached version and reloads the latest. Your token and settings stay.")) resetApp(true);
    });

    // Settings — each change updates the synced settings object (last-write-wins).
    on("set-walkup", "change", (e) => touchSettings((s) => { s.walkup_mode = e.target.checked; }));
    on("set-manual", "change", (e) => touchSettings((s) => { s.manual_entry = e.target.checked; }));
    const numEdit = (id, key, min) => on(id, "change", (e) => {
      const v = Math.max(min, parseInt(e.target.value || "0", 10) || 0);
      touchSettings((s) => { s[key] = v; });
    });
    numEdit("set-capacity", "max_capacity_per_slot", 0);
    numEdit("set-slotlen", "slot_length_minutes", 1);
    numEdit("set-grace-before", "grace_before_minutes", 0);
    numEdit("set-grace-after", "grace_after_minutes", 0);

    // Time-slot schedule.
    on("btn-gen-slots", "click", generateSlots);
    on("btn-add-slot", "click", addSlotManual);
    on("btn-clear-slots", "click", clearSlots);

    // Network transitions: resync immediately on regain, reflect loss at once.
    window.addEventListener("online", () => { conn.failures = 0; syncNow(); });
    window.addEventListener("offline", () => setConn("offline"));
    // Resync when the app is brought back to the foreground (phone unlocked / tab shown).
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
  }

  let _reloading = false;
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW reg failed", e));
    // If a new service worker takes control (after a deploy), reload once to pick up fresh
    // assets. Guarded so the first-ever install (no prior controller) doesn't reload.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (_reloading) return;
        _reloading = true;
        location.reload();
      });
    }
  }

  // Hard reset: unregister the service worker and wipe all caches so a stuck/old build is
  // discarded and the latest is fetched fresh. Keeps local data (token/settings/scan queue).
  async function resetApp(reload) {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { console.warn("reset failed", e); }
    if (reload) location.replace(location.pathname); // clean URL, fetch everything fresh
  }

  async function main() {
    // Recovery entry point: visiting /?reset clears the service worker + caches and reloads.
    if (/[?&]reset\b/.test(location.search)) { await resetApp(true); return; }

    registerSW();
    // Wire the UI even if storage/sync init fails, so buttons are never dead.
    try {
      await openDB();
      await recomputeLastSlotEnd();
    } catch (e) {
      console.error("init (IndexedDB) failed", e);
    }
    wire();
    renderAll();
    renderConn();
    // First sync; it schedules every subsequent poll itself (adaptive backoff).
    syncNow();

    // UI tick: keep the live offset, stats and "last sync" label fresh without touching
    // the network (the sync loop owns network cadence). No token-field writes here.
    setInterval(() => { renderDelayButtons(); renderStats(); renderSyncMeta(); }, 3000);
  }

  document.addEventListener("DOMContentLoaded", main);
})();
