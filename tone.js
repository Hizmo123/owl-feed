// Tone balance + reply targeting. Pure helpers:
//  - stance quotas per verdict (support | neutral | joke | critical | hostile) and who gets which stance (house loyalty, warmth, haters)
//  - server-side balancing of a model's batch, like weighting by stance
//  - `reacting_to` validation, so a reply written for some other post gets dropped
'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const STANCES = ['support', 'joke', 'neutral', 'critical', 'hostile'];
const RANK = { support: 0, joke: 1, neutral: 2, critical: 3, hostile: 4 };
const isNeg = s => s === 'critical' || s === 'hostile';
const isPos = s => s === 'support' || s === 'joke';

// target mix of one batch of replies, by how the post landed
const DIST = {
  viral:         { support: 0.40, joke: 0.25, neutral: 0.20, critical: 0.10, hostile: 0.05 }, // ~65% support/joke, <=15% critical/hostile
  good:          { support: 0.30, joke: 0.20, neutral: 0.25, critical: 0.20, hostile: 0.05 }, // ~50% support/joke, ~25% critical
  mid:           { support: 0.35, joke: 0.15, neutral: 0.20, critical: 0.25, hostile: 0.05 }, // ~35% support, ~35% neutral/joke, ~30% critical
  flop:          { support: 0.15, joke: 0.08, neutral: 0.12, critical: 0.55, hostile: 0.10 }, // mostly critical, but a supporter or pity reply
  controversial: { support: 0.35, joke: 0.10, neutral: 0.10, critical: 0.35, hostile: 0.10 }  // split camps
};
DIST.ratioed = DIST.flop;
const NEG_CAP = { viral: 0.15, good: 0.25, mid: 0.30, controversial: 0.55, flop: 0.85, ratioed: 0.85 };
const TOLERANCE = 0.12;
const dist = v => DIST[v] || DIST.mid;

// the quota as text for the prompt
const QUOTA_TEXT = 'Decide the verdict first, then mix the replies like this. viral: ~65% support/joke, at most ~15% critical/hostile. good: ~50% support/joke, ~25% critical. mid: ~35% support, ~35% neutral/joke, ~30% critical. flop or ratioed: mostly critical, but at least one supporter or pity reply. controversial: split camps, roughly 50/50. At most ONE pure insult (hostile) per batch.';

// how many replies of each stance, as a flat array (unbiased rounding, max one hostile, a flop always gets a supporter)
function allocate(verdict, n, rnd = Math.random) {
  const d = dist(verdict), counts = {}, frac = [];
  let used = 0;
  for (const s of STANCES) { const x = d[s] * n; counts[s] = Math.floor(x); used += counts[s]; frac.push([s, x - counts[s]]); }
  while (used < n) {
    const total = frac.reduce((a, [, f]) => a + f + 1e-4, 0);
    let r = rnd() * total;
    for (const [s, f] of frac) { r -= f + 1e-4; if (r <= 0) { counts[s]++; used++; break; } }
  }
  if (counts.hostile > 1) { counts.critical += counts.hostile - 1; counts.hostile = 1; }
  if ((verdict === 'flop' || verdict === 'ratioed') && n >= 2 && counts.support === 0) {
    if (counts.critical > 0) { counts.critical--; counts.support++; } else if (counts.neutral > 0) { counts.neutral--; counts.support++; } else if (counts.joke > 0) { counts.joke--; counts.support++; }
  }
  const out = [];
  for (const s of STANCES) for (let i = 0; i < counts[s]; i++) out.push(s);
  return out;
}

// ---------------------------------------------------------------- who leans which way
const STUDENT_HOUSES = ['Gryffindor', 'Slytherin', 'Ravenclaw', 'Hufflepuff'];
const rivals = (a, b) => (a === 'Gryffindor' && b === 'Slytherin') || (a === 'Slytherin' && b === 'Gryffindor');
const WARM = new Set(['luna.lovegood', 'nev.herbology', 'c.diggory', 'hagrid']);
const ROASTERS = new Set(['d.malfoy', 'pansy.p', 'peeves']);
const isWarm = b => WARM.has(b.handle) || /wholesome/i.test(b.seed || '') || (b.kind === 'npc' && b.house === 'Hufflepuff');
const isRoaster = b => ROASTERS.has(b.handle) || /professional hater/i.test(b.seed || '');
// hostile is only for established haters: roasters, or someone who already dislikes the author
const canHostile = (b, rel = 0) => !isWarm(b) && (isRoaster(b) || rel <= -4);
const canCritical = b => !isWarm(b) || false;

// >0 leans supportive, <0 leans critical
function leanScore(bot, author, rel = 0) {
  let s = 0;
  if (STUDENT_HOUSES.includes(author.house)) { if (bot.house === author.house) s += 2; else if (rivals(bot.house, author.house)) s -= 2; }
  if (isWarm(bot)) s += 3;
  if (isRoaster(bot)) s -= 2;
  s += clamp(rel, -6, 6) * 0.3;
  if (bot.house === 'Staff' || bot.house === 'Ministry') s = clamp(s, -1, 1); // staff stay fair
  return s;
}
function leanLabel(bot, author, rel = 0) {
  const parts = [];
  if (STUDENT_HOUSES.includes(author.house)) { if (bot.house === author.house) parts.push('backs their own house'); else if (rivals(bot.house, author.house)) parts.push('rival house, leans critical'); }
  if (isWarm(bot)) parts.push('warm, almost never hostile');
  else if (isRoaster(bot)) parts.push('can roast, but must engage with the actual joke');
  if (bot.house === 'Staff') parts.push('fair, in character');
  if (rel <= -4) parts.push('already dislikes them'); else if (rel >= 4) parts.push('already a fan');
  return parts.join('; ') || 'neutral';
}

// give stances to bots: the most supportive-leaning bots get the supportive stances, the most critical get the critical ones
function assign(stances, bots, author, relFn = () => 0, rnd = Math.random) {
  const pool = bots.slice();
  const take = pool.length < stances.length ? stances.slice().sort(() => rnd() - 0.5).slice(0, pool.length) : stances.slice();
  const ranked = pool.map(b => ({ b, lean: leanScore(b, author, relFn(b)) + rnd() * 0.01 })).sort((x, y) => y.lean - x.lean).map(x => x.b);
  const sorted = take.sort((a, b) => RANK[a] - RANK[b]);
  const out = ranked.slice(0, sorted.length).map((b, i) => ({ bot: b, stance: sorted[i] }));
  const rel = b => relFn(b);
  for (let i = 0; i < out.length; i++) {
    if (out[i].stance === 'hostile' && !canHostile(out[i].bot, rel(out[i].bot))) {
      const j = out.findIndex((o, k) => k !== i && o.stance === 'critical' && canHostile(o.bot, rel(o.bot)));
      if (j >= 0) { out[j].stance = 'hostile'; out[i].stance = 'critical'; } else out[i].stance = isWarm(out[i].bot) ? 'neutral' : 'critical';
    }
    if (out[i].stance === 'critical' && isWarm(out[i].bot)) {
      const j = out.findIndex((o, k) => k !== i && (o.stance === 'neutral' || o.stance === 'joke') && !isWarm(o.bot));
      if (j >= 0) { out[j].stance = 'critical'; out[i].stance = 'neutral'; } else out[i].stance = 'neutral';
    }
  }
  return out;
}

// ---------------------------------------------------------------- balancing a model's batch
function balance(replies, verdict) {
  const all = replies.map(r => ({ ...r, stance: STANCES.includes(r.stance) ? r.stance : 'neutral' }));
  const dropped = [];
  let seenHostile = false, kept = [];
  for (const r of all) { // at most one pure insult per batch
    if (r.stance === 'hostile') { if (seenHostile) { dropped.push({ r, why: 'second hostile' }); continue; } seenHostile = true; }
    kept.push(r);
  }
  // how many negative replies this batch may keep, fixed from the batch size (trimming must not shrink the allowance as it goes)
  const maxNeg = Math.floor(((NEG_CAP[verdict] ?? NEG_CAP.mid) + TOLERANCE) * kept.length);
  let neg = kept.filter(r => isNeg(r.stance)).length;
  while (neg > maxNeg) { // too hostile for how the post landed: drop hostile first, then the last critical, keep the supporters
    let idx = kept.findIndex(r => r.stance === 'hostile');
    if (idx < 0) { for (let i = kept.length - 1; i >= 0; i--) if (kept[i].stance === 'critical') { idx = i; break; } }
    if (idx < 0) break;
    dropped.push({ r: kept[idx], why: 'too negative for ' + verdict }); kept.splice(idx, 1); neg--;
  }
  return { replies: kept, dropped, needsSupporter: (verdict === 'flop' || verdict === 'ratioed') && !kept.some(r => r.stance === 'support') };
}
const LIKE_MULT = {
  viral: { support: 1.5, joke: 1.4, neutral: 1, critical: 0.6, hostile: 0.35 },
  good:  { support: 1.5, joke: 1.4, neutral: 1, critical: 0.6, hostile: 0.35 },
  flop:  { support: 0.6, joke: 0.8, neutral: 0.9, critical: 1.3, hostile: 1.6 }
};
LIKE_MULT.ratioed = LIKE_MULT.flop;
// supportive replies earn more likes on good/viral posts, hostile ones only on flops
function adjustLikes(replies, verdict) {
  const m = LIKE_MULT[verdict];
  if (!m) return replies;
  const out = replies.map(r => ({ ...r, likes: Math.max(0, Math.round((Number(r.likes) || 0) * m[r.stance])) }));
  const avg = list => list.length ? list.reduce((a, r) => a + r.likes, 0) / list.length : 0;
  const pos = out.filter(r => isPos(r.stance)), neg = out.filter(r => isNeg(r.stance));
  if (verdict === 'viral' || verdict === 'good') { const cap = Math.floor(avg(pos) * 0.6); if (pos.length) for (const r of neg) r.likes = Math.min(r.likes, cap); }
  else if (neg.length) { const cap = Math.floor(avg(neg) * 0.8); for (const r of pos) r.likes = Math.min(r.likes, cap); }
  return out;
}

// ---------------------------------------------------------------- reacting_to validation
const STOP = new Set('the and for that this with you your are was were has have had not but they them their what when where who why how can will just from its our out about all any one too very been into than then there here would could should also like get got say said yes post'.split(' '));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w));
function fuzzyIn(phrase, text) {
  const p = norm(phrase), t = norm(text);
  if (!p) return false;
  if (t.includes(p)) return true;
  const pt = toks(phrase), tt = toks(text);
  if (!pt.length) return false;
  const set = new Set(tt);
  let hit = 0;
  for (const w of pt) if (set.has(w) || tt.some(x => x.length >= 5 && w.length >= 5 && x.slice(0, 4) === w.slice(0, 4))) hit++;
  return hit >= Math.max(1, Math.ceil(pt.length * 0.6));
}
function checkReacting(reacting, targetTexts, backgroundTexts = []) {
  const r = String(reacting || '').trim();
  if (!r) return 'missing';
  if (/^callback\s*:/i.test(r)) {
    const what = r.replace(/^callback\s*:/i, '').trim();
    return what && backgroundTexts.some(b => fuzzyIn(what, b)) ? 'callback' : 'bad';
  }
  return targetTexts.some(t => fuzzyIn(r, t)) ? 'ok' : 'bad';
}
// drop replies written for some other post. If the model ignored the field entirely we cannot tell, so those are kept.
function filterReplies(replies, targetTexts, backgroundTexts = []) {
  const arr = Array.isArray(replies) ? replies : [];
  const noneHave = arr.length > 0 && arr.every(r => !r || !String(r.reacting_to || '').trim());
  const kept = [], dropped = [];
  for (const r of arr) {
    const v = r ? checkReacting(r.reacting_to, targetTexts, backgroundTexts) : 'bad';
    if (v === 'ok' || v === 'callback' || (v === 'missing' && noneHave)) kept.push(r); else dropped.push({ r, why: v });
  }
  return { kept, dropped, unchecked: noneHave };
}
// a short quote from a post (what a reply is reacting to)
function phraseOf(text, rnd = Math.random) {
  const w = String(text || '').replace(/[#@]\S+/g, ' ').split(/\s+/).filter(x => x.length > 2);
  if (!w.length) return String(text || '').slice(0, 20);
  const len = Math.min(3, w.length), start = Math.floor(rnd() * Math.max(1, w.length - len + 1));
  return w.slice(start, start + len).join(' ').replace(/[.,!?]+$/, '');
}
// numbered feed items [1]..[N]: map a model's number back to an id, or null when out of range
const fromNumber = (n, ids) => (Number.isInteger(n) && n >= 1 && n <= ids.length ? ids[n - 1] : null);

module.exports = { STANCES, DIST, NEG_CAP, QUOTA_TEXT, allocate, assign, balance, adjustLikes, leanScore, leanLabel, isWarm, isRoaster, canHostile, canCritical, fuzzyIn, checkReacting, filterReplies, phraseOf, fromNumber, isNeg, isPos };
