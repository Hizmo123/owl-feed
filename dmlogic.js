// DM + rumour logic: bot personalities, reply timing, mock replies, gossip decisions. Pure functions; server.js owns state and timers.
'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// local time in the castle's timezone (Sydney); `fixed` lets tests pin the hour
function sydneyHour(ts = Date.now(), fixed) {
  if (fixed !== undefined && fixed !== null && fixed !== '') return Number(fixed);
  const h = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }).format(new Date(ts));
  return Number(h) % 24;
}

// ---------------------------------------------------------------- personalities
// delay: [min,max] seconds to reply; night: 'awake' bots reply at odd hours; ignore: leave-on-read chance; double: double-text chance
// leak: gossip personality {p: base chance to act on a rumour, mode}; gossipDelay: seconds before they act; expose: chance to name the source
const PROFILES = {
  'prof.snape':    { delay: [600, 3600], curt: true, ignore: 0.3, double: 0.02, emoji: 0.02, leak: { p: 0.35, mode: 'deduct' }, gossipDelay: [120, 600], expose: 0.2 },
  'albus.d':       { delay: [60, 2400], night: 'awake', odd: true, ignore: 0.1, double: 0.15, emoji: 0.05, leak: { p: 0.5, mode: 'hint' }, gossipDelay: [300, 1800], expose: 0 },
  'ronweasley':    { delay: [8, 60], typos: true, lower: true, ignore: 0.1, double: 0.35, emoji: 0.2, leak: { p: 0.4, mode: 'blurt' }, gossipDelay: [30, 240], expose: 0.25 },
  'hgranger':      { delay: [60, 300], long: true, ignore: 0.05, double: 0.05, emoji: 0.02, leak: { p: 0.1, mode: 'warn' }, gossipDelay: [120, 600], expose: 0.1 },
  'rita.skeeter':  { delay: [20, 120], ignore: 0.05, double: 0.2, emoji: 0.05, leak: { p: 0.95, mode: 'post' }, vague: 0, gossipDelay: [15, 60], expose: 0.35 },
  'pansy.p':       { delay: [15, 120], lower: true, ignore: 0.15, double: 0.25, emoji: 0.15, leak: { p: 0.8, mode: 'post' }, gossipDelay: [20, 90], expose: 0.4 },
  'peeves':        { delay: [5, 90], ignore: 0.2, double: 0.4, emoji: 0.3, night: 'awake', leak: { p: 0.8, mode: 'post' }, gossipDelay: [10, 60], expose: 0.5 },
  'fred.www':      { delay: [15, 90], lower: true, ignore: 0.1, double: 0.3, emoji: 0.15, leak: { p: 0.8, mode: 'post' }, gossipDelay: [20, 100], expose: 0.3 },
  'george.www':    { delay: [15, 90], lower: true, ignore: 0.1, double: 0.3, emoji: 0.15, leak: { p: 0.8, mode: 'post' }, gossipDelay: [20, 100], expose: 0.3 },
  'c.diggory':     { delay: [40, 240], ignore: 0.1, double: 0.1, emoji: 0.1, leak: { p: 0.1, mode: 'warn' }, gossipDelay: [120, 600], expose: 0.05 },
  'nev.herbology': { delay: [40, 300], ignore: 0.1, double: 0.1, emoji: 0.1, leak: { p: 0.1, mode: 'warn' }, gossipDelay: [120, 600], expose: 0.05 },
  'luna.lovegood': { delay: [120, 900], ignore: 0.1, double: 0.1, emoji: 0.1, leak: { p: 0.6, mode: 'confusing' }, gossipDelay: [60, 400], expose: 0 },
  'd.malfoy':      { delay: [30, 300], ignore: 0.2, double: 0.1, emoji: 0.05, leak: { p: 0.6, mode: 'post' }, gossipDelay: [30, 150], expose: 0.4 },
  'g.lockhart':    { delay: [20, 200], ignore: 0.1, double: 0.2, emoji: 0.1, leak: { p: 0.3, mode: 'post' }, gossipDelay: [60, 300], expose: 0.1 }
};
const CHAR_DEFAULT = { delay: [30, 300], ignore: 0.15, double: 0.15, emoji: 0.1, leak: { p: 0.25, mode: 'post' }, gossipDelay: [60, 300], expose: 0.1 };
const NPC_DEFAULT = { delay: [15, 240], lower: true, ignore: 0.2, double: 0.2, emoji: 0.15, leak: { p: 0.3, mode: 'post' }, gossipDelay: [30, 200], expose: 0.2 };

function profileFor(bot) {
  if (PROFILES[bot.handle]) return PROFILES[bot.handle];
  if (bot.kind === 'npc') {
    const seed = String(bot.seed || '');
    const p = /gossip|drama magnet|subtweets/i.test(seed) ? 0.8 : /professional hater|chronically online/i.test(seed) ? 0.5 : NPC_DEFAULT.leak.p;
    return { ...NPC_DEFAULT, leak: { p, mode: 'post' } };
  }
  return CHAR_DEFAULT;
}

// ---------------------------------------------------------------- timing
// How long until the bot replies. hint: fast | normal | slow | later. Scaled by `scale` (tests use ~0.02).
function replyDelayMs(bot, { hint = 'normal', hour = 14, scale = 1, rnd = Math.random } = {}) {
  const pr = profileFor(bot);
  let [lo, hi] = pr.delay;
  if (hint === 'fast') hi = lo + (hi - lo) * 0.3;
  else if (hint === 'slow') lo = lo + (hi - lo) * 0.5;
  else if (hint === 'later') { lo = 1200; hi = 7200; } // 20-120 minutes
  let s = lo + rnd() * (hi - lo);
  if (hour >= 9 && hour < 15) s *= 1.3;       // lessons
  else if (hour >= 17 && hour < 23) s *= 0.7; // evenings are chatty
  if (hour >= 0 && hour < 6) {
    if (pr.night === 'awake') s *= pr.odd ? 0.4 : 0.8;                       // Dumbledore and Peeves keep odd hours
    else if (rnd() < 0.85) s = (6 - hour) * 3600 + rnd() * 1800;            // asleep: replies at breakfast
  }
  return Math.max(600, Math.round(s * 1000 * scale));
}
// when the bot opens the message (the "Seen" receipt), usually well before any reply
function seenDelayMs(bot, { scale = 1, rnd = Math.random } = {}) {
  const pr = profileFor(bot);
  const [lo, hi] = pr.curt ? [60, 600] : [3, 40];
  return Math.max(400, Math.round((lo + rnd() * (hi - lo)) * 1000 * scale));
}
const typingMs = text => clamp(String(text || '').length * 55, 700, 4500);
const gossipDelayMs = (bot, { scale = 1, rnd = Math.random } = {}) => {
  const [lo, hi] = profileFor(bot).gossipDelay;
  return Math.max(500, Math.round((lo + rnd() * (hi - lo)) * 1000 * scale));
};

// ---------------------------------------------------------------- voice
const LINES = {
  default: ['haha ok', 'what do you mean', 'sure', 'tell me more', 'lol', 'not sure about that one', 'huh. interesting'],
  'prof.snape': ['I am busy.', 'Is there a point to this message.', 'Noted. Do not write again unless it is important.', 'Detention remains available.'],
  'albus.d': ['Ah. Some questions answer themselves, if one waits long enough.', 'Have you tried a lemon sherbet? It helps with most things.', 'Curious. Very curious indeed.', 'It is rather late for such thoughts, is it not?'],
  'ronweasley': ['hahaha mate', 'wait what', 'ngl that is actually so funny', 'cant talk, snacks', 'bruh', 'really though'],
  'hgranger': ['I read your message twice and there are a few things worth saying. First, please check your sources before posting things like that. Second, I do appreciate you asking me, and I would much rather you did that than guess.', 'That is a fair question, and I think the honest answer is that it depends on what you actually want to happen. Have you thought about who else this affects?'],
  'rita.skeeter': ['Darling! Do tell me more. Off the record, of course.', 'Oh how deliciously interesting. And who else knows?', 'My lips are sealed. (They are not.)'],
  'd.malfoy': ['Do you actually expect me to reply to that.', 'Hm. Interesting. For you.', 'My father would have words about this.'],
  'fred.www': ['quick question: are you interested in a prank product? 3 galleons', 'we can neither confirm nor deny', 'george says hi. george is lying, george is not here'],
  'george.www': ['product enquiries go through fred, i am merely the face', 'hold on, something is on fire', 'ha. ha. ha. noted'],
  'luna.lovegood': ['That is a lovely thought. The wrackspurts agree, I think.', 'I was just thinking about that, in a way.', 'Do you ever notice the invisible things listening?'],
  'pansy.p': ['ugh. fine. go on', 'omg wait is this about draco', 'obsessed. continue'],
  'peeves': ['OOOH A MESSAGE FOR PEEVES', 'peeves is not afraid of you', 'tee hee. say it again louder']
};
const EMOJI = ['👍', '😂', '👀', '🙄', '❤️', '😬'];

function typo(text, rnd) {
  const swaps = [['the', 'teh'], ['what', 'wat'], ['really', 'realy'], ['though', 'tho'], ['you', 'u'], ['because', 'cuz']];
  let t = String(text).toLowerCase();
  for (const [a, b] of swaps) if (rnd() < 0.5) t = t.replace(new RegExp('\\b' + a + '\\b'), b);
  return t;
}
function styleText(bot, text, rnd) {
  const pr = profileFor(bot);
  if (pr.typos) return typo(text, rnd);
  if (pr.lower) return String(text).toLowerCase();
  return text;
}

// ---------------------------------------------------------------- rumours
const RUMOUR_RX = /(rumou?r|secret|between us|don'?t tell|did you hear|have you heard|heard that|psst|tell \S+ (that|about)|gossip|\bcheated\b|\bcrush\b|\bcaught\b|\bsneaking\b|\bstole\b)/i;
const JUICY_RX = /(cheated|secret|crush|caught|affair|liar|lied|stole|expelled|sneaking|banned|cursed|detention)/gi;

// mock stand-in for the AI's rumour classification (the real AI does this in the same call as the reply)
function classifyRumour(text, botHandle) {
  const t = String(text || '');
  if (!RUMOUR_RX.test(t)) return { is_rumour: false };
  const handles = [...t.matchAll(/@([a-z0-9_.]{2,20})/gi)].map(m => m[1].toLowerCase().replace(/\.+$/, '')).filter(h => h !== botHandle);
  const pass = t.match(/tell @?([a-z0-9_.]{2,20}) (?:that|about)/i);
  const subject = handles.find(h => !pass || h !== pass[1].toLowerCase()) || (handles[0]) || null;
  const juicy = (t.match(JUICY_RX) || []).length + (/(don'?t tell|between us|secret)/i.test(t) ? 1 : 0);
  return {
    is_rumour: true,
    subject: subject ? '@' + subject : 'the castle',
    claim: t.replace(/^\s*(psst|hey|so)\W+/i, '').replace(/tell @?\S+ (that|about)\s*/i, '').replace(/[,.]?\s*(between us|don'?t tell (anyone|a soul))\W*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 220),
    juiciness: clamp(2 + juicy, 1, 5),
    pass_to: pass && pass[1].toLowerCase() !== subject ? '@' + pass[1].toLowerCase().replace(/\.+$/, '') : null
  };
}

// each retelling drifts a little; the original is stored separately
function mutateClaim(claim, rnd = Math.random) {
  let c = String(claim);
  const swaps = [[/\ba bit\b/i, 'a lot'], [/\bonce\b/i, 'twice'], [/\bsometimes\b/i, 'always'], [/\bmight\b/i, 'definitely'], [/\bcheated\b/i, 'cheated AND lied about it'], [/\bcrush\b/i, 'huge obsession'], [/\bcaught\b/i, 'caught red-handed']];
  const opts = swaps.filter(([rx]) => rx.test(c));
  if (opts.length && rnd() < 0.7) { const [rx, to] = pick(rnd, opts); c = c.replace(rx, to); }
  else if (!/^apparently/i.test(c)) c = 'apparently ' + c.charAt(0).toLowerCase() + c.slice(1);
  else c += ' (and it was not the first time)';
  return c.slice(0, 240);
}

// what a bot does with a rumour it knows. returns: secret | dm_bot | vaguepost | post | dm_subject | hint | deduct | warn
function gossipDecision(profile, ctx, rnd = Math.random) {
  const { juiciness = 3, believed = true, subjectIsBot = false, subjectIsPlayer = false } = ctx;
  let p = clamp(profile.leak.p * (0.7 + 0.15 * juiciness), 0, 1);
  if (!believed && profile.leak.p < 0.9) p *= 0.5;
  const r = rnd();
  if (r < p) {
    switch (profile.leak.mode) {
      case 'deduct': return subjectIsBot || subjectIsPlayer ? 'deduct' : 'secret';
      case 'hint': return 'hint';
      case 'blurt': return rnd() < 0.5 ? 'post' : (subjectIsBot || subjectIsPlayer ? 'dm_subject' : 'post');
      case 'warn': return subjectIsBot || subjectIsPlayer ? 'warn' : 'secret';
      default: return rnd() < (profile.vague ?? 0.2) ? 'vaguepost' : 'post';
    }
  }
  if (r < p + 0.25) return 'dm_bot';
  if (profile.leak.mode === 'warn' && r < p + 0.4 && (subjectIsBot || subjectIsPlayer)) return 'warn';
  return 'secret';
}

const SUBJECT_REACTIONS = {
  'd.malfoy': 'Excuse me?? Whoever is saying that is lying, and my father will hear about this.',
  'h.potter': "That's not true. Whoever is spreading this can say it to my face.",
  'hgranger': 'That is completely unfounded, and frankly I would like to know the source.',
  'ronweasley': 'wait WHAT. who said that?? thats not even true',
  'rita.skeeter': 'Darling, it is only gossip if it is not about me. Print what you like.',
  'prof.snape': 'I will be looking into who is responsible for this. Thoroughly.'
};
const subjectReaction = (bot, rnd = Math.random) => SUBJECT_REACTIONS[bot.handle] || pick(rnd, ["That's not true and I'd like to know who started it.", 'wow. just wow. whoever is saying that, we need to talk', 'I have heard what is being said about me. It is false.']);

function rumourPostText(bot, mode, { claim, subject, house, exposeHandle, mention }, rnd = Math.random) {
  const subj = subject && /^@/.test(subject) && mention ? subject + ' ' : '';
  const expose = exposeHandle ? ` (a little owl says it was @${exposeHandle} who started this)` : '';
  const h = bot.handle;
  if (mode === 'vaguepost') return `not saying who but someone in ${house || 'this castle'} has been up to something. you know who you are. 👀`.slice(0, 280);
  if (mode === 'hint') return 'It is curious how often a secret is kept by one person and carried by three. I merely observe.';
  if (mode === 'confusing') return `Someone told a nargle something about ${subject && /^@/.test(subject) ? subject : 'a person'} and the nargle told the radishes. I did not understand it, but it sounded important.`.slice(0, 280);
  if (mode === 'deduct') return `Five points from ${subject && /^@/.test(subject) ? subject : 'a certain student'}. I am aware of what you did.`;
  if (h === 'rita.skeeter') return `EXCLUSIVE: ${subj}${claim}${expose}`.slice(0, 280);
  if (h === 'peeves') return `OOOOH PEEVES HEARD A THING!! ${subj}${claim}${expose} TEE HEE`.slice(0, 280);
  return `${subj}not me saying it but ${claim}${expose}`.slice(0, 280);
}
const warnText = (bot, claim) => `hey, just so you know, there is a rumour going round about you. someone is saying: "${String(claim).slice(0, 140)}". thought you should hear it from me.`;
const gossipDmText = (bot, claim) => `psst. heard something about you... "${String(claim).slice(0, 140)}" 👀`;

// ---------------------------------------------------------------- bot-first DMs
const OPENERS = {
  gloat: { bots: ['d.malfoy'], chance: 0.85, delay: [20, 120], text: ['Heard about your little duel. Shame. Do try to lose with more dignity next time.', 'Saw the exchange. Painful. For you. I simply had to say something.'] },
  fish: { bots: ['rita.skeeter'], chance: 0.8, delay: [20, 90], text: ["Darling! The whole castle is talking about you. Off the record, is there anything you'd like to tell me? A little secret, perhaps?", 'You are everywhere today, sweetheart. Anything juicy you are sitting on? I am all ears.'] },
  pitch: { bots: ['fred.www', 'george.www'], chance: 0.5, delay: [30, 150], text: ['hello there! fancy a product trial? limited stock, nothing explodes (mostly). 3 galleons', 'we noticed you are doing numbers. exclusive offer on Skiving Snackboxes, 2 galleons, tell no prefects'] },
  tellOff: { bots: ['hgranger'], chance: 0.7, delay: [60, 240], text: ["I saw your post. I'm not saying you were wrong exactly, but have you thought about the consequences? Sources, please.", 'That post did not need to be that sharp. I just think you might regret it tomorrow.'] },
  crush: { bots: [], chance: 0.35, delay: [60, 300], text: ['hey. um. i really liked your post. sorry if this is weird', 'hi!! sorry to message out of nowhere. i think you are really funny'] }
};

// ---------------------------------------------------------------- mock DM brain
const INSULT_RX = /(stupid|idiot|hate you|shut up|loser|ugly|trash|useless|pathetic|dumb|annoying|boring)/i;
const FLATTER_RX = /(love you|legend|amazing|brilliant|genius|best|thank you|thanks|you are great|you're great|respect|queen|king)/i;
const HELP_RX = /(help|please|could you|can you|advice)/i;

// decision shape matches the real AI's: { actions:[{kind:'message'|'react'|'ignore'|'end', text, emoji, delay}], relationship_delta, relationship_memory, summary, rumour }
function mockDM(bot, { text, history = [], relScore = 0, player = 'you', summaryNeeded = false, hour = 14, rnd = Math.random }) {
  const pr = profileFor(bot);
  const t = String(text || '');
  const insulted = INSULT_RX.test(t), flattered = FLATTER_RX.test(t), asked = HELP_RX.test(t);
  const rumour = classifyRumour(t, bot.handle);
  const delta = insulted ? -2 : flattered ? 1 : asked ? 1 : rnd() < 0.2 ? 1 : 0;
  const memory = insulted ? `${player} was rude in DMs` : flattered ? `${player} flattered them in DMs` : rumour.is_rumour ? `${player} shared gossip in DMs` : asked ? `${player} asked for a favour in DMs` : `chatted with ${player}: "${t.slice(0, 40)}"`;
  const actions = [];
  const r = rnd();
  const ignore = rumour.is_rumour ? 0 : pr.ignore * (relScore < -3 ? 1.5 : relScore > 3 ? 0.5 : 1);
  const hooks = [...t.matchAll(/#(ignore|react|double|end|reply)\b/gi)];
  const hook = hooks.length ? hooks[hooks.length - 1][1] : undefined; // mock-only test hooks: the latest one in the burst forces a behaviour
  if (hook) {
    const pool = LINES[bot.handle] || LINES.default;
    if (hook.toLowerCase() === 'reply') actions.push({ kind: 'message', text: styleText(bot, pick(rnd, pool), rnd), delay: 'normal' });
    else if (hook.toLowerCase() === 'ignore') actions.push({ kind: 'ignore' });
    else if (hook.toLowerCase() === 'react') actions.push({ kind: 'react', emoji: '👍' });
    else if (hook.toLowerCase() === 'double') actions.push({ kind: 'message', text: styleText(bot, pick(rnd, pool), rnd), delay: 'fast' }, { kind: 'message', text: styleText(bot, 'also, one more thing', rnd), delay: 'fast' });
    else actions.push({ kind: 'message', text: styleText(bot, 'ok. i am done talking.', rnd), delay: 'fast' }, { kind: 'end' });
  }
  else if (r < ignore) actions.push({ kind: 'ignore' });
  else if (r < ignore + (rumour.is_rumour ? 0 : pr.emoji)) actions.push({ kind: 'react', emoji: pick(rnd, EMOJI) });
  else {
    const pool = LINES[bot.handle] || LINES.default;
    const first = styleText(bot, pick(rnd, pool), rnd);
    actions.push({ kind: 'message', text: first, delay: relScore > 4 ? 'fast' : relScore < -4 ? 'slow' : 'normal' });
    if (rnd() < pr.double && !pr.curt) actions.push({ kind: 'message', text: styleText(bot, pick(rnd, pool), rnd), delay: 'fast' });
    if (rnd() < 0.08) actions.push({ kind: 'message', text: styleText(bot, pick(rnd, ['also', 'anyway', 'oh and', 'wait one more thing']), rnd), delay: 'later' });
    if (insulted && rnd() < 0.5) actions.push({ kind: 'end' });
  }
  const out = { actions, relationship_delta: delta, relationship_memory: memory, mood: insulted ? 'annoyed' : flattered ? 'warm' : 'neutral' };
  if (summaryNeeded) out.summary = summarizeHistory(history, bot, player);
  if (rumour.is_rumour) out.rumour = { ...rumour, believed: relScore >= -2 };
  return out;
}

function summarizeHistory(history, bot, player) {
  const lines = history.slice(-12).map(m => `${m.from === 'bot' ? bot.name : player}: ${String(m.text).slice(0, 50)}`);
  return `Recent chat between ${player} and ${bot.name}. ${lines.join(' | ')}`.slice(0, 480);
}

module.exports = { clamp, sydneyHour, PROFILES, profileFor, replyDelayMs, seenDelayMs, typingMs, gossipDelayMs, LINES, EMOJI, typo, styleText, classifyRumour, mutateClaim, gossipDecision, subjectReaction, rumourPostText, warnText, gossipDmText, OPENERS, mockDM, summarizeHistory };
