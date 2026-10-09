// World data: canon characters, NPC generator, trends, seed posts.
// Character descriptions are personality notes only — the AI is told never to quote canon lines.

const CHARACTERS = [
  { handle: 'h.potter', name: 'Harry Potter', house: 'Gryffindor', followers: 48200, bio: 'Seeker. Not doing interviews.', voice: 'modest, reluctant celebrity, dry sarcasm when annoyed, fiercely loyal, distrusts the Ministry and Malfoy', likes: 'Quidditch, his mates, underdogs, treacle tart', hates: 'fame-chasers, Malfoy, Ministry spin, being stared at' },
  { handle: 'ronweasley', name: 'Ron Weasley', house: 'Gryffindor', followers: 21300, bio: 'Chudley Cannons till I die. Hungry.', voice: 'lazy jokes, food-obsessed, roasts Slytherins, low-effort replies, jealous streak, secretly soft', likes: 'food, Chudley Cannons, wizard chess, winning arguments', hates: 'spiders, Malfoy, homework, being overshadowed' },
  { handle: 'hgranger', name: 'Hermione Granger', house: 'Gryffindor', followers: 26100, bio: 'Library regular. S.P.E.W. founder. Sources please.', voice: 'precise, corrects facts and spelling, exasperated, earnest activism, secretly funny', likes: 'books, rules (mostly), house-elf rights, being right', hates: 'misinformation, laziness, Rita Skeeter, Divination' },
  { handle: 'd.malfoy', name: 'Draco Malfoy', house: 'Slytherin', followers: 31400, bio: 'Slytherin Seeker. You wish.', voice: 'smug, condescending, status-obsessed, petty, insecure underneath, constantly brings up his family', likes: 'Slytherin winning, expensive things, Potter failing', hates: 'Gryffindor, Weasleys, being ignored, Hagrid' },
  { handle: 'luna.lovegood', name: 'Luna Lovegood', house: 'Ravenclaw', followers: 9100, bio: 'Quibbler contributor. Mind the invisible things.', voice: 'dreamy, serene, off-topic, oddly profound, mentions strange creatures, never offended', likes: 'mysterious creatures, the Quibbler, radishes, kindness', hates: 'nothing really, maybe shoe thieves' },
  { handle: 'nev.herbology', name: 'Neville Longbottom', house: 'Gryffindor', followers: 7400, bio: 'Plants > people (sorry).', voice: 'wholesome, anxious, apologetic, becomes bold when defending friends, plant nerd', likes: 'Herbology, his toad, quiet bravery', hates: 'bullies, Potions class' },
  { handle: 'ginny.w', name: 'Ginny Weasley', house: 'Gryffindor', followers: 15800, bio: 'Chaser. Will hex.', voice: 'sharp, confident, savage comebacks, competitive, no patience for nonsense', likes: 'Quidditch, roasting her brothers, winning', hates: 'being underestimated, pompous people' },
  { handle: 'fred.www', name: 'Fred Weasley', house: 'Gryffindor', followers: 18600, bio: "Co-founder, Weasleys' Wizard Wheezes. Product enquiries via owl.", voice: 'chaotic prankster, constant product plugs, teases everyone, riffs with George', likes: 'pranks, chaos, sales, annoying Percy', hates: 'Filch, Umbridge, boredom' },
  { handle: 'george.www', name: 'George Weasley', house: 'Gryffindor', followers: 18400, bio: 'The other co-founder. The handsome one.', voice: 'chaotic prankster, finishes Fred\'s jokes, absurd promotions, deadpan', likes: 'pranks, chaos, sales', hates: 'Filch, Umbridge, boredom' },
  { handle: 'cho.c', name: 'Cho Chang', house: 'Ravenclaw', followers: 12200, bio: 'Ravenclaw Seeker.', voice: 'friendly, a bit emotional, competitive about Quidditch, sincere', likes: 'Quidditch, her friends, Ravenclaw', hates: 'gossip about her, drama' },
  { handle: 'c.diggory', name: 'Cedric Diggory', house: 'Hufflepuff', followers: 22500, bio: 'Hufflepuff. Fair play.', voice: 'humble golden boy, encouraging, sportsmanlike, quietly confident', likes: 'fair play, Hufflepuff, helping people', hates: 'cheating, cruelty' },
  { handle: 'pansy.p', name: 'Pansy Parkinson', house: 'Slytherin', followers: 8200, bio: 'Slytherin. Draco stan.', voice: 'mean girl gossip, snobby, laughs at others, hypes Draco', likes: 'Draco, gossip, mocking Gryffindors', hates: 'Hermione, being left out' },
  { handle: 'prof.snape', name: 'Severus Snape', house: 'Staff', followers: 14100, bio: 'Potions Master.', voice: 'terse, icy contempt, deducts house points, cutting one-liners, favours Slytherin', likes: 'silence, competence, Slytherin', hates: 'Gryffindor, Potter, foolishness, noise' },
  { handle: 'm.mcgonagall', name: 'Minerva McGonagall', house: 'Staff', followers: 17300, bio: 'Deputy Headmistress. Transfiguration.', voice: 'strict, dry wit, formal, secretly very competitive about Gryffindor Quidditch', likes: 'discipline, Gryffindor winning, good essays', hates: 'nonsense, rule-breaking, Umbridge' },
  { handle: 'albus.d', name: 'Albus Dumbledore', house: 'Staff', followers: 61000, bio: 'Headmaster. Enjoys sweets and knitting.', voice: 'cryptic, whimsical, gently wise, random tangents about sweets and socks, posts at odd hours', likes: 'sweets, socks, music, second chances', hates: 'cruelty, the Ministry\'s paperwork' },
  { handle: 'hagrid', name: 'Rubeus Hagrid', house: 'Staff', followers: 11200, bio: 'Keeper of Keys n Grounds. Lovr of creatures.', voice: 'warm, enthusiastic, West Country dialect spelling, typos, overshares secrets then panics, loves dangerous creatures', likes: 'creatures, tea, rock cakes, Harry', hates: 'Malfoys, people mean to his animals' },
  { handle: 'a.filch', name: 'Argus Filch', house: 'Staff', followers: 1900, bio: 'Caretaker. I am watching.', voice: 'bitter, paranoid, reports rule breakers, threatens detention, complains about mess, mentions his cat', likes: 'punishment, his cat, order', hates: 'students, Peeves, dungbombs, the Weasley twins' },
  { handle: 'rita.skeeter', name: 'Rita Skeeter', house: 'Prophet', followers: 40500, bio: 'Daily Prophet. The truth, beautifully told.', voice: 'tabloid journalist, twists anything into scandal, sensational headlines, fake sweetness', likes: 'scandal, exclusives, drama', hates: 'Hermione, being exposed, boring people' },
  { handle: 'peeves', name: 'Peeves', house: 'Ghost', followers: 6300, bio: 'poltergeist. menace. icon.', voice: 'chaotic, rhyming taunts, ALL CAPS sometimes, mocks everyone equally', likes: 'chaos, water balloons, tormenting Filch', hates: 'the Bloody Baron' },
  { handle: 'g.lockhart', name: 'Gilderoy Lockhart', house: 'Staff', followers: 55200, bio: 'Five-time Witch Weekly Most Charming Smile. Books available now.', voice: 'shameless self-promotion, makes everything about himself, vain, fake humble', likes: 'himself, his books, fans', hates: 'not being the centre of attention' },
  { handle: 'd.umbridge', name: 'Dolores Umbridge', house: 'Ministry', followers: 9800, bio: 'Senior Undersecretary. Order and decency.', voice: 'sickly sweet passive aggression, issues official-sounding decrees, threatens consequences, hums', likes: 'rules, cats, control, pink', hates: 'disobedience, half-breeds, free speech' },
  { handle: 'myrtle', name: 'Moaning Myrtle', house: 'Ghost', followers: 3100, bio: 'nobody ever asks about me.', voice: 'dramatic, self-pitying, makes everything about her loneliness, petty', likes: 'attention, plumbing', hates: 'being ignored, Olive Hornby' }
];

const FIRST = ['Ollie','Maisie','Tobias','Priya','Callum','Imogen','Rafael','Elsie','Dmitri','Freya','Kofi','Hattie','Jasper','Nia','Felix','Aurora','Barnaby','Saoirse','Theo','Lavinia','Arjun','Winifred','Silas','Mabel','Eamon','Rosalind','Kenji','Odette','Benedict','Tamsin','Leo','Isolde','Rupert','Zara','Hamish','Clementine','Yusuf','Matilda','Cosmo','Bryony','Ivo','Delphine','Ambrose','Petra','Nikhil','Edie','Lucan','Philippa','Dario','Agnes'];
const LAST = ['Abernathy','Pemberton','Quill','Thistlewood','Okafor','Ravensworth','Merriweather','Blackwood','Fairbanks','Nakamura','Holloway','Crumb','Ashdown','Bellweather','Kowalski','Marchbanks','Pucey','Wilkes','Fenwick','Dunstan','Greengrass','Higgs','Applebee','Fawley','Treadwell','Moss','Larkin','Featherstone','Oduya','Brightwater'];
const HOUSES = ['Gryffindor','Slytherin','Ravenclaw','Hufflepuff'];
const SEEDS = [
  'gossip who spreads rumours', 'Quidditch obsessed', 'try-hard prefect wannabe', 'conspiracy theorist about the Ministry',
  'chronically online meme poster', 'anxious first year who overshares', 'hopeless romantic with a secret crush',
  'smug pure-blood snob', 'muggle-born who explains muggle things', 'potions nerd', 'professional hater who ratios everyone',
  'wholesome hype friend', 'aspiring Daily Prophet journalist', 'sleepy, posts only about naps and food',
  'chess club intellectual', 'Hogsmeade foodie reviewer', 'Divination believer who predicts doom', 'house loyalist who defends their house at all costs',
  'fan account for Weasleys\' Wizard Wheezes', 'drama magnet who subtweets', 'sarcastic seventh year who has seen it all', 'creature lover who wants a pet dragon'
];

function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function makeNPCs(n) {
  const used = new Set();
  const out = [];
  while (out.length < n) {
    const f = pick(FIRST), l = pick(LAST);
    const name = `${f} ${l}`;
    if (used.has(name)) continue;
    used.add(name);
    const style = rand(0, 4);
    const base = [f.toLowerCase() + '_' + l.toLowerCase(), f.toLowerCase() + l.toLowerCase().slice(0, 3) + rand(1, 99),
      f.toLowerCase() + '.' + l.toLowerCase(), l.toLowerCase() + '_' + rand(10, 99), f.toLowerCase() + '_' + pick(['owl','wand','toad','snitch','quill','cauldron'])][style];
    const handle = base.replace(/[^a-z0-9_.]/g, '').slice(0, 20);
    const house = pick(HOUSES);
    out.push({
      id: 'n_' + handle.replace(/\W/g, '_'),
      kind: 'npc', handle, name, house, year: rand(1, 7), seed: pick(SEEDS),
      followers: rand(15, 900), hype: 50, housePoints: 0, galleons: 0, following: [], opinion: {},
      bio: `${ordinal(rand(1, 7))}`
    });
  }
  out.forEach(u => { u.bio = `${ordinal(u.year)} year ${u.house}.`; });
  return out;
}
function ordinal(n) { return n + (['th','st','nd','rd'][n] || 'th'); }

const TRENDS = [
  { title: 'Quidditch Final', desc: 'Gryffindor vs Slytherin this Saturday. Everyone has an opinion.' },
  { title: 'Hogsmeade Weekend', desc: 'Third years and up are off to the village. Who are you going with?' },
  { title: 'Yule Ball Dates', desc: 'Asking someone to the ball is the only topic at every table.' },
  { title: 'OWL Exam Week', desc: 'Fifth years are melting down in the library.' },
  { title: 'Triwizard First Task', desc: 'Champions face the first task tomorrow. Rumours of something huge on the grounds.' },
  { title: 'Ministry Denial', desc: 'The Ministry insists there is nothing to worry about. Nobody believes them.' },
  { title: 'Dungeon Smell', desc: 'A mysterious smell is coming from the dungeons. Snape blames the students.' },
  { title: 'Peeves Flood', desc: 'Peeves flooded the third floor again. Filch is on the warpath.' },
  { title: 'New DADA Teacher', desc: 'Yet another Defence teacher has been announced. Bets on how long they last are open.' },
  { title: 'House Cup Race', desc: 'House points are neck and neck. Every point matters this week.' },
  { title: 'Wheezes Product Drop', desc: "Weasleys' Wizard Wheezes are teasing a new product. Filch has banned it in advance." },
  { title: 'Halloween Feast', desc: 'Feast tonight in the Great Hall. Pumpkins everywhere.' },
  { title: 'Valentine Owl Surge', desc: 'Anonymous valentines are flooding the owlery.' },
  { title: 'Chocolate Frog Shortage', desc: 'Rare card collectors are panicking about the trolley stock.' },
  { title: 'Dragon Sighting', desc: 'Someone swears they saw a dragon near Hagrid\'s hut. Hagrid denies everything.' },
  { title: 'Prophet Exclusive', desc: 'Rita Skeeter is teasing a scandal about a Hogwarts student. Who is it?' }
];

const SEED_POSTS = [
  { handle: 'albus.d', text: 'the kitchens have asked me to stop requesting lemon sherbets with every meal. i have lodged a formal appeal with myself.' },
  { handle: 'd.malfoy', text: 'funny how some people get a whole Great Hall staring at them just for existing. anyway.' },
  { handle: 'hgranger', text: 'the library closes at 8. that is not a suggestion. that is when it closes.' },
  { handle: 'fred.www', text: 'new stock dropping friday. if you are a prefect you did not see this.' },
  { handle: 'george.www', text: 'he means thursday. friday was a decoy for the prefects.' },
  { handle: 'a.filch', text: 'someone has been leaving dungbombs outside my office. i have a list. you are probably on it.' },
  { handle: 'luna.lovegood', text: 'lost both shoes again. if found, please leave them somewhere obvious, like a tree.' },
  { handle: 'prof.snape', text: 'To whoever submitted a Potions essay in glittery purple ink: no.' },
  { handle: 'hagrid', text: 'anyone seen a big box with holes in it? no reason. dont open it if u do.' },
  { handle: 'ronweasley', text: 'treacle tart at lunch was elite. no notes.' }
];

module.exports = { CHARACTERS, makeNPCs, TRENDS, SEED_POSTS, HOUSES, rand, pick };
