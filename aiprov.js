// Multi-provider AI layer: Gemini -> Groq -> (caller falls back to mock). One entry point: aiJSON(prompt, {kind}).
// Per-provider circuit breaker (429/5xx/timeouts), RPM + daily budgets that route away BEFORE a limit is hit, shape validation.
'use strict';

const approxTokens = s => Math.ceil(String(s || '').length / 4);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class ProviderError extends Error {
  constructor(msg, { status = 0, retryAfterMs = null, invalid = false, fatal = false } = {}) {
    super(msg);
    Object.assign(this, { status, retryAfterMs, invalid, fatal });
  }
}

// calls that a player is waiting on. Everything else is ambient and gets squeezed first.
const PLAYER_KINDS = new Set(['post', 'reply', 'duel', 'dm', 'dm-opener']);
const MAX_WAIT = { dm: 20000, 'dm-opener': 5000, post: 8000, reply: 8000, duel: 8000 };

function dayKey(tz, ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); }
// ms until the calendar day changes in `tz` (searched in 10 minute steps, accurate enough for a counter reset)
function msToReset(tz, ts) {
  const d = dayKey(tz, ts);
  for (let t = ts + 600e3; t < ts + 26 * 3600e3; t += 600e3) if (dayKey(tz, t) !== d) return t - ts;
  return 24 * 3600e3;
}

function parseRetryAfter(headerVal, bodyText, nowMs) {
  if (headerVal) {
    const n = Number(headerVal);
    if (Number.isFinite(n)) return clamp(n * 1000, 1000, 15 * 60e3);
    const d = Date.parse(headerVal);
    if (Number.isFinite(d)) return clamp(d - nowMs, 1000, 15 * 60e3);
  }
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText || '');
  return m ? clamp(Number(m[1]) * 1000, 1000, 15 * 60e3) : null;
}

function parseJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('Bad JSON from model');
}

// pick a usable Groq text model: the configured one if it exists, else the best of a preference list, else any chat model
const GROQ_PREFS = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
function pickGroqModel(ids, wanted) {
  const ok = ids.filter(id => !/(whisper|guard|tts|embed|playai|orpheus|vision|distil-whisper|safeguard)/i.test(id));
  if (wanted && ids.includes(wanted)) return wanted;
  return GROQ_PREFS.find(m => ok.includes(m)) || ok[0] || wanted || null;
}
function pickGeminiModels(list, primary, fallback) {
  const usable = list.filter(n => /flash/.test(n) && !/(image|tts|audio|live|embed|vision|exp|thinking|robotics|computer)/.test(n));
  let p = primary, f = fallback;
  if (!list.includes(p)) p = usable.find(n => /flash-latest$/.test(n)) || usable.find(n => !/lite/.test(n)) || usable[0] || p;
  if (!list.includes(f)) f = usable.find(n => /lite/.test(n) && n !== p) || usable.find(n => n !== p) || f;
  return { primary: p, fallback: f };
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: ctl.signal }); }
  catch (e) { throw new ProviderError(e && e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `network: ${e && e.message}`, { status: 0 }); }
  finally { clearTimeout(t); }
}
async function httpError(res, label, nowMs) {
  const body = await res.text().catch(() => '');
  return new ProviderError(`${label} ${res.status}: ${body.slice(0, 160)}`, { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), body, nowMs), invalid: res.status === 400 && /json_validate_failed|failed_generation/.test(body), fatal: res.status === 401 || res.status === 403 });
}

// ---------------------------------------------------------------- provider implementations
function geminiProvider(cfg) {
  return {
    name: 'gemini', tz: 'America/Los_Angeles', // free-tier daily quota resets at midnight Pacific
    ...cfg,
    async call(prompt, system, { fetchImpl, timeoutMs, now, temperature = 1.0 }) {
      const models = [this.model, this.fallbackModel].filter((m, i, a) => m && a.indexOf(m) === i);
      let lastErr;
      for (const model of models) {
        try {
          const res = await timedFetch(fetchImpl, `${this.baseUrl}/models/${model}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: 8192 } })
          }, timeoutMs);
          if (!res.ok) { lastErr = await httpError(res, model, now()); continue; }
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          if (!text) { lastErr = new ProviderError(`${model} empty (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '?'})`, { invalid: true }); continue; }
          return { text, model, tokensIn: data.usageMetadata?.promptTokenCount, tokensOut: data.usageMetadata?.candidatesTokenCount };
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
    async init({ fetchImpl, timeoutMs, log }) {
      try {
        const res = await timedFetch(fetchImpl, `${this.baseUrl}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.key } }, timeoutMs);
        if (!res.ok) { log(`[owl] Gemini key check failed (${res.status})`); return; }
        const list = ((await res.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
        const { primary, fallback } = pickGeminiModels(list, this.model, this.fallbackModel);
        this.model = primary; this.fallbackModel = fallback;
        log(`[owl] Gemini key OK. Using ${primary} (fallback ${fallback})`);
      } catch (e) { log('[owl] Could not reach Gemini to check models: ' + e.message); }
    }
  };
}

function groqProvider(cfg) {
  return {
    name: 'groq', tz: 'UTC', // Groq daily limits reset at 00:00 UTC
    ...cfg,
    async call(prompt, system, { fetchImpl, timeoutMs, now, temperature = 1.0 }) {
      const res = await timedFetch(fetchImpl, `${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature, max_tokens: 3000, response_format: { type: 'json_object' } })
      }, timeoutMs);
      if (!res.ok) throw await httpError(res, this.model, now());
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new ProviderError(`${this.model} empty`, { invalid: true });
      return { text, model: this.model, tokensIn: data.usage?.prompt_tokens, tokensOut: data.usage?.completion_tokens };
    },
    async init({ fetchImpl, timeoutMs, log }) {
      try {
        const res = await timedFetch(fetchImpl, `${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.key}` } }, timeoutMs);
        if (!res.ok) { log(`[owl] Groq key check failed (${res.status})`); return; }
        const ids = ((await res.json()).data || []).map(m => m.id);
        const m = pickGroqModel(ids, this.model);
        if (m && m !== this.model) log(`[owl] Groq model ${this.model} not available, using ${m}`);
        if (m) this.model = m;
        log(`[owl] Groq key OK. Using ${this.model}`);
      } catch (e) { log('[owl] Could not reach Groq to check models: ' + e.message); }
    }
  };
}

// ---------------------------------------------------------------- the router
// providersCfg: [{ type:'gemini'|'groq', key, model, fallbackModel, baseUrl, rpm, rpd }]  (a missing key disables that provider)
function createAI({ providers: cfgs, system, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), usage = {}, onUsage = () => {}, log = console.log, timeoutMs = 25000, ambientShare = 0.6 }) {
  const list = cfgs.map(c => {
    const p = (c.type === 'gemini' ? geminiProvider : groqProvider)(c);
    Object.assign(p, { enabled: !!c.key, window: [], cooldownUntil: 0, failStreak: 0, lastError: null, lastOkAt: 0, lastLatency: 0, stats: { calls: 0, ok: 0, fail: 0, invalid: 0 } });
    return p;
  });
  const enabled = () => list.filter(p => p.enabled);

  // daily counters live in `usage` (persisted by the caller) and reset when the provider's calendar day changes
  const dayUsage = p => {
    const day = dayKey(p.tz, now());
    const u = usage[p.name] && usage[p.name].day === day ? usage[p.name] : (usage[p.name] = { day, count: 0 });
    return u;
  };
  const windowUsed = p => { const t = now() - 60e3; while (p.window.length && p.window[0] <= t) p.window.shift(); return p.window.length; };
  const cooling = p => now() < p.cooldownUntil;
  const available = (p, kind) => {
    if (!p.enabled || cooling(p)) return false;
    const ambient = !PLAYER_KINDS.has(kind);
    const rpm = ambient ? Math.max(1, Math.floor(p.rpm * ambientShare)) : p.rpm;
    const rpd = ambient ? Math.floor(p.rpd * 0.8) : p.rpd;
    return windowUsed(p) < rpm && dayUsage(p).count < rpd;
  };
  function trip(p, err) {
    p.failStreak++;
    const base = err.fatal ? 10 * 60e3 : [30e3, 60e3, 120e3][Math.min(p.failStreak - 1, 2)];
    const ms = err.retryAfterMs ? Math.max(err.retryAfterMs, 1000) : base;
    p.cooldownUntil = now() + ms;
    p.lastError = err.message;
    log(`[owl] ${p.name} cooling down ${Math.round(ms / 1000)}s (${err.message.slice(0, 90)})`);
  }
  // the soonest moment any provider could take a call of this kind
  function nextAvailableMs(kind) {
    let best = Infinity;
    for (const p of enabled()) {
      let w = Math.max(0, p.cooldownUntil - now());
      const ambient = !PLAYER_KINDS.has(kind), rpm = ambient ? Math.max(1, Math.floor(p.rpm * ambientShare)) : p.rpm;
      if (windowUsed(p) >= rpm) w = Math.max(w, p.window[Math.max(0, p.window.length - rpm)] + 60e3 - now());
      const rpd = ambient ? Math.floor(p.rpd * 0.8) : p.rpd;
      if (dayUsage(p).count >= rpd) w = Infinity;
      best = Math.min(best, w);
    }
    return best;
  }

  async function aiJSON(prompt, { kind = 'misc', validate = null, temperature = 1.0 } = {}) {
    if (!enabled().length) return null;
    const maxWait = MAX_WAIT[kind] || 0;
    const tried = new Set();
    const inTok = approxTokens(system) + approxTokens(prompt);
    let waited = 0;
    for (;;) {
      let p = list.find(x => !tried.has(x.name) && available(x, kind));
      if (!p) {
        // a player is waiting: if a provider frees up soon, wait for it instead of dropping to mock
        const w = nextAvailableMs(kind);
        if (tried.size === 0 && maxWait && Number.isFinite(w) && w > 0 && waited + w <= maxWait) { waited += w; await sleep(w + 20); continue; }
        log(`[owl] AI ${kind}: no provider available${tried.size ? ' (all tried)' : ''}, using mock`);
        return null;
      }
      tried.add(p.name);
      const t0 = now();
      p.window.push(t0); dayUsage(p).count++; p.stats.calls++; onUsage();
      try {
        const out = await p.call(prompt, system, { fetchImpl, timeoutMs, now, temperature });
        const data = parseJSON(out.text);
        if (validate && !validate(data)) throw new ProviderError(`${out.model} returned the wrong JSON shape`, { invalid: true });
        p.failStreak = 0; p.lastOkAt = now(); p.lastLatency = now() - t0; p.stats.ok++;
        log(`[owl] AI ${p.name}/${out.model} ${kind} ${p.lastLatency}ms ~${out.tokensIn || inTok}→${out.tokensOut || approxTokens(out.text)} tok ok`);
        return data;
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(e.message, { invalid: /JSON/.test(e.message) });
        p.lastLatency = now() - t0;
        if (err.invalid) { p.stats.invalid++; p.lastError = err.message; log(`[owl] AI ${p.name}/${p.model} ${kind} ${p.lastLatency}ms invalid output, trying the next provider (${err.message.slice(0, 70)})`); }
        else { p.stats.fail++; trip(p, err); log(`[owl] AI ${p.name}/${p.model} ${kind} ${p.lastLatency}ms FAILED ${err.status || 'error'}`); }
      }
    }
  }

  return {
    aiJSON,
    providers: list,
    get enabled() { return enabled().length > 0; },
    async init() { for (const p of enabled()) await p.init({ fetchImpl, timeoutMs: Math.min(timeoutMs, 10000), log }); },
    // true when no provider would take an ambient call right now (skip ambient work, keep the budget for players)
    tight() { return enabled().length > 0 && !enabled().some(p => available(p, 'ambient')); },
    // 0..1: how much of the busiest provider's budget is spent. Ambient shrinks above ~0.5.
    pressure() { return enabled().reduce((m, p) => Math.max(m, windowUsed(p) / p.rpm, dayUsage(p).count / p.rpd), 0); },
    status() {
      return {
        mock_only: !enabled().length,
        providers: list.map(p => {
          const u = p.enabled ? dayUsage(p) : { day: null, count: 0 };
          return {
            name: p.name, enabled: p.enabled, model: p.model, fallback_model: p.fallbackModel || null,
            healthy: p.enabled && !cooling(p) && p.failStreak === 0,
            cooling_down_s: cooling(p) ? Math.ceil((p.cooldownUntil - now()) / 1000) : 0, fail_streak: p.failStreak, last_error: p.lastError,
            rpm: { used: p.enabled ? windowUsed(p) : 0, limit: p.rpm },
            daily: { used: u.count, limit: p.rpd, day: u.day, resets_in_s: p.enabled ? Math.round(msToReset(p.tz, now()) / 1000) : null, reset_zone: p.tz },
            calls: p.stats.calls, ok: p.stats.ok, failures: p.stats.fail, invalid: p.stats.invalid, last_latency_ms: p.lastLatency, last_ok_at: p.lastOkAt || null
          };
        })
      };
    }
  };
}

module.exports = { createAI, ProviderError, PLAYER_KINDS, parseRetryAfter, parseJSON, pickGroqModel, pickGeminiModels, dayKey, msToReset, approxTokens };
