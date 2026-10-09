// Unit checks for bot<->bot relationships and storylines: node test/botrel.test.js
const assert = require('assert');
const B = require('../botrel');
const world = require('../world');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const chars = {}; for (const c of world.CHARACTERS) chars[c.handle] = { id: 'c_' + c.handle, kind: 'char', ...c };
const npc = (handle, house) => ({ id: 'n_' + handle, kind: 'npc', handle, house, name: handle });

t('canon feuds and friendships are seeded the right way round (and symmetric)', () => {
  const s = {};
  assert.ok(B.score(s, chars['d.malfoy'], chars['h.potter']) <= -7);
  assert.ok(B.score(s, chars['h.potter'], chars['d.malfoy']) <= -7);
  assert.ok(B.score(s, chars['fred.www'], chars['george.www']) >= 9);
  assert.ok(B.score(s, chars['a.filch'], chars['peeves']) <= -9);
  assert.ok(B.score(s, chars['hgranger'], chars['rita.skeeter']) <= -7);
  assert.ok(B.score(s, chars['h.potter'], chars['ronweasley']) >= 8);
  assert.ok(B.score(s, chars['d.malfoy'], chars['pansy.p']) >= 6);
});

t('Snape is cold to most students and warmer to Slytherins; Filch dislikes students', () => {
  const s = {};
  const gry = npc('a_student', 'Gryffindor'), rav = npc('b_student', 'Ravenclaw'), sly = npc('c_student', 'Slytherin');
  assert.ok(B.score(s, chars['prof.snape'], gry) <= -2 && B.score(s, chars['prof.snape'], rav) <= -2);
  assert.ok(B.score(s, chars['prof.snape'], sly) >= 0);
  assert.ok(B.score(s, chars['a.filch'], gry) <= -3);
});

t('NPCs are seeded from houses: same house friendly, Gryffindor vs Slytherin hostile, deterministic', () => {
  const s1 = {}, s2 = {};
  const a = npc('x', 'Gryffindor'), b = npc('y', 'Gryffindor'), c = npc('z', 'Slytherin');
  assert.ok(B.score(s1, a, b) >= 1);
  assert.ok(B.score(s1, a, c) <= -2);
  assert.strictEqual(B.score(s1, a, b), B.score(s2, a, b));
  for (const [x, y] of [[a, b], [a, c], [b, c]]) assert.ok(Math.abs(B.score({}, x, y)) <= 4);
});

t('interactions move the score within -10..10, remember the last 3 events, and persist in plain JSON', () => {
  const s = {};
  const d = chars['d.malfoy'], r = chars['ronweasley'];
  const start = B.score(s, d, r);
  B.interact(s, d, r, -1.5, 'dunked on ron');
  assert.strictEqual(B.score(s, r, d), Math.round((start - 1.5) * 10) / 10);
  for (let i = 0; i < 40; i++) B.interact(s, d, r, -1, 'beef ' + i);
  assert.strictEqual(B.score(s, d, r), -10);
  assert.strictEqual(B.getRel(s, d, r).mem.length, 3);
  const copy = JSON.parse(JSON.stringify(s));
  assert.strictEqual(B.score(copy, d, r), -10);
});

t('topPairs surfaces the strongest feelings and ignores players', () => {
  const s = {};
  const list = [chars['d.malfoy'], chars['h.potter'], chars['fred.www'], chars['george.www'], chars['luna.lovegood'], { id: 'p1', kind: 'player', handle: 'zayd', house: 'Gryffindor' }];
  const pairs = B.topPairs(s, list, 4);
  assert.strictEqual(pairs.length, 4);
  assert.ok(pairs.every((p, i) => i === 0 || Math.abs(p.score) <= Math.abs(pairs[i - 1].score)));
  assert.ok(pairs.some(p => p.a === '@fred.www' && p.b === '@george.www' && p.stance === 'close friends'));
  assert.ok(!JSON.stringify(pairs).includes('zayd'));
});

t('engagement odds rise with friendship and house, and vanish for enemies', () => {
  const s = {};
  const f = B.engageProb(s, chars['fred.www'], chars['george.www']), e = B.engageProb(s, chars['d.malfoy'], chars['h.potter']);
  assert.ok(f > 0.8 && e < 0.1, `${f} vs ${e}`);
  assert.strictEqual(B.engageProb(s, chars['hagrid'], chars['hagrid']), 0);
});

t('storylines: at most 3 active, advance, resolve, expire', () => {
  const s = {}, now = 1e9;
  const a = B.addStory(s, { title: 'Draco vs Ron: Quidditch final', bots: ['d', 'r'], summary: 'beef' }, now);
  B.addStory(s, { title: 'Filch vs Peeves', bots: ['f', 'p'] }, now); B.addStory(s, { title: 'Hermione vs Rita', bots: ['h', 'r2'] }, now);
  assert.strictEqual(B.addStory(s, { title: 'a fourth one', bots: ['x'] }, now), null);
  assert.strictEqual(B.addStory(s, { title: 'draco vs ron: quidditch final', bots: ['d'] }, now), null, 'no duplicates');
  assert.strictEqual(B.activeStories(s).length, 3);
  B.advanceStory(s, a.id, { beat: 'Ron challenged Draco' }, now + 1);
  assert.strictEqual(a.stage, 2); assert.strictEqual(a.beats.length, 2);
  B.advanceStory(s, a.id, { resolve: true, resolution: 'Draco backed down' }, now + 2);
  assert.strictEqual(a.status, 'resolved'); assert.strictEqual(B.activeStories(s).length, 2);
  assert.ok(B.addStory(s, { title: 'a fourth one', bots: ['x'] }, now + 3), 'a slot freed up');
  const b = B.activeStories(s)[0];
  for (let i = 0; i < 8 && b.status === 'active'; i++) B.advanceStory(s, b.id, { beat: 'beat ' + i }, now + 10 + i);
  assert.strictEqual(b.status, 'resolved', 'stories end on their own after enough stages');
  const c = B.activeStories(s)[0];
  const done = B.expireStories(s, now + 5 * 3600e3);
  assert.ok(done.length >= 1 && c.status === 'resolved' && c.resolution);
  assert.strictEqual(B.storyForBots(s, ['nobody']), null);
});

const SC = require('../botscenes');
const ctxFor = (stories = []) => {
  const all = Object.values(chars), ns = [npc('maisie_q', 'Gryffindor'), npc('tobias_r', 'Slytherin'), npc('elsie_l', 'Ravenclaw')];
  const byH = Object.fromEntries([...all, ...ns].map(u => [u.handle, u]));
  const pairs = []; const st = {};
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pairs.push({ a: all[i], b: all[j], score: B.score(st, all[i], all[j]) });
  pairs.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
  return { bot: h => byH[String(h).replace('@', '')], chars: all, npcs: ns, pairs, trend: { title: 'Quidditch Final' }, stories, recent: [{ id: 'post1', authorHandle: 'albus.d' }] };
};
t('mock scenes are valid multi-bot reply chains (2-6 messages, real handles, replies point backwards)', () => {
  const ctx = ctxFor();
  let multi = 0, total = 0;
  for (let i = 0; i < 80; i++) {
    const out = SC.buildMockScenes(ctx);
    assert.ok(out.scenes.length >= 1 && out.scenes.length <= 3);
    for (const sc of out.scenes) {
      total++;
      assert.ok(sc.messages.length >= (sc.under === 'new' ? 2 : 1) && sc.messages.length <= 6, 'length ' + sc.messages.length);
      sc.messages.forEach((m, k) => {
        assert.ok(ctx.bot(m.handle), 'unknown handle ' + m.handle);
        assert.ok(m.text.length > 3 && m.text.length <= 280);
        assert.ok(m.reply_to === null || m.reply_to === undefined || (m.reply_to >= 0 && m.reply_to < k), 'reply_to ' + m.reply_to + ' at ' + k);
        assert.ok(!/\{\w+\}/.test(m.text), 'unfilled template: ' + m.text);
      });
      if (new Set(sc.messages.map(m => m.handle)).size >= 2) multi++;
    }
  }
  assert.ok(multi / total > 0.95, 'scenes involve at least two different bots');
});

t('mock storylines: starts from a real feud, continues, and resolves after a few beats', () => {
  const ctx = ctxFor();
  let started = null;
  for (let i = 0; i < 60 && !started; i++) { const o = SC.buildMockScenes(ctx); if (o.new_storyline) started = o.new_storyline; }
  assert.ok(started && started.bots.length === 2 && /vs/.test(started.title), JSON.stringify(started));
  const [a, b] = started.bots.map(h => ctx.bot(h));
  assert.ok(B.score({}, a, b) <= -5, 'a feud, not a friendship');
  const story = { id: 's1', title: started.title, bots: started.bots.map(h => h.replace('@', '')), stage: 4 };
  let resolved = false, continued = false;
  for (let i = 0; i < 60; i++) {
    const o = SC.buildMockScenes(ctxFor([story]));
    const up = o.storyline_updates.find(u => u.id === 's1');
    if (up) { continued = true; if (up.resolve) { resolved = true; assert.ok(up.resolution); } }
  }
  assert.ok(continued && resolved);
  const full = [1, 2, 3].map(n => ({ id: 's' + n, title: 't' + n, bots: ['d.malfoy', 'h.potter'], stage: 1 }));
  for (let i = 0; i < 40; i++) assert.strictEqual(SC.buildMockScenes(ctxFor(full)).new_storyline, null, 'never more than 3 active');
});

t('stock scenes cover the double act, Filch vs Peeves, Hermione correcting, Luna derailing, staff deducting', () => {
  const seen = new Set(); const ctx = ctxFor();
  for (let i = 0; i < 300; i++) for (const sc of SC.buildMockScenes(ctx).scenes) {
    const hs = sc.messages.map(m => m.handle);
    if (hs.includes('@fred.www') && hs.includes('@george.www')) seen.add('double');
    if (hs.includes('@a.filch') && hs.includes('@peeves')) seen.add('filch');
    if (hs.includes('@hgranger') && sc.messages.some(m => /closes at 8/.test(m.text))) seen.add('correct');
    if (hs.includes('@luna.lovegood') && sc.messages.some(m => /nargles/.test(m.text))) seen.add('luna');
    if (sc.messages.some(m => m.points < 0)) seen.add('staff');
  }
  assert.deepStrictEqual([...seen].sort(), ['correct', 'double', 'filch', 'luna', 'staff']);
});

console.log(`\n${passed} bot relationship/storyline/scene tests passed`);
