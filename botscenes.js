// Mock "scenes": multi-bot reply chains + storyline beats, used when no AI provider answers (and in tests).
// Pure: the server passes in who exists and how bots feel about each other.
'use strict';

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const shuffle = (rnd, a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const topicOf = trend => (trend && trend.title ? '#' + trend.title.replace(/\s+/g, '') : '#Hogwarts');

const OPEN = ['hot take: {T} is overrated and everyone knows it', 'can we talk about how {T} is being handled? because wow', 'the way people are acting about {T} is honestly embarrassing', '{T} update: i was right. i will not be taking questions'];
const COMEBACK = ['{A} bold words from someone who needs a map to the Great Hall 💀', '{A} you said that out loud? in public? brave', '{A} imagine being this wrong with this much confidence', '{A} noted. filed under things nobody asked'];
const ESCALATE = ['{B} the audacity. truly. you of all people', '{B} say it to my face then. lake. 4pm.', '{B} counting the days until you get humbled. house cup season is coming', '{B} you really want to do this in front of everyone?'];
const BACKDOWN = ['{A} fine. enjoy the win. i have better things to do', '{A} we will settle it on the pitch', '{A} whatever. you are not worth the detention'];
const FRIEND_A = ['{B} this ^^^ and also you are right as usual', '{B} okay but you literally always get it', '{B} thank you for saying what everyone was thinking 🫶'];
const FRIEND_B = ['{A} stop it you are making me blush in the corridor', '{A} the two of us against the world, as always', '{A} meet me by the fire later, we need to talk about this properly'];

const DOUBLE = [
  ['announcement: the new product launch rumours are TRUE', '{o} we agreed this was a surprise', '{o} it is less a surprise and more a hazard', '{o} legal says we are no longer allowed to say "explosive"'],
  ['quick poll: who wants a free sample of the new thing', '{o} nobody has ever wanted that, brother', '{o} and yet it sells out every time', '{o} the prefects know. the prefects always know.']
];
const FILCH = ['to whoever keeps flooding the second floor: i WILL find you', '{o} OOOH TRY ME LITTLE MAN 💦', '{o} i am writing this down', '{o} write faster'];
const CORRECT = [['does the library close at 10 or something?', '{o} It closes at 8. It has always closed at 8.', '{o} ok ok sorry 😭', 'Apology accepted. The notice board is there for a reason.']];
const LUNA = ['genuinely stressed about OWL week 😩', '{o} Have you considered that the nargles may be sitting on your quills?', '{o} ...what', '{o} It helps to ask them, politely, to leave.'];
const STAFF = ['just threw a dungbomb for science. no regrets', '{o} you are SO getting caught lol', '{o2} Five points from {H}. The dungbomb is going to the caretaker.', '{o} worth it'];
const STUDENTS = ['unpopular opinion: {T} has been ruined by the hype', '{o} you only say that because your house is losing', '{o} my house is fine, thank you, see the points table', '{o} the points table is a work of fiction'];
const BEAT = ['{A} and {B} traded public barbs about {T}', '{A} called {B} out again over {T}', '{A} and {B} are still circling each other over {T}'];

function fill(t, v) { return t.replace(/\{(\w+)\}/g, (_, k) => v[k] !== undefined ? v[k] : ''); }

// ctx: { bot: handle -> user|undefined, chars: [users], npcs: [users], pairs: [{a,b,score}] (user objects), trend, stories: [{id,title,bots:[handles],stage}], recent: [{id, authorHandle}] }
function buildMockScenes(ctx, rnd = Math.random) {
  const out = { scenes: [], new_storyline: null, storyline_updates: [] };
  const used = new Set();
  const T = topicOf(ctx.trend);
  const has = h => !!ctx.bot(h);
  const at = h => '@' + h;
  const want = 1 + (rnd() < 0.5 ? 1 : 0);

  // 1) continue (or resolve) an active storyline first
  const story = ctx.stories && ctx.stories.length ? pick(rnd, ctx.stories) : null;
  if (story && story.bots.length >= 2 && story.bots.every(has)) {
    const [A, B] = story.bots;
    const resolve = story.stage >= 4 && rnd() < 0.55;
    const msgs = [{ handle: at(A), text: fill(pick(rnd, OPEN), { T }), reply_to: null }];
    msgs.push({ handle: at(B), text: fill(pick(rnd, COMEBACK), { A: at(A) }), reply_to: 0 });
    msgs.push({ handle: at(A), text: fill(pick(rnd, resolve ? BACKDOWN : ESCALATE), { A: at(B), B: at(B) }), reply_to: 1 });
    if (!resolve) msgs.push({ handle: at(B), text: fill(pick(rnd, ESCALATE), { B: at(A) }), reply_to: 2 });
    out.scenes.push({ under: 'new', storyline_id: story.id, messages: msgs });
    out.storyline_updates.push({ id: story.id, beat: fill(pick(rnd, BEAT), { A: ctx.bot(A).name, B: ctx.bot(B).name, T }), resolve, resolution: resolve ? `${ctx.bot(A).name} and ${ctx.bot(B).name} called a truce, for now` : undefined });
    used.add(A); used.add(B);
  } else if ((!ctx.stories || ctx.stories.length < 3) && ctx.pairs && ctx.pairs.length && rnd() < 0.7) {
    // 2) start a new storyline from the strongest feud (or friendship) nobody is already telling
    const free = ctx.pairs.filter(p => p.score <= -5 && has(p.a.handle) && has(p.b.handle) && !(ctx.stories || []).some(s => s.bots.includes(p.a.handle) && s.bots.includes(p.b.handle)));
    const p = free.length ? pick(rnd, free.slice(0, 6)) : null;
    if (p) {
      const A = p.a, B = p.b;
      out.new_storyline = { title: `${A.name} vs ${B.name}: ${T.replace('#', '')}`, bots: [at(A.handle), at(B.handle)], summary: `${A.name} and ${B.name} are feuding over ${T}` };
      out.scenes.push({ under: 'new', storyline_id: 'new', messages: [
        { handle: at(A.handle), text: fill(pick(rnd, OPEN), { T }), reply_to: null },
        { handle: at(B.handle), text: fill(pick(rnd, COMEBACK), { A: at(A.handle) }), reply_to: 0 },
        { handle: at(A.handle), text: fill(pick(rnd, ESCALATE), { B: at(B.handle) }), reply_to: 1 }
      ] });
      used.add(A.handle); used.add(B.handle);
    }
  }

  // 3) fill the rest with stock scenes
  const kinds = shuffle(rnd, ['double', 'filch', 'correct', 'luna', 'staff', 'students', 'friends', 'feud']);
  for (const kind of kinds) {
    if (out.scenes.length >= want + (out.new_storyline ? 0 : 0) && out.scenes.length >= want) break;
    let msgs = null;
    if (kind === 'double' && has('fred.www') && has('george.www') && !used.has('fred.www')) {
      const s = pick(rnd, DOUBLE);
      msgs = s.map((t, i) => ({ handle: at(i % 2 ? 'george.www' : 'fred.www'), text: fill(t, { o: i % 2 ? at('fred.www') : at('george.www') }), reply_to: i ? i - 1 : null }));
      used.add('fred.www'); used.add('george.www');
    } else if (kind === 'filch' && has('a.filch') && has('peeves') && !used.has('a.filch')) {
      msgs = FILCH.map((t, i) => ({ handle: at(i % 2 ? 'peeves' : 'a.filch'), text: fill(t, { o: i % 2 ? at('a.filch') : at('peeves') }), reply_to: i ? i - 1 : null }));
      used.add('a.filch'); used.add('peeves');
    } else if (kind === 'correct' && has('hgranger') && ctx.npcs.length && !used.has('hgranger')) {
      const n = pick(rnd, ctx.npcs);
      const s = pick(rnd, CORRECT);
      msgs = s.map((t, i) => ({ handle: at(i === 1 || i === 3 ? 'hgranger' : n.handle), text: fill(t, { o: i === 1 ? at(n.handle) : at('hgranger') }), reply_to: i ? i - 1 : null }));
      used.add('hgranger');
    } else if (kind === 'luna' && has('luna.lovegood') && ctx.npcs.length && !used.has('luna.lovegood')) {
      const n = pick(rnd, ctx.npcs);
      msgs = LUNA.map((t, i) => ({ handle: at(i === 1 || i === 3 ? 'luna.lovegood' : n.handle), text: fill(t, { o: i === 1 ? at(n.handle) : at('luna.lovegood') }), reply_to: i ? i - 1 : null }));
      used.add('luna.lovegood');
    } else if (kind === 'staff' && ctx.npcs.length > 1 && (has('m.mcgonagall') || has('prof.snape'))) {
      const [n1, n2] = shuffle(rnd, ctx.npcs);
      const st = has('m.mcgonagall') ? 'm.mcgonagall' : 'prof.snape';
      msgs = [
        { handle: at(n1.handle), text: STAFF[0], reply_to: null },
        { handle: at(n2.handle), text: fill(STAFF[1], { o: at(n1.handle) }), reply_to: 0 },
        { handle: at(st), text: fill(STAFF[2], { o2: at(n1.handle), H: n1.house }), reply_to: 0, points: -5, points_to: at(n1.handle) },
        { handle: at(n1.handle), text: fill(STAFF[3], { o: at(st) }), reply_to: 2 }
      ];
    } else if (kind === 'students' && ctx.npcs.length > 1) {
      const [n1, n2] = shuffle(rnd, ctx.npcs);
      msgs = STUDENTS.map((t, i) => ({ handle: at(i % 2 ? n2.handle : n1.handle), text: fill(t, { T, o: at(i % 2 ? n1.handle : n2.handle) }), reply_to: i ? i - 1 : null }));
    } else if (kind === 'friends' && ctx.pairs && ctx.pairs.length) {
      const f = ctx.pairs.filter(p => p.score >= 5 && has(p.a.handle) && has(p.b.handle) && !used.has(p.a.handle));
      if (f.length) { const p = pick(rnd, f); msgs = [{ handle: at(p.a.handle), text: `honestly proud of ${T} today, this castle is something else`, reply_to: null }, { handle: at(p.b.handle), text: fill(pick(rnd, FRIEND_A), { B: at(p.a.handle) }), reply_to: 0 }, { handle: at(p.a.handle), text: fill(pick(rnd, FRIEND_B), { A: at(p.b.handle) }), reply_to: 1 }]; used.add(p.a.handle); }
    } else if (kind === 'feud' && ctx.pairs && ctx.pairs.length) {
      const f = ctx.pairs.filter(p => p.score <= -3 && has(p.a.handle) && has(p.b.handle) && !used.has(p.a.handle) && !used.has(p.b.handle));
      if (f.length) { const p = pick(rnd, f); msgs = [{ handle: at(p.a.handle), text: fill(pick(rnd, OPEN), { T }), reply_to: null }, { handle: at(p.b.handle), text: fill(pick(rnd, COMEBACK), { A: at(p.a.handle) }), reply_to: 0 }, { handle: at(p.a.handle), text: fill(pick(rnd, BACKDOWN), { A: at(p.b.handle) }), reply_to: 1 }]; used.add(p.a.handle); used.add(p.b.handle); }
    }
    if (msgs) out.scenes.push({ under: 'new', storyline_id: null, messages: msgs.slice(0, 6) });
  }
  // a scene can also play out under an existing bot post (replies only)
  if (out.scenes.length > 1 && ctx.recent && ctx.recent.length && rnd() < 0.5) {
    const r = pick(rnd, ctx.recent);
    const sc = out.scenes[out.scenes.length - 1];
    if (sc.messages.length >= 2 && !sc.storyline_id) { sc.under = r.id; sc.messages = sc.messages.slice(1).map((m, i) => ({ ...m, reply_to: i === 0 ? null : (m.reply_to > 0 ? m.reply_to - 1 : null) })); }
  }
  return out;
}

module.exports = { buildMockScenes, topicOf };
