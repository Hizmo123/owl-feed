// Provider fallback tests against fake local endpoints: node test/aiprov.test.js
const assert = require('assert');
const http = require('http');
const A = require('../aiprov');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- fake providers
function fakeServer(kind) {
  const st = { mode: 'ok', hits: 0, models: [], retryAfter: null, deadModels: new Set() };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.method === 'GET') {
        return kind === 'gemini'
          ? send(200, { models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-flash-lite-latest', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] })
          : send(200, { data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] });
      }
      const model = kind === 'gemini' ? decodeURIComponent(req.url.split('/models/')[1].split(':')[0]) : JSON.parse(body).model;
      st.hits++; st.models.push(model);
      st.lastBody = body;
      if (st.deadModels.has(model)) return send(429, { error: { message: 'quota' } }, st.retryAfter ? { 'Retry-After': String(st.retryAfter) } : {});
      const mode = st.mode;
      if (mode === 429) return send(429, kind === 'gemini' ? { error: { code: 429, details: st.retryDelay ? [{ retryDelay: st.retryDelay }] : [] } } : { error: { message: 'rate limit' } }, st.retryAfter ? { 'Retry-After': String(st.retryAfter) } : {});
      if (mode === 500) return send(500, { error: 'boom' });
      if (mode === 401) return send(401, { error: 'bad key' });
      if (mode === 'hang') return; // never answers
      const text = mode === 'badjson' ? 'this is not json at all' : mode === 'wrongshape' ? JSON.stringify({ nope: 1 }) : JSON.stringify({ replies: [], src: kind });
      send(200, kind === 'gemini' ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } } : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: 'http://127.0.0.1:' + srv.address().port })));
}

async function rig(opts = {}) {
  const g = await fakeServer('gemini'), q = await fakeServer('groq');
  const clock = { t: Date.UTC(2026, 9, 9, 12, 0, 0) };
  const usage = opts.usage || {};
  const logs = [];
  const ai = A.createAI({
    providers: [
      { type: 'gemini', key: opts.noGemini ? '' : 'gk', model: 'gemini-flash-latest', fallbackModel: opts.fallback ?? 'gemini-flash-lite-latest', baseUrl: g.url, rpm: opts.gRpm || 10, rpd: opts.gRpd || 250 },
      { type: 'groq', key: opts.noGroq ? '' : 'qk', model: 'llama-3.3-70b-versatile', baseUrl: q.url, rpm: opts.qRpm || 25, rpd: opts.qRpd || 900 }
    ],
    system: 'Output ONLY valid JSON.', usage, log: m => logs.push(m), now: () => clock.t, sleep: async ms => { clock.t += ms; }, timeoutMs: opts.timeoutMs || 3000
  });
  const close = () => { g.srv.close(); q.srv.close(); };
  return { ai, g: g.st, q: q.st, clock, usage, logs, close, call: (kind = 'post', extra = {}) => ai.aiJSON('{"task":"x"}', { kind, validate: d => Array.isArray(d.replies), ...extra }) };
}
const advance = (r, ms) => { r.clock.t += ms; };
const gem = r => r.ai.status().providers[0], grq = r => r.ai.status().providers[1];

t('healthy: Gemini answers first', async () => {
  const r = await rig();
  const d = await r.call();
  assert.strictEqual(d.src, 'gemini'); assert.strictEqual(r.q.hits, 0);
  r.close();
});

t('Gemini 429 -> the call goes to Groq, Gemini cools down 30s', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 429;
  const d = await r.call();
  assert.strictEqual(d.src, 'groq');
  assert.strictEqual(gem(r).cooling_down_s, 30); assert.strictEqual(gem(r).healthy, false);
  // while cooling, Gemini is not even contacted
  const hits = r.g.hits;
  assert.strictEqual((await r.call()).src, 'groq'); assert.strictEqual(r.g.hits, hits);
  r.close();
});

t('Gemini recovers after the cooldown: traffic returns to Gemini', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 500;
  assert.strictEqual((await r.call()).src, 'groq');
  r.g.mode = 'ok';
  advance(r, 29e3); assert.strictEqual((await r.call()).src, 'groq', 'still cooling at 29s');
  advance(r, 2e3);
  assert.strictEqual((await r.call()).src, 'gemini');
  assert.strictEqual(gem(r).fail_streak, 0); assert.strictEqual(gem(r).healthy, true);
  r.close();
});

t('backoff grows 30s -> 60s -> 120s while the failures continue', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 429;
  const seen = [];
  for (let i = 0; i < 4; i++) { await r.call(); seen.push(gem(r).cooling_down_s); advance(r, (gem(r).cooling_down_s + 1) * 1000); }
  assert.deepStrictEqual(seen, [30, 60, 120, 120]);
  r.close();
});

t('Retry-After header (and Gemini retryDelay) set the cooldown', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 429; r.g.retryAfter = 45;
  await r.call();
  assert.strictEqual(gem(r).cooling_down_s, 45);
  advance(r, 50e3); r.g.retryAfter = null; r.g.retryDelay = '90s';
  await r.call();
  assert.strictEqual(gem(r).cooling_down_s, 90);
  assert.strictEqual(A.parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', '', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')), 60e3);
  r.close();
});

t('both providers fail -> null (the caller uses mock)', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 429; r.q.mode = 500;
  assert.strictEqual(await r.call(), null);
  assert.ok(r.logs.some(l => /no provider available/.test(l)));
  // a call right after finds both cooling and also returns null without hitting either
  const hits = r.g.hits + r.q.hits;
  assert.strictEqual(await r.call('ambient'), null);
  assert.strictEqual(r.g.hits + r.q.hits, hits);
  r.close();
});

t('invalid JSON from Gemini -> retried once on Groq, with no cooldown for Gemini', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 'badjson';
  const d = await r.call();
  assert.strictEqual(d.src, 'groq');
  assert.strictEqual(gem(r).cooling_down_s, 0); assert.strictEqual(gem(r).invalid, 1);
  r.close();
});

t('valid JSON with the wrong shape is rejected and retried on the next provider; both wrong -> null', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 'wrongshape';
  assert.strictEqual((await r.call()).src, 'groq');
  r.q.mode = 'wrongshape';
  assert.strictEqual(await r.call(), null);
  assert.strictEqual(r.g.hits, 2); assert.strictEqual(r.q.hits, 2);
  r.close();
});

t('Gemini falls back to its lite model before the provider is declared down', async () => {
  const r = await rig();
  r.g.deadModels.add('gemini-flash-latest');
  const d = await r.call();
  assert.strictEqual(d.src, 'gemini'); assert.deepStrictEqual(r.g.models, ['gemini-flash-latest', 'gemini-flash-lite-latest']);
  assert.strictEqual(r.q.hits, 0);
  r.close();
});

t('timeouts count as failures and route to the next provider', async () => {
  const r = await rig({ fallback: '', timeoutMs: 150 });
  r.g.mode = 'hang';
  assert.strictEqual((await r.call()).src, 'groq');
  assert.ok(/timeout/.test(gem(r).last_error));
  r.close();
});

t('bad API key (401) takes the provider out for 10 minutes', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 401;
  await r.call();
  assert.strictEqual(gem(r).cooling_down_s, 600);
  r.close();
});

t('RPM budget: traffic is routed away BEFORE the limit is hit, and returns after a minute', async () => {
  const r = await rig({ gRpm: 3 });
  for (let i = 0; i < 3; i++) assert.strictEqual((await r.call()).src, 'gemini');
  assert.strictEqual(r.g.hits, 3);
  assert.strictEqual((await r.call()).src, 'groq');
  assert.strictEqual(r.g.hits, 3, 'Gemini was not contacted for the 4th call');
  assert.strictEqual(gem(r).failures, 0);
  advance(r, 61e3);
  assert.strictEqual((await r.call()).src, 'gemini');
  r.close();
});

t('daily budget: routes away at the daily limit, resets at midnight Pacific, persists across restarts', async () => {
  const usage = {};
  let r = await rig({ gRpd: 2, usage });
  await r.call(); await r.call();
  assert.strictEqual(usage.gemini.count, 2);
  assert.strictEqual((await r.call()).src, 'groq');
  assert.strictEqual(r.g.hits, 2);
  r.close();
  // "restart": a new instance with the same persisted usage object still sees 2/2
  const r2 = await rig({ gRpd: 2, usage });
  r2.clock.t = r.clock.t;
  assert.strictEqual((await r2.call()).src, 'groq');
  assert.strictEqual(r2.g.hits, 0);
  // next Pacific day: counter resets
  advance(r2, 26 * 3600e3);
  assert.strictEqual((await r2.call()).src, 'gemini');
  assert.strictEqual(usage.gemini.count, 1);
  r2.close();
});

t('daily reset follows each provider\'s own zone (Pacific vs UTC)', () => {
  const noon = Date.UTC(2026, 9, 9, 12, 0, 0); // 05:00 PDT, 12:00 UTC
  const pt = A.msToReset('America/Los_Angeles', noon), utc = A.msToReset('UTC', noon);
  assert.ok(Math.abs(pt - 19 * 3600e3) < 700e3, 'pacific resets in ~19h: ' + pt / 3600e3);
  assert.ok(Math.abs(utc - 12 * 3600e3) < 700e3, 'utc resets in ~12h: ' + utc / 3600e3);
  assert.notStrictEqual(A.dayKey('America/Los_Angeles', Date.UTC(2026, 9, 9, 3, 0, 0)), A.dayKey('UTC', Date.UTC(2026, 9, 9, 3, 0, 0)));
});

t('ambient calls keep a reserve for players and are skipped first when the budget is tight', async () => {
  const r = await rig({ gRpm: 10, noGroq: true });
  for (let i = 0; i < 6; i++) assert.ok(await r.call('ambient'));            // 60% of 10
  assert.strictEqual(r.ai.tight(), true);
  assert.strictEqual(await r.call('ambient'), null);                           // skipped, Gemini untouched
  assert.strictEqual(r.g.hits, 6);
  assert.ok((await r.call('post')).src === 'gemini');                          // a player's post still gets through
  assert.ok(r.ai.pressure() >= 0.7);
  r.close();
});

t('a player-facing call waits briefly for a short cooldown instead of dropping to mock, but not for a long one', async () => {
  const r = await rig({ noGroq: true, fallback: '' });
  r.g.mode = 429; r.g.retryAfter = 5;
  assert.strictEqual(await r.call('ambient'), null);        // trips Gemini for 5s
  r.g.mode = 'ok';
  const before = r.clock.t;
  const d = await r.call('dm');                             // waits ~5s (fake sleep advances the clock), then Gemini answers
  assert.strictEqual(d.src, 'gemini'); assert.ok(r.clock.t - before >= 5e3 && r.clock.t - before < 20e3);
  r.g.mode = 429; r.g.retryAfter = 120;
  await r.call('dm');                                       // trips for 120s
  r.g.mode = 'ok';
  assert.strictEqual(await r.call('dm'), null);             // 120s is longer than a DM will wait: mock
  r.close();
});

t('no keys at all: disabled, aiJSON returns null, status says mock_only', async () => {
  const r = await rig({ noGemini: true, noGroq: true });
  assert.strictEqual(r.ai.enabled, false); assert.strictEqual(await r.call(), null);
  assert.strictEqual(r.ai.status().mock_only, true); assert.strictEqual(r.g.hits + r.q.hits, 0);
  r.close();
});

t('only Groq configured works on its own (Gemini key optional)', async () => {
  const r = await rig({ noGemini: true });
  assert.strictEqual((await r.call()).src, 'groq'); assert.strictEqual(r.g.hits, 0);
  r.close();
});

t('Groq sends the same prompt in JSON mode with a system message', async () => {
  const r = await rig({ noGemini: true });
  await r.call();
  const b = JSON.parse(r.q.lastBody);
  assert.deepStrictEqual(b.response_format, { type: 'json_object' });
  assert.strictEqual(b.messages[0].role, 'system'); assert.strictEqual(b.messages[1].content, '{"task":"x"}');
  r.close();
});

t('boot model checks pick valid models for both providers', async () => {
  const r = await rig();
  await r.ai.init();
  assert.strictEqual(grq(r).model, 'llama-3.3-70b-versatile');
  assert.strictEqual(A.pickGroqModel(['whisper-large-v3', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'], 'llama-3.3-70b-versatile'), 'openai/gpt-oss-120b');
  assert.strictEqual(A.pickGroqModel(['whisper-large-v3', 'llama-guard-4'], 'x'), 'x');
  assert.deepStrictEqual(A.pickGeminiModels(['gemini-2.5-flash-latest', 'gemini-flash-lite-latest'], 'gemini-flash-latest', 'gemini-flash-lite-latest'), { primary: 'gemini-2.5-flash-latest', fallback: 'gemini-flash-lite-latest' });
  r.close();
});

t('status() reports health, cooldowns, usage and reset times', async () => {
  const r = await rig({ fallback: '' });
  r.g.mode = 429; await r.call();
  const s = r.ai.status();
  assert.strictEqual(s.mock_only, false);
  const g = s.providers[0], q = s.providers[1];
  assert.deepStrictEqual([g.name, g.healthy, g.cooling_down_s, g.failures, g.daily.used, g.rpm.used], ['gemini', false, 30, 1, 1, 1]);
  assert.deepStrictEqual([q.name, q.healthy, q.ok, q.daily.used], ['groq', true, 1, 1]);
  assert.ok(g.daily.resets_in_s > 0 && g.last_error);
  r.close();
});

t('reply generation runs at temperature 0.9 on both providers (default stays 1.0)', async () => {
  const r = await rig({ fallback: '' });
  await r.call('post', { temperature: 0.9 });
  assert.strictEqual(JSON.parse(r.g.lastBody).generationConfig.temperature, 0.9);
  await r.call('dm');
  assert.strictEqual(JSON.parse(r.g.lastBody).generationConfig.temperature, 1.0);
  r.g.mode = 429; await r.call('reply', { temperature: 0.9 });
  assert.strictEqual(JSON.parse(r.q.lastBody).temperature, 0.9);
  r.close();
});

(async () => {
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('ok -', name); }
    catch (e) { console.error('FAIL -', name, '\n  ', e.stack.split('\n').slice(0, 4).join('\n   ')); process.exitCode = 1; }
  }
  console.log(`\n${ok}/${tests.length} provider tests passed`);
  process.exit(process.exitCode || 0);
})();
