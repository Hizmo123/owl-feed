// Priority queue tests: node test/aiqueue.test.js
const assert = require('assert');
const { createQueue } = require('../aiqueue');
const { createBudget } = require('../quota');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const PRI = { dm: 0, post: 1, reply: 1, duel: 1, 'dm-opener': 2, 'hype-wave': 3, ambient: 6 }; // same map the server uses

t('player-facing calls jump ahead of ambient and wave work that is already waiting', async () => {
  const q = createQueue();
  const order = [];
  let release; const gate = new Promise(r => release = r);
  const first = q.enqueue(async () => { await gate; order.push('first'); }, { pri: 6, kind: 'ambient' }); // occupies the worker
  const jobs = [
    q.enqueue(async () => order.push('ambient-2'), { pri: PRI.ambient, kind: 'ambient' }),
    q.enqueue(async () => order.push('wave'), { pri: PRI['hype-wave'], kind: 'hype-wave' }),
    q.enqueue(async () => order.push('opener'), { pri: PRI['dm-opener'], kind: 'dm-opener' }),
    q.enqueue(async () => order.push('post'), { pri: PRI.post, kind: 'post' }),
    q.enqueue(async () => order.push('dm'), { pri: PRI.dm, kind: 'dm' }),
    q.enqueue(async () => order.push('ambient-3'), { pri: PRI.ambient, kind: 'ambient' })
  ];
  assert.strictEqual(q.length, 6);
  assert.deepStrictEqual(q.kinds(), { ambient: 2, 'hype-wave': 1, 'dm-opener': 1, post: 1, dm: 1 });
  release();
  await Promise.all([first, ...jobs]);
  assert.deepStrictEqual(order, ['first', 'dm', 'post', 'opener', 'wave', 'ambient-2', 'ambient-3']);
});

t('same priority stays first-in-first-out', async () => {
  const q = createQueue();
  const order = []; let release; const gate = new Promise(r => release = r);
  const a = q.enqueue(async () => { await gate; }, { pri: 1 });
  const rest = [1, 2, 3, 4].map(i => q.enqueue(async () => order.push(i), { pri: 1 }));
  release(); await Promise.all([a, ...rest]);
  assert.deepStrictEqual(order, [1, 2, 3, 4]);
});

t('a minimum gap is kept between calls', async () => {
  let clock = 1e6; const naps = [];
  const q = createQueue({ minGap: 2500, now: () => clock, sleep: async ms => { naps.push(ms); clock += ms; } });
  await q.enqueue(async () => 1); clock += 100;
  await q.enqueue(async () => 2);
  assert.strictEqual(naps.length, 1); assert.strictEqual(naps[0], 2400);
});

t('failures reject only their own job and do not stall the queue', async () => {
  const q = createQueue();
  const bad = q.enqueue(async () => { throw new Error('boom'); }, { pri: 1 });
  const good = q.enqueue(async () => 'ok', { pri: 6 });
  await assert.rejects(bad, /boom/);
  assert.strictEqual(await good, 'ok');
});

t('a global per-minute cap makes jobs wait (and logs "busy") instead of failing', async () => {
  let clock = Date.now(); const logs = [];
  const budget = createBudget({ perMin: 2, now: () => clock });
  const q = createQueue({ budget, now: () => clock, log: m => logs.push(m) });
  const done = [];
  await q.enqueue(async () => done.push(1)); await q.enqueue(async () => done.push(2));
  const third = q.enqueue(async () => done.push(3), { pri: 0, kind: 'dm' });
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(done, [1, 2]);
  assert.ok(logs.some(l => /bots are busy/.test(l)));
  clock += 61e3; // the window moves on; the timer is real so just advance the fake clock and nudge the queue
  q.enqueue(async () => done.push(4), { pri: 5 }).catch(() => {});
  await Promise.race([third, new Promise(r => setTimeout(r, 200))]);
  assert.ok(done.includes(3));
});

(async () => {
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('ok -', name); }
    catch (e) { console.error('FAIL -', name, '\n  ', e.stack.split('\n').slice(0, 4).join('\n   ')); process.exitCode = 1; }
  }
  console.log(`\n${ok}/${tests.length} queue tests passed`);
  process.exit(process.exitCode || 0);
})();
