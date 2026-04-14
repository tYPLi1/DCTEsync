/**
 * Translation module
 *
 * Supported providers:
 *
 *  AI models (use natural language prompt):
 *   - "anthropic"      Claude Haiku          ANTHROPIC_API_KEY
 *   - "openai"         GPT-4o-mini           OPENAI_API_KEY
 *   - "ollama"         Local LLM             OLLAMA_BASE_URL, OLLAMA_MODEL
 *
 *  Dedicated translation APIs (use ISO language codes):
 *   - "google"         Google Cloud v2       GOOGLE_TRANSLATE_API_KEY
 *   - "deepl"          DeepL API             DEEPL_API_KEY
 *   - "libretranslate" LibreTranslate        LIBRETRANSLATE_URL, LIBRETRANSLATE_API_KEY (opt.)
 *   - "microsoft"      Azure Translator      MICROSOFT_TRANSLATOR_KEY, MICROSOFT_TRANSLATOR_REGION
 */

import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

// ── Language code map ─────────────────────────────────────────────────────────
// Maps human-readable language names → ISO codes used by translation APIs.
// "code" = general ISO 639-1 (Google, LibreTranslate, Ollama prompt)
// "deepl" = DeepL target codes (null = not supported)
// "ms"    = Microsoft Translator codes

const LANG_MAP = {
  'English':              { code: 'en', deepl: 'EN-US', ms: 'en' },
  'German':               { code: 'de', deepl: 'DE',    ms: 'de' },
  'French':               { code: 'fr', deepl: 'FR',    ms: 'fr' },
  'Spanish':              { code: 'es', deepl: 'ES',    ms: 'es' },
  'Italian':              { code: 'it', deepl: 'IT',    ms: 'it' },
  'Portuguese':           { code: 'pt', deepl: 'PT-PT', ms: 'pt' },
  'Dutch':                { code: 'nl', deepl: 'NL',    ms: 'nl' },
  'Polish':               { code: 'pl', deepl: 'PL',    ms: 'pl' },
  'Russian':              { code: 'ru', deepl: 'RU',    ms: 'ru' },
  'Turkish':              { code: 'tr', deepl: 'TR',    ms: 'tr' },
  'Arabic':               { code: 'ar', deepl: null,    ms: 'ar' },
  'Chinese (Simplified)': { code: 'zh', deepl: 'ZH',   ms: 'zh-Hans' },
  'Japanese':             { code: 'ja', deepl: 'JA',    ms: 'ja' },
  'Korean':               { code: 'ko', deepl: 'KO',    ms: 'ko' },
  'Ukrainian':            { code: 'uk', deepl: 'UK',    ms: 'uk' },
  'Swedish':              { code: 'sv', deepl: 'SV',    ms: 'sv' },
  'Danish':               { code: 'da', deepl: 'DA',    ms: 'da' },
  'Finnish':              { code: 'fi', deepl: 'FI',    ms: 'fi' },
  'Norwegian':            { code: 'nb', deepl: 'NB',    ms: 'nb' },
  'Czech':                { code: 'cs', deepl: 'CS',    ms: 'cs' },
  'Slovak':               { code: 'sk', deepl: 'SK',    ms: 'sk' },
  'Romanian':             { code: 'ro', deepl: 'RO',    ms: 'ro' },
  'Hungarian':            { code: 'hu', deepl: 'HU',    ms: 'hu' },
  'Greek':                { code: 'el', deepl: 'EL',    ms: 'el' },
  'Hebrew':               { code: 'he', deepl: null,    ms: 'he' },
  'Hindi':                { code: 'hi', deepl: null,    ms: 'hi' },
  'Bengali':              { code: 'bn', deepl: null,    ms: 'bn' },
  'Indonesian':           { code: 'id', deepl: 'ID',    ms: 'id' },
  'Vietnamese':           { code: 'vi', deepl: null,    ms: 'vi' },
};

function getLangCode(language, field) {
  return LANG_MAP[language]?.[field] ?? language;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function translateAnthropic(text, targetLanguage) {
  if (!anthropicClient) throw new Error('ANTHROPIC_API_KEY not set');

  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    // System prompt is marked for prompt caching — it is reused across many
    // translation calls, so caching it reduces latency and token costs.
    system: [
      {
        type: 'text',
        text: 'You are a translation assistant. Translate the user\'s message to the requested target language accurately and naturally. Return ONLY the translated text — no commentary, explanations, or quotation marks.',
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{
      role: 'user',
      content: `Translate to ${targetLanguage}:\n\n${text}`
    }]
  });

  return response.content[0]?.text?.trim() ?? null;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function translateOpenAI(text, targetLanguage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Translate the following message to ${targetLanguage}. Return ONLY the translated text.\n\n${text}`
      }],
      max_tokens: 1024
    })
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

// ── Ollama (local) ────────────────────────────────────────────────────────────

async function translateOllama(text, targetLanguage) {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model   = process.env.OLLAMA_MODEL || 'llama3';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{
        role: 'user',
        content: `Translate the following message to ${targetLanguage}. Return ONLY the translated text.\n\n${text}`
      }]
    })
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content?.trim() ?? null;
}

// ── Google Cloud Translation (v2 / Basic) ─────────────────────────────────────

async function translateGoogle(text, targetLanguage) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_TRANSLATE_API_KEY not set');

  const target = getLangCode(targetLanguage, 'code');
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target, format: 'text' })
  });

  if (!res.ok) throw new Error(`Google Translate ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.translations?.[0]?.translatedText ?? null;
}

// ── DeepL ─────────────────────────────────────────────────────────────────────

async function translateDeepL(text, targetLanguage) {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) throw new Error('DEEPL_API_KEY not set');

  const targetCode = getLangCode(targetLanguage, 'deepl');
  if (!targetCode) throw new Error(`DeepL does not support language: ${targetLanguage}`);

  // Free keys end with ':fx', Pro keys use the regular endpoint
  const base = apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com'
    : 'https://api.deepl.com';

  const res = await fetch(`${base}/v2/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DeepL-Auth-Key ${apiKey}`
    },
    body: JSON.stringify({ text: [text], target_lang: targetCode })
  });

  if (!res.ok) throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.translations?.[0]?.text ?? null;
}

// ── LibreTranslate (self-hosted or public) ────────────────────────────────────

async function translateLibre(text, targetLanguage) {
  const baseUrl = (process.env.LIBRETRANSLATE_URL || 'http://localhost:5000').replace(/\/$/, '');
  const target  = getLangCode(targetLanguage, 'code');

  const body = { q: text, source: 'auto', target, format: 'text' };
  if (process.env.LIBRETRANSLATE_API_KEY) {
    body.api_key = process.env.LIBRETRANSLATE_API_KEY;
  }

  const res = await fetch(`${baseUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`LibreTranslate ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`LibreTranslate: ${data.error}`);
  return data.translatedText ?? null;
}

// ── Microsoft Translator (Azure) ──────────────────────────────────────────────

async function translateMicrosoft(text, targetLanguage) {
  const apiKey = process.env.MICROSOFT_TRANSLATOR_KEY;
  if (!apiKey) throw new Error('MICROSOFT_TRANSLATOR_KEY not set');

  const region = process.env.MICROSOFT_TRANSLATOR_REGION || 'global';
  const target = getLangCode(targetLanguage, 'ms');

  const res = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${target}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
        'Ocp-Apim-Subscription-Region': region
      },
      body: JSON.stringify([{ text }])
    }
  );

  if (!res.ok) throw new Error(`Microsoft Translator ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data[0]?.translations?.[0]?.text ?? null;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic:      translateAnthropic,
  openai:         translateOpenAI,
  ollama:         translateOllama,
  google:         translateGoogle,
  deepl:          translateDeepL,
  libretranslate: translateLibre,
  microsoft:      translateMicrosoft
};

// ── Exhaustion tracking ───────────────────────────────────────────────────────
// Providers that have hit their quota are stored here in-memory.
// They are skipped for all subsequent translations until manually reset.

const exhaustedProviders = new Set();

export function getExhaustedProviders() {
  return [...exhaustedProviders];
}

export function resetExhausted(provider) {
  if (provider) {
    exhaustedProviders.delete(provider);
    console.log(`[translation] Exhaustion reset for: ${provider}`);
  } else {
    exhaustedProviders.clear();
    console.log('[translation] Exhaustion reset for all providers');
  }
}

/**
 * Returns true if the error signals a permanent quota/character-limit exhaustion
 * (as opposed to a transient network or auth error).
 */
function isQuotaError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes(' 456:')             ||  // DeepL character quota exceeded
    msg.includes('quota')             ||
    msg.includes('limit exceeded')    ||
    msg.includes('character limit')   ||
    msg.includes('insufficient_quota')||
    msg.includes('insufficient quota')||
    msg.match(/ 429:/) !== null           // rate-limit → treat as quota
  );
}

// ── Internal: single provider, throws on any error ───────────────────────────

async function translateProvider(text, targetLanguage, provider) {
  if (!text?.trim()) return text;
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  return (await fn(text, targetLanguage)) || text;
}

// ── Public: single provider with catch (backward compat) ─────────────────────

export async function translate(text, targetLanguage, provider = 'anthropic') {
  try {
    return await translateProvider(text, targetLanguage, provider);
  } catch (err) {
    console.error(`[translation] ${provider} error: ${err.message}`);
    return text;
  }
}

/**
 * Apply translation with automatic fallback chain.
 *
 * Tries the pair's primary provider first, then each provider in fallbackChain
 * in order.  When a provider returns a quota/limit error it is marked exhausted
 * and skipped for all future calls until resetExhausted() is called.
 * The special value 'none' in the chain means "stop and return original text".
 *
 * @param {string}   text
 * @param {object}   translationConfig  pair.translation
 * @param {'tgToDiscord'|'discordToTg'} direction
 * @param {string[]} fallbackChain  ordered list from store.getTranslationChain()
 * @returns {Promise<string>}
 */
export async function maybeTranslate(text, translationConfig, direction, fallbackChain = []) {
  if (process.env.TRANSLATION_ENABLED === 'false') return text;
  if (!translationConfig?.enabled) return text;

  const dir = translationConfig[direction];
  if (!dir?.enabled) return text;

  const targetLanguage  = dir.targetLanguage || 'English';
  const primaryProvider = translationConfig.provider || 'anthropic';

  // Build deduplicated chain: primary first, then fallbacks
  const seen  = new Set();
  const chain = [];
  for (const p of [primaryProvider, ...fallbackChain]) {
    if (!seen.has(p)) { seen.add(p); chain.push(p); }
  }

  for (const provider of chain) {
    if (provider === 'none') return text; // explicit pass-through entry

    if (exhaustedProviders.has(provider)) {
      console.log(`[translation] Skipping exhausted provider: ${provider}`);
      continue;
    }

    try {
      return await translateProvider(text, targetLanguage, provider);
    } catch (err) {
      if (isQuotaError(err)) {
        exhaustedProviders.add(provider);
        console.warn(`[translation] ${provider} quota reached — switching to next provider`);
        continue;
      }
      console.error(`[translation] ${provider} error: ${err.message}`);
      continue; // non-quota errors also try next provider
    }
  }

  return text; // all providers exhausted or chain ended
}

/**
 * Return availability status for all providers.
 * Used by the /api/status endpoint.
 */
export function getProviderStatus() {
  return {
    enabled:        process.env.TRANSLATION_ENABLED !== 'false',
    anthropic:      !!process.env.ANTHROPIC_API_KEY,
    openai:         !!process.env.OPENAI_API_KEY,
    ollama:         true, // always potentially available, no key needed
    google:         !!process.env.GOOGLE_TRANSLATE_API_KEY,
    deepl:          !!process.env.DEEPL_API_KEY,
    libretranslate: true, // always potentially available, no key needed
    microsoft:      !!process.env.MICROSOFT_TRANSLATOR_KEY
  };
}

export { LANG_MAP };
