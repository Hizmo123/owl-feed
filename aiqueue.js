// Priority queue in front of the AI layer: one call at a time, lowest `pri` first (players before ambient), minimum gap between calls,
// and an optional global per-minute cap (quota.js) where jobs wait instead of failing.
'use strict';

function createQueue({ minGap = 0, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), budget = null, enforce = true, log = () => {} } = {}) {
  const q = [];
  let busy = false, last = 0, timer = null;
  async function pump() {
    if (busy || !q.length) return;
    if (budget && enforce && !budget.canCall()) {
      if (!timer) {
        const w = budget.msUntilFree() + 50;
        log(`[owl] AI budget full (${budget.used()}/${budget.perMin} per min): ${q.length} job(s) waiting ${Math.round(w / 1000)}s, bots are busy`);
        timer = setTimeout(() => { timer = null; pump(); }, w);
      }
      return;
    }
    const job = q.shift();
    busy = true;
    const wait = Math.max(0, last + minGap - now());
    if (wait) await sleep(wait);
    const n = budget ? budget.record() : null;
    log(`[owl] AI call (${job.kind})${n !== null ? ` · ${n}/${budget.perMin} in the last minute` : ''}${q.length ? ` · ${q.length} queued` : ''}`);
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
    last = now();
    busy = false;
    pump();
  }
  function enqueue(fn, { pri = 5, kind = 'misc' } = {}) {
    return new Promise((resolve, reject) => {
      q.push({ fn, resolve, reject, pri, kind, at: now(), seq: q.length ? q[q.length - 1].seq + 1 : 0 });
      q.sort((a, b) => a.pri - b.pri || a.at - b.at || a.seq - b.seq);
      pump();
    });
  }
  return {
    enqueue,
    get length() { return q.length; },
    kinds() { const k = {}; for (const j of q) k[j.kind] = (k[j.kind] || 0) + 1; return k; }
  };
}

module.exports = { createQueue };
