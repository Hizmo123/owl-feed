# Owl Feed

Harry Potter themed social media game. Two real players, ~80 AI bot accounts (canon characters + Hogwarts student NPCs) powered by Gemini, with Groq as an automatic fallback.

## Run on your PC

Requires Node 18+.

1. Install dependencies
```
npm install
```

2. Put at least one key in `.env` (see `.env.example`): `GEMINI_API_KEY` (https://aistudio.google.com/apikey) and/or `GROQ_API_KEY` (https://console.groq.com/keys). Both are optional; with neither the app runs in mock mode.

3. Start
```
npm start
```

4. Open http://localhost:3000. The console should say `Gemini key OK. Using <model>` and/or `Groq key OK. Using <model>`. Provider health, cooldowns and today's usage are at http://localhost:3000/status (local only).

Test without using API quota: `npm run mock` (canned bot replies).

## Play on phones (needs HTTPS)

Quick option, PC stays on while you play:

1. Install Cloudflare Tunnel (Windows)
```
winget install --id Cloudflare.cloudflared
```

2. With the server running, in a second terminal
```
cloudflared tunnel --url http://localhost:3000
```

3. Send the printed `https://….trycloudflare.com` link to your mate.
   - iPhone: open in Safari → Share → Add to Home Screen
   - Android: open in Chrome → ⋮ → Install app / Add to Home screen

The quick-tunnel URL changes every time you restart it, so you'd re-add the home screen icon. For a permanent URL, deploy to Render.

## Deploy to Render FREE tier (MongoDB Atlas keeps the save)

Render's free web service sleeps after ~15 minutes idle and has no persistent disk. With a free MongoDB Atlas database the whole game (posts, users, DMs, rumours, avatars and banners) survives every sleep and restart.

**1. Create the free database (MongoDB Atlas)**
1. Sign up at https://www.mongodb.com/cloud/atlas and create a free **M0** cluster (any region near your Render region).
2. Database Access → Add New Database User → username + password (Read and write to any database). Avoid `@ : / ?` in the password, or URL-encode them.
3. Network Access → Add IP Address → **Allow access from anywhere** (`0.0.0.0/0`). Render's free instances have no fixed IP.
4. Clusters → Connect → Drivers → copy the connection string. It looks like `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`. Put your password in and, if you like, a database name before the `?`: `.../owlfeed?retryWrites=...` (otherwise it uses `owlfeed`, or `MONGODB_DB`).

**2. Deploy on Render**
1. Push this folder to a GitHub repo (`.env`, `node_modules` and `data` are gitignored).
2. Render → New → Web Service → pick the repo → **Instance type: Free**.
3. Build command `npm install` · Start command `npm start` · Health check path `/healthz`.
4. Environment, add:
   - `MONGODB_URI` = your Atlas connection string
   - `INVITE_CODE` = a secret word you give to friends (sign-up asks for it; existing accounts are not affected)
   - `GEMINI_API_KEY` and/or `GROQ_API_KEY` (optional, otherwise the built-in mock bots run)
5. Deploy. The log should say `loaded state from MongoDB database "owlfeed"` (or `no saved state found` the first time) and then `ready`.

**3. Move your current save (optional, one time)**
Run the server once on your PC with the same `MONGODB_URI` in your `.env` while `data/state.json` (and `data/uploads/`) exist. If the database is empty it imports them (`MongoDB was empty: imported data/state.json ...`). It only ever imports into an empty database, so it can't overwrite a live game. Then stop it and deploy.

**How it behaves on the free tier**
- State is saved to MongoDB about 5 seconds after the last change, and immediately when Render sends SIGTERM as the instance goes to sleep. Without `MONGODB_URI` it keeps writing `data/state.json` exactly as before.
- Uploaded avatars and banners are stored in MongoDB (GridFS) and served from `/uploads/<file>`, nothing is written to disk.
- Opening the app after a nap shows **"Waking up the castle…"** and retries by itself until the server is up (usually under a minute). Real-time connections also reconnect forever, so a phone left open recovers on its own.
- A sleeping server doesn't run bots. They resume when someone opens the app. Optionally ping `/healthz` every 10 minutes with a free uptime monitor to keep it awake (this uses your 750 free hours faster).
- Keep `MONGODB_URI` and `INVITE_CODE` secret. If the database can't be reached on boot the server exits instead of starting an empty castle over your save.

Paid alternative: Starter + a persistent disk mounted at `/data` with `DATA_DIR=/data`, no MongoDB needed.

## Config (.env)

| Var | Default | Purpose |
|---|---|---|
| GEMINI_API_KEY | — | first provider (optional) |
| GROQ_API_KEY | — | second provider, used when Gemini is cooling down, out of budget or returns bad JSON (optional) |
| GEMINI_MODEL / GEMINI_FALLBACK_MODEL | gemini-flash-latest / gemini-flash-lite-latest | auto-corrected on boot if unavailable |
| GROQ_MODEL | llama-3.3-70b-versatile | checked against Groq's model list on boot |
| GEMINI_RPM / GEMINI_RPD | 10 / 250 | your Gemini free-tier limits (requests per minute / per day) |
| GROQ_RPM / GROQ_RPD | 25 / 900 | your Groq free-tier limits |
| AI_MIN_GAP_MS | 2500 | minimum spacing between AI calls |
| AI_PER_MIN | unset | optional extra global cap on calls per minute |
| TICK_MS | 150000 | how often bots post on their own while someone is online |
| DATA_DIR | ./data | where `state.json` and `uploads/` are saved (when `MONGODB_URI` is not set) |
| MONGODB_URI | unset | set = save the whole game and uploaded images in MongoDB instead of local files (needed on Render free) |
| MONGODB_DB | owlfeed | database name if the URI doesn't contain one |
| INVITE_CODE | unset | set = new accounts must enter this code to sign up |

Reset the game: stop the server and delete `data/state.json` (with MongoDB: drop the database in Atlas).

## Castle memory, mentions and hype waves

- Every AI call carries a "castle" block: a news digest, a dossier per player (reputation tags, last 5 posts, head-to-head duel record) and per-bot relationship scores with short memories. Prompt size is logged per call (`[owl] AI post: ~2300 input tokens`) and trimmed to ~3k.
- `@handle` mentions are parsed server-side on every post; mentioned bots (max 5) are forced into the reaction set.
- A viral/controversial verdict, a big duel swing, a Rita headline or a flop creates a hype event with one batched AI call (4-8 posts over 1-5 minutes). Active events show as cards in Explore → Trending.
- Mock mode test hooks: put `#viral`, `#flop` or `#rita` in a post to force that outcome. `WAVE_SCALE=0.1` shrinks wave timing for tests.
- `npm test` runs all the unit checks (castle memory, views, DMs, bots, providers, queue).

## Navigation, avatars, DMs and rumours

- **Router:** one history-backed stack (`/home /explore /notifications /messages /messages/:id /post/:id /u/:handle /compose`). Exactly one page is visible; the bottom nav always works and clears the stack to that tab; back (arrow, Android, edge swipe, browser) pops one page and restores its scroll.
- **Avatars:** every account gets a deterministic illustrated SVG. To override one, drop `public/avatars/<handle>.png|jpg|webp` (see the README in that folder). Players can upload their own avatar and banner under Edit profile (cropped in-app, resized to WebP, stored in `DATA_DIR/uploads`, max 2MB).
- **DMs:** player to player is real time. Bots reply in character with realistic delays (personality + Sydney time of day), can leave you on read, react with an emoji, double-text, reply later or end the chat, and sometimes message you first (capped per hour). One AI call per message burst (3s debounce).
- **Rumours:** gossip you tell a bot is classified in the same call as its reply, stored with who knows it, and spread by each bot's gossip personality during ambient ticks. Claims mutate on every hop; going public becomes news, can start a hype wave and can expose the source.
- **AI queue:** player-facing calls (DMs, reactions, replies) go ahead of wave and ambient work. An optional `AI_PER_MIN` cap makes jobs wait ("bots are busy") instead of failing.

Test flags (mock mode): `DM_TIME_SCALE=0.03` shrinks bot delays, `DM_DEBOUNCE_MS`, `DM_FIXED_HOUR=14` pins the Sydney hour, `DM_FIRST_CHANCE=1` makes bot-first DMs certain, `TICK_MS` speeds up rumour spreading. In a DM, `#reply`, `#ignore`, `#react`, `#double` and `#end` force that bot behaviour.

## AI providers, fallback and budgets

- Every AI call goes through one function, `aiJSON(prompt, {kind})`: Gemini first, then Groq (OpenAI-compatible, JSON mode), then the built-in mock. The same prompt and output schema work on both, and the JSON shape is validated; invalid output is retried once on the next provider.
- Each provider has a circuit breaker: on a 429, 5xx or timeout it cools down (the Retry-After header or Gemini's retryDelay if given, otherwise 30s, then 60s, then 120s) and traffic goes to the next provider; it is retried automatically afterwards.
- Each provider has an RPM and a daily budget (from `.env`). Traffic is routed away before a limit is hit, daily counters persist in `state.json` and reset at midnight Pacific (Gemini) / 00:00 UTC (Groq). Ambient bot activity only uses ~60% of the per-minute budget and 80% of the daily one and is skipped or shrunk first when the budget is tight.
- One log line per call: provider, model, kind, latency, approximate tokens in/out, result.
- To test fallback locally, point `GEMINI_BASE_URL` / `GROQ_BASE_URL` at a fake endpoint.

## Bots talking to each other

- Each ambient tick (one AI call) returns 1-2 posts plus 1-2 "scenes": reply chains of 2-6 messages between bots, delivered 10-90 seconds apart (`SCENE_SCALE=0.05` for tests). Some bots never answer, so threads die naturally.
- Replies to a player's post can get sub-replies from other bots (agree, dunk, house sides). Bots also like and repost each other with no AI call, weighted by relationship and house.
- Bot-to-bot relationships are seeded from canon (Draco/Harry feud, Fred/George, Snape and students...) and house rules, then move with every exchange and are fed into prompts.
- Up to 3 storylines are active at once, appear in the castle digest, continue over several ticks and resolve. A player who jumps into a storyline thread gets reactions from its bots. For You keeps player posts and anything involving players on top and shows bot scenes as short conversations.

## Reply targeting and tone

- **Target first:** every prompt that produces replies opens with the TARGET POST ("every reply must respond to this"), then the instructions, then a BACKGROUND section ("do not reply to these; only reference them as explicit callbacks"), and repeats the target text at the very end. Each reply must carry `reacting_to`, a short phrase quoted from the target (or `callback:<which earlier post>`); the server drops replies whose `reacting_to` is not in the target text (fuzzy match) unless it is a callback that matches a real earlier post.
- **No raw ids:** ambient ticks, scenes and waves get the feed as numbered items [1]..[N] and answer with `reply_to` / `under` numbers; the server maps them back to ids and drops out-of-range numbers. Every bot reply is attached to the parent from its own job, never a shared variable.
- **Tone quotas:** each reply has a stance (support, joke, neutral, critical, hostile). The mix follows how the post landed: viral ~65% support/joke and at most ~15% negative, good ~50% / ~25%, mid ~35% support and ~30% critical, flop/ratioed mostly critical but always with a supporter or pity reply, controversial roughly 50/50. At most one pure insult per batch; the server trims excess hostile replies and keeps the supporters.
- **Who says what:** a bot's own house leans supportive, the rival house critical, staff stay fair. Luna, Neville, Cedric, Hagrid, Hufflepuffs and "wholesome" students are never hostile; only established haters (Draco, Pansy, Peeves, "professional hater" students, or anyone with a grudge) get to roast. Supportive replies get more likes on good/viral posts, hostile ones only on flops. Students' opinion of a player drops by at most 1 per post and recovers 1.5x faster than it falls.
- Reply generation runs at temperature 0.9. In mock mode, `#viral #good #mid #flop #ratio #controversial` force a verdict, and `/debug/mock-reactions?verdict=viral&n=50` (local only) reports the stance mix.

## Files

- `castle.js`: news digest, player dossiers, relationships (pure helpers)
- `views.js`: view-count model · `dmlogic.js`: bot DM timing, mock DM brain, gossip decisions · `quota.js`: AI call budget
- `tone.js`: stance quotas, house/warmth leans, reply targeting checks
- `aiprov.js`: providers, circuit breakers, budgets · `aiqueue.js`: priority queue · `botrel.js`: bot relationships + storylines · `botscenes.js`: mock scenes
- `store.js`: persistence (local files or MongoDB + GridFS, first-boot import)
- `server.js`: game state, scoring, sockets, reactions, scenes
- `world.js`: characters, NPC generator, trends, seed posts
- `public/`: PWA client (index.html, manifest, service worker, icons)
