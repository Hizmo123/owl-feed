// View-count model (X-style impressions). Pure helpers; the server owns the state and the ticking.
'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const VERDICT_MULT = { flop: 0.05, ratioed: 0.1, mid: 0.3, good: 1, controversial: 2 };
const FLOOR_PER_LIKE = 15;

// reach a post gets from its author's audience at multiplier 1 ("good")
const baseReach = u => Math.round((u.followers || 0) * 1.5 + 20);
// an account's typical post reach (a "mid" post)
const typicalReach = u => Math.round(baseReach(u) * 0.3);

// viral posts roll 3-5x once, when the verdict lands, and keep it
const pickVMult = (verdict, rnd = Math.random) => (verdict === 'viral' ? 3 + 2 * rnd() : VERDICT_MULT[verdict] ?? 0.3);
const verdictMult = p => p.vmult || (p.verdict === 'viral' ? 4 : VERDICT_MULT[p.verdict] ?? 0.3);

// a reply may pass its parent only when its author has 10x+ the parent author's followers
const isBigAuthor = (author, parentAuthor) => (author.followers || 0) >= 10 * Math.max(1, parentAuthor.followers || 0);

// 15-60% of the parent's views, weighted by how early the reply arrived (rank among siblings) and its likes
function replyShare(likes, rank) {
  const earliness = 1 / (1 + 0.35 * rank);
  const likeScore = likes / (likes + 20);
  const w = 0.6 * earliness + 0.4 * likeScore;
  return { w, share: 0.15 + 0.45 * w };
}

// engagement boost sits on top of reach, so it lifts views even when the likes floor is what's holding them up
const rootTarget = (p, author) => Math.max((p.likes || 0) * FLOOR_PER_LIKE, baseReach(author) * verdictMult(p)) + (p.boost || 0);

function replyTarget(p, parent, author, parentAuthor, rank) {
  const { w, share } = replyShare(p.likes || 0, rank);
  const floor = (p.likes || 0) * FLOOR_PER_LIKE, boost = p.boost || 0;
  const raw = (parent.views || 0) * share;
  if (isBigAuthor(author, parentAuthor)) return Math.max(raw, floor) + boost + 0.2 * typicalReach(author) * w; // small bonus; may pass the parent
  return Math.max(Math.min(raw + boost, parent.views || 0), floor);                                          // never exceeds the parent (the likes floor lifts the parent instead)
}

// how much one piece of engagement pushes the TARGET post's impressions
function engagementBoost(kind, actor, rnd = Math.random) {
  const f = (actor && actor.followers) || 0;
  switch (kind) {
    case 'reply': return Math.min(400, 20 + rnd() * 40 + f * 0.03);
    case 'quote': return Math.min(800, 40 + rnd() * 80 + f * 0.05);
    case 'repost': return Math.min(600, 30 + rnd() * 60 + f * 0.03);
    case 'like': return 8 + rnd() * 17;
    default: return 0;
  }
}

module.exports = { clamp, VERDICT_MULT, FLOOR_PER_LIKE, baseReach, typicalReach, pickVMult, verdictMult, isBigAuthor, replyShare, rootTarget, replyTarget, engagementBoost };
