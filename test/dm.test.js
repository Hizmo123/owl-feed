// Unit checks for DM/rumour logic and the AI budget: node test/dm.test.js
const assert = require('assert');
const D = require('../dmlogic');
const { createBudget } = require('../quota');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const bot = (handle, extra = {}) => ({ id: 'c_' + handle, kind: 'char', handle, name: handle, ...extra });
const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const avg = (b, opts, n = 300) => { const r = seeded(7); let s = 0; for (let i = 0; i < n; i++) s += D.replyDelayMs(b, { ...opts, rnd: r }); return s / n; };

t('Snape replies far later than Ron; Hermione is slower than Ron too', () => {
  const o = { hour: 19 };
  assert.ok(avg(bot('prof.snape'), o) > 8 * avg(bot('ronweasley'), o));
  assert.ok(avg(bot('hgranger'), o) > avg(bot('ronweasley'), o));
});

t('time of day: most bots sleep until morning at 2am, Dumbledore keeps odd hours', () => {
  const ron = bot('ronweasley'), albus = bot('albus.d');
  assert.ok(avg(ron, { hour: 2 }) > 10 * avg(ron, { hour: 19 }), 'Ron should be asleep at 2am');
  assert.ok(avg(albus, { hour: 2 }) < avg(albus, { hour: 11 }), 'Dumbledore is quicker at night');
});

t('time scale compresses delays for tests but keeps a floor', () => {
  const b = bot('prof.snape');
  const real = D.replyDelayMs(b, { hour: 14, scale: 1, rnd: () => 0.5 }), fast = D.replyDelayMs(b, { hour: 14, scale: 0.02, rnd: () => 0.5 });
  assert.ok(real > 600e3 && fast < real / 40 && fast >= 600);
  assert.ok(D.replyDelayMs(bot('ronweasley'), { hour: 14, scale: 0.0001 }) >= 600);
});

t('"later" replies take 20-120 minutes', () => {
  const ms = D.replyDelayMs(bot('ronweasley'), { hint: 'later', hour: 19, rnd: () => 0 });
  assert.ok(ms >= 1200e3 * 0.7 - 1);
});

t('sydneyHour honours a pinned hour and otherwise returns 0-23', () => {
  assert.strictEqual(D.sydneyHour(Date.now(), 14), 14);
  const h = D.sydneyHour(Date.UTC(2026, 9, 9, 3, 0)); // 03:00 UTC = 14:00 AEDT in October
  assert.strictEqual(h, 14);
  assert.ok(D.sydneyHour() >= 0 && D.sydneyHour() <= 23);
});

t('mock DM brain: always valid actions; leaves on read, reacts, double-texts and ends sometimes', () => {
  const seen = new Set(); const r = seeded(3);
  for (let i = 0; i < 400; i++) {
    const b = bot(['ronweasley', 'prof.snape', 'albus.d'][i % 3]);
    const d = D.mockDM(b, { text: i % 5 === 0 ? 'you are so stupid' : 'hello there', rnd: r });
    assert.ok(d.actions.length >= 1);
    for (const a of d.actions) { assert.ok(['message', 'react', 'ignore', 'end'].includes(a.kind)); if (a.kind === 'message') assert.ok(a.text.length > 0); seen.add(a.kind); }
    if (d.actions.filter(a => a.kind === 'message').length > 1) seen.add('double');
  }
  for (const k of ['message', 'react', 'ignore', 'end', 'double']) assert.ok(seen.has(k), 'never produced ' + k);
});

t('insults cost relationship, flattery earns it', () => {
  const b = bot('ronweasley');
  assert.ok(D.mockDM(b, { text: 'shut up you loser', rnd: () => 0.5 }).relationship_delta < 0);
  assert.ok(D.mockDM(b, { text: 'you are a legend, thanks', rnd: () => 0.5 }).relationship_delta > 0);
});

t('Ron types lowercase with typos; Hermione writes long careful replies', () => {
  assert.strictEqual(D.styleText(bot('ronweasley'), 'What REALLY though', () => 0.1), 'wat realy tho');
  assert.ok(D.LINES.hgranger.every(l => l.length > 120));
});

t('rumour classification: subject, juiciness, pass_to', () => {
  const r = D.classifyRumour("psst @momo2 cheated on his potions essay, don't tell anyone", 'rita.skeeter');
  assert.strictEqual(r.is_rumour, true);
  assert.strictEqual(r.subject, '@momo2');
  assert.ok(r.juiciness >= 3, 'juiciness ' + r.juiciness);
  assert.ok(r.claim.includes('cheated'));
  const p = D.classifyRumour('tell harry that @d.malfoy cheated in Quidditch', 'hgranger');
  assert.strictEqual(p.subject, '@d.malfoy');
  assert.strictEqual(p.pass_to, '@harry');
  assert.strictEqual(D.classifyRumour('how was your day', 'ronweasley').is_rumour, false);
});

t('claims mutate a little on each hop; the input is untouched', () => {
  const orig = 'momo2 cheated on his potions essay once';
  const m1 = D.mutateClaim(orig, () => 0.1);
  assert.notStrictEqual(m1, orig);
  assert.ok(m1.includes('twice') || m1.includes('AND lied'));
  assert.ok(D.mutateClaim('plain words here', () => 0.9).startsWith('apparently'));
  assert.ok(D.mutateClaim(orig, Math.random).length <= 240);
});

t('gossip personalities: Rita almost always leaks, Dumbledore never posts, Snape deducts, Hermione warns', () => {
  const r = seeded(11); const count = (handle, ctx, n = 1000) => { const c = {}; for (let i = 0; i < n; i++) { const a = D.gossipDecision(D.profileFor(bot(handle)), ctx, r); c[a] = (c[a] || 0) + 1; } return c; };
  const ctx = { juiciness: 4, believed: true, subjectIsPlayer: true };
  const rita = count('rita.skeeter', ctx);
  assert.ok((rita.post || 0) + (rita.vaguepost || 0) > 940, JSON.stringify(rita));
  const albus = count('albus.d', ctx);
  assert.ok(!albus.post && !albus.vaguepost && albus.hint > 300, JSON.stringify(albus));
  const snape = count('prof.snape', ctx);
  assert.ok(snape.deduct > 200 && !snape.post, JSON.stringify(snape));
  const herm = count('hgranger', ctx);
  assert.ok(herm.warn > 0 && (herm.post || 0) === 0 && (herm.secret || 0) > 400, JSON.stringify(herm));
  const pansy = count('pansy.p', ctx);
  assert.ok(pansy.post > 600, JSON.stringify(pansy));
});

t('NPC gossip bots leak more than ordinary NPCs', () => {
  const g = D.profileFor({ kind: 'npc', handle: 'x', seed: 'gossip who spreads rumours' }), n = D.profileFor({ kind: 'npc', handle: 'y', seed: 'potions nerd' });
  assert.ok(g.leak.p > n.leak.p);
});

t('rumour post text: Rita headlines with the subject, exposure credits the source, vague posts name nobody', () => {
  const rita = bot('rita.skeeter');
  const post = D.rumourPostText(rita, 'post', { claim: 'x cheated', subject: '@momo2', mention: true, exposeHandle: 'zayd2' });
  assert.ok(post.startsWith('EXCLUSIVE: @momo2') && post.includes('@zayd2'));
  const vague = D.rumourPostText(bot('pansy.p'), 'vaguepost', { claim: 'x cheated', subject: '@momo2', house: 'Slytherin' });
  assert.ok(vague.includes('someone in Slytherin') && !vague.includes('@momo2'));
  assert.ok(post.length <= 280);
});

t('AI budget: sliding 60s window, waits instead of failing', () => {
  let clock = 1000; const b = createBudget({ perMin: 3, now: () => clock });
  assert.ok(b.canCall()); b.record(); clock += 10e3; b.record(); clock += 10e3; b.record();
  assert.strictEqual(b.used(), 3);
  assert.strictEqual(b.canCall(), false);
  assert.ok(b.nearLimit());
  assert.strictEqual(b.msUntilFree(), 60e3 - 20e3);
  clock += 40e3 + 1;
  assert.strictEqual(b.canCall(), true);
  assert.strictEqual(b.used(), 2);
});

console.log(`\n${passed} DM/rumour/budget tests passed`);
