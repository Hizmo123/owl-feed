// Unit checks for castle memory: node test/castle.test.js
const assert = require('assert');
const castle = require('../castle');

const mkState = () => ({ users: {}, posts: [], news: [], events: [], rel: {} });
const player = (id, handle, house) => ({ id, kind: 'player', handle, name: handle, house, followers: 100, hype: 40 });
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

t('digest keeps important recent news, drops stale low-importance items, newest first', () => {
  const s = mkState(), now = Date.now();
  castle.pushNews(s, 'ancient trivia', 1, 'x', now - 30 * 3600e3);
  castle.pushNews(s, 'old viral', 4, 'viral', now - 2 * 3600e3);
  castle.pushNews(s, 'fresh duel', 3, 'duel', now - 60e3);
  const d = castle.digest(s, now, 10);
  assert.strictEqual(d.length, 2);
  assert.ok(d[0].startsWith('fresh duel') && d[0].includes('(1m ago)'));
  assert.ok(d[1].startsWith('old viral') && d[1].includes('2h ago'));
  assert.ok(!d.join('|').includes('ancient'));
});

t('digest caps at 12 and de-duplicates repeats within 10 minutes', () => {
  const s = mkState(), now = Date.now();
  for (let i = 0; i < 30; i++) castle.pushNews(s, 'event ' + i, 3, 'x', now - i * 1000);
  assert.strictEqual(castle.digest(s, now, 99).length, 12);
  castle.pushNews(s, 'same thing', 2, 'x', now); castle.pushNews(s, 'same thing', 2, 'x', now + 1000);
  assert.strictEqual(s.news.filter(n => n.text === 'same thing').length, 1);
});

t('news store is bounded and keeps the most important items', () => {
  const s = mkState(), now = Date.now();
  for (let i = 0; i < 200; i++) castle.pushNews(s, 'low ' + i, 1, 'x', now - i);
  castle.pushNews(s, 'big one', 5, 'x', now);
  assert.ok(s.news.length <= 60);
  assert.ok(s.news.some(n => n.text === 'big one'));
});

t('character relationships clamp to -10..10 and keep only the last 3 memories', () => {
  const s = mkState();
  const draco = { id: 'c_d', kind: 'char', handle: 'd.malfoy', name: 'Draco' }, z = player('p1', 'zayd', 'Gryffindor');
  for (let i = 0; i < 6; i++) castle.relInteract(s, draco, z, 3, 'memory ' + i);
  assert.strictEqual(castle.relScore(s, draco, 'p1'), 10);
  const v = castle.relView(s, draco, 'p1');
  assert.deepStrictEqual(v.memory, ['memory 3', 'memory 4', 'memory 5']);
  for (let i = 0; i < 9; i++) castle.relInteract(s, draco, z, -3, null);
  assert.strictEqual(castle.relScore(s, draco, 'p1'), -10);
});

t('NPC relationships use and update the existing opinion score', () => {
  const s = mkState();
  const npc = { id: 'n_x', kind: 'npc', handle: 'x', name: 'X', opinion: { p1: 4 } }, z = player('p1', 'zayd', 'Gryffindor');
  castle.relInteract(s, npc, z, 2, 'replied to Zayd');
  assert.strictEqual(npc.opinion.p1, 6);
  assert.strictEqual(castle.relView(s, npc, 'p1').score, 6);
  assert.deepStrictEqual(castle.relView(s, npc, 'p1').memory, ['replied to Zayd']);
});

t('duel records and head-to-head update both sides', () => {
  const a = player('a', 'zayd', 'Gryffindor'), b = player('b', 'momo', 'Slytherin');
  castle.ensureStats(a); castle.ensureStats(b);
  castle.recordDuel(a, b, 'b'); castle.recordDuel(a, b, 'b'); castle.recordDuel(a, b, 'a'); castle.recordDuel(a, b, null);
  assert.deepStrictEqual(a.h2h.b, { w: 1, l: 2, d: 1 });
  assert.deepStrictEqual(b.h2h.a, { w: 2, l: 1, d: 1 });
  assert.strictEqual(a.stats.duelsLost, 2);
});

t('reputation tags derive from history (viral twice, lost duels, roasting a house, flop streak)', () => {
  const s = mkState(), now = Date.now();
  const a = player('a', 'zayd', 'Gryffindor'), b = player('b', 'momo', 'Slytherin');
  castle.ensureStats(a); castle.ensureStats(b);
  castle.recordVerdict(a, 'viral', now - 1000); castle.recordVerdict(a, 'viral', now - 500);
  castle.recordDuel(a, b, 'b'); castle.recordDuel(a, b, 'b');
  for (let i = 0; i < 3; i++) castle.recordVerdict(a, 'flop', now);
  s.posts = [
    { id: '1', authorId: 'a', text: 'slytherin is trash honestly', parentId: null },
    { id: '2', authorId: 'a', text: 'slytherin are such losers', parentId: null }
  ];
  const tags = castle.reputationTags(a, [a, b], s.posts, now);
  assert.ok(tags.includes('went viral 2 times today'), tags.join('|'));
  assert.ok(tags.includes('lost 2 duels to @momo'));
  assert.ok(tags.includes('known for roasting Slytherin'));
  assert.ok(tags.includes('on a flop streak'));
});

t('dossier carries the last 5 posts, rivalry record and stays small', () => {
  const s = mkState();
  const a = player('a', 'zayd', 'Gryffindor'), b = player('b', 'momo', 'Slytherin');
  castle.ensureStats(a); castle.ensureStats(b);
  castle.recordDuel(a, b, 'a');
  for (let i = 0; i < 8; i++) s.posts.push({ id: 'p' + i, authorId: 'a', text: 'post number ' + i, parentId: null });
  const d = castle.dossier(s, a, [a, b]);
  assert.strictEqual(d.last_posts.length, 5);
  assert.strictEqual(d.last_posts[4], 'post number 7');
  assert.deepStrictEqual(d.rivalry, [{ vs: '@momo', record: '1W-0L-0D', status: 'leads' }]);
  assert.ok(castle.approxTokens(JSON.stringify(d)) < 250);
});

t('mention sentiment lexicon', () => {
  assert.strictEqual(castle.sentiment('this is trash, ratio'), -1);
  assert.strictEqual(castle.sentiment('absolute legend, love this'), 1);
  assert.strictEqual(castle.sentiment('see you in class'), 0);
});

t('everything survives a JSON round trip (persistence) and old states migrate via ensureCastle', () => {
  const s = mkState();
  const a = player('a', 'zayd', 'Gryffindor'), c = { id: 'c1', kind: 'char', handle: 'h', name: 'Harry' };
  castle.recordVerdict(a, 'viral'); castle.relInteract(s, c, a, 2, 'cheered Zayd on'); castle.pushNews(s, 'Zayd went viral', 4, 'viral');
  const back = JSON.parse(JSON.stringify({ s, a }));
  assert.strictEqual(castle.relView(back.s, c, 'a').score, 2);
  assert.deepStrictEqual(castle.relView(back.s, c, 'a').memory, ['cheered Zayd on']);
  assert.strictEqual(castle.digest(back.s).length, 1);
  assert.strictEqual(back.a.stats.viral, 1);
  const old = { users: {}, posts: [] };
  castle.ensureCastle(old);
  assert.deepStrictEqual([old.news, old.events, old.rel], [[], [], {}]);
});

console.log(`\n${passed} castle tests passed`);
