// Owl Feed — server. Owns all game state + scores, runs the bots via Gemini, pushes everything live over Socket.io.
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CHARACTERS, makeNPCs, TRENDS, SEED_POSTS, HOUSES, rand, pick } = require('./world');
const castle = require('./castle');
const V = require('./views');
const DM = require('./dmlogic');
const { createBudget } = require('./quota');
const { createAI } = require('./aiprov');
const { createQueue } = require('./aiqueue');
const { createStore, importFromDisk } = require('./store');
const BR = require('./botrel');
const BS = require('./botscenes');
const tone = require('./tone');

const PORT = process.env.PORT || 3000;
const FORCE_MOCK = process.env.MOCK_AI === '1' || process.argv.includes('--mock');
const GEMINI_KEY = FORCE_MOCK ? '' : (process.env.GEMINI_API_KEY || '').trim();
const GROQ_KEY = FORCE_MOCK ? '' : (process.env.GROQ_API_KEY || '').trim();
const MOCK = !GEMINI_KEY && !GROQ_KEY;   // no keys (or MOCK_AI=1): canned bot replies
const TICK_MS = +process.env.TICK_MS || 150000;      // ambient bot posts while someone is online
const MIN_GAP = +process.env.AI_MIN_GAP_MS || 2500; // minimum spacing between AI calls (providers also enforce their own RPM/daily budgets)
const SCENE_SCALE = process.env.SCENE_SCALE !== undefined ? +process.env.SCENE_SCALE : 1; // shrink bot-scene pacing in tests (real: 10-90s between messages)
const TREND_MS = 6 * 3600 * 1000;
const WAVE_SCALE = +process.env.WAVE_SCALE || 1;   // shrink hype-wave timing for tests (1 = real 1-5 min waves)
const PROMPT_BUDGET = 3000;                         // approx input tokens per AI call, system prompt included
// DM + rumour tuning (the *_SCALE / fixed-hour flags make timers fast and deterministic in tests)
const DM_TIME_SCALE = process.env.DM_TIME_SCALE !== undefined ? +process.env.DM_TIME_SCALE : 1;
const DM_DEBOUNCE_MS = +process.env.DM_DEBOUNCE_MS || 3000;   // several quick messages become one AI call
const DM_FIXED_HOUR = process.env.DM_FIXED_HOUR;               // pin the Sydney hour (tests)
const DM_FIRST_MAX = +process.env.DM_FIRST_MAX || 3;           // bot-initiated DMs per player per hour
const DM_FIRST_CHANCE = process.env.DM_FIRST_CHANCE !== undefined ? +process.env.DM_FIRST_CHANCE : null; // override opener odds (tests)
const AI_PER_MIN = +process.env.AI_PER_MIN || 12;              // AI call budget per rolling minute
const BUDGET_ON = !!process.env.AI_PER_MIN;                     // optional extra global cap; the per-provider budgets are the real limits
const MAX_UPLOAD = 2 * 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();   // set = state + uploaded images live in MongoDB (Render free tier has no disk)
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();   // set = sign-up requires it
const store = createStore({ uri: MONGODB_URI, dir: DATA_DIR, dbName: process.env.MONGODB_DB, log: m => console.log(m) });
let ready = false; // false while the server is still waking up (connecting to storage, loading state)

const PROVIDER_CFG = [
  { type: 'gemini', key: GEMINI_KEY, model: process.env.GEMINI_MODEL || 'gemini-flash-latest', fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest', baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta', rpm: +process.env.GEMINI_RPM || 10, rpd: +process.env.GEMINI_RPD || 250 },
  { type: 'groq', key: GROQ_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', rpm: +process.env.GROQ_RPM || 25, rpd: +process.env.GROQ_RPD || 900 }
];
if (MOCK) console.warn(FORCE_MOCK ? '[owl] MOCK_AI=1: bots use canned replies' : '[owl] No GEMINI_API_KEY or GROQ_API_KEY set: running with canned mock replies');
else console.log('[owl] AI providers: ' + [GEMINI_KEY && 'Gemini', GROQ_KEY && 'Groq'].filter(Boolean).join(' -> ') + ' -> mock');

// ---------------------------------------------------------------- utils
const uid = () => crypto.randomBytes(6).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampInt = (v, lo, hi) => { v = Math.round(Number(v) || 0); return Math.max(lo, Math.min(hi, v)); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanHandle = h => String(h || '').trim().replace(/^@/, '').toLowerCase();

// ---------------------------------------------------------------- state
// timers can fire while storage is still loading; they see an empty world until boot swaps in the real state
function placeholderState() { return { users: {}, posts: [], notifs: {}, trend: null, trendIdx: 0, news: [], events: [], rel: {}, dms: {}, dmQueue: [], dmFirst: {}, rumours: [], aiUsage: {}, botRel: {}, stories: [] }; }
let state = placeholderState();
const postIndex = new Map();
const handleIndex = new Map();

function freshState() {
  const s = { users: {}, posts: [], notifs: {}, trend: null, trendIdx: rand(0, TRENDS.length - 1), created: Date.now() };
  for (const c of CHARACTERS) {
    const id = 'c_' + c.handle.replace(/\W/g, '_');
    s.users[id] = { ...c, id, kind: 'char', hype: 50, housePoints: 0, galleons: 0, following: [] };
  }
  for (const n of makeNPCs(60)) s.users[n.id] = n;
  let t = Date.now() - SEED_POSTS.length * 9 * 60000;
  for (const sp of SEED_POSTS) {
    const u = Object.values(s.users).find(x => x.handle === sp.handle);
    if (!u) continue;
    const p = mkPost(u.id, sp.text, null, t);
    p.likes = p.targetLikes = Math.round(u.followers * (0.02 + Math.random() * 0.05));
    p.reposts = p.targetReposts = Math.round(p.likes * 0.08);
    p.views = p.targetViews = p.likes * rand(14, 26) + rand(30, 300);
    s.posts.push(p);
    t += 9 * 60000;
  }
  return s;
}

async function loadState() {
  let s = null;
  try { s = await store.load(); }
  catch (e) { console.error('[owl] state load failed:', e.message); if (store.kind === 'mongo') throw e; } // never start "fresh" over a database we could not read
  if (!s && store.kind === 'mongo') {
    const imp = await importFromDisk(store, DATA_DIR);
    if (imp) { console.log(`[owl] MongoDB was empty: imported data/state.json (${imp.users} users, ${imp.posts} posts, ${imp.uploads} uploaded images)`); s = await store.load(); }
  }
  if (s) { console.log(`[owl] loaded state from ${store.describe}: ${Object.keys(s.users).length} users, ${s.posts.length} posts`); return s; }
  console.log('[owl] no saved state found, starting a fresh castle');
  return freshState();
}

// add fields introduced after a save was written, so old state.json files keep working
function migrate(s) {
  for (const p of s.posts || []) {
    if (p.likedBy === undefined) p.likedBy = [];
    if (p.repostedBy === undefined) p.repostedBy = [];
    if (p.quoteId === undefined) p.quoteId = null;
    if (p.quoteCount === undefined) p.quoteCount = 0;
    if (p.views === undefined) { p.views = (p.likes || 0) * rand(14, 24) + rand(5, 120); p.targetViews = p.views; }
    if (p.targetViews === undefined) p.targetViews = p.views;
    if (p.eventId === undefined) p.eventId = null;
  }
  for (const u of Object.values(s.users || {})) {
    if (u.kind === 'player' && u.bookmarks === undefined) u.bookmarks = [];
    if (u.joined === undefined) u.joined = s.created || Date.now();
    if (u.kind === 'player') castle.ensureStats(u);
  }
  if (!s.notifs) s.notifs = {};
  castle.ensureCastle(s);
  for (const e of s.events) { e.waveState = 'idle'; e.upgrade = false; } // an interrupted wave is not resumed
  // DMs, queued bot messages, rumours and bot-opener rate limits
  if (!s.dms || typeof s.dms !== 'object') s.dms = {};
  if (!Array.isArray(s.dmQueue)) s.dmQueue = [];
  if (!Array.isArray(s.rumours)) s.rumours = [];
  if (!s.dmFirst || typeof s.dmFirst !== 'object') s.dmFirst = {};
  if (!s.aiUsage || typeof s.aiUsage !== 'object') s.aiUsage = {};   // per-provider daily counters
  if (!s.botRel || typeof s.botRel !== 'object') s.botRel = {};      // bot <-> bot relationship scores
  if (!Array.isArray(s.stories)) s.stories = [];                     // active/resolved bot storylines
  for (const c of Object.values(s.dms)) {
    if (!c.read) c.read = {};
    if (!Array.isArray(c.msgs)) c.msgs = [];
    if (c.sinceSummary === undefined) c.sinceSummary = 0;
    if (c.summary === undefined) c.summary = '';
  }
  return s;
}

const replyIdx = new Map(); // parentId -> [reply ids] in arrival order (a reply's rank drives its share of the parent's views)
function rebuildReplyIndex() {
  replyIdx.clear();
  for (const p of state.posts) if (p.parentId) { if (!replyIdx.has(p.parentId)) replyIdx.set(p.parentId, []); replyIdx.get(p.parentId).push(p.id); }
}
function reindex() {
  postIndex.clear(); handleIndex.clear();
  for (const p of state.posts) postIndex.set(p.id, p);
  for (const u of Object.values(state.users)) handleIndex.set(u.handle.toLowerCase(), u);
  rebuildReplyIndex();
}

// debounced save: ~3s on disk, ~5s on MongoDB (gentler on the free tier). One write at a time; shutdown flushes whatever is pending.
const SAVE_MS = store.kind === 'mongo' ? 5000 : 3000;
let saveTimer = null, saving = false, dirty = false;
function save() {
  if (!ready || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, SAVE_MS);
}
async function persist() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    if (state.posts.length > 3000) { state.posts = state.posts.slice(-3000); reindex(); }
    await store.save(JSON.stringify(state));
  } catch (e) { console.error('[owl] save failed', e.message); }
  saving = false;
  if (dirty) { dirty = false; save(); }
}
async function flush() { clearTimeout(saveTimer); saveTimer = null; while (saving) await sleep(50); await persist(); }

function mkPost(authorId, text, parentId, ts = Date.now()) {
  const parent = parentId ? postIndex.get(parentId) : null;
  return {
    id: uid(), authorId, text, ts, parentId: parentId || null, rootId: parent ? (parent.rootId || parent.id) : null,
    likes: 0, targetLikes: 0, reposts: 0, targetReposts: 0, likedBy: [], repostedBy: [], replyCount: 0, verdict: null,
    quoteId: null, quoteCount: 0, views: 0, targetViews: 0, boost: 0, vmult: null, eventId: null,
    mentions: extractMentions(text, authorId)
  };
}

// only real handles count; self-mentions ignored
function extractMentions(text, authorId) {
  const out = [];
  for (const m of String(text).matchAll(/(^|[^a-z0-9_.])@([a-z0-9_.]{2,20})/gi)) {
    const h = m[2].replace(/\.+$/, '');
    const u = handleIndex.get(h.toLowerCase());
    if (u && u.id !== authorId && !out.includes(u.id)) out.push(u.id);
  }
  return out;
}
// mentioned bots (characters first), capped at 5, forced into the AI reaction set
function forcedBots(post) {
  const bots = (post.mentions || []).map(id => U(id)).filter(u => u && u.kind !== 'player');
  bots.sort((a, b) => (b.kind === 'char') - (a.kind === 'char'));
  return bots.slice(0, 5);
}

const U = id => state.users[id];
const byHandle = h => handleIndex.get(cleanHandle(h));
const players = () => Object.values(state.users).filter(u => u.kind === 'player');
const chars = () => Object.values(state.users).filter(u => u.kind === 'char');
const npcs = () => Object.values(state.users).filter(u => u.kind === 'npc');

// public/avatars/<handle>.(png|jpg|jpeg|webp) overrides the generated avatar; a player's own upload wins over both
const AVATAR_DIR = path.join(__dirname, 'public', 'avatars');
let avatarFiles = new Map();
function scanAvatars() {
  const next = new Map();
  try {
    for (const f of fs.readdirSync(AVATAR_DIR)) {
      const m = f.match(/^(.+)\.(png|jpe?g|webp)$/i);
      if (m) next.set(m[1].toLowerCase(), '/avatars/' + f);
    }
  } catch (_) {}
  return next;
}
avatarFiles = scanAvatars();
function pubUser(u) {
  const { token, opinion, seed, voice, likes, hates, bookmarks, stats, h2h, mile, avatarUrl, bannerUrl, ...rest } = u;
  rest.avatarUrl = avatarUrl || avatarFiles.get(String(u.handle).toLowerCase()) || null;
  rest.bannerUrl = bannerUrl || null;
  return rest;
}
function pubPost(p) {
  const { targetLikes, targetReposts, targetViews, mentionSentiment, boost, vmult, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------- server + sockets
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
if (store.kind === 'mongo') { // uploaded avatars/banners come out of GridFS
  app.get('/uploads/:id', async (req, res) => {
    try {
      const f = await store.readUpload(req.params.id);
      if (!f) return res.status(404).send('Not found');
      res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=2592000, immutable' });
      res.send(f.buf);
    } catch (e) { res.status(500).send('Error'); }
  });
} else app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, fallthrough: false }));
app.get('/healthz', (_, res) => (ready ? res.send('ok') : res.status(503).send('waking')));
// provider health, cooldowns and today's usage: local only (requests through a tunnel/proxy carry forwarding headers and are refused)
const isLocalReq = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['forwarded'];
app.get('/status', (req, res) => {
  if (!isLocalReq(req)) return res.status(404).send('Not found');
  res.json({
    uptime_s: Math.round(process.uptime()), mock: MOCK, ai: aiLayer ? aiLayer.status() : null,
    queue: { waiting: aiq.length, by_kind: aiq.kinds(), calls_last_minute: budget.used() },
    world: { online: online.size, posts: state.posts.length, storylines: BR.activeStories(state).map(x => ({ title: x.title, stage: x.stage })), rumours: state.rumours.length, dms: Object.keys(state.dms).length }
  });
});
// client-side routes (/post/:id, /u/:handle, /messages/:id ...) all serve the app shell
app.get('*', (req, res, next) => {
  if (path.extname(req.path) || /^\/(socket\.io|uploads|avatars|icons|debug|status|healthz)\b/.test(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// local-only, mock-only test hook: runs the real mock reaction pipeline N times for a verdict and reports the stance mix
app.get('/debug/mock-reactions', (req, res) => {
  if (!isLocalReq(req) || !MOCK) return res.status(404).send('Not found');
  const verdict = VERDICTS.includes(req.query.verdict) ? req.query.verdict : 'mid';
  const n = clampInt(req.query.n || 50, 1, 500);
  const author = players()[0];
  if (!author) return res.status(400).json({ error: 'needs at least one player' });
  const SAMPLES = ['Omniculars are wildly overpriced and nobody can tell me otherwise', 'unpopular opinion: treacle tart beats every other dessert', 'the Great Hall ceiling is just a very expensive screensaver', 'Quidditch is basically rugby with worse insurance', 'I have never once finished a Potions essay on time', 'whoever keeps moving the staircases owes me an apology', 'Peeves is the only honest member of staff', 'the owlery smells like regret and bird'];
  const counts = {}; tone.STANCES.forEach(s => { counts[s] = 0; });
  let total = 0, supportive = 0, hostileBatches = 0, onTopic = 0;
  for (let i = 0; i < n; i++) {
    const post = { id: 'dbg' + i, authorId: author.id, text: SAMPLES[i % SAMPLES.length] };
    const r = mockPost(post, pickChars(5, post.text), pickNPCs(8, author.id), [], verdict);
    cleanReplies(r, { targets: [post.text], background: [], verdict, label: 'debug', silent: true });
    for (const x of r.replies) { counts[x.stance]++; total++; if (tone.fuzzyIn(x.reacting_to, post.text)) onTopic++; }
    if (r.replies.some(x => x.stance === 'support')) supportive++;
    if (r.replies.filter(x => x.stance === 'hostile').length > 1) hostileBatches++;
  }
  const pct = k => Math.round(1000 * counts[k] / Math.max(1, total)) / 10;
  res.json({ verdict, batches: n, replies: total, stance_percent: Object.fromEntries(tone.STANCES.map(k => [k, pct(k)])), support_or_joke: Math.round(1000 * (counts.support + counts.joke) / Math.max(1, total)) / 10, critical_or_hostile: Math.round(1000 * (counts.critical + counts.hostile) / Math.max(1, total)) / 10, batches_with_a_supporter: supportive, batches_with_more_than_one_insult: hostileBatches, replies_quoting_the_target: onTopic });
});
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000, maxHttpBufferSize: 3e6 });
io.use((sock, next) => (ready ? next() : next(new Error('waking')))); // still loading state: the client shows its "waking up" splash and retries

const online = new Map(); // playerId -> socket count
const onlineIds = () => [...online.keys()];
const activity = {};      // postId -> label (bots typing)

function addPost(p) {
  state.posts.push(p);
  postIndex.set(p.id, p);
  const author = U(p.authorId);
  const parent = p.parentId ? postIndex.get(p.parentId) : null;
  if (p.parentId) {
    if (!replyIdx.has(p.parentId)) replyIdx.set(p.parentId, []);
    replyIdx.get(p.parentId).push(p.id);
  }
  if (!p.views) p.views = parent ? Math.max(1, Math.round(parent.views * 0.08)) : Math.max(2, Math.round(V.baseReach(author) * 0.02));
  p.targetViews = Math.max(p.targetViews || 0, p.views);
  if (parent) { parent.replyCount++; engage(parent, 'reply', author); io.emit('post:update', slim(parent)); }
  if (p.quoteId) {
    const q = postIndex.get(p.quoteId);
    if (q) { q.quoteCount++; engage(q, 'quote', author); io.emit('post:update', slim(q)); }
  }
  io.emit('post:new', pubPost(p));
  growing.add(p.id);
  onPostAdded(p);
  save();
  return p;
}

// runs for every new post, human or bot: counts toward hype events, notifies mentioned players, scores bot call-outs
function onPostAdded(p) {
  const author = U(p.authorId);
  const sent = p.mentionSentiment; delete p.mentionSentiment;
  const ev = p.eventId ? eventById(p.eventId) : eventForPost(p);
  if (ev) { p.eventId = ev.id; ev.posts = (ev.posts || 0) + 1; emitEvents(); }
  if (!author) return;
  if (author.kind !== 'player') botEngage(p); // other bots like/repost it, weighted by relationship and house
  for (const id of p.mentions || []) {
    const t = U(id);
    if (!t || t.kind !== 'player') continue;
    notify(t.id, { type: 'mention', fromId: author.id, postId: p.id, text: `${author.name} mentioned you: "${SNIP(p.text, 60)}"` });
    if (author.kind !== 'player') mentionEffect(p, author, t, sent);
  }
}

// a bot @-mentioning a player: high-follower characters boost hype/followers, call-outs cost them
function mentionEffect(p, bot, player, sent) {
  if (sent === undefined || sent === null) sent = castle.sentiment(p.text);
  const w = Math.min(1, bot.followers / 40000);
  const mult = sent > 0 ? 1 : sent < 0 ? -1 : 0.5;
  const hd = Math.round(mult * 4 * w);
  const fd = Math.round(mult * (w * player.followers * 0.02 + w * 6));
  castle.relInteract(state, bot, player, sent > 0 ? 1 : sent < 0 ? -1 : 0, `${sent < 0 ? 'called out' : sent > 0 ? 'shouted out' : 'mentioned'} ${player.name}: "${SNIP(p.text, 50)}"`);
  if (bot.kind === 'char') relFollowCheck(bot, player);
  if (hd || fd) {
    player.hype = clampInt(player.hype + hd, 0, 100);
    player.followers = Math.max(0, player.followers + fd);
    emitUser(player);
  }
  if (w >= 0.3) castle.pushNews(state, `${bot.name} ${sent < 0 ? 'called out' : sent > 0 ? 'shouted out' : 'tagged'} ${player.name}`, sent < 0 ? 3 : 2, 'mention');
}
const slim = p => ({ id: p.id, likes: p.likes, reposts: p.reposts, replyCount: p.replyCount, verdict: p.verdict, likedBy: p.likedBy, repostedBy: p.repostedBy, quoteCount: p.quoteCount, views: p.views });

// a bot reposting a player's post
function botRepost(bot, p) {
  if (!bot || bot.kind === 'player' || !postIndex.has(p.id)) return;
  if (p.repostedBy.some(r => r.id === bot.id)) return;
  p.repostedBy.push({ id: bot.id, ts: Date.now() });
  p.reposts++; p.targetReposts = Math.max(p.targetReposts, p.reposts);
  engage(p, 'repost', bot);
  io.emit('post:update', slim(p)); save();
  const a = U(p.authorId);
  if (a && a.kind === 'player') notify(a.id, { type: 'repost', fromId: bot.id, postId: p.id, text: `${bot.name} reposted your post` });
}

const MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
function checkMilestone(u) {
  if (u.kind !== 'player') return;
  const top = MILESTONES.filter(m => u.followers >= m).pop() || 0;
  if (u.mile === undefined) { u.mile = top; return; } // old saves: don't announce history
  if (top > u.mile) {
    u.mile = top;
    castle.pushNews(state, `${u.name} passed ${top.toLocaleString('en-GB')} followers`, 3, 'milestone');
    notify(u.id, { type: 'milestone', text: `🎉 You passed ${top.toLocaleString('en-GB')} followers` });
  }
}
function emitUser(u) { checkMilestone(u); io.emit('user:update', pubUser(u)); save(); }
const SNIP = (t, n = 60) => { t = String(t || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };

function notify(playerId, n) {
  const u = U(playerId);
  if (!u || u.kind !== 'player') return;
  const note = { id: uid(), ts: Date.now(), read: false, ...n };
  (state.notifs[playerId] = state.notifs[playerId] || []).unshift(note);
  if (state.notifs[playerId].length > 200) state.notifs[playerId].length = 200;
  io.to('u:' + playerId).emit('notif', note);
  save();
}

function setActivity(postId, label) {
  if (label) activity[postId] = label; else delete activity[postId];
  io.emit('activity', { postId, label: label || null });
}

// ---------------------------------------------------------------- views (model in views.js)
const growing = new Set();
const authorOf = p => U(p.authorId);
function viewsTargetOf(p) {
  const a = authorOf(p);
  if (!a) return p.views || 0;
  const par = p.parentId ? postIndex.get(p.parentId) : null;
  const pa = par && authorOf(par);
  if (par && pa) return V.replyTarget(p, par, a, pa, Math.max(0, (replyIdx.get(par.id) || []).indexOf(p.id)));
  return V.rootTarget(p, a);
}
// views never drop below likes x15; a reply never sits above its parent (the parent is lifted instead) unless the big-account rule applies
function enforceViews(p) {
  let changed = false;
  const floor = (p.likes || 0) * V.FLOOR_PER_LIKE;
  if (p.views < floor) { p.views = floor; changed = true; }
  let cur = p;
  while (cur.parentId) {
    const par = postIndex.get(cur.parentId), ca = authorOf(cur), pa = par && authorOf(par);
    if (!par || !ca || !pa || cur.views <= par.views || V.isBigAuthor(ca, pa)) break;
    par.views = cur.views; par.targetViews = Math.max(par.targetViews || 0, par.views);
    io.emit('post:update', slim(par));
    cur = par;
  }
  return changed;
}
// engagement on a post lifts ITS impressions and, at half strength per level, its ancestors'
function engage(p, kind, actor, amount) {
  let amt = amount ?? V.engagementBoost(kind, actor);
  for (let cur = p; cur && amt >= 1; cur = cur.parentId ? postIndex.get(cur.parentId) : null) {
    cur.boost = (cur.boost || 0) + amt; growing.add(cur.id); amt *= 0.5;
  }
}
const wakeReplies = p => { for (const id of replyIdx.get(p.id) || []) growing.add(id); };

// likes / reposts / views tick up gradually so it feels live (views only ever increase)
setInterval(() => {
  for (const id of [...growing]) {
    const p = postIndex.get(id);
    if (!p) { growing.delete(id); continue; }
    let changed = false;
    if (p.likes < p.targetLikes) {
      const before = p.likes;
      p.likes += Math.max(1, Math.ceil((p.targetLikes - p.likes) * (0.12 + Math.random() * 0.25))); p.likes = Math.min(p.likes, p.targetLikes);
      engage(p, 'bulk', null, (p.likes - before) * 4);
      changed = true;
    }
    if (p.reposts < p.targetReposts) { p.reposts += Math.max(1, Math.ceil((p.targetReposts - p.reposts) * 0.3)); p.reposts = Math.min(p.reposts, p.targetReposts); changed = true; }
    const viewsBefore = p.views;
    p.targetViews = Math.max(p.targetViews || 0, Math.round(viewsTargetOf(p)));
    if (p.views < p.targetViews) { p.views += Math.max(1, Math.ceil((p.targetViews - p.views) * (0.1 + Math.random() * 0.2))); p.views = Math.min(p.views, p.targetViews); }
    enforceViews(p);
    if (p.views !== viewsBefore) { changed = true; wakeReplies(p); }
    if (changed) io.emit('post:update', slim(p));
    if (p.likes >= p.targetLikes && p.reposts >= p.targetReposts && p.views >= p.targetViews) growing.delete(id);
  }
}, 1500);

// boot migration: recompute every post's views with the current rules, roots first; a root's views never go down
function recomputeAllViews() {
  const depth = p => { let d = 0, c = p; while (c && c.parentId && d < 60) { c = postIndex.get(c.parentId); d++; } return d; };
  const order = state.posts.map(p => [depth(p), p]).sort((a, b) => a[0] - b[0] || a[1].ts - b[1].ts).map(x => x[1]);
  for (const p of order) {
    if (p.boost === undefined) p.boost = (p.replyCount || 0) * 40 + (p.quoteCount || 0) * 60 + (p.reposts || 0) * 25;
    if (p.vmult === undefined || p.vmult === null) p.vmult = p.verdict === 'viral' ? V.pickVMult('viral') : null;
    const t = Math.round(viewsTargetOf(p));
    const isReply = p.parentId && postIndex.has(p.parentId);
    p.views = isReply ? t : Math.max(p.views || 0, t);
    p.targetViews = p.views;
  }
  for (const p of order.slice().reverse()) enforceViews(p); // lifts parents of replies whose likes floor exceeds them
}

// trends rotate every 6h
function ensureTrend(force) {
  if (!force && state.trend && state.trend.until > Date.now()) return;
  state.trendIdx = (state.trendIdx + 1) % TRENDS.length;
  state.trend = { ...TRENDS[state.trendIdx], until: Date.now() + TREND_MS };
  io.emit('trend', state.trend);
  save();
}
setInterval(() => ensureTrend(false), 60000);

const HANDLE_RE = /^[a-z0-9_.]{3,20}$/;
const cooldown = new Map();

function initPayload(me) {
  return {
    me: { ...pubUser(me), bookmarks: me.bookmarks || [] },
    users: Object.values(state.users).map(pubUser),
    posts: state.posts.slice(-700).map(pubPost),
    notifs: state.notifs[me.id] || [],
    trend: state.trend,
    online: onlineIds(),
    activity,
    events: publicEvents(),
    dms: convsFor(me.id).map(c => pubConv(c, 25))
  };
}

io.on('connection', sock => {
  let me = null;
  sock.emit('config', { inviteRequired: !!INVITE_CODE });

  function attach(u) {
    me = u;
    sock.join('u:' + u.id);
    online.set(u.id, (online.get(u.id) || 0) + 1);
    io.emit('presence', onlineIds());
    lastSeenOnline = Date.now();
  }
  const guard = (ack, fn) => (...args) => { try { fn(...args); } catch (e) { console.error(e); typeof ack === 'function' && ack({ ok: false, error: 'Server error' }); } };

  sock.on('hello', (data, ack) => guard(ack, () => {
    const token = data && data.token;
    const u = token && players().find(p => p.token === token);
    if (!u) return ack && ack({ ok: false });
    if (!me) attach(u);
    ack && ack({ ok: true, init: initPayload(u) });
  })());

  sock.on('signup', (data, ack) => guard(ack, () => {
    if (me) return ack({ ok: false, error: 'Already signed in' });
    if (INVITE_CODE && String(data.invite || '').trim().toLowerCase() !== INVITE_CODE.toLowerCase()) {
      sock.inviteFails = (sock.inviteFails || 0) + 1;
      if (sock.inviteFails >= 8) sock.disconnect(true); // guessing the code
      return ack({ ok: false, error: 'Invalid invite code' });
    }
    const name = String(data.name || '').trim().slice(0, 30);
    const handle = cleanHandle(data.handle);
    const house = HOUSES.includes(data.house) ? data.house : null;
    if (name.length < 2) return ack({ ok: false, error: 'Name too short' });
    if (!HANDLE_RE.test(handle)) return ack({ ok: false, error: 'Handle: 3–20 chars, letters, numbers, _ or .' });
    if (handleIndex.has(handle)) return ack({ ok: false, error: 'Handle taken' });
    if (!house) return ack({ ok: false, error: 'Pick a house' });
    const u = {
      id: 'p_' + uid(), kind: 'player', token: crypto.randomBytes(24).toString('hex'),
      name, handle, house, bio: `${house}. New to Owl Feed.`, followers: 25, hype: 40, housePoints: 0, galleons: 10,
      following: [], bookmarks: [], joined: Date.now()
    };
    state.users[u.id] = u; handleIndex.set(handle, u);
    io.emit('user:new', pubUser(u));
    for (const p of players()) if (p.id !== u.id) notify(p.id, { type: 'join', fromId: u.id, text: `${u.name} (@${u.handle}) joined Owl Feed. Search them to follow.` });
    notify(u.id, { type: 'system', text: `Welcome to Owl Feed. Post something — the whole castle is watching.` });
    attach(u);
    save();
    ack({ ok: true, token: u.token, init: initPayload(u) });
    // a few NPCs from your house follow you on arrival
    setTimeout(() => {
      const fans = shuffle(npcs().filter(n => n.house === house)).slice(0, 3);
      fans.forEach((f, i) => setTimeout(() => { u.followers++; emitUser(u); notify(u.id, { type: 'follow', fromId: f.id, text: `@${f.handle} followed you` }); }, i * 2500));
    }, 4000);
  })());

  function rateOk(ack) {
    const last = cooldown.get(me.id) || 0;
    if (Date.now() - last < 6000) { ack && ack({ ok: false, error: 'Slow down — the owls need a sec' }); return false; }
    cooldown.set(me.id, Date.now());
    return true;
  }

  sock.on('post', (data, ack) => guard(ack, () => {
    if (!me) return ack({ ok: false, error: 'Not signed in' });
    const text = String(data.text || '').trim().slice(0, 280);
    if (!text) return ack({ ok: false, error: 'Empty' });
    if (!rateOk(ack)) return;
    const p = addPost(mkPost(me.id, text, null));
    ack({ ok: true, id: p.id });
    const mentioned = forcedBots(p);
    for (const pl of players()) if (pl.id !== me.id && pl.following.includes(me.id)) notify(pl.id, { type: 'friend_post', fromId: me.id, postId: p.id, text: `${me.name} posted: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` });
    reactToPost(p, mentioned).catch(e => console.error('[owl] reactToPost', e));
  })());

  sock.on('reply', (data, ack) => guard(ack, () => {
    if (!me) return ack({ ok: false, error: 'Not signed in' });
    const parent = postIndex.get(data.parentId);
    if (!parent) return ack({ ok: false, error: 'Post not found' });
    const text = String(data.text || '').trim().slice(0, 280);
    if (!text) return ack({ ok: false, error: 'Empty' });
    if (!rateOk(ack)) return;
    const r = addPost(mkPost(me.id, text, parent.id));
    ack({ ok: true, id: r.id });
    const mentioned = forcedBots(r);
    const pa = U(parent.authorId);
    if (pa && pa.kind === 'player' && pa.id !== me.id && !r.mentions.includes(pa.id)) notify(pa.id, { type: 'reply', fromId: me.id, postId: r.id, text: `${me.name} replied: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` });
    reactToReply(r, parent, mentioned).catch(e => console.error('[owl] reactToReply', e));
  })());

  sock.on('repost', (data, ack) => guard(ack, () => {
    if (!me) return ack && ack({ ok: false, error: 'Not signed in' });
    const p = postIndex.get(data && data.postId);
    if (!p) return ack && ack({ ok: false, error: 'Post not found' });
    const i = p.repostedBy.findIndex(r => r.id === me.id);
    if (i >= 0) {
      p.repostedBy.splice(i, 1);
      p.reposts = Math.max(0, p.reposts - 1);
      p.targetReposts = Math.max(0, p.targetReposts - 1);
    } else {
      p.repostedBy.push({ id: me.id, ts: Date.now() });
      p.reposts++; p.targetReposts = Math.max(p.targetReposts, p.reposts);
      engage(p, 'repost', me);
      const a = U(p.authorId);
      if (a && a.kind === 'player' && a.id !== me.id) notify(a.id, { type: 'repost', fromId: me.id, postId: p.id, text: `${me.name} reposted your post` });
    }
    io.emit('post:update', slim(p)); save();
    ack && ack({ ok: true, reposted: i < 0 });
  })());

  sock.on('quote', (data, ack) => guard(ack, () => {
    if (!me) return ack({ ok: false, error: 'Not signed in' });
    const q = postIndex.get(data && data.postId);
    if (!q) return ack({ ok: false, error: 'Post not found' });
    const text = String(data.text || '').trim().slice(0, 280);
    if (!text) return ack({ ok: false, error: 'Empty' });
    if (!rateOk(ack)) return;
    const p = mkPost(me.id, text, null);
    p.quoteId = q.id;
    addPost(p);
    ack({ ok: true, id: p.id });
    const mentioned = forcedBots(p);
    const qa = U(q.authorId);
    if (qa && qa.kind === 'player' && qa.id !== me.id) {
      notify(qa.id, { type: 'quote', fromId: me.id, postId: p.id, text: `${me.name} quoted your post: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` });
      // quoting the other player is a duel in front of the castle
      reactToReply(p, q, mentioned).catch(e => console.error('[owl] reactToQuote', e));
    } else {
      reactToPost(p, mentioned).catch(e => console.error('[owl] reactToPost(quote)', e));
    }
  })());

  sock.on('bookmark', (data, ack) => guard(ack, () => {
    if (!me) return;
    const p = postIndex.get(data && data.postId);
    if (!p) return ack && ack({ ok: false });
    me.bookmarks = me.bookmarks || [];
    const i = me.bookmarks.indexOf(p.id);
    if (i >= 0) me.bookmarks.splice(i, 1); else me.bookmarks.unshift(p.id);
    save();
    ack && ack({ ok: true, bookmarked: i < 0 });
  })());

  sock.on('delete', (data, ack) => guard(ack, () => {
    if (!me) return ack({ ok: false, error: 'Not signed in' });
    const p = postIndex.get(data && data.postId);
    if (!p) return ack({ ok: false, error: 'Post not found' });
    if (p.authorId !== me.id) return ack({ ok: false, error: 'Not your post' });
    const ids = new Set([p.id]);
    let grew = true;
    while (grew) { // cascade: remove the reply subtree so no orphans remain
      grew = false;
      for (const x of state.posts) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); grew = true; }
    }
    if (p.parentId) {
      const par = postIndex.get(p.parentId);
      if (par) { par.replyCount = Math.max(0, par.replyCount - 1); io.emit('post:update', slim(par)); }
    }
    if (p.quoteId) {
      const q = postIndex.get(p.quoteId);
      if (q) { q.quoteCount = Math.max(0, q.quoteCount - 1); io.emit('post:update', slim(q)); }
    }
    state.posts = state.posts.filter(x => !ids.has(x.id));
    for (const id of ids) replyIdx.delete(id);
    rebuildReplyIndex();
    for (const id of ids) { postIndex.delete(id); growing.delete(id); delete activity[id]; }
    for (const pl of players()) if (pl.bookmarks) pl.bookmarks = pl.bookmarks.filter(id => !ids.has(id));
    io.emit('post:delete', { ids: [...ids] });
    save();
    ack({ ok: true });
  })());

  sock.on('profile', (data, ack) => guard(ack, () => {
    if (!me) return ack && ack({ ok: false, error: 'Not signed in' });
    const name = String(data && data.name || '').trim().slice(0, 30);
    const bio = String(data && data.bio || '').trim().slice(0, 160);
    if (name.length >= 2) me.name = name;
    me.bio = bio;
    emitUser(me);
    ack && ack({ ok: true });
  })());

  // own avatar / banner: the client crops and resizes to WebP, the server validates type, size and magic bytes
  sock.on('upload', (data, ack) => guard(ack, () => {
    if (!me) return ack && ack({ ok: false, error: 'Not signed in' });
    const kind = data && data.kind;
    if (kind !== 'avatar' && kind !== 'banner') return ack && ack({ ok: false, error: 'Bad upload kind' });
    const buf = data && data.data && (Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data));
    if (!buf || !buf.length) return ack && ack({ ok: false, error: 'No image data' });
    if (buf.length > MAX_UPLOAD) return ack && ack({ ok: false, error: 'Image too large (max 2MB)' });
    const ext = imageExt(buf);
    if (!ext) return ack && ack({ ok: false, error: 'Images only (WebP, PNG or JPEG)' });
    const recent = (uploadStamp.get(me.id) || []).filter(t => Date.now() - t < 60e3);
    if (recent.length >= 6) return ack && ack({ ok: false, error: 'Too many uploads, try again in a minute' });
    recent.push(Date.now()); uploadStamp.set(me.id, recent);
    const file = `${me.id}-${kind}-${Date.now().toString(36)}.${ext}`;
    const key = kind === 'avatar' ? 'avatarUrl' : 'bannerUrl';
    const user = me;
    store.saveUpload(file, buf).then(() => {
      const old = user[key];
      user[key] = '/uploads/' + file;
      if (old && old.startsWith('/uploads/')) store.deleteUpload(path.basename(old)).catch(() => {});
      emitUser(user);
      ack && ack({ ok: true, url: user[key] });
    }).catch(e => { console.error('[owl] upload failed:', e.message); ack && ack({ ok: false, error: 'Could not save the image' }); });
  })());

  // ---- direct messages
  sock.on('dm:send', (data, ack) => guard(ack, () => {
    if (!me) return ack && ack({ ok: false, error: 'Not signed in' });
    const to = U(data && data.to);
    const text = String(data && data.text || '').replace(/\s+$/g, '').slice(0, 500);
    if (!to || to.id === me.id) return ack && ack({ ok: false, error: 'No such account' });
    if (!text.trim()) return ack && ack({ ok: false, error: 'Empty' });
    if (!dmRateOk(me.id)) return ack && ack({ ok: false, error: 'Slow down' });
    const conv = getConv(me.id, to.id, true);
    const msg = addDM(conv, me.id, text);
    ack && ack({ ok: true, convId: conv.id, msg });
    if (to.kind !== 'player') onPlayerDM(conv, to, me);
  })());
  sock.on('dm:read', (data) => guard(null, () => {
    const conv = me && state.dms[data && data.convId];
    if (conv && conv.members.includes(me.id)) markRead(conv, me.id);
  })());
  sock.on('dm:typing', (data) => guard(null, () => {
    if (!me) return;
    const to = U(data && data.to);
    if (to && to.kind === 'player' && to.id !== me.id) io.to('u:' + to.id).emit('dm:typing', { convId: convIdOf(me.id, to.id), from: me.id, typing: !!data.typing });
  })());
  sock.on('dm:history', (data, ack) => guard(ack, () => {
    const conv = me && state.dms[data && data.convId];
    if (!conv || !conv.members.includes(me.id)) return ack && ack({ ok: false });
    ack && ack({ ok: true, conv: pubConv(conv, 200) });
  })());

  sock.on('like', (data) => guard(null, () => {
    if (!me) return;
    const p = postIndex.get(data && data.postId);
    if (!p) return;
    const i = p.likedBy.indexOf(me.id);
    if (i >= 0) { p.likedBy.splice(i, 1); p.likes = Math.max(0, p.likes - 1); p.targetLikes = Math.max(0, p.targetLikes - 1); }
    else {
      p.likedBy.push(me.id); p.likes++; p.targetLikes++;
      engage(p, 'like', me);
      enforceViews(p);
      const a = U(p.authorId);
      if (a && a.kind === 'player' && a.id !== me.id) notify(a.id, { type: 'like', fromId: me.id, postId: p.id, text: `${me.name} liked your post` });
    }
    io.emit('post:update', slim(p)); save();
  })());

  sock.on('follow', (data) => guard(null, () => {
    if (!me) return;
    const t = U(data && data.userId);
    if (!t || t.id === me.id || me.following.includes(t.id)) return;
    me.following.push(t.id); t.followers++;
    emitUser(me); emitUser(t);
    if (t.kind === 'player') castle.pushNews(state, t.following.includes(me.id) ? `${me.name} and ${t.name} now follow each other` : `${me.name} followed ${t.name}`, 2, 'follow');
    else if (t.kind === 'char') castle.pushNews(state, `${me.name} followed ${t.name}`, 1, 'follow');
    if (t.kind === 'player') notify(t.id, { type: 'follow', fromId: me.id, text: `${me.name} followed you${t.following.includes(me.id) ? ' back' : ''}` });
    if (t.kind === 'char') maybeFollowBack(t, me);
  })());

  sock.on('unfollow', (data) => guard(null, () => {
    if (!me) return;
    const t = U(data && data.userId);
    if (!t) return;
    const i = me.following.indexOf(t.id);
    if (i < 0) return;
    me.following.splice(i, 1); t.followers = Math.max(0, t.followers - 1);
    emitUser(me); emitUser(t);
    if (t.kind !== 'npc') castle.pushNews(state, `${me.name} unfollowed ${t.name}`, t.kind === 'player' ? 3 : 2, 'unfollow');
  })());

  sock.on('readNotifs', () => guard(null, () => {
    if (!me) return;
    (state.notifs[me.id] || []).forEach(n => n.read = true); save();
  })());

  sock.on('disconnect', () => {
    if (!me) return;
    const c = (online.get(me.id) || 1) - 1;
    if (c <= 0) online.delete(me.id); else online.set(me.id, c);
    io.emit('presence', onlineIds());
  });
});

function maybeFollowBack(char, player) {
  const ratio = player.followers / Math.max(1, char.followers);
  const chance = Math.min(0.85, 0.08 + ratio * 4 + player.hype / 400);
  if (Math.random() > chance) return;
  setTimeout(() => {
    if (char.following.includes(player.id)) return;
    char.following.push(player.id); player.followers++; player.hype = Math.min(100, player.hype + 4);
    emitUser(char); emitUser(player);
    castle.pushNews(state, `${char.name} followed ${player.name} back`, 3, 'follow');
    notify(player.id, { type: 'follow', fromId: char.id, text: `${char.name} followed you back. Big.` });
  }, rand(8000, 30000));
}

// ---------------------------------------------------------------- Gemini
const SYS = `You are the engine of "Owl Feed", a comedic Twitter-style social network inside the Harry Potter universe, set at Hogwarts during the students' school years. Two real players post on it. You voice every bot account (canon characters and student NPCs) and judge how posts land with the castle.

Rules:
- Write each canon character in their own established personality and voice, but NEVER quote, paraphrase or recycle lines, catchphrases or passages from the books or films. Everything must be fresh and original.
- Owl Feed is a fun, fast social feed. Mix support, banter, jokes and criticism like real social media. Most people scrolling are neutral or friendly; a few are haters. Write short (usually under 25 words), casual, lowercase is fine, slang, occasional emoji. Staff and Ministry accounts can be more formal but stay fair.
- React to what was actually written. Bots take sides along house lines and remember the recent feed.
- REPLY TARGETING: a prompt with a TARGET POST asks for replies to that one post only. Everything under BACKGROUND is context: never reply to it, only reference it as an explicit callback. Every reply carries reacting_to: a short phrase quoted from the target post, or callback:<which earlier post>. Feed items are numbered [1]..[N]; refer to them by number, never by id.
- TONE: every reply has a stance: support, neutral, joke, critical or hostile. Follow the quota for how the post landed. Bots from the author's own house lean supportive and rival houses lean critical. Warm characters (Luna, Neville, Cedric, Hagrid, Hufflepuffs, wholesome friends) are almost never hostile. Draco, Pansy, Peeves and professional haters can roast but must still engage with the actual joke. Find the funny in the post and riff on it (yes and); do not just insult the author. At most one pure insult per batch; insults about the person instead of the post are rare and only from established haters. Supportive replies deserve more likes than hostile ones on good and viral posts, hostile ones only on flops.
- Keep it PG-13: no slurs, no sexual content.
- Only use handles from the lists given. Never write as a player.
- CASTLE MEMORY: every request carries a "castle" block with a news digest of what just happened, dossiers on both players (reputation tags, last posts, head-to-head duel record) and per-bot "relations" (score -10..10 plus short memories). Reference recent events naturally, remember past beef, call back to earlier posts. Never contradict the digest or the duel records: do not say someone won a duel they lost, or that a viral post flopped.
- RELATIONSHIPS: a bot with a negative relation score holds a grudge and is cold or hostile; a positive one is a fan. Use the memory lines. Students with an opinion score follow the same logic.
- MENTIONS: you may write @handles of listed accounts or the players inside posts. A bot listed in "mentioned_accounts" was tagged directly and replies to the player directly, in character, almost always. A bot that calls a player out or praises them should tag them with their @handle.
- HYPE: when "hype_events" is non-empty, that player is the main character of the castle; heat (0-5) says how much people still talk about it, so mention it less as heat falls and drop it at 0.
- RUMOURS: a bot's "heard" list is what that bot has been told in private (claim as it reached them, whether they believe it). Bots may let it colour their posts and replies, hold it back, or deny it, in character. Never present an unconfirmed rumour as fact.
- DMS: in direct messages bots behave like real people, not assistants. They are not always instant or eager: they can leave someone on read, send one emoji reaction instead of a message, double-text, split a thought into several short messages, reply later, use lowercase and slang, or end the conversation when annoyed. Keep each DM short unless the character would ramble. Stay in the character's voice, remember the conversation summary and recent messages, and let the relationship score and memories decide warmth. If the player shares gossip or a secret, classify it in the same response (rumour fields) and react in character.
- BOT SCENES AND STORYLINES: bots talk to each other, not only to players. A scene is a short reply chain between bots (2-6 messages): keep every message in that bot's voice and let it point at an earlier message. Bots take sides by house and by how they feel about each other (bot_pairs: score -10..10, feud at -6 or lower, rivals at -3, friendly at 3 or more). Not every bot answers and threads can end early. Ongoing storylines in castle.storylines continue across ticks: escalate, then resolve one after about 3-5 beats, and never contradict its last_beat. When a player joins a storyline thread the storyline bots notice and react to the player in character. Sub-replies are other bots answering a bot reply (agree, dunk, or take a house side).
- Output ONLY valid JSON in the exact shape requested.`;

// ---------------------------------------------------------------- AI layer
// Providers (Gemini -> Groq -> mock), circuit breakers and RPM/daily budgets live in aiprov.js. This is the priority queue in front of it:
// players first (DMs, reactions, replies), then wave posts, then ambient. Ambient work is skipped when the budget is tight.
let aiLayer = null;
const budget = createBudget({ perMin: AI_PER_MIN });
const aiq = createQueue({ minGap: MIN_GAP, budget, enforce: BUDGET_ON, log: m => console.log(m) });
const PRI = { dm: 0, post: 1, reply: 1, duel: 1, 'dm-opener': 2, 'hype-wave': 3, ambient: 6 };
// the shape each kind of call must return; anything else is retried once on the next provider
const TEMP = { post: 0.9, reply: 0.9, duel: 0.9, 'hype-wave': 0.9, ambient: 0.9 }; // reply generation runs a little cooler than DMs
const hasArr = k => d => !!d && typeof d === 'object' && Array.isArray(d[k]);
const SHAPES = {
  post: hasArr('replies'), reply: hasArr('replies'), duel: hasArr('replies'),
  dm: hasArr('actions'), 'dm-opener': d => !!d && typeof d.text === 'string',
  'hype-wave': hasArr('posts'), ambient: d => !!d && (Array.isArray(d.posts) || Array.isArray(d.scenes))
};
// the one entry point for every AI call: parsed JSON, or null (caller falls back to mock)
const ai = (prompt, opts = {}) => {
  const kind = opts.kind || 'misc';
  return aiq.enqueue(() => aiLayer ? aiLayer.aiJSON(prompt, { kind, validate: SHAPES[kind], temperature: TEMP[kind] }) : null, { pri: opts.pri ?? PRI[kind] ?? 5, kind });
};
const aiTight = () => !!aiLayer && aiLayer.tight();

// ---------------------------------------------------------------- context builders
const pids = () => players().map(p => p.id);
const uctx = u => ({ handle: '@' + u.handle, name: u.name, house: u.house, followers: u.followers, hype: u.hype });
// per-bot memory of the players: relationship score + last interactions (empty ones are omitted to save tokens)
function relBrief(bot, ids) {
  const o = {};
  for (const id of ids || []) {
    const pl = U(id); if (!pl) continue;
    const v = castle.relView(state, bot, id);
    if (v.score || v.memory.length) o['@' + pl.handle] = { score: v.score, memory: v.memory };
  }
  return Object.keys(o).length ? o : undefined;
}
// "heard" = private rumours this bot has been told, so later posts, replies and DMs stay consistent with what they know
const cctx = (c, ids) => ({ handle: '@' + c.handle, name: c.name, house: c.house, personality: c.voice, likes: c.likes, hates: c.hates, relations: relBrief(c, ids), heard: heardBy(c) });
const nctx = (n, pid, ids) => ({ handle: '@' + n.handle, name: n.name, house: n.house, year: n.year, personality: n.seed, opinion_of_player: pid ? (n.opinion?.[pid] || 0) : undefined, relations: relBrief(n, ids || (pid ? [pid] : [])), heard: heardBy(n) });

function feedSummary(n = 14) {
  return state.posts.slice(-n).map(p => {
    const a = U(p.authorId); const par = p.parentId ? postIndex.get(p.parentId) : null;
    return { id: p.id, by: '@' + (a ? a.handle : '?'), player: a?.kind === 'player' || undefined, reply_to: par ? '@' + (U(par.authorId)?.handle || '?') : undefined, text: p.text };
  });
}
function recentBy(uid_, n = 5) { return state.posts.filter(p => p.authorId === uid_).slice(-n - 1, -1).map(p => p.text); }
function otherPlayersCtx(meId) {
  return players().filter(p => p.id !== meId).map(p => ({ ...uctx(p), recent_posts: state.posts.filter(x => x.authorId === p.id).slice(-3).map(x => x.text) }));
}
function pickChars(n, text = '') {
  const t = text.toLowerCase();
  const mentioned = chars().filter(c => t.includes(c.handle) || t.includes(c.name.split(' ')[0].toLowerCase()) || t.includes(c.name.split(' ').slice(-1)[0].toLowerCase()));
  const rest = shuffle(chars().filter(c => !mentioned.includes(c)));
  return [...mentioned.slice(0, 3), ...rest].slice(0, n);
}
function pickNPCs(n, pid) {
  const all = npcs();
  const opinionated = all.filter(x => Math.abs(x.opinion?.[pid] || 0) >= 3).sort(() => Math.random() - 0.5).slice(0, Math.ceil(n / 2));
  return [...opinionated, ...shuffle(all.filter(x => !opinionated.includes(x)))].slice(0, n);
}
// put forced (mentioned) bots first in the reaction pool
function withForced(cs, ns, forced) {
  for (const m of forced) {
    if (m.kind === 'char') cs = [m, ...cs.filter(x => x !== m)];
    else ns = [m, ...ns.filter(x => x !== m)];
  }
  return [cs, ns];
}

// castle memory block injected into EVERY AI call: news digest, player dossiers, hot events
function castleCtx() {
  const now = Date.now(), pl = players();
  const hot = activeEvents(now).map(e => ({ player: '@' + (U(e.playerId)?.handle || '?'), what: e.summary, heat: +heat(e, now).toFixed(1), minutes_ago: Math.round((now - e.startedAt) / 60e3) }));
  const stories = storiesCtx();
  return { news: castle.digest(state, now, 10), hype_events: hot.length ? hot : undefined, storylines: stories.length ? stories : undefined, players: pl.map(p => castle.dossier(state, p, pl, now)) };
}
// castle memory block injected into EVERY AI call: news digest, player dossiers, hot events
// (castleCtx is defined above)
const BG_KEYS = ['trend', 'recent_feed', 'other_players', 'thread_root', 'castle'];
// build the prompt, trim to the token budget, and log its approximate size.
// With a `target` the prompt is TARGET-FIRST: the post every reply must respond to opens the prompt, everything else is labelled
// background, and the target is repeated at the very end so the model cannot drift to some other post.
function buildPrompt(label, obj, target) {
  obj.castle = castleCtx();
  let doc = obj;
  if (target) {
    const bg = {}, main = {};
    for (const k of Object.keys(obj)) (BG_KEYS.includes(k) ? bg : main)[k] = obj[k];
    doc = {
      TARGET_POST: { rule: 'TARGET POST — every reply must respond to this', ...target },
      ...main,
      BACKGROUND: { rule: 'BACKGROUND (do not reply to these; only reference them as explicit callbacks like "not you again after the X post", with reacting_to set to "callback:<which earlier post>")', ...bg },
      FINAL_REMINDER: { rule: 'Every reply responds to the TARGET POST above, and its reacting_to quotes a short phrase from it', target_post: target.text }
    };
  }
  const bgOf = () => doc.BACKGROUND || doc;
  const size = () => castle.approxTokens(SYS) + castle.approxTokens(JSON.stringify(doc));
  let tok = size();
  const trims = [
    () => { const b = bgOf(); if (b.recent_feed) b.recent_feed = b.recent_feed.slice(-6); },
    () => { const b = bgOf(); b.castle.players.forEach(p => { p.last_posts = p.last_posts.slice(-3); }); (b.other_players || []).forEach(p => { p.recent_posts = (p.recent_posts || []).slice(-1); }); },
    () => { const b = bgOf(); b.castle.news = b.castle.news.slice(0, 8); if (b.recent_feed) b.recent_feed = b.recent_feed.slice(-3); },
    () => { for (const k of ['available_students', 'available_characters']) (doc[k] || []).forEach(x => { delete x.likes; delete x.hates; }); },
    () => { if (doc.available_students) doc.available_students = doc.available_students.slice(0, 6); if (doc.bot_pairs) doc.bot_pairs = doc.bot_pairs.slice(0, 4); },
    () => { const b = bgOf(); if (b.recent_feed) b.recent_feed = b.recent_feed.slice(-3); (doc.available_characters || []).forEach(x => { delete x.personality; }); },
    () => { if (doc.available_students) doc.available_students = doc.available_students.slice(0, 4); const b = bgOf(); if (b.recent_feed) b.recent_feed = b.recent_feed.slice(-2); },
    () => { const b = bgOf(); b.castle.news = b.castle.news.slice(0, 4); b.castle.players = b.castle.players.slice(0, 4); if (doc.bot_pairs) doc.bot_pairs = doc.bot_pairs.slice(0, 2); },
    () => { if (doc.available_characters) doc.available_characters = doc.available_characters.slice(0, 12); if (doc.available_students) doc.available_students = doc.available_students.slice(0, 3); const b = bgOf(); b.castle.players.forEach(p => { p.last_posts = p.last_posts.slice(-1); }); },
    () => { const b = bgOf(); b.castle.news = b.castle.news.slice(0, 2); b.castle.players = b.castle.players.slice(0, 3); if (b.recent_feed) b.recent_feed = b.recent_feed.slice(-1); if (doc.available_characters) doc.available_characters = doc.available_characters.slice(0, 8); }
  ];
  for (const t of trims) { if (tok <= PROMPT_BUDGET) break; t(); tok = size(); }
  // last resort: halve the largest remaining list (never the TARGET_POST) until it fits
  for (let guard = 0; tok > PROMPT_BUDGET && guard < 12; guard++) {
    let best = null;
    const scan = (o, key) => { for (const k of Object.keys(o)) { if (k === 'TARGET_POST' || k === 'FINAL_REMINDER') continue; const v = o[k]; if (Array.isArray(v) && v.length > 2) { const w = JSON.stringify(v).length; if (!best || w > best.w) best = { o, k, w }; } else if (v && typeof v === 'object' && !Array.isArray(v) && key !== 'deep') scan(v, 'deep'); } };
    scan(doc);
    if (!best) break;
    best.o[best.k] = best.o[best.k].slice(0, Math.max(2, Math.ceil(best.o[best.k].length / 2)));
    tok = size();
  }
  console.log(`[owl] AI ${label}: ~${tok} input tokens${tok > PROMPT_BUDGET ? ' (over budget)' : ''}`);
  return JSON.stringify(doc);
}

// numbered feed items [1]..[N]: the model answers with a NUMBER, never a raw id; `ids[n-1]` maps it back (out-of-range numbers are rejected)
function feedNumbered(n = 14, excludeId = null) {
  const list = state.posts.filter(p => p.id !== excludeId).slice(-n);
  return {
    ids: list.map(p => p.id),
    items: list.map((p, i) => {
      const a = U(p.authorId), par = p.parentId ? postIndex.get(p.parentId) : null;
      return { n: i + 1, by: '@' + (a ? a.handle : '?'), player: a?.kind === 'player' || undefined, reply_to: par ? '@' + (U(par.authorId)?.handle || '?') : undefined, text: p.text };
    })
  };
}
// "3", "[3]" or 3
const toNum = v => (typeof v === 'number' ? v : /^\s*\[?(\d+)\]?\s*$/.test(String(v)) ? Number(String(v).replace(/\D/g, '')) : NaN);
const VERDICTS = ['viral', 'good', 'mid', 'flop', 'ratioed', 'controversial'];
const newsTexts = () => (state.news || []).slice(-12).map(n => n.text);

// Keep only the replies that respond to THIS job's target post, then enforce the tone mix for how the post landed.
// Sub-replies are re-pointed at their surviving parents (positions shift when replies are dropped or reordered).
function cleanReplies(r, { targets, background = [], verdict = null, forced = [], label = 'post', silent = false }) {
  const log = silent ? () => {} : console.log;
  const arr = Array.isArray(r.replies) ? r.replies : [];
  const tagged = arr.filter(x => x && typeof x === 'object').map(x => ({ ...x, stance: String(x.stance || '').toLowerCase(), _i: arr.indexOf(x) })); // original positions: sub_replies.to points at these
  if (forced.length) { // bots the player tagged answer first
    const tagIds = new Set(forced.map(f => '@' + f.handle));
    tagged.sort((a, b) => (tagIds.has('@' + cleanHandle(b.handle)) ? 1 : 0) - (tagIds.has('@' + cleanHandle(a.handle)) ? 1 : 0));
  }
  const f = tone.filterReplies(tagged, targets, background);
  let kept = f.kept;
  if (f.dropped.length) log(`[owl] ${label}: dropped ${f.dropped.length} reply(ies) not about the target post (${f.dropped.map(d => `"${SNIP(d.r && d.r.reacting_to || '', 28)}" ${d.why}`).join('; ')})`);
  if (f.unchecked) log(`[owl] ${label}: model sent no reacting_to, replies could not be verified`);
  let counts = null;
  if (verdict) {
    const b = tone.balance(kept, verdict);
    if (b.dropped.length) log(`[owl] ${label}: trimmed ${b.dropped.length} reply(ies) to keep the tone right for a ${verdict} post (${b.dropped.map(d => d.why).join('; ')})`);
    kept = tone.adjustLikes(b.replies, verdict);
    counts = {}; for (const s of tone.STANCES) counts[s] = kept.filter(x => x.stance === s).length;
    log(`[owl] tone ${verdict}: ${tone.STANCES.map(s => `${s} ${counts[s]}`).join(', ')}`);
  }
  const subArr = Array.isArray(r.sub_replies) ? r.sub_replies : [];
  const noneHave = subArr.every(s => !s || !String(s.reacting_to || '').trim());
  const subs = [];
  for (const s of subArr) {
    const idx = s ? kept.findIndex(k => k._i === Number(s.to)) : -1;
    if (idx < 0) continue;
    const v = tone.checkReacting(s.reacting_to, [kept[idx].text]);
    if (v === 'ok' || v === 'callback' || (v === 'missing' && noneHave)) subs.push({ ...s, to: idx });
    else log(`[owl] ${label}: dropped a sub-reply that is not about the reply it answers`);
  }
  r.replies = kept; r.sub_replies = subs;
  return counts;
}


// ---------------------------------------------------------------- relationships
function relFollowCheck(bot, player) {
  if (bot.kind !== 'char') return;
  const score = castle.relScore(state, bot, player.id);
  if (score >= 6 && !bot.following.includes(player.id) && Math.random() < 0.5) {
    setTimeout(() => {
      if (bot.following.includes(player.id)) return;
      bot.following.push(player.id); player.followers++; player.hype = Math.min(100, player.hype + 2);
      emitUser(bot); emitUser(player);
      castle.pushNews(state, `${bot.name} started following ${player.name}`, 3, 'follow');
      notify(player.id, { type: 'follow', fromId: bot.id, text: `${bot.name} started following you` });
    }, rand(4000, 15000));
  } else if (score <= -6 && bot.following.includes(player.id)) {
    bot.following = bot.following.filter(x => x !== player.id);
    player.followers = Math.max(0, player.followers - 1); player.hype = Math.max(0, player.hype - 2);
    emitUser(bot); emitUser(player);
    castle.pushNews(state, `${bot.name} unfollowed ${player.name}`, 3, 'unfollow');
    notify(player.id, { type: 'unfollow', fromId: bot.id, text: `${bot.name} unfollowed you` });
  }
}
// apply the AI's relationship/opinion shifts toward one player
function applyShifts(r, player) {
  const seen = new Set();
  for (const s of (Array.isArray(r.relationship_shifts) ? r.relationship_shifts : [])) {
    const bot = byHandle(s && s.handle);
    if (!bot || bot.kind === 'player') continue;
    seen.add(bot.id);
    castle.relInteract(state, bot, player, clampInt(s.delta, -3, 3), s.memory);
    relFollowCheck(bot, player);
  }
  for (const s of (Array.isArray(r.opinion_shifts) ? r.opinion_shifts : [])) {
    const n = byHandle(s && s.handle);
    if (n && n.kind === 'npc' && !seen.has(n.id)) castle.relInteract(state, n, player, clampInt(s.delta, -3, 3), null);
  }
}
const shiftBotIds = r => new Set((Array.isArray(r.relationship_shifts) ? r.relationship_shifts : []).map(s => byHandle(s && s.handle)?.id).filter(Boolean));
const SENT = { positive: 1, negative: -1, neutral: 0 };

// ---------------------------------------------------------------- reactions
// bots the player mentioned reply first
function forcedFirst(r, forced) {
  if (!forced.length || !Array.isArray(r.replies)) return;
  const ids = new Set(forced.map(f => '@' + f.handle));
  const norm = h => '@' + cleanHandle(h);
  r.replies.sort((a, b) => (ids.has(norm(b.handle)) ? 1 : 0) - (ids.has(norm(a.handle)) ? 1 : 0));
}

async function reactToPost(post, forced = []) {
  const author = U(post.authorId);
  setActivity(post.id, 'Owls are reacting…');
  let [cs, ns] = withForced(pickChars(5, post.text), pickNPCs(8, author.id), forced);
  cs = cs.slice(0, 6); ns = ns.slice(0, 9);
  const allowed = new Set([...cs, ...ns].map(x => x.id));
  const quoted = post.quoteId ? postIndex.get(post.quoteId) : null;
  const hot = hotEventFor(author.id);
  const followUp = hot && hot.postId !== post.id ? hot : null;
  if (followUp) {
    followUp.followUps = (followUp.followUps || 0) + 1;
    followUp.until = Math.min(followUp.until + 60e3, followUp.startedAt + eventLife(followUp.intensity) * 1.5);
    castle.pushNews(state, `${author.name} posted again while trending: "${SNIP(post.text, 50)}"`, 3, 'followup');
  }
  const ids = pids();
  const feed = feedNumbered(10, post.id);
  const leanFor = b => tone.leanLabel(b, author, castle.relScore(state, b, author.id));
  const target = { by: `@${author.handle} (${author.name})`, text: post.text, quoting: quoted ? { by: '@' + (U(quoted.authorId)?.handle || '?'), text: quoted.text } : undefined };
  const prompt = buildPrompt('post', {
    task: quoted ? 'A player quote-posted someone. Decide how the castle reacts to the quote.' : 'A player just posted. Decide how the castle reacts.',
    trend: state.trend,
    author: { ...uctx(author), their_recent_posts: recentBy(author.id) },
    mentioned_accounts: forced.length ? forced.map(m => '@' + m.handle) : undefined,
    mention_note: forced.length ? 'These accounts were tagged directly. Each of them almost always replies directly to the player, in character, and they reply first.' : undefined,
    follow_up_to_hype_event: followUp ? { what: followUp.summary, note: 'The player posted again while their moment is still hot. React to it as a follow-up: doubling down, the sequel, trying to milk it.' } : undefined,
    other_players: otherPlayersCtx(author.id),
    recent_feed: feed.items,
    available_characters: cs.map(c => ({ ...cctx(c, ids), lean: leanFor(c) })),
    available_students: ns.map(n => ({ ...nctx(n, author.id, ids), lean: leanFor(n) })),
    bot_pairs: pairsCtx([...cs, ...ns], 6),
    scoring: 'quality 0-100 based on wit, boldness, in-world flavour, relevance to the trend, and originality. Repetitive, low-effort or cringe posts flop. Controversial posts get lots of replies but risk a ratio. likes scale with the author\'s followers: flop <1%, mid 1-5%, good 5-20%, viral 20-80% (+ flat 5-40). follower_delta roughly: flop negative (up to -15%), mid small, good +5-15%, viral +20-60%. hype_delta -20..+20. house_points -30..+30 (McGonagall/Snape/staff can award or deduct). ' + tone.QUOTA_TEXT + ' Each bot has a lean (house loyalty, warmth): follow it. Find the funny in the post and riff on it (yes and); do not just insult the author.',
    output_shape: {
      quality: 'int', verdict: 'one of: viral | good | mid | flop | ratioed | controversial',
      likes: 'int', reposts: 'int', follower_delta: 'int', hype_delta: 'int', house_points: 'int',
      replies: [{ handle: '@handle from available lists', text: 'reply (may @mention listed accounts or players)', stance: 'support | joke | neutral | critical | hostile', reacting_to: 'a short phrase QUOTED from the target post, or callback:<which earlier post> for an explicit callback', likes: 'int', mention_sentiment: 'only if the reply @mentions a player: positive | negative | neutral' }],
      sub_replies: [{ to: 'index (0-based) of the reply in replies that this one answers', handle: '@handle from the available lists (not the author of that reply)', text: 'a bot answering a different bot reply: agree, dunk, or take a house side', likes: 'int', stance: 'agree | dunk | house', reacting_to: 'a short phrase quoted from the reply it answers' }],
      reposts_by: ['0-3 @handles from the available lists who would repost this to their own followers (only if good or viral)'],
      relationship_shifts: [{ handle: '@bot who now feels differently about the author', delta: 'int -3..3', memory: 'one short line, past tense, max 12 words, e.g. "mocked Gryffindor; replied"' }],
      prophet_headline: 'string or null — only if Rita Skeeter would write a sensational headline twisting this post (rare, ~15%)'
    },
    reply_count: '2-3 characters + 3-5 students, ordered as they would arrive. Replies can also argue with each other. Add 0-3 sub_replies where bots answer other bots replies.'
  }, target);

  let r = null;
  try { r = await ai(prompt, { kind: 'post' }); } catch (e) { console.error('[owl] AI post failed:', e.message); }
  if (!r) r = mockPost(post, cs, ns, forced);
  // only replies that respond to THIS post survive, then the tone mix for how it landed is enforced
  cleanReplies(r, { targets: [post.text, ...(quoted ? [quoted.text] : [])], background: [...feed.items.map(i => i.text), ...newsTexts()], verdict: VERDICTS.includes(r.verdict) ? r.verdict : 'mid', forced, label: 'post' });

  const f = author.followers;
  const likes = clampInt(r.likes, 0, Math.round(f * 0.9) + 60);
  post.targetLikes = Math.max(post.likes, likes);
  post.targetReposts = clampInt(r.reposts, 0, Math.round(likes * 0.4) + 5);
  growing.add(post.id);

  const { endDelay, count } = scheduleBotReplies(r.replies, post, allowed, { player: author, about: post.text, skipMem: shiftBotIds(r), sub: r.sub_replies });
  setTimeout(() => setActivity(post.id, null), Math.max(4000, endDelay - 2000));

  for (const h of (Array.isArray(r.reposts_by) ? r.reposts_by : []).slice(0, 3)) {
    const bot = byHandle(h);
    if (bot && allowed.has(bot.id)) setTimeout(() => botRepost(bot, post), rand(4000, endDelay + 8000));
  }

  setTimeout(() => {
    const verdict = ['viral', 'good', 'mid', 'flop', 'ratioed', 'controversial'].includes(r.verdict) ? r.verdict : 'mid';
    const fd = clampInt(r.follower_delta, -Math.round(f * 0.2) - 3, Math.round(f * 0.6) + 40);
    const hd = clampInt(r.hype_delta, -20, 20);
    const hp = clampInt(r.house_points, -30, 30);
    const gal = Math.max(0, Math.round(likes / 40)) + (verdict === 'viral' ? 15 : 0);
    author.followers = Math.max(0, author.followers + fd);
    author.hype = clampInt(author.hype + hd, 0, 100);
    author.housePoints += hp;
    author.galleons += gal;
    post.verdict = verdict;
    post.vmult = V.pickVMult(verdict);
    growing.add(post.id);
    castle.recordVerdict(author, verdict);
    io.emit('post:update', slim(post));
    emitUser(author);
    applyShifts(r, author);
    const sign = v => (v >= 0 ? '+' : '') + v;
    notify(author.id, { type: 'verdict', postId: post.id, text: `Your owl landed: ${verdict.toUpperCase()} · ${sign(fd)} followers · ${sign(hd)} hype${hp ? ` · ${sign(hp)} house pts` : ''}${gal ? ` · +${gal} galleons` : ''}` });
    if (verdict === 'viral') for (const pl of players()) if (pl.id !== author.id) notify(pl.id, { type: 'friend_viral', fromId: author.id, postId: post.id, text: `${author.name}'s post is going viral 👀` });

    // castle news + hype events
    const snip = SNIP(post.text, 55);
    const evBase = { player: author, post };
    // bots sliding into the DMs, tied to what just happened (capped per hour in canOpen)
    if (verdict === 'viral') { botOpener('rita.skeeter', author, 'fish', 'their post just went viral and she smells gossip'); botOpener(pick(['fred.www', 'george.www']), author, 'pitch', 'they are suddenly very visible, so a product pitch'); botOpener(null, author, 'crush', 'they saw their viral post'); }
    else if (verdict === 'controversial' || verdict === 'ratioed') botOpener('hgranger', author, 'tellOff', `their latest post was ${verdict}`);
    else if (verdict === 'good') { botOpener(pick(['fred.www', 'george.www']), author, 'pitch', 'their post did well'); botOpener(null, author, 'crush', 'they liked their post'); }
    if (verdict === 'viral') {
      castle.pushNews(state, `${author.name}'s post went viral: "${snip}"`, 4, 'viral');
      createHypeEvent({ ...evBase, type: 'viral', intensity: (r.quality || 0) >= 95 || likes > f * 0.5 ? 5 : 4, summary: `${author.name} went viral: "${snip}"`, title: `${author.name}'s ${author.house} take` });
    } else if (verdict === 'controversial') {
      castle.pushNews(state, `${author.name}'s post split the castle: "${snip}"`, 3, 'controversial');
      createHypeEvent({ ...evBase, type: 'controversial', intensity: 3, summary: `${author.name} started a fight: "${snip}"`, title: `${author.name}'s ${author.house} take` });
    } else if (verdict === 'flop' || verdict === 'ratioed') {
      castle.pushNews(state, `${author.name}'s post ${verdict === 'ratioed' ? 'got ratioed' : 'flopped'}: "${snip}"`, 2, 'flop');
      createHypeEvent({ ...evBase, type: 'flop', intensity: 1, sign: -1, summary: `${author.name} ${verdict === 'ratioed' ? 'got ratioed' : 'flopped'}: "${snip}"`, title: `${author.name}'s ${author.house} L` });
    }

    if (r.prophet_headline && typeof r.prophet_headline === 'string') {
      const rita = byHandle('rita.skeeter');
      if (rita) setTimeout(() => {
        const headline = r.prophet_headline.slice(0, 220);
        const p = mkPost(rita.id, `EXCLUSIVE: ${headline} (@${author.handle})`, null);
        p.targetLikes = rand(300, 1800); p.targetReposts = rand(40, 300);
        addPost(p);
        author.followers += rand(10, 60) + Math.round(author.followers * 0.05); emitUser(author);
        castle.pushNews(state, `Rita Skeeter ran a story on ${author.name}: "${SNIP(headline, 70)}"`, 4, 'rita');
        createHypeEvent({ player: author, post: p, type: 'prophet', intensity: 3, summary: `Rita Skeeter's story on ${author.name}`, title: `Rita on ${author.name}` });
        for (const pl of players()) notify(pl.id, { type: 'prophet', fromId: rita.id, postId: p.id, text: pl.id === author.id ? 'Rita Skeeter wrote about you.' : `Rita Skeeter wrote about ${author.name}.` });
      }, rand(8000, 20000));
    }
  }, Math.max(6000, endDelay + 1500));
  return count;
}

async function reactToReply(reply, parent, forced = []) {
  const me = U(reply.authorId), pa = U(parent.authorId);
  setActivity(reply.id, 'Owls are reacting…');
  const vsPlayer = pa.kind === 'player' && pa.id !== me.id;
  const isQuote = reply.quoteId === parent.id;
  let cs = pickChars(4, reply.text + ' ' + parent.text);
  if (pa.kind === 'char' && !cs.includes(pa)) cs.unshift(pa);
  let ns = pickNPCs(6, me.id);
  if (pa.kind === 'npc' && !ns.includes(pa)) ns.unshift(pa);
  forced = forced.slice();
  const story = storyOfPost(parent);
  if (story) { // the player joined a bot storyline thread: its bots are pulled in to react
    for (const id of story.bots) { const b = U(id); if (b && b.kind !== 'player' && !forced.includes(b)) forced.push(b); }
    castle.pushNews(state, `${me.name} jumped into the "${story.title}" thread`, 2, 'story');
  }
  [cs, ns] = withForced(cs, ns, forced);
  const allowed = new Set([...cs, ...ns].map(x => x.id));
  const root = parent.rootId ? postIndex.get(parent.rootId) : null;
  const ids = pids();
  const rfeed = feedNumbered(8, reply.id);
  const target = { by: `@${me.handle} (${me.name})`, text: reply.text, in_reply_to: { by: `@${pa.handle} (${pa.name})`, text: parent.text } };
  const prompt = buildPrompt(vsPlayer ? 'duel' : 'reply', {
    task: vsPlayer
      ? (isQuote
        ? 'A player QUOTE-POSTED the OTHER player\'s post to their own feed. This is a public duel in front of the castle. Judge who won the exchange and have bots pile in, taking sides by house.'
        : 'A player replied to the OTHER player\'s post. This is a duel in front of the castle. Judge who won the exchange and have bots pile in, taking sides by house.')
      : pa.kind === 'player' ? 'A player replied in their own thread. Bots react.' : `A player replied to ${pa.name}'s post. ${pa.name} should usually reply back first, in character, then others may pile in.`,
    mentioned_accounts: forced.length ? forced.map(m => '@' + m.handle) : undefined,
    mention_note: forced.length ? 'These accounts were tagged directly. Each of them almost always replies directly to the player, in character, and they reply first.' : undefined,
    trend: state.trend,
    thread_root: root ? { by: '@' + U(root.authorId)?.handle, text: root.text } : undefined,
    recent_feed: rfeed.items,
    available_characters: cs.map(c => cctx(c, ids)),
    available_students: ns.map(n => nctx(n, me.id, ids)),
    bot_pairs: pairsCtx([...cs, ...ns], 6),
    storyline: story ? { title: story.title, bots: story.bots.map(id => U(id) ? '@' + U(id).handle : null).filter(Boolean), summary: story.summary, stage: story.stage, note: 'The player just jumped into this ongoing bot storyline thread. The storyline bots notice the player joining and react to them in character, continuing or escalating the feud.' } : undefined,
    output_shape: {
      winner: 'reply | parent | draw',
      reply_likes: 'int (scale to replier followers)',
      replies: [{ handle: '@handle', stance: 'support | joke | neutral | critical | hostile', reacting_to: 'a short phrase QUOTED from the target (the player reply), or callback:<which earlier post>', text: 'reply to the player\'s reply', likes: 'int', mention_sentiment: 'only if the reply @mentions a player: positive | negative | neutral' }],
      sub_replies: [{ to: 'index (0-based) of the reply in replies that this one answers', handle: '@handle (not the author of that reply)', text: 'a bot answering a different bot reply: agree, dunk, or take a house side', likes: 'int', stance: 'agree | dunk | house', reacting_to: 'a short phrase quoted from the reply it answers' }],
      follower_steal: 'int — followers the winner takes from the loser (0 if draw or not a duel)',
      hype_delta: 'int -15..15 for the replier',
      parent_hype_delta: 'int -15..15 for the parent author (only matters if player)',
      house_points: 'int -20..20 for the replier',
      relationship_shifts: [{ handle: '@bot who now feels differently about the replier', delta: 'int -3..3', memory: 'one short line, past tense, max 12 words' }]
    },
    reply_count: '2-5 replies'
  }, target);

  let r = null;
  try { r = await ai(prompt, { kind: vsPlayer ? 'duel' : 'reply' }); } catch (e) { console.error('[owl] AI reply failed:', e.message); }
  if (!r) r = mockReply(reply, parent, cs, ns, forced);
  cleanReplies(r, { targets: [reply.text, parent.text], background: [...rfeed.items.map(i => i.text), ...(root ? [root.text] : []), ...newsTexts()], verdict: null, forced, label: vsPlayer ? 'duel' : 'reply' });

  reply.targetLikes = Math.max(reply.likes, clampInt(r.reply_likes, 0, Math.round(me.followers * 0.6) + 30));
  growing.add(reply.id);
  const { endDelay } = scheduleBotReplies(r.replies, reply, allowed, { max: 6, start: 2000, player: me, about: reply.text, skipMem: shiftBotIds(r), sub: r.sub_replies });
  setTimeout(() => setActivity(reply.id, null), Math.max(3500, endDelay - 1500));

  setTimeout(() => {
    const hd = clampInt(r.hype_delta, -15, 15), hp = clampInt(r.house_points, -20, 20);
    me.hype = clampInt(me.hype + hd, 0, 100);
    me.housePoints += hp;
    applyShifts(r, me);
    const sign = v => (v >= 0 ? '+' : '') + v;
    if (vsPlayer) {
      const winner = ['reply', 'parent', 'draw'].includes(r.winner) ? r.winner : 'draw';
      const phd = clampInt(r.parent_hype_delta, -15, 15);
      pa.hype = clampInt(pa.hype + phd, 0, 100);
      let steal = 0, loserBefore = 0, champ = null, loser = null;
      if (winner !== 'draw') {
        loser = winner === 'reply' ? pa : me; champ = winner === 'reply' ? me : pa;
        loserBefore = loser.followers;
        steal = clampInt(r.follower_steal, 0, Math.max(2, Math.round(loser.followers * 0.12)));
        loser.followers = Math.max(0, loser.followers - steal); champ.followers += steal;
      }
      reply.verdict = winner === 'reply' ? 'won' : winner === 'parent' ? 'lost' : 'draw';
      castle.recordDuel(me, pa, champ ? champ.id : null);
      io.emit('post:update', slim(reply));
      emitUser(pa);
      const res = winner === 'draw' ? 'Draw' : (winner === 'reply' ? `${me.name} won` : `${pa.name} won`);
      notify(me.id, { type: 'duel', fromId: pa.id, postId: reply.id, text: `Duel vs ${pa.name}: ${res}${steal ? ` · ${steal} followers changed hands` : ''} · ${sign(hd)} hype` });
      notify(pa.id, { type: 'duel', fromId: me.id, postId: reply.id, text: `${me.name} came at you. ${res}${steal ? ` · ${steal} followers changed hands` : ''} · ${sign(phd)} hype` });
      if (champ) {
        if (loser.kind === 'player') botOpener('d.malfoy', loser, 'gloat', `${loser.name} just lost a duel to ${champ.name}`);
        const ratio = steal / Math.max(1, loserBefore);
        castle.pushNews(state, `${champ.name} beat ${loser.name} in a duel (${steal} followers changed hands)`, ratio >= 0.08 ? 4 : 3, 'duel');
        if (steal >= 4 || ratio >= 0.06) createHypeEvent({ player: champ, post: reply, type: 'duel', intensity: ratio >= 0.15 ? 4 : ratio >= 0.08 ? 3 : 2, summary: `${champ.name} beat ${loser.name} in a duel (${steal} followers swung)`, title: `${me.name} vs ${pa.name}` });
      } else castle.pushNews(state, `${me.name} and ${pa.name} fought to a draw`, 2, 'duel');
    }
    emitUser(me);
  }, Math.max(5000, endDelay + 1500));
}

// ---------------------------------------------------------------- hype waves
const eventById = id => state.events.find(e => e.id === id);
const activeEvents = (now = Date.now()) => state.events.filter(e => e.until > now);
const eventLife = i => i * 8 * 60e3; // 8-40 minutes of "main character" time
const heat = (ev, now = Date.now()) => Math.max(0, ev.intensity * (1 - (now - ev.startedAt) / Math.max(1, ev.until - ev.startedAt)));
const hotEventFor = pid => activeEvents().filter(e => e.playerId === pid).sort((a, b) => heat(b) - heat(a))[0];
function eventForPost(p) {
  const refs = [p.quoteId, p.rootId, p.parentId].filter(Boolean);
  return refs.length ? activeEvents().find(e => refs.includes(e.postId)) || null : null;
}
const publicEvents = () => activeEvents().map(e => ({ id: e.id, type: e.type, playerId: e.playerId, postId: e.postId, title: e.title, summary: e.summary, intensity: e.intensity, posts: e.posts || 0, startedAt: e.startedAt, until: e.until, heat: +heat(e).toFixed(2) }));
let evTimer = null;
function emitEvents() { if (evTimer) return; evTimer = setTimeout(() => { evTimer = null; io.emit('events', publicEvents()); save(); }, 600); }

// one active event per player; a bigger event upgrades it (and queues a follow-up wave once the current one ends)
function createHypeEvent({ type, player, post, summary, intensity, sign = 1, title }) {
  const now = Date.now();
  intensity = clampInt(intensity, 1, 5);
  const ev = hotEventFor(player.id);
  if (ev) {
    if (intensity > ev.intensity) {
      Object.assign(ev, { type, postId: post.id, summary, title, intensity, sign, until: Math.max(ev.until, now + eventLife(intensity)) });
      castle.pushNews(state, `${player.name}'s moment just got bigger: ${summary}`, Math.min(5, intensity + 1), 'hype');
      if (ev.waveState === 'running') ev.upgrade = true; else runWave(ev).catch(e => console.error('[owl] wave', e));
    } else ev.until = Math.min(ev.until + 2 * 60e3, ev.startedAt + eventLife(ev.intensity) * 1.5);
    emitEvents();
    return ev;
  }
  const ne = { id: uid(), type, playerId: player.id, postId: post.id, summary, title, intensity, sign, startedAt: now, until: now + eventLife(intensity), decay: 'linear', posts: 0, waveState: 'idle', upgrade: false, followUps: 0 };
  state.events.push(ne);
  state.events = state.events.filter(e => e.until > now - 3600e3).slice(-20);
  castle.pushNews(state, `${player.name} is trending at Hogwarts: ${summary}`, Math.min(5, intensity + 1), 'hype');
  notify(player.id, { type: 'trending', postId: post.id, text: sign > 0 ? `🔥 You're trending at Hogwarts: ${title}` : `🔥 You're trending at Hogwarts (not in a good way): ${title}` });
  for (const pl of players()) if (pl.id !== player.id) notify(pl.id, { type: 'friend_viral', fromId: player.id, postId: post.id, text: `🔥 ${player.name} is trending at Hogwarts 👀` });
  emitEvents();
  runWave(ne).catch(e => console.error('[owl] wave', e));
  return ne;
}

const WAVE_VOICES = ['d.malfoy', 'fred.www', 'george.www', 'm.mcgonagall', 'prof.snape', 'g.lockhart', 'luna.lovegood'];
function waveCast(player, ev) {
  const voiced = WAVE_VOICES.map(byHandle).filter(Boolean);
  if (ev.sign < 0) { const pansy = byHandle('pansy.p'); if (pansy) voiced.splice(1, 0, pansy); }
  const cs = voiced.slice(0, Math.min(7, ev.intensity + 3));
  const rivals = HOUSES.filter(h => h !== player.house);
  const stans = shuffle(npcs().filter(n => n.house === player.house)).slice(0, 3);
  const haters = shuffle(npcs().filter(n => rivals.includes(n.house))).slice(0, 3);
  return { cs, ns: [...stans, ...haters] };
}

// ONE AI call per wave; the posts it returns are spread over 1-5 minutes by intensity
async function runWave(ev) {
  if (ev.waveState === 'running') return;
  const player = U(ev.playerId), orig = postIndex.get(ev.postId);
  if (!player || !orig) return;
  ev.waveState = 'running'; ev.upgrade = false;
  const origId = orig.id; // this wave belongs to THIS post, even if the event is later upgraded to another one
  const size = Math.min(8, 3 + ev.intensity);
  const others = players().filter(p => p.id !== player.id);
  const cast = waveCast(player, ev);
  const allowed = new Set([...cast.cs, ...cast.ns].map(x => x.id));
  const ids = pids();
  let r = null;
  try {
    const prompt = buildPrompt('hype-wave', {
      task: `A hype wave is hitting the castle because of ${player.name}. In ONE response write the follow-up posts people make over the next few minutes. Mix: quote posts of the original ("this is the funniest thing posted this term"), standalone posts @mentioning the player, stans and haters forming camps along house lines, characters reacting in their own voice (Draco jealous, Fred and George trying to sell merch about it, McGonagall or Snape awarding or deducting house points, Lockhart claiming he inspired it, Luna's weird take), meme-style riffs and copycat posts imitating the original${others.length ? ', and at least one post tagging the other player (' + others.map(o => '@' + o.handle).join(', ') + ') like "you seeing this??"' : ''}.`,
      event: { type: ev.type, summary: ev.summary, intensity: ev.intensity, mood: ev.sign > 0 ? 'celebration, envy, stan vs hater camps' : 'mockery and pile-on, a few sympathetic voices' },
      player: uctx(player),
      other_players: others.map(o => '@' + o.handle),
      available_characters: cast.cs.map(c => cctx(c, ids)),
      available_students: cast.ns.map(n => nctx(n, player.id, ids)),
      output_shape: { posts: [{ handle: '@handle from available lists', kind: 'quote | post | reply', reacting_to: 'REQUIRED for quote and reply: a short phrase quoted from the target post', text: 'post text, may @mention players', likes: 'int', camp: 'stan | hater | neutral', points: 'int -15..15 house points awarded/deducted from the player, ONLY for McGonagall/Snape, else 0' }] },
      count: size
    }, { by: '@' + (U(orig.authorId)?.handle || '?'), text: orig.text });
    r = await ai(prompt, { kind: 'hype-wave' });
  } catch (e) { console.error('[owl] AI wave failed:', e.message); }
  const waveMock = !r || !Array.isArray(r.posts);
  if (waveMock) { r = mockWave(ev, player, orig, cast, others, size); for (const it of r.posts) if (it.kind !== 'post' && !it.reacting_to) it.reacting_to = tone.phraseOf(orig.text); }

  let items = r.posts.filter(it => it && allowed.has(byHandle(it.handle)?.id) && String(it.text || '').trim()).slice(0, size);
  items = items.map(it => ({ ...it, kind: ['quote', 'post', 'reply'].includes(it.kind) ? it.kind : 'post', text: String(it.text).trim().slice(0, 280) }));
  { // quotes and replies must be about the post the wave belongs to
    const targeted = items.filter(it => it.kind !== 'post');
    const ok = new Set(tone.filterReplies(targeted, [orig.text], []).kept);
    if (ok.size < targeted.length) console.log(`[owl] hype-wave: dropped ${targeted.length - ok.size} quote/reply item(s) not about the original post`);
    items = items.filter(it => it.kind === 'post' || ok.has(it));
  }
  const tags = (it, h) => new RegExp('@' + h.replace(/\./g, '\\.') + '(?![a-z0-9_.])', 'i').test(it.text);
  if (items.length) { // guarantee the player is tagged and the other player gets pulled in
    if (!items.some(it => it.kind === 'post')) items[items.length - 1].kind = 'post';
    const firstPost = items.find(it => it.kind === 'post');
    if (!items.some(it => it.kind === 'post' && tags(it, player.handle))) firstPost.text = `@${player.handle} ${firstPost.text}`.slice(0, 280);
    for (const o of others) if (!items.some(it => tags(it, o.handle))) {
      const tgt = [...items].reverse().find(it => it.kind === 'post') || firstPost;
      tgt.text = `${tgt.text} @${o.handle} you seeing this??`.slice(0, 280);
    }
  }
  const dur = 60e3 * (0.25 + ev.intensity * 0.95) * WAVE_SCALE;
  const fr = items.map(() => Math.random()).sort((a, b) => a - b);
  let last = 0;
  items.forEach((it, i) => {
    const delay = Math.round(Math.max(800, 2500 * WAVE_SCALE) + fr[i] * dur);
    last = Math.max(last, delay);
    setTimeout(() => {
      const o = postIndex.get(origId), bot = byHandle(it.handle);
      if (!o || !bot) return;
      let p;
      if (it.kind === 'quote') { p = mkPost(bot.id, it.text, null); p.quoteId = o.id; }
      else if (it.kind === 'reply') p = mkPost(bot.id, it.text, o.id);
      else p = mkPost(bot.id, it.text, null);
      p.eventId = ev.id;
      p.targetLikes = clampInt(Math.round((it.likes ?? rand(5, 120)) * (0.6 + 0.2 * ev.intensity)), 0, Math.round(bot.followers * 0.1) + 25);
      p.targetReposts = Math.round(p.targetLikes * Math.random() * 0.12);
      if (it.camp === 'stan' || it.camp === 'hater' || it.camp === 'neutral') p.mentionSentiment = it.camp === 'stan' ? 1 : it.camp === 'hater' ? -1 : 0;
      addPost(p);
      engage(o, 'wave', null, rand(40, 160) * ev.intensity); o.targetLikes += rand(0, 2 * ev.intensity);
      const pts = clampInt(it.points, -15, 15);
      if (pts && bot.house === 'Staff') {
        player.housePoints += pts; emitUser(player);
        castle.pushNews(state, `${bot.name} ${pts > 0 ? 'awarded' : 'deducted'} ${Math.abs(pts)} house points ${pts > 0 ? 'to' : 'from'} ${player.name}`, Math.abs(pts) >= 10 ? 3 : 2, 'points');
      }
    }, delay);
  });
  setTimeout(() => {
    ev.waveState = 'idle';
    if (ev.upgrade && ev.until > Date.now()) runWave(ev).catch(e => console.error('[owl] wave', e));
    emitEvents();
  }, last + 1000);
}

// followers trickle in (or out) while an event is hot; expired events are announced once
setInterval(() => {
  const now = Date.now();
  for (const ev of state.events) {
    if (ev.until <= now) { if (!ev.ended) { ev.ended = true; emitEvents(); } continue; }
    const pl = U(ev.playerId); const h = heat(ev, now);
    if (!pl || h < 0.3) continue;
    const d = Math.round((rand(0, 2) + pl.followers * 0.003) * (h / 3)) * ev.sign;
    if (d) { pl.followers = Math.max(0, pl.followers + d); emitUser(pl); }
  }
}, 20000);

// ---------------------------------------------------------------- direct messages
const uploadStamp = new Map();
function imageExt(buf) {
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}
const dmStamps = new Map();
function dmRateOk(id) {
  const now = Date.now(), a = (dmStamps.get(id) || []).filter(t => now - t < 60e3);
  if (a.length >= 20) return false;
  a.push(now); dmStamps.set(id, a); return true;
}

const convIdOf = (a, b) => [a, b].sort().join('~');
const convsFor = pid => Object.values(state.dms).filter(c => c.members.includes(pid)).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
function getConv(a, b, create) {
  const id = convIdOf(a, b);
  let c = state.dms[id];
  if (!c && create) c = state.dms[id] = { id, members: [a, b].sort(), msgs: [], summary: '', sinceSummary: 0, read: {}, coldUntil: 0, lastTs: Date.now() };
  return c;
}
const pubConv = (c, n = 25) => ({ id: c.id, members: c.members, msgs: c.msgs.slice(-n), read: c.read, lastTs: c.lastTs, total: c.msgs.length });
function emitConv(conv, event, payload) {
  for (const id of conv.members) if (U(id) && U(id).kind === 'player') io.to('u:' + id).emit(event, payload);
}
function addDM(conv, from, text, extra = {}) {
  const msg = { id: uid(), from, text, ts: Date.now(), ...extra };
  conv.msgs.push(msg);
  if (conv.msgs.length > 300) conv.msgs = conv.msgs.slice(-300);
  conv.lastTs = msg.ts; conv.sinceSummary = (conv.sinceSummary || 0) + 1;
  conv.read[from] = msg.ts; // whoever sends has read everything before their own message
  emitConv(conv, 'dm:msg', { convId: conv.id, members: conv.members, msg });
  save();
  return msg;
}
function markRead(conv, pid) {
  const ts = Date.now();
  conv.read[pid] = ts;
  emitConv(conv, 'dm:read', { convId: conv.id, by: pid, ts });
  save();
}

// bot messages are queued (and persisted) so long delays survive a restart; kinds: text | react | seen
const dmTimers = new Map();
function enqueueBotMsg(q) {
  q.id = uid();
  state.dmQueue.push(q);
  scheduleQueued(q);
  save();
  return q;
}
function scheduleQueued(q) {
  const wait = Math.max(0, q.at - Date.now());
  const typing = q.kind === 'text' ? Math.min(DM.typingMs(q.text), wait) : 0;
  if (typing > 0) dmTimers.set(q.id + 't', setTimeout(() => botTyping(q, true), wait - typing));
  dmTimers.set(q.id, setTimeout(() => deliverQueued(q.id), wait));
}
function botTyping(q, on) {
  const conv = state.dms[q.convId];
  if (conv) emitConv(conv, 'dm:typing', { convId: conv.id, from: q.from, typing: on });
}
function dropQueued(q) {
  clearTimeout(dmTimers.get(q.id)); clearTimeout(dmTimers.get(q.id + 't'));
  dmTimers.delete(q.id); dmTimers.delete(q.id + 't');
  state.dmQueue = state.dmQueue.filter(x => x.id !== q.id);
}
function cancelQueued(convId, botId) {
  for (const q of state.dmQueue.filter(x => x.convId === convId && x.from === botId)) { botTyping(q, false); dropQueued(q); }
}
function deliverQueued(id) {
  const q = state.dmQueue.find(x => x.id === id);
  if (!q) return;
  dropQueued(q);
  const conv = state.dms[q.convId], bot = U(q.from);
  if (!conv || !bot) return;
  if (q.kind === 'seen') {
    conv.read[bot.id] = Date.now();
    emitConv(conv, 'dm:read', { convId: conv.id, by: bot.id, ts: conv.read[bot.id] });
    save();
  } else if (q.kind === 'react') {
    const target = conv.msgs.find(m => m.id === q.msgId);
    if (target) {
      target.reactions = [...(target.reactions || []).filter(r => r.by !== bot.id), { by: bot.id, emoji: q.emoji }];
      conv.read[bot.id] = Date.now();
      emitConv(conv, 'dm:react', { convId: conv.id, msgId: target.id, reactions: target.reactions });
      emitConv(conv, 'dm:read', { convId: conv.id, by: bot.id, ts: conv.read[bot.id] });
      save();
    }
  } else {
    botTyping(q, false);
    addDM(conv, bot.id, q.text);
  }
}

// a player messaged a bot: debounce quick bursts into ONE AI call
const dmBursts = new Map();
function onPlayerDM(conv, bot, player) {
  cancelQueued(conv.id, bot.id);
  clearTimeout(dmBursts.get(conv.id));
  dmBursts.set(conv.id, setTimeout(() => {
    dmBursts.delete(conv.id);
    runDMBurst(conv, bot, player).catch(e => console.error('[owl] dm burst', e));
  }, DM_DEBOUNCE_MS));
}

async function runDMBurst(conv, bot, player) {
  const msgs = conv.msgs;
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].from === player.id) i--;
  const burst = msgs.slice(i).map(m => m.text);
  if (!burst.length) return;
  const text = burst.join('\n');
  const hour = DM.sydneyHour(Date.now(), DM_FIXED_HOUR);
  if (conv.coldUntil > Date.now()) { // they ended the conversation: left on read for a while
    enqueueBotMsg({ convId: conv.id, from: bot.id, kind: 'seen', at: Date.now() + DM.seenDelayMs(bot, { scale: DM_TIME_SCALE }) });
    return;
  }
  const rel = castle.relView(state, bot, player.id);
  const summaryNeeded = (conv.sinceSummary || 0) >= 10;
  const recent = msgs.slice(-15).map(m => ({ from: m.from === player.id ? player.name : bot.name, text: m.text }));
  const ids = [player.id];
  const prompt = buildPrompt('dm', {
    task: `${player.name} is sending you direct messages. You are ${bot.name}. Decide how you respond like a real person would, not an assistant.`,
    persona: bot.kind === 'char' ? cctx(bot, ids) : nctx(bot, player.id, ids),
    player: uctx(player),
    now: { sydney_hour: hour },
    conversation: { summary: conv.summary || undefined, recent, new_messages: burst },
    summary_needed: summaryNeeded ? 'also return an updated "summary" (max 60 words) of the whole conversation so far' : undefined,
    behaviour: 'You may send 0-4 short messages (several in a row is fine), react with just an emoji, leave the player on read (ignore), reply later, or end the conversation if annoyed. Do not over-explain. Match your usual speed and tone: busy or aloof characters leave people on read.',
    output_shape: {
      actions: [{ kind: 'message | react | ignore | end', text: 'for message', emoji: 'for react', delay: 'fast | normal | slow | later' }],
      relationship_delta: 'int -3..3 (flattery, insults, helpfulness, betrayal)',
      relationship_memory: 'one short line',
      summary: 'only if summary_needed',
      rumour: { is_rumour: 'bool: did the player tell you gossip or a secret about someone or something?', subject: '@handle or a short topic', claim: 'the claim in one sentence', juiciness: 'int 1-5', believed: 'bool: do you believe it?', pass_to: '@handle if the player asked you to tell someone, else null' }
    }
  });
  let d = null;
  try { d = await ai(prompt, { kind: 'dm' }); } catch (e) { console.error('[owl] AI dm failed:', e.message); }
  if (!d || !Array.isArray(d.actions)) {
    d = DM.mockDM(bot, { text, history: recent.map(r => ({ from: r.from === bot.name ? 'bot' : 'player', text: r.text })), relScore: rel.score, player: player.name, summaryNeeded, hour });
  }
  applyDMDecision(conv, bot, player, d, hour);
}

function applyDMDecision(conv, bot, player, d, hour) {
  castle.relInteract(state, bot, player, clampInt(d.relationship_delta, -3, 3), d.relationship_memory || `messaged with ${player.name}`);
  if (bot.kind === 'char') relFollowCheck(bot, player);
  if (typeof d.summary === 'string' && d.summary.trim()) { conv.summary = d.summary.trim().slice(0, 500); conv.sinceSummary = 0; }
  else if ((conv.sinceSummary || 0) >= 10) { conv.summary = DM.summarizeHistory(conv.msgs.map(m => ({ from: m.from === player.id ? 'player' : 'bot', text: m.text })), bot, player.name); conv.sinceSummary = 0; }
  if (d.rumour && (d.rumour.is_rumour === true || d.rumour.is_rumour === 'true')) storeRumour(conv, bot, player, d.rumour);

  const scale = DM_TIME_SCALE, now = Date.now();
  const actions = d.actions.filter(a => a && ['message', 'react', 'ignore', 'end'].includes(a.kind)).slice(0, 5);
  const firstMsg = actions.find(a => a.kind === 'message' && String(a.text || '').trim());
  const firstAt = firstMsg ? now + DM.replyDelayMs(bot, { hint: firstMsg.delay, hour, scale }) : now + DM.seenDelayMs(bot, { scale });
  // the "Seen" receipt lands before the first reply (or alone when they leave you on read)
  const seenAt = Math.min(firstAt - 250, now + DM.seenDelayMs(bot, { scale }));
  if (!(firstMsg && firstAt - now < 1200)) enqueueBotMsg({ convId: conv.id, from: bot.id, kind: 'seen', at: Math.max(now + 300, seenAt) });
  const lastPlayerMsg = [...conv.msgs].reverse().find(m => m.from === player.id);
  let at = firstAt, sent = 0, lastAt = firstAt;
  for (const a of actions) {
    if (a.kind === 'ignore') continue;
    if (a.kind === 'react') {
      if (lastPlayerMsg && a.emoji) enqueueBotMsg({ convId: conv.id, from: bot.id, kind: 'react', emoji: String(a.emoji).slice(0, 4), msgId: lastPlayerMsg.id, at: Math.max(now + 800, seenAt + 400) });
      continue;
    }
    if (a.kind === 'end') { conv.coldUntil = lastAt + Math.max(3000, 30 * 60e3 * scale); continue; }
    const txt = String(a.text || '').trim().slice(0, 500);
    if (!txt || sent >= 4) continue;
    if (sent > 0) at = a.delay === 'later' ? lastAt + DM.replyDelayMs(bot, { hint: 'later', hour, scale }) : lastAt + Math.max(900, (a.delay === 'fast' ? rand(2500, 9000) : rand(5000, 20000)) * scale);
    enqueueBotMsg({ convId: conv.id, from: bot.id, kind: 'text', text: txt, at });
    lastAt = at; sent++;
  }
  save();
}

// ---------------------------------------------------------------- bot-first DMs
function canOpen(bot, player) {
  const now = Date.now();
  const list = (state.dmFirst[player.id] = (state.dmFirst[player.id] || []).filter(x => now - x.ts < 3600e3));
  if (list.length >= DM_FIRST_MAX) return false;
  if (list.some(x => x.bot === bot.id)) return false;
  const conv = getConv(bot.id, player.id);
  return !(conv && now - (conv.lastTs || 0) < Math.max(20e3, 5 * 60e3 * DM_TIME_SCALE));
}
function openerDM(bot, player, text) {
  const conv = getConv(bot.id, player.id, true);
  enqueueBotMsg({ convId: conv.id, from: bot.id, kind: 'text', text, at: Date.now() + 700 });
}
// reason: gloat | fish | pitch | tellOff | crush (see DM.OPENERS). Capped per player per hour and per bot.
function botOpener(handle, player, reason, why = '') {
  const spec = DM.OPENERS[reason];
  let bot = handle ? byHandle(handle) : null;
  if (reason === 'crush') bot = shuffle(npcs().filter(n => /crush|romantic/i.test(n.seed || '') && n.id !== player.id))[0] || pick(npcs());
  if (!spec || !bot || bot.kind === 'player') return;
  if (Math.random() > (DM_FIRST_CHANCE ?? spec.chance) || !canOpen(bot, player)) return;
  state.dmFirst[player.id].push({ ts: Date.now(), bot: bot.id });
  const delay = Math.max(800, rand(spec.delay[0], spec.delay[1]) * 1000 * DM_TIME_SCALE);
  setTimeout(async () => {
    let text = null;
    if (!MOCK) {
      try {
        const d = await ai(buildPrompt('dm-opener', {
          task: `${bot.name} is sending ${player.name} a first direct message, unprompted. Reason: ${why || reason}. Write the opening DM in character: short and natural, the way a real person would slide into someone's DMs.`,
          persona: bot.kind === 'char' ? cctx(bot, [player.id]) : nctx(bot, player.id, [player.id]),
          player: uctx(player), output_shape: { text: 'the DM' }
        }), { kind: 'dm-opener' });
        if (d && typeof d.text === 'string') text = d.text.trim().slice(0, 400);
      } catch (e) { console.error('[owl] AI opener failed:', e.message); }
    }
    if (!text) text = DM.styleText(bot, pick(spec.text), Math.random);
    openerDM(bot, player, text);
  }, delay);
}

// ---------------------------------------------------------------- rumours
// "@d.malfoy", "d.malfoy", or just a first name ("harry")
function findAccount(raw) {
  const h = cleanHandle(raw);
  if (!h) return null;
  return byHandle(h) || chars().find(c => c.name.split(' ')[0].toLowerCase() === h) || null;
}
const heardBy = (bot, n = 3) => {
  const list = state.rumours.filter(r => r.knownBy.some(k => k.id === bot.id)).slice(-n)
    .map(r => ({ about: r.subject, claim: r.knownBy.find(k => k.id === bot.id).claim, believes: r.believedBy.includes(bot.id) }));
  return list.length ? list : undefined;
};
function storeRumour(conv, bot, player, rr) {
  const claim = String(rr.claim || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!claim) return;
  const raw = String(rr.subject || '').trim();
  const sUser = raw && raw !== 'the castle' ? findAccount(raw) : null;
  const now = Date.now();
  const r = {
    id: uid(), claim, subject: sUser ? '@' + sUser.handle : (raw.slice(0, 60) || 'the castle'), subjectId: sUser ? sUser.id : null,
    source: player.id, toldTo: bot.id, juiciness: clampInt(rr.juiciness, 1, 5), ts: now,
    knownBy: [{ id: bot.id, from: 'p:' + player.id, claim, knowsSource: true, at: now }],
    believedBy: rr.believed === false || rr.believed === 'false' ? [] : [bot.id],
    spreadLog: [{ ts: now, from: 'p:' + player.id, to: bot.id, via: 'told', claim }],
    publicAt: null, postId: null, hops: 0, decided: {}, tries: {}, reacted: {},
    readyAt: { [bot.id]: now + DM.gossipDelayMs(bot, { scale: DM_TIME_SCALE }) }, reactionDue: {}
  };
  state.rumours.push(r);
  if (state.rumours.length > 120) state.rumours = state.rumours.slice(-120);
  castle.pushNews(state, `${player.name} told ${bot.name} something in private`, 1, 'rumour');
  const pt = rr.pass_to ? findAccount(rr.pass_to) : null;
  if (pt && pt.kind !== 'player' && pt.id !== bot.id) spreadTo(r, bot, pt, { via: 'asked' });
  save();
}
// the claim drifts a little on every hop; the original stays in r.claim
function spreadTo(r, fromBot, toBot, opts = {}) {
  if (r.knownBy.some(k => k.id === toBot.id) || (r.hops || 0) >= 5) return false;
  const from = r.knownBy.find(k => k.id === fromBot.id);
  const claim = opts.claim && opts.claim !== (from && from.claim) ? opts.claim : DM.mutateClaim(from ? from.claim : r.claim);
  r.knownBy.push({ id: toBot.id, from: fromBot.id, claim, knowsSource: !!(from && from.knowsSource && Math.random() < 0.6), at: Date.now() });
  if (Math.random() < 0.7) r.believedBy.push(toBot.id);
  r.spreadLog.push({ ts: Date.now(), from: fromBot.id, to: toBot.id, via: opts.via || 'dm', claim });
  r.hops = (r.hops || 0) + 1;
  r.readyAt[toBot.id] = Date.now() + DM.gossipDelayMs(toBot, { scale: DM_TIME_SCALE });
  if (r.subjectId === toBot.id) subjectHears(r, toBot);
  save();
  return true;
}
// a character who learns a rumour about themself reacts in character, and may hold it against the source
function subjectHears(r, bot, postId) {
  if (r.reactionDue[bot.id] !== undefined || r.reacted[bot.id]) return;
  r.reactionTo = r.reactionTo || {};
  if (postId) r.reactionTo[bot.id] = postId;
  r.reactionDue[bot.id] = Date.now() + DM.gossipDelayMs(bot, { scale: DM_TIME_SCALE });
  const k = r.knownBy.find(x => x.id === bot.id), src = U(r.source);
  if (bot.kind === 'char' && src && src.kind === 'player' && k && k.knowsSource) castle.relInteract(state, bot, src, -2, `heard ${src.name} started a rumour about them`);
}
const gossipTargets = ['pansy.p', 'rita.skeeter', 'fred.www', 'george.www', 'peeves', 'ronweasley', 'hgranger', 'd.malfoy'];
function pickGossipTarget(r, bot) {
  const pool = [...gossipTargets.map(byHandle), ...shuffle(npcs()).slice(0, 4)].filter(b => b && b.id !== bot.id && !r.knownBy.some(k => k.id === b.id));
  return pool.length ? pick(pool) : null;
}

function dueRumours(limit = 3) {
  const now = Date.now(), out = [];
  for (const r of state.rumours) {
    if (now - r.ts > 48 * 3600e3) continue;
    for (const k of r.knownBy) {
      const bot = U(k.id);
      if (!bot || r.decided[k.id] || (r.readyAt[k.id] || 0) > now) continue;
      out.push({ r, bot, k });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
function dueReactions(limit = 2) {
  const now = Date.now(), out = [];
  for (const r of state.rumours) for (const [id, at] of Object.entries(r.reactionDue)) {
    const bot = U(id);
    if (bot && !r.reacted[id] && at <= now) { out.push({ r, bot }); if (out.length >= limit) return out; }
  }
  return out;
}
const rumourCtx = ({ r, bot, k }) => {
  const sub = r.subjectId ? U(r.subjectId) : null;
  const src = k.from.startsWith('p:') ? 'told directly by @' + (U(r.source)?.handle || '?') : 'passed on by ' + (U(k.from)?.name || 'someone');
  return { id: r.id, bot: '@' + bot.handle, about: r.subject, subject_is_player: sub ? sub.kind === 'player' : false, claim_as_you_heard_it: k.claim, believes_it: r.believedBy.includes(bot.id), juiciness: r.juiciness, how_you_heard: src, knows_who_started_it: !!k.knowsSource, public_already: !!r.publicAt, gossip_style: DM.profileFor(bot).leak.mode };
};

// mock stand-in for the AI's batched rumour decisions (same shape as the real output)
function mockRumourActions(due) {
  return due.map(({ r, bot, k }) => {
    const sub = r.subjectId ? U(r.subjectId) : null, pr = DM.profileFor(bot);
    const action = DM.gossipDecision(pr, { juiciness: r.juiciness, believed: r.believedBy.includes(bot.id), subjectIsBot: !!sub && sub.kind !== 'player', subjectIsPlayer: !!sub && sub.kind === 'player' });
    return { rumour_id: r.id, bot: '@' + bot.handle, action, mention_subject: bot.handle === 'rita.skeeter' || Math.random() < 0.5, expose_source: !!k.knowsSource && Math.random() < pr.expose };
  });
}

function applyRumourAction(due, act) {
  const { r, bot, k } = due;
  const type = ['secret', 'dm_bot', 'vaguepost', 'post', 'dm_subject', 'hint', 'deduct', 'warn'].includes(act.action) ? act.action : 'secret';
  r.decided[bot.id] = type;
  const sub = r.subjectId ? U(r.subjectId) : null, src = U(r.source), pr = DM.profileFor(bot);
  const claim = String(act.claim_as_told || k.claim).slice(0, 220);
  const publish = (mode, text) => {
    const exposed = !!(act.expose_source && k.knowsSource && src);
    let body = String(text || '').trim() || DM.rumourPostText(bot, mode, { claim, subject: r.subject, house: (sub || src || {}).house, exposeHandle: exposed ? src.handle : null, mention: act.mention_subject !== false }, Math.random);
    if (exposed && !body.includes('@' + src.handle)) body = `${body} (a little owl says it was @${src.handle})`;
    const p = mkPost(bot.id, body.slice(0, 280), null);
    p.targetLikes = rand(40, 300) + (bot.handle === 'rita.skeeter' ? rand(200, 900) : 0); p.targetReposts = Math.round(p.targetLikes * 0.1);
    addPost(p);
    r.spreadLog.push({ ts: Date.now(), from: bot.id, to: 'castle', via: mode, postId: p.id, claim });
    return { p, exposed };
  };
  switch (type) {
    case 'dm_bot': {
      const t = act.target ? byHandle(act.target) : null;
      const target = t && t.kind !== 'player' && t.id !== bot.id ? t : pickGossipTarget(r, bot);
      if (target) spreadTo(r, bot, target, { via: 'dm', claim });
      break;
    }
    case 'vaguepost': case 'hint': publish(type, act.text); break;
    case 'post': {
      const { p, exposed } = publish(pr.leak.mode === 'confusing' ? 'confusing' : 'post', act.text);
      rumourPublic(r, bot, p, exposed, claim);
      break;
    }
    case 'deduct': {
      if (!sub) break;
      const pts = rand(5, 15);
      sub.housePoints = (sub.housePoints || 0) - pts;
      emitUser(sub);
      const { p, exposed } = publish('deduct', act.text || `${pts === 10 ? 'Ten' : pts} points from @${sub.handle}. I am aware of what you did.`);
      castle.pushNews(state, `${bot.name} deducted ${pts} house points from ${sub.name}`, 3, 'points');
      rumourPublic(r, bot, p, exposed, claim);
      break;
    }
    case 'dm_subject': case 'warn': {
      if (!sub) break;
      if (sub.kind === 'player') {
        if (sub.id !== bot.id && canOpen(bot, sub)) { state.dmFirst[sub.id].push({ ts: Date.now(), bot: bot.id }); openerDM(bot, sub, String(act.text || (type === 'warn' ? DM.warnText(bot, claim) : DM.gossipDmText(bot, claim))).slice(0, 400)); }
      } else spreadTo(r, bot, sub, { via: type, claim });
      break;
    }
    default: break;
  }
  save();
}

// a rumour goes public: castle news, a possible hype wave, notify the subject, and the source may be exposed
function rumourPublic(r, bot, post, exposed, claim) {
  r.publicAt = Date.now(); r.postId = post.id;
  const sub = r.subjectId ? U(r.subjectId) : null, src = U(r.source);
  castle.pushNews(state, `${bot.name} leaked a rumour${sub ? ' about ' + sub.name : ''}: "${SNIP(claim, 60)}"`, clampInt(r.juiciness, 2, 5), 'rumour');
  if (sub && sub.kind === 'player') {
    if (sub.id !== r.source) notify(sub.id, { type: 'rumour', fromId: bot.id, postId: post.id, text: exposed && src ? `${bot.name} is spreading a rumour about you, and says ${src.name} started it` : `${bot.name} is spreading a rumour about you` });
    if (r.juiciness >= 3) createHypeEvent({ player: sub, post, type: 'rumour', intensity: Math.min(5, r.juiciness), sign: -1, summary: `A rumour about ${sub.name} went public: "${SNIP(claim, 50)}"`, title: `Rumour: ${sub.name}` });
  }
  if (sub && sub.kind !== 'player') subjectHears(r, sub, post.id);
  if (exposed && src) {
    src.hype = clampInt(src.hype - 6, 0, 100);
    emitUser(src);
    notify(src.id, { type: 'exposed', fromId: bot.id, postId: post.id, text: `${bot.name} exposed you as the source of the rumour${sub ? ' about ' + sub.name : ''}. -6 hype` });
    if (sub && sub.kind !== 'player') castle.relInteract(state, sub, src, -3, `learned ${src.name} started a rumour about them`);
    castle.relInteract(state, bot, src, -1, `outed ${src.name} as a rumour source`);
    castle.pushNews(state, `${bot.name} exposed ${src.name} as the source of a rumour`, 3, 'rumour');
  }
}
function applyReaction(due, text) {
  const { r, bot } = due;
  r.reacted[bot.id] = true;
  const parent = postIndex.get((r.reactionTo && r.reactionTo[bot.id]) || r.postId);
  const body = String(text || DM.subjectReaction(bot)).trim().slice(0, 280);
  const p = mkPost(bot.id, body, parent ? parent.id : null);
  p.targetLikes = rand(30, 250);
  addPost(p);
  castle.pushNews(state, `${bot.name} responded to a rumour about them`, 2, 'rumour');
  save();
}
function processRumourBatch(r, due, reactions, mockUsed) {
  const acts = Array.isArray(r.rumour_actions) ? r.rumour_actions : (mockUsed ? mockRumourActions(due) : []);
  for (const d of due) {
    const act = acts.find(a => a && a.rumour_id === d.r.id && byHandle(a.bot)?.id === d.bot.id);
    if (act) applyRumourAction(d, act);
    else if (!mockUsed) { d.r.tries[d.bot.id] = (d.r.tries[d.bot.id] || 0) + 1; if (d.r.tries[d.bot.id] >= 3) d.r.decided[d.bot.id] = 'secret'; }
  }
  const rs = Array.isArray(r.rumour_reactions) ? r.rumour_reactions : [];
  for (const d of reactions) {
    const a = rs.find(x => x && byHandle(x.bot)?.id === d.bot.id);
    applyReaction(d, a && a.text);
  }
}

// ---------------------------------------------------------------- bots interacting with each other
// bot <-> bot feelings move with every exchange (botrel.js); likes/reposts between bots are simulated here with no AI call.
function botReplyRel(bot, other, text, stance) {
  let s = castle.sentiment(text);
  if (stance === 'agree') s = 1; else if (stance === 'dunk') s = -1;
  BR.interact(state, bot, other, s > 0 ? 0.4 : s < 0 ? -0.6 : 0.1, `${s < 0 ? 'clashed with' : s > 0 ? 'sided with' : 'replied to'} ${other.name}: "${SNIP(text, 40)}"`);
}
// other bots like and repost a bot's post, weighted by relationship and house (friends yes, enemies no)
function botEngage(p) {
  const author = U(p.authorId);
  if (!author || author.kind === 'player') return;
  let n = 0;
  for (const b of shuffle([...chars(), ...npcs()]).slice(0, 10)) {
    if (n >= 4) break;
    const pr = BR.engageProb(state, author, b, 0.22);
    if (Math.random() >= pr) continue;
    n++;
    setTimeout(() => {
      if (!postIndex.has(p.id) || p.likedBy.includes(b.id)) return;
      p.likedBy.push(b.id); p.targetLikes++; growing.add(p.id);
      BR.interact(state, author, b, 0.1);
      if (Math.random() < pr * 0.45 && !p.repostedBy.some(r => r.id === b.id)) botRepost(b, p);
    }, Math.max(500, rand(4000, 60000) * SCENE_SCALE));
  }
}
function storyOfPost(p) {
  for (let c = p, i = 0; c && i < 12; c = c.parentId ? postIndex.get(c.parentId) : null, i++) if (c.storyId) return (state.stories || []).find(s => s.id === c.storyId) || null;
  return null;
}
const storiesCtx = () => BR.activeStories(state).map(s => ({ id: s.id, title: s.title, bots: s.bots.map(id => U(id) ? '@' + U(id).handle : null).filter(Boolean), stage: s.stage, last_beat: s.beats[s.beats.length - 1] }));
const pairsCtx = (list, n = 6) => { const p = BR.topPairs(state, list, n); return p.length ? p : undefined; };

function applyStorylineOutput(r) {
  let fresh = null;
  const ns_ = r.new_storyline;
  if (ns_ && typeof ns_ === 'object' && ns_.title) {
    const ids = (Array.isArray(ns_.bots) ? ns_.bots : []).map(h => byHandle(h)).filter(b => b && b.kind !== 'player').map(b => b.id);
    if (ids.length >= 2) {
      fresh = BR.addStory(state, { title: ns_.title, bots: ids, summary: ns_.summary });
      if (fresh) castle.pushNews(state, `New castle storyline: ${fresh.title}`, 3, 'story');
    }
  }
  for (const u of (Array.isArray(r.storyline_updates) ? r.storyline_updates : []).slice(0, 3)) {
    const s = u && BR.advanceStory(state, u.id, { beat: u.beat, resolve: !!u.resolve, resolution: u.resolution });
    if (!s) continue;
    castle.pushNews(state, s.status === 'resolved' ? `Storyline resolved: ${s.title} (${s.resolution})` : `${s.title}: ${s.beats[s.beats.length - 1]}`, s.status === 'resolved' ? 3 : 2, 'story');
  }
  for (const s of BR.expireStories(state)) castle.pushNews(state, `Storyline faded: ${s.title}`, 1, 'story');
  return fresh;
}

// a scene: 2-6 bot messages as a reply chain, delivered 10-90s apart. under = 'new' (first message becomes a new post) or an existing feed post id.
function runScene(sc, allowed, fresh) {
  let msgs = (Array.isArray(sc.messages) ? sc.messages : []).slice(0, 6).filter(m => {
    const b = m && byHandle(m.handle);
    return b && b.kind !== 'player' && String(m.text || '').trim() && (!allowed || allowed.has(b.id));
  });
  const under = sc.under && sc.under !== 'new' ? postIndex.get(sc.under) : null;
  if (!msgs.length || (!under && msgs.length < 2)) return 0;
  const stop = msgs.findIndex((_, i) => i >= 2 && Math.random() < 0.18); // threads die naturally: a later bot just never answers
  if (stop > 0) msgs = msgs.slice(0, stop);
  let story = null;
  if (sc.storyline_id === 'new') story = fresh;
  else if (sc.storyline_id) story = (state.stories || []).find(s => s.id === sc.storyline_id && s.status === 'active') || null;
  if (!story) {
    const ids = msgs.map(m => byHandle(m.handle).id), cand = BR.storyForBots(state, ids);
    if (cand && new Set(ids.filter(i => cand.bots.includes(i))).size >= 2) story = cand;
  }
  const sceneId = uid(), ids = [];
  let delay = 0;
  msgs.forEach((m, i) => {
    delay += Math.max(600, (i === 0 ? rand(500, 4000) : rand(10000, 90000)) * SCENE_SCALE);
    setTimeout(() => {
      const bot = byHandle(m.handle);
      if (!bot) return;
      const rt = Number.isInteger(m.reply_to) ? m.reply_to : null;
      const parentId = i === 0 ? (under ? under.id : null) : ((rt !== null && ids[rt]) || ids[i - 1] || ids[0] || (under ? under.id : null));
      if (parentId && !postIndex.has(parentId)) return;
      const p = mkPost(bot.id, String(m.text).trim().slice(0, 280), parentId);
      p.sceneId = sceneId;
      if (story) { p.storyId = story.id; p.storyTitle = story.title; }
      p.targetLikes = clampInt(m.likes ?? rand(3, 80), 0, Math.round(bot.followers * 0.08) + 25);
      const ev = eventForPost(p); if (ev) p.eventId = ev.id;
      addPost(p);
      ids[i] = p.id;
      const par = parentId && postIndex.get(parentId), pa = par && U(par.authorId);
      if (pa && pa.kind !== 'player' && pa.id !== bot.id) botReplyRel(bot, pa, p.text);
      if (pa && pa.kind === 'player' && !p.mentions.includes(pa.id)) notify(pa.id, { type: 'reply', fromId: bot.id, postId: p.id, text: `${bot.name}: "${p.text.slice(0, 70)}${p.text.length > 70 ? '…' : ''}"` });
      const target = m.points && m.points_to ? byHandle(m.points_to) : null;
      const pts = clampInt(m.points, -10, 10);
      if (target && pts && bot.house === 'Staff') {
        target.housePoints = (target.housePoints || 0) + pts; emitUser(target);
        castle.pushNews(state, `${bot.name} ${pts > 0 ? 'awarded' : 'deducted'} ${Math.abs(pts)} house points ${pts > 0 ? 'to' : 'from'} ${target.name}`, 2, 'points');
      }
    }, delay);
  });
  return delay;
}

// replies to a post, plus sub-replies: other bots answering those bot replies (agree, dunk, take house sides)
function scheduleBotReplies(replies, parent, allowed, opts = {}) {
  let delay = opts.start || 2500;
  let count = 0;
  const delivered = {}, at = {};
  (replies || []).slice(0, opts.max || 8).forEach((r, i) => {
    const bot = byHandle(r.handle);
    if (!bot || bot.kind === 'player' || (allowed && !allowed.has(bot.id))) return;
    const text = String(r.text || '').trim().slice(0, 280);
    if (!text) return;
    delay += Math.max(300, rand(1500, 6500) * SCENE_SCALE);
    at[i] = delay;
    count++;
    setTimeout(() => {
      if (!postIndex.has(parent.id)) return;
      const p = mkPost(bot.id, text, parent.id);
      p.targetLikes = clampInt(r.likes ?? rand(0, 30), 0, Math.max(50, Math.round(bot.followers * 0.05)));
      if (r.mention_sentiment in SENT) p.mentionSentiment = SENT[r.mention_sentiment];
      if (parent.storyId) { p.storyId = parent.storyId; p.storyTitle = parent.storyTitle; }
      const ev = eventForPost(p); if (ev) p.eventId = ev.id;
      addPost(p);
      delivered[i] = p.id;
      if (opts.player && !(opts.skipMem && opts.skipMem.has(bot.id))) castle.relInteract(state, bot, opts.player, 0, `replied to ${opts.player.name}: "${SNIP(opts.about, 45)}"`);
      const pa = U(parent.authorId);
      if (pa && pa.kind !== 'player' && pa.id !== bot.id) botReplyRel(bot, pa, text);
      if (pa && pa.kind === 'player' && !p.mentions.includes(pa.id)) notify(pa.id, { type: 'reply', fromId: bot.id, postId: p.id, text: `${bot.name}: "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"` });
    }, delay);
  });
  for (const s of (Array.isArray(opts.sub) ? opts.sub : []).slice(0, 3)) {
    const i = Number(s && s.to);
    if (!(i in at)) continue;
    const bot = byHandle(s.handle), parentBot = byHandle((replies[i] || {}).handle);
    if (!bot || bot.kind === 'player' || !parentBot || bot.id === parentBot.id || (allowed && !allowed.has(bot.id))) continue;
    const text = String(s.text || '').trim().slice(0, 280);
    if (!text) continue;
    const d = at[i] + Math.max(600, rand(3500, 12000) * SCENE_SCALE);
    delay = Math.max(delay, d); count++;
    setTimeout(() => {
      const pid = delivered[i];
      if (!pid || !postIndex.has(pid)) return; // the reply it answers never landed: the sub-thread dies
      const par = postIndex.get(pid);
      const p = mkPost(bot.id, text, pid);
      p.targetLikes = clampInt(s.likes ?? rand(0, 25), 0, Math.max(40, Math.round(bot.followers * 0.04)));
      if (par.storyId) { p.storyId = par.storyId; p.storyTitle = par.storyTitle; }
      const ev = eventForPost(p); if (ev) p.eventId = ev.id;
      addPost(p);
      botReplyRel(bot, parentBot, text, s.stance === 'agree' ? 'agree' : s.stance === 'dunk' ? 'dunk' : undefined);
    }, d);
  }
  return { endDelay: delay, count };
}

// ambient bot posts
let lastAmbient = 0, lastSeenOnline = 0, ambientRunning = false;
async function ambientTick() {
  if (ambientRunning) return;
  if (aiTight()) { lastAmbient = Date.now() - TICK_MS * 0.5; return; } // keep the budget for players, look again in half a tick
  ambientRunning = true; lastAmbient = Date.now();
  try {
    const squeeze = !MOCK && !!aiLayer && aiLayer.pressure() > 0.5; // budget getting tight: smaller tick
    const cs = pickChars(squeeze ? 3 : 5), ns = pickNPCs(squeeze ? 4 : 7, null);
    for (const s of BR.activeStories(state)) for (const id of s.bots) { // storyline bots are always in the cast
      const b = U(id);
      if (b && b.kind === 'char' && !cs.includes(b)) cs.push(b);
      if (b && b.kind === 'npc' && !ns.includes(b)) ns.push(b);
    }
    const feed = feedNumbered(squeeze ? 8 : 14);
    const ids = pids();
    const hot = activeEvents();
    const dueR = dueRumours(), dueX = dueReactions(); // rumour decisions ride along in this same call
    const stories = storiesCtx();
    const prompt = buildPrompt('ambient', {
      task: 'Make the castle feel alive. Return 1-2 standalone posts PLUS 1-2 "scenes": reply chains of 2-6 messages between bots (characters and/or students), either as a new bot post with replies, or replying under a post in recent_feed (use its number n from recent_feed in "under"; refer to feed items ONLY by their number, never by id). Examples: a feud between two characters, Fred and George doing a double act, Filch chasing Peeves, Hermione correcting a student, students arguing about the trend, Luna derailing a thread, a staff member stepping in to deduct house points. Bots disagree along house lines and their bot_pairs feelings; not every bot has to answer and threads can end early. Continue the ongoing storylines in castle.storylines across ticks (escalate, then resolve one after about 3-5 beats with storyline_updates) and only start a new one (new_storyline) when fewer than 3 are active. Use castle.news for callbacks. If castle.hype_events lists an active event, roughly heat/5 of the posts should still reference that player (@mention them); otherwise do not force it.'
        + (dueR.length ? ' RUMOURS: for each item in rumours_ready decide what that bot does with the rumour, in line with its gossip_style and personality (rumour_actions). Options: secret (keep it), dm_bot (quietly tell another character: set target), vaguepost ("not saying who but someone in Gryffindor..."), post (leak it publicly, optionally tagging the subject and optionally naming who started it if knows_who_started_it), dm_subject (message the subject directly), hint (cryptic, names nobody), deduct (use it to take house points), warn (tell the subject someone is spreading it). When passing it on you may exaggerate or garble the claim slightly (claim_as_told). Rita almost always leaks; Dumbledore never posts it; Hermione, Cedric and Neville rarely do and may warn the subject instead.' : '')
        + (dueX.length ? ' Each bot in rumour_reactions_due just heard a rumour about itself: write its in-character public reaction (rumour_reactions).' : ''),
      trend: state.trend,
      recent_feed: feed.items,
      storylines: stories.length ? stories : undefined,
      available_characters: cs.map(c => cctx(c, ids)),
      available_students: ns.map(n => nctx(n, null, ids)),
      bot_pairs: pairsCtx([...cs, ...ns], squeeze ? 4 : 8),
      rumours_ready: dueR.length ? dueR.map(rumourCtx) : undefined,
      rumour_reactions_due: dueX.length ? dueX.map(d => ({ bot: '@' + d.bot.handle, heard: d.r.knownBy.find(k => k.id === d.bot.id)?.claim })) : undefined,
      output_shape: {
        posts: [{ handle: '@handle', text: 'post text (may @mention players or listed accounts)', reply_to: 'the number n of a recent_feed post this replies to, or null for a standalone post', reacting_to: 'only when reply_to is set: a short phrase quoted from that post', likes: 'int', mention_sentiment: 'only if it @mentions a player: positive | negative | neutral' }],
        scenes: [{ under: '"new" or the number n of a post in recent_feed', storyline_id: 'id from storylines, or null', messages: [{ handle: '@handle from the available lists', text: 'message in that bot\'s voice', reply_to: 'index of an EARLIER message in this scene, or null', reacting_to: 'REQUIRED on the first message when under is a number: a short phrase quoted from that post', likes: 'int', points: 'int, only for staff deducting (negative) or awarding house points', points_to: '@handle receiving the points' }] }],
        new_storyline: { title: 'short title, e.g. "Draco vs Ron: the Quidditch final"', bots: ['@handle', '@handle'], summary: 'one line' },
        storyline_updates: [{ id: 'storyline id', beat: 'one line: what happened this tick', resolve: 'bool', resolution: 'one line, only when resolving' }],
        rumour_actions: dueR.length ? [{ rumour_id: 'id from rumours_ready', bot: '@handle', action: 'secret | dm_bot | vaguepost | post | dm_subject | hint | deduct | warn', target: '@handle for dm_bot', text: 'the post or DM text, in voice (optional)', claim_as_told: 'the claim as this bot retells it', mention_subject: 'bool', expose_source: 'bool, only if knows_who_started_it' }] : undefined,
        rumour_reactions: dueX.length ? [{ bot: '@handle', text: 'reaction post' }] : undefined
      },
      count: squeeze ? '1 post and 1 scene' : '1-2 standalone posts and 1-2 scenes'
    });
    let r = null;
    try { r = await ai(prompt, { kind: 'ambient' }); } catch (e) { console.error('[owl] AI ambient failed:', e.message); }
    const mockUsed = !r;
    if (!r) r = mockAmbient(cs, ns, hot, feed);
    processRumourBatch(r, dueR, dueX, mockUsed);
    const fresh = applyStorylineOutput(r);
    const allowed = new Set([...cs, ...ns].map(x => x.id));
    let delay = 500;
    let accepted = 0; // the 1-2 post cap counts posts that survive validation, not the ones that were dropped
    for (const item of (r.posts || []).slice(0, 12)) {
      if (accepted >= (mockUsed ? 5 : 2)) break;
      const bot = byHandle(item.handle);
      if (!bot || bot.kind === 'player' || !allowed.has(bot.id)) continue;
      const text = String(item.text || '').trim().slice(0, 280);
      if (!text) continue;
      let parent = null;
      if (item.reply_to !== null && item.reply_to !== undefined && item.reply_to !== '') {
        const pid = tone.fromNumber(toNum(item.reply_to), feed.ids);
        if (!pid) { console.log(`[owl] ambient: dropped a post with out-of-range reply_to ${JSON.stringify(item.reply_to)}`); continue; }
        parent = postIndex.get(pid);
        if (!parent) continue;
        const v = tone.checkReacting(item.reacting_to, [parent.text], feed.items.map(i => i.text));
        if (!mockUsed && v !== 'ok' && v !== 'callback') { console.log('[owl] ambient: dropped a reply that is not about the post it replies to'); continue; }
      }
      delay += Math.max(500, rand(4000, 20000) * SCENE_SCALE);
      accepted++;
      setTimeout(() => {
        const p = mkPost(bot.id, text, parent ? parent.id : null);
        p.targetLikes = clampInt(item.likes ?? rand(5, 200), 0, Math.round(bot.followers * 0.15) + 20);
        p.targetReposts = Math.round(p.targetLikes * Math.random() * 0.15);
        if (item.mention_sentiment in SENT) p.mentionSentiment = SENT[item.mention_sentiment];
        const ev = activeEvents().find(e => p.mentions.includes(e.playerId)); if (ev) p.eventId = ev.id;
        addPost(p);
        const pa = parent && U(parent.authorId);
        if (pa && pa.kind === 'player' && !p.mentions.includes(pa.id)) notify(pa.id, { type: 'reply', fromId: bot.id, postId: p.id, text: `${bot.name}: "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"` });
      }, delay);
    }
    // scenes may use anyone the model was shown, the storyline cast, and the authors of posts they reply under
    const sceneAllowed = new Set(allowed);
    for (const s of BR.activeStories(state)) s.bots.forEach(id => sceneAllowed.add(id));
    for (const sc0 of (r.scenes || []).slice(0, 2)) {
      let sc = sc0;
      if (sc && sc.under !== undefined && sc.under !== null && String(sc.under).toLowerCase() !== 'new') {
        const pid = tone.fromNumber(toNum(sc.under), feed.ids);
        if (!pid) { console.log(`[owl] ambient: dropped a scene with out-of-range under ${JSON.stringify(sc.under)}`); continue; }
        const under = postIndex.get(pid);
        if (!under) continue;
        const first = Array.isArray(sc.messages) ? sc.messages[0] : null;
        if (first && mockUsed && !first.reacting_to) first.reacting_to = tone.phraseOf(under.text);
        const v = first ? tone.checkReacting(first.reacting_to, [under.text], feed.items.map(i => i.text)) : 'bad';
        if (v !== 'ok' && v !== 'callback') { console.log('[owl] ambient: dropped a scene whose first message is not about the post it replies under'); continue; }
        sc = { ...sc, under: pid };
        if (U(under.authorId) && U(under.authorId).kind !== 'player') sceneAllowed.add(under.authorId);
      } else if (sc) sc = { ...sc, under: 'new' };
      runScene(sc, mockUsed ? null : sceneAllowed, fresh);
    }
  } finally { ambientRunning = false; }
}
setInterval(() => {
  if (!online.size) return;
  const since = Date.now() - lastAmbient;
  if (since > TICK_MS && aiq.length === 0) ambientTick();
}, 10000);

// ---------------------------------------------------------------- mock AI (no key / MOCK_AI=1)
const MOCK_LINES = ['lol', 'ok this is actually funny', 'who asked', 'mid tbh', 'ratio', 'ten points to whoever posted this', 'not you posting this in the great hall', 'this is so true it hurts', 'house cup energy', 'reported to filch', 'i felt this', 'bold of you', 'screaming', 'the audacity', 'go back to bed'];
// mock replies: every reply carries a stance (support | joke | neutral | critical | hostile) and quotes a phrase from the post it answers.
// stances follow the verdict quotas (tone.js); who gets which stance follows house loyalty, warmth and grudges.
const MOCK_LINES_BY_STANCE = {
  support: ['"{P}" is so true', 'love this, especially {P}', 'finally someone said it: {P}', 'this made my day, {P} 👏'],
  joke: ['"{P}" is going on my wall', '{P}?? the way i cackled', 'not me quoting "{P}" in the common room all night', 'ok but "{P}" would be a great band name'],
  neutral: ['interesting take on {P}', 'hm, {P}. go on', 'ok but what do you mean by {P}', 'noted: {P}'],
  critical: ['not sure about {P}, honestly', 'i do not buy "{P}"', '{P} is a stretch tbh', 'respectfully, {P} is wrong'],
  hostile: ['"{P}"?? bold of you', '{P}... genuinely painful to read', 'who let "{P}" out of the dungeon']
};
const mockLine = (stance, P) => pick(MOCK_LINES_BY_STANCE[stance] || MOCK_LINES_BY_STANCE.neutral).replace(/\{P\}/g, P);
const relToAuthor = (bot, author) => (author && author.kind === 'player' ? castle.relScore(state, bot, author.id) : 0);
// mock: bots the player tagged always answer first (real AI is only instructed to, "almost always")
const forcedLines = (forced, who, text) => forced.map(u => {
  const P = tone.phraseOf(text), st = tone.leanScore(u, who, relToAuthor(u, who)) >= 0 ? 'support' : 'neutral';
  return { handle: '@' + u.handle, text: `@${who.handle} ${mockLine(st, P)}`, stance: st, reacting_to: P, likes: rand(2, 40), mention_sentiment: pick(['positive', 'neutral', 'negative']) };
});
function mockShifts(users, memo) { return users.slice(0, 3).map(u => ({ handle: '@' + u.handle, delta: rand(-2, 3), memory: memo })); }
// replies for `n` bots reacting to `text`: stances from the verdict quota, handed out by lean
function mockReactions(verdict, n, bots, who, text) {
  const pool = shuffle(bots).slice(0, n);
  return tone.assign(tone.allocate(verdict, pool.length), pool, who, b => relToAuthor(b, who)).map(a => {
    const P = tone.phraseOf(text);
    return { handle: '@' + a.bot.handle, text: mockLine(a.stance, P), stance: a.stance, reacting_to: P, likes: rand(0, 20) };
  });
}
// test hooks (mock only): #viral #good #mid #flop #ratio #controversial in a post force that verdict
const MOCK_VERDICT_HOOKS = [[/#viral/i, 'viral', 97], [/#good/i, 'good', 75], [/#mid/i, 'mid', 50], [/#flop/i, 'flop', 12], [/#ratio/i, 'ratioed', 8], [/#controversial/i, 'controversial', 60]];
function mockPost(post, cs, ns, forced = [], verdictOverride) {
  const hook = verdictOverride ? [null, verdictOverride, 60] : MOCK_VERDICT_HOOKS.find(h => h[0].test(post.text));
  let q = hook ? hook[2] : rand(10, 95);
  let verdict = hook ? hook[1] : (q > 85 ? 'viral' : q > 65 ? 'good' : q > 35 ? 'mid' : q > 20 ? 'flop' : 'ratioed');
  if (!hook && verdict === 'mid' && Math.random() < 0.12) verdict = 'controversial';
  const who = U(post.authorId), f = who.followers;
  const pool = [...shuffle(cs).slice(0, 3), ...shuffle(ns).slice(0, 4)].filter(b => !forced.includes(b));
  const mockReplies5 = [...forcedLines(forced, who, post.text), ...mockReactions(verdict, 5, pool, who, post.text)];
  return {
    quality: q, verdict, likes: Math.round(f * q / 300) + rand(1, 20) + (q > 85 ? Math.round(f * 0.3) : 0), reposts: rand(0, 15),
    follower_delta: Math.round(f * (q - 45) / 300) + rand(-2, 8), hype_delta: Math.round((q - 50) / 4), house_points: rand(-5, 10),
    replies: mockReplies5,
    sub_replies: mockSubReplies(mockReplies5, [...cs, ...ns]),
    reposts_by: q > 60 ? shuffle([...cs, ...ns]).slice(0, rand(1, 2)).map(u => '@' + u.handle) : [],
    relationship_shifts: mockShifts(cs, `reacted to ${who.name}'s post: "${SNIP(post.text, 30)}"`),
    opinion_shifts: ns.slice(0, 2).map(n => ({ handle: '@' + n.handle, delta: rand(-2, 2) })),
    prophet_headline: /#rita/i.test(post.text) || (!hook && Math.random() < 0.1) ? 'Student caught posting at a scandalous hour' : null
  };
}
function mockReply(reply, parent, cs, ns, forced = []) {
  const who = U(reply.authorId);
  const pool = [...cs.slice(0, 2), ...shuffle(ns).slice(0, 3)].filter(b => !forced.includes(b));
  const reps = [...forcedLines(forced, who, reply.text), ...mockReactions('mid', 3, pool, who, reply.text)];
  return {
    winner: pick(['reply', 'parent', 'draw']), reply_likes: rand(1, 30), follower_steal: rand(0, 6), hype_delta: rand(-5, 8), parent_hype_delta: rand(-5, 5), house_points: rand(-3, 5),
    replies: reps,
    sub_replies: mockSubReplies(reps, [...cs, ...ns]),
    relationship_shifts: mockShifts(cs, `traded words with ${who.name}`)
  };
}
// mock sub-replies: bots answering OTHER bots' replies, tone from how the two bots feel about each other
function mockSubReplies(replies, pool) {
  const out = [];
  const n = Math.min(rand(1, 2), replies.length);
  for (let k = 0; k < n; k++) {
    const idx = rand(0, replies.length - 1);
    const parentBot = byHandle(replies[idx].handle);
    if (!parentBot) continue;
    const cand = shuffle(pool).find(b => b.id !== parentBot.id && !out.some(o => byHandle(o.handle)?.id === b.id));
    if (!cand) continue;
    const sc = BR.score(state, cand, parentBot);
    const stance = sc <= -3 ? 'dunk' : sc >= 3 ? 'agree' : 'house';
    const at = '@' + parentBot.handle;
    const P = tone.phraseOf(replies[idx].text);
    const text = stance === 'dunk' ? pick([`${at} "${P}" is the best you have got?`, `${at} ratio incoming on "${P}"`, `${at} "${P}"... bold`])
      : stance === 'agree' ? pick([`${at} this ^^ "${P}"`, `${at} exactly what i was about to say about ${P}`, `${at} thank you for saying ${P}`])
      : pick([`${at} ${cand.house} would never say "${P}", but ok`, `${at} "${P}" is very ${parentBot.house} of you`]);
    out.push({ to: idx, handle: '@' + cand.handle, text, likes: rand(0, 25), stance, reacting_to: P });
  }
  return out;
}
const HOT_LINES = ['really said that in front of the whole castle 💀', 'is the main character today and i am not okay', 'cannot stop thinking about this post', 'the way the great hall went quiet'];
// every character pair with its current score (users, not handles), strongest feelings first
function allCharPairs() {
  const cs_ = chars(), out = [];
  for (let i = 0; i < cs_.length; i++) for (let j = i + 1; j < cs_.length; j++) out.push({ a: cs_[i], b: cs_[j], score: BR.score(state, cs_[i], cs_[j]) });
  return out.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
}
// mock tick: 2 standalone posts, 1-2 scenes (feuds, double acts, corrections...), storyline start/continue/resolve. `feed` is the numbered feed the model would have seen.
function mockAmbient(cs, ns, hot = [], feed = { items: [], ids: [] }) {
  const posts = [...cs.slice(0, 1), ...ns.slice(0, 1)].map(u => ({ handle: '@' + u.handle, text: `${pick(MOCK_LINES)} #${(state.trend?.title || 'hogwarts').replace(/\s/g, '')}`, reply_to: null, likes: rand(1, 80) }));
  for (const ev of hot) {
    const pl = U(ev.playerId); const h = heat(ev);
    if (pl && Math.random() < Math.min(0.9, h / 3)) posts.push({ handle: '@' + pick([...cs, ...ns]).handle, text: `@${pl.handle} ${pick(HOT_LINES)}`, reply_to: null, likes: rand(5, 90), mention_sentiment: ev.sign > 0 ? 'positive' : 'negative' });
  }
  const recent = feed.items.filter(i => !i.reply_to && !i.player).slice(-8).map(i => ({ id: i.n, authorHandle: i.by.replace('@', '') }));
  const ctx = {
    bot: h => byHandle(h), chars: chars(), npcs: shuffle(npcs()).slice(0, 8), pairs: allCharPairs().slice(0, 40), trend: state.trend, recent,
    stories: BR.activeStories(state).map(s => ({ id: s.id, title: s.title, bots: s.bots.map(id => U(id) && U(id).handle).filter(Boolean), stage: s.stage }))
  };
  const sc = BS.buildMockScenes(ctx);
  return { posts, scenes: sc.scenes, new_storyline: sc.new_storyline, storyline_updates: sc.storyline_updates };
}
// mock hype wave: quotes, mentions, camps by house, characters in voice, copycats, the other player tagged
const WAVE_MOCK = {
  'd.malfoy': { pos: 'funny how a whole castle talks about this. i could have done it better. obviously.', neg: 'imagine posting that and thinking nobody would notice. oh wait, everyone did.' },
  'fred.www': { pos: 'limited edition merch of this is already in the works. george start the paperwork', neg: 'condolences. we sell a cream for that. ask us about it' },
  'george.www': { pos: 'i would like it noted that i also have opinions and they are worth 3 galleons', neg: 'hold on, i will get the sympathy fudge from the back' },
  'm.mcgonagall': { pos: 'Ten points for the nerve, if not the punctuation.', neg: 'This is not the standard of this house. Five points off.', pts: [8, -6] },
  'prof.snape': { pos: 'Noted. Do not let it go to your head.', neg: 'Five points from whoever thought this was a good idea.', pts: [-4, -8] },
  'g.lockhart': { pos: 'i inspired this, you are all welcome. signed copies available', neg: 'a cautionary tale. i wrote a chapter about it' },
  'luna.lovegood': { pos: 'the nargles seem very proud of this', neg: 'maybe the post was just early. like a very sad radish' },
  'pansy.p': { pos: 'ugh i hate that this is good', neg: 'the way i screamed. screenshotting for the group chat' }
};
function mockWave(ev, player, orig, cast, others, size) {
  const pos = ev.sign > 0;
  const posts = [];
  for (const c of cast.cs) {
    const v = WAVE_MOCK[c.handle]; if (!v) continue;
    const pts = v.pts ? v.pts[pos ? 0 : 1] : 0;
    posts.push({ handle: '@' + c.handle, kind: posts.length % 2 ? 'post' : 'quote', text: pos ? v.pos : v.neg, likes: rand(30, 200), camp: pos ? 'neutral' : 'hater', points: pts });
    if (posts.length >= 3) break;
  }
  const stans = cast.ns.slice(0, 3), haters = cast.ns.slice(3);
  const extra = [
    () => ({ handle: '@' + stans[0].handle, kind: 'quote', text: pos ? 'this is the funniest thing posted this term' : 'not them getting ratioed in front of everyone, i cannot', camp: pos ? 'stan' : 'hater' }),
    () => ({ handle: '@' + haters[0].handle, kind: 'post', text: `@${player.handle} ${pos ? 'ratio + ' + player.house + ' fell off' : 'L + ratio, ' + player.house + ' is cooked'}`, camp: 'hater' }),
    () => ({ handle: '@' + stans[1].handle, kind: 'post', text: `@${player.handle} ${pick(HOT_LINES)}`, camp: 'stan' }),
    () => ({ handle: '@' + haters[1].handle, kind: 'post', text: `my version: "${SNIP(orig.text, 60)}" (but better)`, camp: 'hater' }),
    () => ({ handle: '@' + stans[2].handle, kind: 'quote', text: `${player.house} house is not ready for this`, camp: 'stan' }),
    () => ({ handle: '@' + haters[2].handle, kind: 'reply', text: 'copycat posts incoming in 3, 2, 1', camp: 'hater' })
  ];
  for (const mk of extra) { if (posts.length >= size) break; if (cast.ns.length >= 6) posts.push({ ...mk(), likes: rand(5, 90) }); }
  return { posts: posts.slice(0, size) };
}

// ---------------------------------------------------------------- boot
// Listen first so the host sees an open port straight away. Clients that arrive while storage is still loading are told the castle is waking up and retry.
server.listen(PORT, () => console.log(`[owl] Owl Feed running on http://localhost:${PORT} (${store.kind === 'mongo' ? 'MongoDB' : 'local files'}${INVITE_CODE ? ', invite code required' : ''})`));
(async function boot() {
  try {
    await store.init();
    if (process.env.BOOT_DELAY_MS) await sleep(+process.env.BOOT_DELAY_MS); // test hook: pretend to be a slow cold start
    state = migrate(await loadState());
    aiLayer = createAI({ providers: PROVIDER_CFG, system: SYS, usage: state.aiUsage, onUsage: () => save() });
    reindex();
    for (const p of state.posts) if (!Array.isArray(p.mentions)) p.mentions = extractMentions(p.text, p.authorId); // old saves
    recomputeAllViews();
    ensureTrend(false);
    // bot DMs queued before a restart still arrive (overdue ones trickle in)
    for (const q of state.dmQueue) { q.at = Math.max(q.at, Date.now() + rand(600, 4000)); scheduleQueued(q); }
    // public/avatars/<handle>.png|jpg|webp can be added while running; tell clients when the set changes
    setInterval(() => {
      const next = scanAvatars(), changed = [];
      for (const [h, url] of next) if (avatarFiles.get(h) !== url) changed.push(h);
      for (const h of avatarFiles.keys()) if (!next.has(h)) changed.push(h);
      avatarFiles = next;
      for (const h of changed) { const u = handleIndex.get(h); if (u) io.emit('user:update', pubUser(u)); }
    }, 20000);
    ready = true;
    save();
    aiLayer.init();
    console.log('[owl] ready');
  } catch (e) { console.error('[owl] boot failed:', e); process.exit(1); }
})();

// Render stops free instances with SIGTERM: write the latest state before exiting so nothing is lost when it sleeps
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[owl] shutting down, saving the castle…');
  const bail = setTimeout(() => process.exit(1), 8000);
  try { if (ready) await flush(); await store.close(); } catch (e) { console.error('[owl] final save failed:', e.message); }
  clearTimeout(bail);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
