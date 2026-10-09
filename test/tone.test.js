// Tone balance + reply targeting tests: node test/tone.test.js
const assert = require('assert');
const T = require('../tone');
const castle = require('../castle');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const mkBot = (handle, house, kind = 'char', seed) => ({ id: 'b_' + handle, handle, house, kind, seed, name: handle });
const CAST = [
  mkBot('d.malfoy', 'Slytherin'), mkBot('pansy.p', 'Slytherin'), mkBot('h.potter', 'Gryffindor'), mkBot('ronweasley', 'Gryffindor'), mkBot('luna.lovegood', 'Ravenclaw'),
  mkBot('nev.herbology', 'Gryffindor'), mkBot('c.diggory', 'Hufflepuff'), mkBot('prof.snape', 'Staff'), mkBot('m.mcgonagall', 'Staff'), mkBot('hagrid', 'Staff'),
  mkBot('n1', 'Gryffindor', 'npc', 'professional hater who ratios everyone'), mkBot('n2', 'Slytherin', 'npc', 'wholesome hype friend'), mkBot('n3', 'Ravenclaw', 'npc', 'potions nerd'), mkBot('n4', 'Hufflepuff', 'npc', 'sarcastic seventh year'),
  mkBot('n5', 'Slytherin', 'npc', 'chronically online meme poster'), mkBot('n6', 'Gryffindor', 'npc', 'quidditch obsessed')
];
const pickN = (n, rnd) => CAST.slice().sort(() => rnd() - 0.5).slice(0, n);
const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const share = (list, f) => list.filter(f).length / list.length;

// one simulated batch, the same pipeline the server runs for mock reactions
function batch(verdict, author, rnd, n = 5) {
  const bots = pickN(n, rnd);
  const stances = T.allocate(verdict, n, rnd);
  const replies = T.assign(stances, bots, author, () => 0, rnd).map(a => ({ bot: a.bot, stance: a.stance, likes: Math.floor(rnd() * 40) }));
  return T.balance(replies, verdict);
}
function distribution(verdict, runs = 50, author = { house: 'Gryffindor' }) {
  const rnd = seeded(verdict.length * 7919);
  const all = [], batches = [];
  for (let i = 0; i < runs; i++) { const b = batch(verdict, author, rnd, 5 + (i % 3)); all.push(...b.replies); batches.push(b); }
  return { all, batches };
}

t('mock reactions follow the verdict quotas (50 batches per verdict, distribution logged)', () => {
  const rows = [];
  const check = (verdict, fn) => { const { all, batches } = distribution(verdict); const c = {}; for (const s of T.STANCES) c[s] = Math.round(100 * share(all, r => r.stance === s)); rows.push(`${verdict.padEnd(14)} n=${all.length}  support ${c.support}%  joke ${c.joke}%  neutral ${c.neutral}%  critical ${c.critical}%  hostile ${c.hostile}%`); fn(all, batches, c); };
  check('viral', all => { assert.ok(share(all, r => T.isPos(r.stance)) >= 0.6, 'viral support/joke'); assert.ok(share(all, r => T.isNeg(r.stance)) <= 0.2, 'viral critical/hostile'); });
  check('good', all => { const p = share(all, r => T.isPos(r.stance)); assert.ok(p >= 0.42 && p <= 0.64, 'good support/joke ' + p); const n = share(all, r => T.isNeg(r.stance)); assert.ok(n >= 0.12 && n <= 0.33, 'good critical ' + n); });
  check('mid', all => { const s = share(all, r => r.stance === 'support'); assert.ok(s >= 0.26 && s <= 0.46, 'mid support ' + s); const nj = share(all, r => r.stance === 'neutral' || r.stance === 'joke'); assert.ok(nj >= 0.27 && nj <= 0.47, 'mid neutral/joke ' + nj); const c = share(all, r => T.isNeg(r.stance)); assert.ok(c >= 0.18 && c <= 0.4, 'mid critical ' + c); });
  check('flop', (all, batches) => { assert.ok(share(all, r => T.isNeg(r.stance)) >= 0.5, 'flop mostly critical'); assert.ok(batches.every(b => b.replies.some(r => r.stance === 'support')), 'every flop batch has a supporter or pity reply'); });
  check('ratioed', (all, batches) => { assert.ok(share(all, r => T.isNeg(r.stance)) >= 0.5); assert.ok(batches.every(b => b.replies.some(r => r.stance === 'support'))); });
  check('controversial', all => { const p = share(all, r => T.isPos(r.stance)), n = share(all, r => T.isNeg(r.stance)); assert.ok(p >= 0.33 && p <= 0.57, 'split camps (support) ' + p); assert.ok(n >= 0.33 && n <= 0.57, 'split camps (critical) ' + n); });
  console.log('   ' + rows.join('\n   '));
});

t('never more than ONE pure insult in a batch, whatever the verdict', () => {
  for (const v of ['viral', 'good', 'mid', 'flop', 'ratioed', 'controversial']) {
    const { batches } = distribution(v, 80);
    assert.ok(batches.every(b => b.replies.filter(r => r.stance === 'hostile').length <= 1), v);
  }
});

t('house loyalty: the author\'s own house leans supportive, the rival house critical', () => {
  const rnd = seeded(5);
  const slyAuthor = { house: 'Slytherin' };
  const own = [], rival = [];
  for (let i = 0; i < 300; i++) {
    for (const a of T.assign(T.allocate('mid', 6, rnd), pickN(6, rnd), slyAuthor, () => 0, rnd)) {
      if (a.bot.house === 'Slytherin') own.push(a.stance); else if (a.bot.house === 'Gryffindor') rival.push(a.stance);
    }
  }
  assert.ok(share(own, T.isPos) > share(rival, T.isPos) + 0.15, `own house support ${share(own, T.isPos)} vs rival ${share(rival, T.isPos)}`);
  assert.ok(share(rival, T.isNeg) > share(own, T.isNeg) + 0.15);
});

t('warm characters are never hostile or critical; only established haters get to be hostile', () => {
  const rnd = seeded(9);
  let hostile = 0;
  for (let i = 0; i < 400; i++) {
    for (const v of ['flop', 'controversial', 'mid']) for (const a of T.assign(T.allocate(v, 7, rnd), pickN(7, rnd), { house: 'Gryffindor' }, () => 0, rnd)) {
      if (T.isWarm(a.bot)) assert.ok(!T.isNeg(a.stance), `${a.bot.handle} was ${a.stance}`);
      if (a.stance === 'hostile') { hostile++; assert.ok(T.canHostile(a.bot, 0), `${a.bot.handle} should not be hostile`); }
    }
  }
  assert.ok(hostile > 20, 'haters still roast sometimes (' + hostile + ')');
  assert.ok(T.isWarm(mkBot('x', 'Hufflepuff', 'npc')) && T.isWarm(mkBot('y', 'Ravenclaw', 'npc', 'wholesome hype friend')));
  assert.ok(T.canHostile(mkBot('z', 'Gryffindor', 'npc', 'potions nerd'), -5), 'someone who already dislikes the author may be hostile');
  assert.ok(!T.canHostile(mkBot('z', 'Gryffindor', 'npc', 'potions nerd'), 0));
});

t('staff stay fair: their lean is clamped', () => {
  const s = T.leanScore(mkBot('prof.snape', 'Staff'), { house: 'Gryffindor' }, -6), m = T.leanScore(mkBot('m.mcgonagall', 'Staff'), { house: 'Gryffindor' }, 6);
  assert.ok(s >= -1 && m <= 1);
});

t('balancing trims excess hostile replies and keeps the best supporters', () => {
  const mk = stances => stances.map((s, i) => ({ stance: s, text: 'r' + i, likes: 10 }));
  let b = T.balance(mk(['support', 'hostile', 'hostile', 'hostile', 'joke']), 'mid');
  assert.strictEqual(b.replies.filter(r => r.stance === 'hostile').length, 1);
  b = T.balance(mk(['support', 'joke', 'critical', 'critical', 'critical', 'hostile']), 'viral');
  assert.strictEqual(b.replies.filter(r => T.isNeg(r.stance)).length, 1, 'a viral batch of six keeps at most one negative');
  assert.ok(b.replies.length >= 3);
  assert.deepStrictEqual(b.replies.filter(r => T.isPos(r.stance)).map(r => r.text), ['r0', 'r1'], 'the supporters survive');
  b = T.balance(mk(['critical', 'critical', 'hostile', 'neutral']), 'flop');
  assert.strictEqual(b.replies.length, 4, 'flops may stay critical');
  assert.strictEqual(b.needsSupporter, true);
  b = T.balance(mk(['bogus', undefined]), 'mid');
  assert.ok(b.replies.every(r => r.stance === 'neutral'));
});

t('likes: supporters beat haters on viral/good posts, hostile replies only win on flops', () => {
  const base = [['support', 20], ['joke', 20], ['critical', 20], ['hostile', 20], ['neutral', 20]].map(([stance, likes]) => ({ stance, likes }));
  for (const v of ['viral', 'good']) {
    const out = T.adjustLikes(base, v), min = x => Math.min(...out.filter(r => T.isPos(r.stance)).map(r => r.likes)), max = Math.max(...out.filter(r => T.isNeg(r.stance)).map(r => r.likes));
    assert.ok(min() > max, `${v}: supporters ${min()} vs negatives ${max}`);
  }
  const f = T.adjustLikes(base, 'flop');
  assert.ok(f.find(r => r.stance === 'hostile').likes > f.find(r => r.stance === 'support').likes);
  assert.deepStrictEqual(T.adjustLikes(base, 'mid').map(r => r.likes), [20, 20, 20, 20, 20]);
});

t('reacting_to validation: a reply written for another post is dropped', () => {
  const target = 'Omniculars are wildly overpriced and nobody can tell me otherwise';
  assert.strictEqual(T.checkReacting('omniculars are wildly overpriced', [target]), 'ok');
  assert.strictEqual(T.checkReacting('overpriced omnicular', [target]), 'ok', 'fuzzy: plural / typo tolerant');
  assert.strictEqual(T.checkReacting('what is a phd', [target]), 'bad');
  assert.strictEqual(T.checkReacting('', [target]), 'missing');
  const bg = ['I finally finished my PhD thesis on dragon scales', 'trending: quidditch final'];
  assert.strictEqual(T.checkReacting('callback: the phd thesis post', [target], bg), 'callback');
  assert.strictEqual(T.checkReacting('callback: the cauldron cake post', [target], bg), 'bad', 'an unverifiable callback is not a free pass');
  const r = T.filterReplies([{ text: 'ok', reacting_to: 'wildly overpriced' }, { text: 'what is a phd?', reacting_to: 'phd thesis' }, { text: 'not you again after the PhD post', reacting_to: 'callback: PhD thesis' }, { text: 'no field', reacting_to: '' }], [target], bg);
  assert.deepStrictEqual(r.kept.map(x => x.text), ['ok', 'not you again after the PhD post']);
  assert.deepStrictEqual(r.dropped.map(d => d.why), ['bad', 'missing']);
  const ignored = T.filterReplies([{ text: 'a' }, { text: 'b' }], [target]);
  assert.strictEqual(ignored.kept.length, 2); assert.strictEqual(ignored.unchecked, true);
});

t('numbered feed items map back to ids; out-of-range numbers are rejected', () => {
  const ids = ['a', 'b', 'c'];
  assert.strictEqual(T.fromNumber(1, ids), 'a'); assert.strictEqual(T.fromNumber(3, ids), 'c');
  for (const bad of [0, 4, 99, -1, 1.5, '2', null, undefined, NaN]) assert.strictEqual(T.fromNumber(bad, ids), null, String(bad));
});

t('phraseOf quotes real words from the post', () => {
  const p = T.phraseOf('Omniculars are wildly overpriced and nobody cares #quidditch', seeded(3));
  assert.ok(T.fuzzyIn(p, 'Omniculars are wildly overpriced and nobody cares #quidditch'), p);
});

t('NPC opinion drift: negative capped at -1 per interaction, recovery is faster than loss', () => {
  const s = { rel: {} };
  const npc = { id: 'n1', kind: 'npc', handle: 'x', name: 'X', opinion: { p1: 0 } }, p = { id: 'p1', name: 'P' };
  castle.relInteract(s, npc, p, -3, 'insulted');
  assert.strictEqual(npc.opinion.p1, -1, 'a harsh post only costs 1');
  for (let i = 0; i < 4; i++) castle.relInteract(s, npc, p, -3, 'again');
  assert.strictEqual(npc.opinion.p1, -5);
  castle.relInteract(s, npc, p, 2, 'apologised');
  assert.strictEqual(npc.opinion.p1, -2, 'positive interactions recover 1.5x faster while negative (+3 for a +2)');
  castle.relInteract(s, npc, p, 1, 'nice');
  assert.strictEqual(npc.opinion.p1, 0, 'ceil(1 * 1.5) = 2');
  castle.relInteract(s, npc, p, 2, 'more'); assert.strictEqual(npc.opinion.p1, 2, 'no bonus once positive');
  const ch = { id: 'c1', kind: 'char', handle: 'y', name: 'Y' };
  castle.relInteract(s, ch, p, -3, 'characters keep the full range'); assert.strictEqual(castle.relScore(s, ch, 'p1'), -3);
});

console.log(`\n${passed} tone tests passed`);
