// Bot <-> bot relationships (seeded from canon personalities and houses, updated by interactions) and active storylines.
'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = v => Math.round(v * 10) / 10;
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const HOUSES4 = ['Gryffindor', 'Slytherin', 'Ravenclaw', 'Hufflepuff'];
// [a, b, score]: canon feuds and friendships (symmetric)
const CANON = [
  ['d.malfoy', 'h.potter', -8], ['d.malfoy', 'ronweasley', -7], ['d.malfoy', 'hgranger', -6], ['d.malfoy', 'nev.herbology', -4], ['d.malfoy', 'ginny.w', -5], ['d.malfoy', 'fred.www', -5], ['d.malfoy', 'george.www', -5],
  ['d.malfoy', 'luna.lovegood', -2], ['d.malfoy', 'hagrid', -6], ['d.malfoy', 'pansy.p', 7], ['d.malfoy', 'c.diggory', -2], ['d.malfoy', 'prof.snape', 4],
  ['fred.www', 'george.www', 10], ['fred.www', 'ronweasley', 5], ['george.www', 'ronweasley', 5], ['ginny.w', 'fred.www', 6], ['ginny.w', 'george.www', 6], ['ginny.w', 'ronweasley', 4],
  ['fred.www', 'a.filch', -8], ['george.www', 'a.filch', -8], ['fred.www', 'd.umbridge', -9], ['george.www', 'd.umbridge', -9], ['fred.www', 'm.mcgonagall', -2], ['george.www', 'm.mcgonagall', -2], ['fred.www', 'peeves', 4], ['george.www', 'peeves', 4],
  ['h.potter', 'ronweasley', 9], ['h.potter', 'hgranger', 9], ['h.potter', 'prof.snape', -7], ['h.potter', 'd.umbridge', -8], ['h.potter', 'albus.d', 8], ['h.potter', 'hagrid', 8], ['h.potter', 'cho.c', 4],
  ['h.potter', 'g.lockhart', -2], ['h.potter', 'ginny.w', 6], ['h.potter', 'nev.herbology', 5], ['h.potter', 'luna.lovegood', 4], ['h.potter', 'rita.skeeter', -4],
  ['ronweasley', 'hgranger', 5], ['ronweasley', 'nev.herbology', 3], ['ronweasley', 'pansy.p', -4], ['ronweasley', 'prof.snape', -6], ['ronweasley', 'luna.lovegood', 1],
  ['hgranger', 'rita.skeeter', -8], ['hgranger', 'prof.snape', -3], ['hgranger', 'pansy.p', -5], ['hgranger', 'g.lockhart', -3], ['hgranger', 'd.umbridge', -8], ['hgranger', 'luna.lovegood', 3], ['hgranger', 'nev.herbology', 4], ['hgranger', 'm.mcgonagall', 5],
  ['prof.snape', 'nev.herbology', -6], ['prof.snape', 'albus.d', 2], ['prof.snape', 'm.mcgonagall', -1], ['prof.snape', 'a.filch', 1], ['prof.snape', 'g.lockhart', -5], ['prof.snape', 'pansy.p', 2],
  ['a.filch', 'peeves', -10], ['a.filch', 'd.umbridge', 3], ['a.filch', 'hagrid', -3], ['a.filch', 'myrtle', -2],
  ['peeves', 'myrtle', -3], ['peeves', 'g.lockhart', -4], ['peeves', 'd.umbridge', -5],
  ['rita.skeeter', 'd.umbridge', 2], ['rita.skeeter', 'g.lockhart', 1], ['rita.skeeter', 'albus.d', -2], ['rita.skeeter', 'luna.lovegood', -2],
  ['m.mcgonagall', 'd.umbridge', -8], ['m.mcgonagall', 'albus.d', 6], ['m.mcgonagall', 'g.lockhart', -3], ['m.mcgonagall', 'hagrid', 3],
  ['luna.lovegood', 'nev.herbology', 3], ['luna.lovegood', 'cho.c', 2], ['albus.d', 'd.umbridge', -5], ['albus.d', 'g.lockhart', -1], ['c.diggory', 'cho.c', 5],
  ['pansy.p', 'luna.lovegood', -3], ['hagrid', 'd.umbridge', -8], ['hagrid', 'g.lockhart', -2]
];
const pairHandles = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const CANON_MAP = new Map(CANON.map(([a, b, s]) => [pairHandles(a, b), s]));
const pairKey = (a, b) => (a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id);

// where a pair starts: canon table first, then house rules, then a little deterministic jitter so NPCs aren't clones
function seedScore(a, b) {
  const canon = CANON_MAP.get(pairHandles(a.handle, b.handle));
  if (canon !== undefined) return canon;
  const isStudent = u => HOUSES4.includes(u.house);
  let s = 0;
  const snape = a.handle === 'prof.snape' ? b : b.handle === 'prof.snape' ? a : null;
  const filch = a.handle === 'a.filch' ? b : b.handle === 'a.filch' ? a : null;
  const peeves = a.handle === 'peeves' || b.handle === 'peeves';
  if (snape) s = snape.house === 'Slytherin' ? 1 : isStudent(snape) ? -3 : 0;
  else if (filch) s = isStudent(filch) ? -4 : 0;
  else if (peeves) s = -1;
  else if (a.house === b.house && isStudent(a)) s = 2;
  else if ((a.house === 'Gryffindor' && b.house === 'Slytherin') || (a.house === 'Slytherin' && b.house === 'Gryffindor')) s = -3;
  else if (a.house === 'Staff' && isStudent(b) || b.house === 'Staff' && isStudent(a)) s = 0;
  s += (hash(pairHandles(a.handle, b.handle)) % 3) - 1;
  return clamp(s, -10, 10);
}

function getRel(state, a, b) {
  state.botRel = state.botRel || {};
  const k = pairKey(a, b);
  return state.botRel[k] || (state.botRel[k] = { score: seedScore(a, b), mem: [] });
}
// reads never persist: only pairs that actually interact are stored, untouched pairs are re-derived from the seed
const peek = (state, a, b) => (state.botRel && state.botRel[pairKey(a, b)]) || { score: seedScore(a, b), mem: [] };
const score = (state, a, b) => peek(state, a, b).score;
function interact(state, a, b, delta, memory, ts = Date.now()) {
  const r = getRel(state, a, b);
  r.score = clamp(round1(r.score + delta), -10, 10);
  if (memory) { r.mem.push({ ts, text: String(memory).slice(0, 100) }); if (r.mem.length > 3) r.mem = r.mem.slice(-3); }
  return r;
}
const stance = s => (s <= -6 ? 'feud' : s <= -3 ? 'rivals' : s >= 6 ? 'close friends' : s >= 3 ? 'friendly' : 'neutral');

// the pairs among `users` with the strongest feelings, for prompts ("keep this feud going")
function topPairs(state, users, n = 6) {
  const out = [];
  for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) {
    const a = users[i], b = users[j];
    if (a.id === b.id || a.kind === 'player' || b.kind === 'player') continue;
    const r = peek(state, a, b);
    if (Math.abs(r.score) >= 2) out.push({ a: '@' + a.handle, b: '@' + b.handle, score: r.score, stance: stance(r.score), memory: r.mem.length ? r.mem[r.mem.length - 1].text : undefined });
  }
  return out.sort((x, y) => Math.abs(y.score) - Math.abs(x.score)).slice(0, n);
}

// chance that `other` likes/reposts a post by `author` (relationship and house weighted). Dunkers don't like.
function engageProb(state, author, other, base = 0.3) {
  if (author.id === other.id) return 0;
  const s = score(state, author, other);
  return clamp(base + s * 0.06 + (author.house === other.house ? 0.08 : 0), 0, 0.9);
}

// ---------------------------------------------------------------- storylines
const MAX_ACTIVE = 3, MAX_STAGE = 6, MAX_AGE = 3 * 3600e3;
function activeStories(state) { return (state.stories || []).filter(s => s.status === 'active'); }
function addStory(state, { title, bots, summary }, now = Date.now()) {
  state.stories = state.stories || [];
  if (activeStories(state).length >= MAX_ACTIVE || !title || !bots || bots.length < 1) return null;
  const clash = activeStories(state).find(s => s.title.toLowerCase() === String(title).toLowerCase());
  if (clash) return null;
  const s = { id: Math.random().toString(16).slice(2, 10), title: String(title).slice(0, 80), bots: bots.slice(0, 4), summary: String(summary || title).slice(0, 160), stage: 1, beats: [String(summary || title).slice(0, 120)], started: now, lastTick: now, ticks: 0, status: 'active' };
  state.stories.push(s);
  if (state.stories.length > 30) state.stories = state.stories.filter(x => x.status === 'active').concat(state.stories.filter(x => x.status !== 'active').slice(-10));
  return s;
}
function advanceStory(state, id, { beat, resolve, resolution } = {}, now = Date.now()) {
  const s = (state.stories || []).find(x => x.id === id && x.status === 'active');
  if (!s) return null;
  s.ticks++; s.lastTick = now; s.stage++;
  if (beat) { s.beats.push(String(beat).slice(0, 120)); if (s.beats.length > 6) s.beats = s.beats.slice(-6); }
  if (resolve || s.stage > MAX_STAGE) { s.status = 'resolved'; s.resolvedAt = now; s.resolution = String(resolution || 'The drama quietly fizzled out.').slice(0, 140); }
  return s;
}
// stories nobody has touched for a long time end on their own
function expireStories(state, now = Date.now()) {
  const done = [];
  for (const s of activeStories(state)) if (now - s.started > MAX_AGE * 2 || now - s.lastTick > MAX_AGE) { s.status = 'resolved'; s.resolvedAt = now; s.resolution = 'The castle moved on.'; done.push(s); }
  return done;
}
const storyForBots = (state, ids) => activeStories(state).find(s => s.bots.some(b => ids.includes(b))) || null;

module.exports = { CANON, seedScore, getRel, peek, score, interact, stance, topPairs, engageProb, pairKey, activeStories, addStory, advanceStory, expireStories, storyForBots, MAX_ACTIVE, MAX_STAGE };
