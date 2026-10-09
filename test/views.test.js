// Unit checks for the view-count model: node test/views.test.js
const assert = require('assert');
const V = require('../views');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const user = f => ({ followers: f });

t('a reply gets 15-60% of the parent views for any rank and like count', () => {
  for (const rank of [0, 1, 3, 10, 40]) for (const likes of [0, 5, 50, 5000]) {
    const { share } = V.replyShare(likes, rank);
    assert.ok(share >= 0.15 && share <= 0.6, `share ${share} (rank ${rank}, likes ${likes})`);
  }
});

t('earlier replies and better-liked replies get a bigger share', () => {
  assert.ok(V.replyShare(10, 0).share > V.replyShare(10, 8).share);
  assert.ok(V.replyShare(200, 3).share > V.replyShare(0, 3).share);
});

t('a normal reply never exceeds its parent views', () => {
  const parent = { views: 1000 }, a = user(300), pa = user(400);
  for (let rank = 0; rank < 12; rank++) for (const boost of [0, 100, 5000, 1e6]) {
    const r = { likes: 3, boost };
    assert.ok(V.replyTarget(r, parent, a, pa, rank) <= 1000 || r.likes * 15 > 1000);
  }
  const share = V.replyTarget({ likes: 0, boost: 0 }, parent, a, pa, 0) / 1000;
  assert.ok(share >= 0.15 && share <= 0.6, 'share ' + share);
});

t('a 10x+ follower account may pass the parent, with a bonus of at most 20% of its typical reach', () => {
  const parent = { views: 200 }, pa = user(100), big = user(50000);
  assert.ok(V.isBigAuthor(big, pa) && !V.isBigAuthor(user(999), pa) && V.isBigAuthor(user(1000), pa));
  const r = { likes: 0, boost: 0 };
  const target = V.replyTarget(r, parent, big, pa, 0);
  const { share } = V.replyShare(0, 0);
  const bonus = target - parent.views * share;
  assert.ok(target > parent.views, 'passes the parent: ' + target);
  assert.ok(bonus > 0 && bonus <= 0.2 * V.typicalReach(big) + 1e-6, 'bonus ' + bonus);
});

t('root views = base reach x verdict multiplier (flop .05, mid .3, good 1, viral 3-5, controversial 2)', () => {
  const a = user(1000), base = V.baseReach(a);
  const at = verdict => V.rootTarget({ likes: 0, boost: 0, verdict }, a);
  assert.strictEqual(at('flop'), base * 0.05);
  assert.strictEqual(at('mid'), base * 0.3);
  assert.strictEqual(at('good'), base);
  assert.strictEqual(at('controversial'), base * 2);
  assert.ok(at('flop') < at('mid') && at('mid') < at('good') && at('good') < at('controversial') && at('controversial') < at('viral'));
  for (let i = 0; i < 200; i++) { const m = V.pickVMult('viral'); assert.ok(m >= 3 && m <= 5); }
  assert.strictEqual(V.rootTarget({ likes: 0, boost: 0, verdict: 'viral', vmult: 5 }, a), base * 5);
});

t('views are never below likes x 15, and engagement boost adds on top of the base', () => {
  const a = user(10);
  assert.strictEqual(V.rootTarget({ likes: 1000, boost: 0, verdict: 'flop' }, a), 15000);
  assert.ok(V.rootTarget({ likes: 0, boost: 500, verdict: 'mid' }, a) >= 500 + V.baseReach(a) * 0.3 - 1);
  const parent = { views: 100 };
  assert.ok(V.replyTarget({ likes: 100, boost: 0 }, parent, user(5), user(5), 0) >= 1500);
});

t('replies, quotes, reposts and likes all produce a positive engagement boost; quotes outweigh likes', () => {
  const actor = user(500);
  for (const k of ['reply', 'quote', 'repost', 'like']) assert.ok(V.engagementBoost(k, actor, () => 0.5) > 0, k);
  assert.ok(V.engagementBoost('quote', actor, () => 0.5) > V.engagementBoost('like', actor, () => 0.5));
  assert.strictEqual(V.engagementBoost('nonsense', actor), 0);
});

console.log(`\n${passed} view tests passed`);
