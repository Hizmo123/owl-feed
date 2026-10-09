// Castle memory: shared world awareness injected into every AI call.
// Pure helpers over the persisted `state` object (news digest, player dossiers, bot->player relationships).
'use strict';
const crypto = require('crypto');

const NEWS_MAX = 60;
const approxTokens = s => Math.ceil(String(s).length / 4);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const NEG = /\b(trash|garbage|mid|lame|flop|flopped|loser|losers|cringe|overrated|pathetic|worst|ugly|stupid|dumb|joke|embarrassing|embarrassed|ratio|ratioed|hate|hates|awful|terrible|clown|cope|sad|boring|useless|bad)\b/i;
const POS = /\b(love|loves|legend|goat|iconic|funniest|best|genius|queen|king|W|respect|proud|brilliant|amazing|hilarious|slay|obsessed|stan|inspired|fan|great|congrats|beautiful|win|winner)\b/i;
function sentiment(text) {
  const t = String(text || '');
  const n = NEG.test(t), p = POS.test(t);
  return n && !p ? -1 : p && !n ? 1 : 0;
}

function ensureCastle(state) {
  if (!Array.isArray(state.news)) state.news = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.rel || typeof state.rel !== 'object') state.rel = {};
  return state;
}

// ---------------------------------------------------------------- news digest
// importance 1-5; score fades by one point every 4 hours
const newsScore = (n, now) => n.importance - (now - n.ts) / (4 * 3600e3);

function pushNews(state, text, importance = 2, type = 'event', ts = Date.now()) {
  ensureCastle(state);
  text = String(text).replace(/\s+/g, ' ').slice(0, 170);
  const dup = state.news.find(n => n.text === text && ts - n.ts < 10 * 60e3);
  if (dup) { dup.ts = ts; return dup; }
  const item = { id: crypto.randomBytes(4).toString('hex'), ts, text, importance: clamp(Math.round(importance), 1, 5), type };
  state.news.push(item);
  if (state.news.length > NEWS_MAX) {
    state.news = state.news.filter(n => n.importance >= 5 || newsScore(n, ts) > 0);
    if (state.news.length > NEWS_MAX) state.news = state.news.sort((a, b) => newsScore(b, ts) - newsScore(a, ts)).slice(0, NEWS_MAX).sort((a, b) => a.ts - b.ts);
  }
  return item;
}

function ageLabel(ms) {
  const m = Math.round(ms / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

// the 8-12 most important recent items, newest first
function digest(state, now = Date.now(), n = 10) {
  ensureCastle(state);
  return state.news
    .filter(i => newsScore(i, now) > 0)
    .sort((a, b) => newsScore(b, now) - newsScore(a, now))
    .slice(0, clamp(n, 1, 12))
    .sort((a, b) => b.ts - a.ts)
    .map(i => `${i.text} (${ageLabel(now - i.ts)})`);
}

// ---------------------------------------------------------------- relationships (bot -> player)
function relGet(state, botId, playerId) {
  ensureCastle(state);
  const byBot = (state.rel[botId] = state.rel[botId] || {});
  return (byBot[playerId] = byBot[playerId] || { score: 0, mem: [] });
}

// NPCs keep their existing opinion scores as the source of truth; characters use rel.score
function relScore(state, bot, playerId) {
  if (bot.kind === 'npc') return (bot.opinion && bot.opinion[playerId]) || 0;
  const byBot = state.rel && state.rel[bot.id];
  return (byBot && byBot[playerId] && byBot[playerId].score) || 0;
}

function relInteract(state, bot, player, delta, memory, ts = Date.now()) {
  const r = relGet(state, bot.id, player.id);
  delta = clamp(Math.round(Number(delta) || 0), -3, 3);
  if (bot.kind === 'npc') {
    bot.opinion = bot.opinion || {};
    const cur = bot.opinion[player.id] || 0;
    // students don't snowball into hating a player: a bad post costs at most 1, and recovering is faster than losing
    if (delta < 0) delta = Math.max(delta, -1);
    else if (delta > 0 && cur < 0) delta = Math.ceil(delta * 1.5);
    bot.opinion[player.id] = clamp(cur + delta, -10, 10);
    r.score = bot.opinion[player.id];
  } else {
    r.score = clamp(r.score + delta, -10, 10);
  }
  if (memory) {
    r.mem.push({ ts, text: String(memory).replace(/\s+/g, ' ').slice(0, 110) });
    if (r.mem.length > 3) r.mem = r.mem.slice(-3);
  }
  return r;
}

function relView(state, bot, playerId) {
  const byBot = state.rel && state.rel[bot.id];
  const r = byBot && byBot[playerId];
  const score = relScore(state, bot, playerId);
  const memory = r ? r.mem.map(m => m.text) : [];
  return { score, memory };
}

// ---------------------------------------------------------------- player history -> dossier
function ensureStats(u) {
  if (u.kind !== 'player') return u;
  u.stats = Object.assign({ posts: 0, viral: 0, flops: 0, ratioed: 0, controversial: 0, duelsWon: 0, duelsLost: 0, duelsDrawn: 0, viralLog: [], verdicts: [] }, u.stats || {});
  if (!u.h2h) u.h2h = {};
  return u;
}

function recordVerdict(u, verdict, ts = Date.now()) {
  ensureStats(u);
  const s = u.stats;
  s.posts++;
  if (verdict === 'viral') { s.viral++; s.viralLog.push(ts); if (s.viralLog.length > 20) s.viralLog = s.viralLog.slice(-20); }
  if (verdict === 'flop') s.flops++;
  if (verdict === 'ratioed') s.ratioed++;
  if (verdict === 'controversial') s.controversial++;
  s.verdicts.push(verdict);
  if (s.verdicts.length > 12) s.verdicts = s.verdicts.slice(-12);
}

// winner/loser are player users; draw=true records a draw for both
function recordDuel(a, b, winnerId) {
  ensureStats(a); ensureStats(b);
  const rec = (x, y) => (x.h2h[y.id] = x.h2h[y.id] || { w: 0, l: 0, d: 0 });
  if (!winnerId) { rec(a, b).d++; rec(b, a).d++; a.stats.duelsDrawn++; b.stats.duelsDrawn++; return; }
  const win = winnerId === a.id ? a : b, lose = win === a ? b : a;
  rec(win, lose).w++; rec(lose, win).l++;
  win.stats.duelsWon++; lose.stats.duelsLost++;
}

const HOUSES = ['Gryffindor', 'Slytherin', 'Ravenclaw', 'Hufflepuff'];
function reputationTags(u, players, posts, now = Date.now()) {
  ensureStats(u);
  const tags = [];
  const s = u.stats;
  const viralToday = s.viralLog.filter(t => now - t < 24 * 3600e3).length;
  if (viralToday >= 2) tags.push(`went viral ${viralToday} times today`);
  else if (viralToday === 1 && now - s.viralLog[s.viralLog.length - 1] < 3 * 3600e3) tags.push('just went viral');
  for (const o of players) {
    if (o.id === u.id) continue;
    const h = u.h2h[o.id];
    if (h && h.l >= 2) tags.push(`lost ${h.l} duels to @${o.handle}`);
    else if (h && h.w >= 2) tags.push(`beating @${o.handle} in duels`);
  }
  const last = s.verdicts.slice(-6);
  if (last.filter(v => v === 'flop' || v === 'ratioed').length >= 3) tags.push('on a flop streak');
  if (s.controversial >= 2) tags.push('keeps stirring controversy');
  const own = posts.filter(p => p.authorId === u.id).slice(-15);
  for (const h of HOUSES) {
    if (h === u.house) continue;
    const hits = own.filter(p => new RegExp(h, 'i').test(p.text));
    if (hits.length >= 2) tags.push(hits.filter(p => NEG.test(p.text)).length >= 2 ? `known for roasting ${h}` : `keeps posting about ${h}`);
  }
  return tags.slice(0, 5);
}

function dossier(state, u, players, now = Date.now(), lastN = 5) {
  ensureStats(u);
  const own = state.posts.filter(p => p.authorId === u.id && !p.parentId);
  const rivals = players.filter(o => o.id !== u.id).map(o => {
    const h = u.h2h[o.id] || { w: 0, l: 0, d: 0 };
    return { vs: '@' + o.handle, record: `${h.w}W-${h.l}L-${h.d}D`, status: h.w > h.l ? 'leads' : h.w < h.l ? 'trails' : 'level' };
  });
  return {
    handle: '@' + u.handle, house: u.house, followers: u.followers, hype: u.hype,
    reputation: reputationTags(u, players, state.posts, now),
    last_posts: own.slice(-lastN).map(p => p.text.slice(0, 90)),
    rivalry: rivals.length ? rivals : undefined
  };
}

module.exports = { approxTokens, sentiment, ensureCastle, pushNews, digest, relGet, relScore, relInteract, relView, ensureStats, recordVerdict, recordDuel, reputationTags, dossier, clamp, HOUSES };
