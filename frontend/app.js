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
    get token() { return localStorage.getItem("tc_token") || ""; },
    set token(v) { localStorage.setItem("tc_token", v); },
    get deviceId() {
      let id = localStorage.getItem("tc_device_id");
      if (!id) { id = "dev-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random()); localStorage.setItem("tc_device_id", id); }
      return id;
    },
    get version() { return parseInt(localStorage.getItem("tc_data_version") || "0", 10); },
    set version(v) { localStorage.setItem("tc_data_version", String(v)); },
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
    opts.headers = Object.assign({ "X-Scanner-Token": LS.token }, opts.headers || {});
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error("HTTP " + res.status);
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

  async function syncNow() {
    if (!navigator.onLine) { setOnline(false); return; }
    try {
      // 1) Push anything pending first so our changes aren't overwritten.
      await flushQueue();
      await pushDelayIfDirty();
      await pushSettingsIfDirty();

      // 2) Pull the snapshot.
      const data = await apiFetch("/api/sync?since=" + LS.version);
      setOnline(true);
      if (data.unchanged) { LS.lastSync = iso(nowDate()); renderStatus(); return; }

      if (data.event_date) LS.eventDate = data.event_date;
      await replaceTickets(data.tickets || []);
      await putRedemptions(data.redemptions || []);

      // Last-write-wins for delay: keep local if it is newer than the server's.
      const serverDelay = data.delay || defaultDelay();
      const local = LS.delay;
      if (!LS.delayDirty && (serverDelay.updated_at || "") >= (local.updated_at || "")) {
        LS.delay = serverDelay;
      }
      // Last-write-wins for settings (own timestamp group).
      const serverSettings = data.settings || defaultSettings();
      if (!LS.settingsDirty && (serverSettings.updated_at || "") >= (LS.settings.updated_at || "")) {
        LS.settings = Object.assign(defaultSettings(), serverSettings);
      }
      LS.version = data.data_version || LS.version;
      LS.lastSync = iso(nowDate());
      await recomputeLastSlotEnd();
      renderAll();
    } catch (e) {
      setOnline(false);
      console.warn("sync failed", e);
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
  let scanLoop = null;
  let lastHandled = { value: null, at: 0 };

  async function startCamera() {
    if (stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = $("video");
      video.srcObject = stream;
      await video.play();
      $("btn-camera").textContent = "Stop camera";
      if ("BarcodeDetector" in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        detector = new window.BarcodeDetector({ formats: formats });
        scanLoop = setInterval(scanTick, 250);
      } else {
        showResult("info", "Camera scanning not supported", "Use manual entry below (BarcodeDetector unavailable on this browser).", null);
      }
    } catch (e) {
      showResult("info", "Camera unavailable", String(e.message || e) + " — use manual entry.", null);
    }
  }

  function stopCamera() {
    if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    detector = null;
    $("btn-camera").textContent = "Start camera";
  }

  async function scanTick() {
    if (!detector) return;
    const video = $("video");
    if (!video.videoWidth) return;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) handleScan(codes[0].rawValue);
    } catch (e) { /* transient detect errors are expected */ }
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
  function slotDate(hhmm) {
    const base = LS.eventDate ? new Date(LS.eventDate + "T00:00:00") : new Date();
    const mins = hhmmToMin(hhmm);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(mins / 60), mins % 60, 0, 0);
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
    const slots = (LS.settings.slots || []).slice().sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
    for (const s of slots) {
      const start = slotDate(s.start), end = slotDate(s.end);
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

  async function renderStats() {
    const s = await computeStats();
    $("offset-badge").textContent = s.offset > 0 ? "Slots +" + s.offset + " min" : "On schedule";
    $("offset-badge").className = "badge " + (s.offset > 0 ? "badge-warn" : "badge-ok");

    $("stat-slot-total").textContent = s.slotTotal;
    $("stat-slot-scanned").textContent = s.slotScanned;
    $("stat-slot-notyet").textContent = s.slotNotYet;
    $("stat-slot-pct").textContent = s.slotPct + "%";
    $("stat-slot-bar").style.width = s.slotPct + "%";

    $("stat-noshows").textContent = s.noShows;
    $("stat-noshow-pct").textContent = s.noShowPct + "%";

    $("stat-day-total").textContent = s.dayTotal;
    $("stat-day-scanned").textContent = s.dayScanned;
    $("stat-day-pct").textContent = s.dayPct + "%";

    // Capacity card.
    $("cap-window").textContent = s.capWindow;
    if (s.capSet) {
      $("stat-cap-used").textContent = s.capUsed;
      $("stat-cap-max").textContent = s.cap;
      $("stat-cap-pct").textContent = s.capPct + "%";
      const bar = $("stat-cap-bar");
      bar.style.width = Math.min(100, s.capPct) + "%";
      const over = s.capUsed > s.cap;
      bar.classList.toggle("bar-over", over);
      $("stat-cap-pct").classList.toggle("pct-over", over);
    } else {
      $("stat-cap-used").textContent = s.capUsed;
      $("stat-cap-max").textContent = "∞";
      $("stat-cap-pct").textContent = "—";
      $("stat-cap-bar").style.width = "0%";
    }
  }

  function renderSettings() {
    const s = LS.settings;
    $("set-capacity").value = s.max_capacity_per_slot || 0;
    $("set-slotlen").value = s.slot_length_minutes || 15;
    $("set-walkup").checked = !!s.walkup_mode;
    $("set-grace-before").value = s.grace_before_minutes || 0;
    $("set-grace-after").value = s.grace_after_minutes || 0;
    const wb = $("walkup-banner");
    if (wb) wb.style.display = s.walkup_mode ? "block" : "none";
    renderSlots();
  }

  function renderSlots() {
    const slots = (LS.settings.slots || []).slice().sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
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
    slots.sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
    touchSettings((s) => { s.slots = slots; });
  }

  function generateSlots() {
    const start = hhmmToMin($("gen-start").value || "09:00");
    const len = Math.max(1, parseInt($("gen-len").value || LS.settings.slot_length_minutes || "15", 10));
    let count = 0;
    if ($("gen-count").value) {
      count = Math.max(0, parseInt($("gen-count").value, 10) || 0);
    } else if ($("gen-end").value) {
      count = Math.max(0, Math.floor((hhmmToMin($("gen-end").value) - start) / len));
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

  function renderStatus() {
    $("ticket-count").textContent = LS.version ? "v" + LS.version : "—";
    $("last-sync").textContent = LS.lastSync ? new Date(LS.lastSync).toLocaleTimeString() : "never";
    $("device-id").textContent = LS.deviceId;
    $("token-input").value = LS.token;
  }

  function setOnline(on) {
    const b = $("online-badge");
    b.textContent = on ? "online" : "offline";
    b.className = "badge " + (on ? "badge-ok" : "badge-warn");
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

  function wire() {
    $("tabbtn-scan").onclick = () => showTab("scan");
    $("tabbtn-add").onclick = () => showTab("add");
    $("tabbtn-settings").onclick = () => showTab("settings");

    $("btn-camera").onclick = () => (stream ? stopCamera() : startCamera());
    $("btn-manual").onclick = () => { handleScan($("manual-input").value); $("manual-input").value = ""; };
    $("manual-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-manual").click(); });
    $("btn-override").onclick = doOverride;

    $("btn-start-delay").onclick = startDelay;
    $("btn-stop-delay").onclick = stopDelay;
    $("btn-catchup-1").onclick = () => catchUp(1);
    $("btn-catchup-5").onclick = () => catchUp(5);
    $("btn-reset-delay").onclick = resetDelay;

    $("btn-upload").onclick = () => uploadPdfs($("pdf-input").files);
    $("btn-sync").onclick = syncNow;
    $("btn-save-token").onclick = () => { LS.token = $("token-input").value.trim(); syncNow(); };

    // Settings — each change updates the synced settings object (last-write-wins).
    $("set-walkup").onchange = (e) => touchSettings((s) => { s.walkup_mode = e.target.checked; });
    const numEdit = (id, key, min) => {
      $(id).onchange = (e) => {
        const v = Math.max(min, parseInt(e.target.value || "0", 10) || 0);
        touchSettings((s) => { s[key] = v; });
      };
    };
    numEdit("set-capacity", "max_capacity_per_slot", 0);
    numEdit("set-slotlen", "slot_length_minutes", 1);
    numEdit("set-grace-before", "grace_before_minutes", 0);
    numEdit("set-grace-after", "grace_after_minutes", 0);

    // Time-slot schedule.
    $("btn-gen-slots").onclick = generateSlots;
    $("btn-add-slot").onclick = addSlotManual;
    $("btn-clear-slots").onclick = clearSlots;

    window.addEventListener("online", () => { setOnline(true); syncNow(); });
    window.addEventListener("offline", () => setOnline(false));
  }

  async function main() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW reg failed", e));
    }
    await openDB();
    await recomputeLastSlotEnd();
    wire();
    setOnline(navigator.onLine);
    renderAll();
    await syncNow();

    // Keep the live delay offset / stats ticking even without scans.
    setInterval(() => { renderDelayButtons(); renderStats(); }, 10000);
    // Periodic background sync when online.
    setInterval(() => { if (navigator.onLine) syncNow(); }, 20000);
  }

  document.addEventListener("DOMContentLoaded", main);
})();
