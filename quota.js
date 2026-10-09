// Per-minute AI call budget: a sliding 60s window. When it is full, callers wait (bots are "busy") instead of failing.
'use strict';

function createBudget({ perMin = 12, now = Date.now } = {}) {
  let calls = [];
  const prune = () => { const t = now() - 60e3; while (calls.length && calls[0] <= t) calls.shift(); };
  return {
    perMin,
    used() { prune(); return calls.length; },
    canCall() { prune(); return calls.length < perMin; },
    // ms until the oldest call leaves the window (0 when there is room)
    msUntilFree() { prune(); return calls.length < perMin ? 0 : Math.max(0, calls[0] + 60e3 - now()); },
    record() { prune(); calls.push(now()); return calls.length; },
    // true when only a few calls are left in the window
    nearLimit(margin = 2) { prune(); return calls.length >= perMin - margin; }
  };
}

module.exports = { createBudget };
