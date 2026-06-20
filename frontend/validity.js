/*
 * Validity rule — mirror of backend/validity.py. Keep the two in lock-step.
 *
 * A ticket may ride down DURING its slot, or AFTER every slot has passed (free-for-all).
 * Between its own slot end and the last slot end it is BLOCKED. A global delay offset
 * (minutes) shifts every slot; an optional grace window widens each slot.
 *
 * Exposed as window.Validity (classic script, no modules — simplest for SW + offline).
 */
(function (global) {
  "use strict";

  const EARLY = "early";
  const VALID = "valid";
  const BLOCKED = "blocked";

  function minutesBetween(a, b) {
    return (a.getTime() - b.getTime()) / 60000;
  }

  // Frozen accumulated delay plus any currently-running delay's elapsed minutes.
  function effectiveOffsetMinutes(delay, now) {
    let base = Number(delay && delay.delay_base_minutes) || 0;
    const runningSince = delay && delay.delay_running_since;
    if (runningSince) {
      const started = new Date(runningSince);
      if (!isNaN(started) && now > started) {
        base += minutesBetween(now, started);
      }
    }
    return Math.max(0, base);
  }

  function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  }

  /**
   * @param slotStart, slotEnd, lastSlotEnd : Date
   * @param delay : {delay_base_minutes, delay_running_since, grace_before_minutes, grace_after_minutes}
   * @param now : Date
   * @returns {status, reason, offsetMinutes}
   */
  function computeValidity(slotStart, slotEnd, lastSlotEnd, delay, now) {
    const offset = effectiveOffsetMinutes(delay, now);
    const gBefore = Number(delay && delay.grace_before_minutes) || 0;
    const gAfter = Number(delay && delay.grace_after_minutes) || 0;

    const start = addMinutes(slotStart, offset);
    const end = addMinutes(slotEnd, offset);
    const lastEnd = addMinutes(lastSlotEnd, offset);

    const startGrace = addMinutes(start, -gBefore);
    const endGrace = addMinutes(end, gAfter);

    let status, reason;
    if (now >= lastEnd) {
      status = VALID;
      reason = "all slots passed (free-for-all)";
    } else if (now >= startGrace && now <= endGrace) {
      status = VALID;
      reason = "within assigned slot";
    } else if (now < startGrace) {
      status = EARLY;
      reason = "slot has not started yet";
    } else {
      status = BLOCKED;
      reason = "slot passed; ride down not yet open for everyone";
    }
    return { status: status, reason: reason, offsetMinutes: Math.round(offset * 100) / 100 };
  }

  global.Validity = {
    EARLY: EARLY,
    VALID: VALID,
    BLOCKED: BLOCKED,
    effectiveOffsetMinutes: effectiveOffsetMinutes,
    computeValidity: computeValidity,
    addMinutes: addMinutes,
  };
})(typeof self !== "undefined" ? self : this);
