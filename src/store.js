import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const DATA_FILE  = process.env.DATA_FILE || './data/config.json';
// Stored separately so frequent message-map writes don't touch the main config.
const MSGMAP_FILE = join(dirname(DATA_FILE), 'msgmap.json');

const DEFAULT_CONFIG = {
  pairs: []
};

function ensureFile() {
  const dir = dirname(DATA_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(DATA_FILE)) {
    writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

function read() {
  ensureFile();
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function write(config) {
  ensureFile();
  writeFileSync(DATA_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getPairs() {
  return read().pairs;
}

/**
 * Find a pair by Telegram chat ID, optionally scoped to a forum topic.
 *
 * Lookup order:
 *  1. Exact match: same chatId AND same topicId
 *  2. Catch-all:   same chatId, no topicId configured (topicId = null / undefined)
 *
 * Pass topicId = null (default) to match only non-topic pairs.
 *
 * @param {string|number} telegramChatId
 * @param {number|null} [topicId]
 */
export function getPairByTelegramId(telegramChatId, topicId = null) {
  const pairs = getPairs();
  const chatStr = String(telegramChatId);

  // 1. Exact match (chatId + topicId)
  if (topicId != null) {
    const exact = pairs.find(p =>
      String(p.telegramChatId) === chatStr &&
      (p.telegramTopicId ?? null) === topicId
    );
    if (exact) return exact;
  }

  // 2. Catch-all: same chatId, no topic configured
  return pairs.find(p =>
    String(p.telegramChatId) === chatStr &&
    !p.telegramTopicId
  ) ?? null;
}

export function getPairByDiscordId(discordChannelId) {
  return getPairs().find(p => String(p.discordChannelId) === String(discordChannelId)) || null;
}

export function addPair(pair) {
  const config = read();
  config.pairs.push(pair);
  write(config);
}

export function updatePair(id, updates) {
  const config = read();
  const idx = config.pairs.findIndex(p => p.id === id);
  if (idx === -1) return false;
  config.pairs[idx] = { ...config.pairs[idx], ...updates };
  write(config);
  return true;
}

export function removePair(id) {
  const config = read();
  const before = config.pairs.length;
  config.pairs = config.pairs.filter(p => p.id !== id);
  write(config);
  return config.pairs.length < before;
}

// ── DeepL multi-key management ───────────────────────────────────────────────
// Keys are stored in config.json (up to 20). Backward compat: if no keys are
// stored yet and DEEPL_API_KEY is set in .env, that key is used as the sole key.

export function getDeepLKeys() {
  const keys = read().deeplKeys;
  if (Array.isArray(keys) && keys.length > 0) return keys;
  return process.env.DEEPL_API_KEY ? [process.env.DEEPL_API_KEY] : [];
}

export function setDeepLKeys(keys) {
  const config = read();
  config.deeplKeys = keys
    .filter(k => typeof k === 'string' && k.trim())
    .map(k => k.trim())
    .slice(0, 20);
  write(config);
}

// ── Translation fallback chain ────────────────────────────────────────────────

/**
 * Returns the ordered list of providers to try for translation.
 * An empty array means "use only the pair's primary provider, no fallback".
 */
export function getTranslationChain() {
  return read().translationChain ?? [];
}

export function setTranslationChain(chain) {
  const config = read();
  config.translationChain = chain;
  write(config);
}

// ── Microsoft Translator usage tracking ───────────────────────────────────────
// Azure's free tier allows 2,000,000 characters per month and resets on the
// 1st of each month (UTC). We track usage locally since Azure has no usage API.

const MICROSOFT_CHAR_LIMIT = 2_000_000;

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function getMicrosoftUsage() {
  const config = read();
  const stored = config.microsoftUsage ?? { chars: 0, month: currentMonth() };
  // Auto-reset when the calendar month has rolled over
  if (stored.month !== currentMonth()) {
    return { chars: 0, limit: MICROSOFT_CHAR_LIMIT, month: currentMonth() };
  }
  return { chars: stored.chars, limit: MICROSOFT_CHAR_LIMIT, month: stored.month };
}

export function addMicrosoftChars(n) {
  const config = read();
  const now    = currentMonth();
  const prev   = config.microsoftUsage ?? { chars: 0, month: now };
  config.microsoftUsage = {
    chars: (prev.month === now ? prev.chars : 0) + n,
    month: now
  };
  write(config);
}

export function setMicrosoftChars(n) {
  const config = read();
  config.microsoftUsage = { chars: Math.max(0, n), month: currentMonth() };
  write(config);
}

// ── LibreTranslate usage tracking ─────────────────────────────────────────────
// LibreTranslate has no usage API (and usually no hard limit when self-hosted),
// so we track it locally. Counters are lifetime totals — they do NOT reset
// automatically and can only be cleared manually via the dashboard.

export function getLibreUsage() {
  const config = read();
  const stored = config.libreUsage ?? { chars: 0, requests: 0 };
  return { chars: stored.chars ?? 0, requests: stored.requests ?? 0 };
}

export function addLibreUsage(chars) {
  const config = read();
  const prev   = config.libreUsage ?? { chars: 0, requests: 0 };
  config.libreUsage = {
    chars:    (prev.chars    ?? 0) + chars,
    requests: (prev.requests ?? 0) + 1
  };
  write(config);
}

export function setLibreUsage({ chars, requests }) {
  const config = read();
  const prev   = config.libreUsage ?? { chars: 0, requests: 0 };
  config.libreUsage = {
    chars:    Math.max(0, chars    ?? prev.chars    ?? 0),
    requests: Math.max(0, requests ?? prev.requests ?? 0)
  };
  write(config);
}

// ── Translation tiers ─────────────────────────────────────────────────────────

/**
 * Default global translation tier config.
 * premium.provider / standard.provider = null means "use pair.translation.provider".
 * premium.chain / standard.chain = [] means "use the global translationChain as fallback".
 */
export const DEFAULT_TRANSLATION_TIERS = {
  premium:  { provider: null, chain: [] },
  standard: { provider: null, chain: [] }
};

/**
 * Default global premium-access config.
 * discordRoleIds: role IDs whose holders get the premium tier (Discord).
 * telegramUserIds: user IDs that get the premium tier (Telegram).
 */
export const DEFAULT_PREMIUM_ACCESS = {
  discordRoleIds:  [],
  telegramUserIds: []
};

export function getTranslationTiers() {
  return read().translationTiers ?? JSON.parse(JSON.stringify(DEFAULT_TRANSLATION_TIERS));
}

export function setTranslationTiers(tiers) {
  const config = read();
  config.translationTiers = tiers;
  write(config);
}

export function getPremiumAccess() {
  return read().premiumAccess ?? JSON.parse(JSON.stringify(DEFAULT_PREMIUM_ACCESS));
}

export function setPremiumAccess(access) {
  const config = read();
  config.premiumAccess = access;
  write(config);
}

// ── Default extra fields applied to every new pair ────────────────────────────

/**
 * Default extra fields applied to every new pair.
 * telegramTopicId: null = bridge the whole group/channel (no topic filtering).
 *                  integer = bridge only this forum topic thread.
 */
export const DEFAULT_TOPIC = { telegramTopicId: null };

/**
 * Default translation config applied to every new pair.
 * Translation is OFF by default; the user explicitly enables it per pair.
 */
export const DEFAULT_TRANSLATION = {
  enabled: false,
  provider: 'anthropic',
  tgToDiscord: {
    enabled: false,
    targetLanguage: 'English'
  },
  discordToTg: {
    enabled: false,
    targetLanguage: 'English'
  }
};

/**
 * Default media sync config applied to every new pair.
 * All types are ON by default — the user can disable individual types per pair.
 *
 * tgToDiscord: which Telegram message types to forward to Discord
 * discordToTg: which Discord attachment categories to forward to Telegram
 */
export const DEFAULT_MEDIA_SYNC = {
  tgToDiscord: {
    photo:     true,
    video:     true,
    audio:     true,
    voice:     true,
    document:  true,
    sticker:   true,
    animation: true,
    videoNote: true,
    location:  true,
    poll:      true
  },
  discordToTg: {
    image:    true,
    video:    true,
    audio:    true,
    document: true
  }
};

/**
 * Default per-pair bot-message sync config.
 * Both directions are disabled by default.
 * useGlobal: true  → use the global bot whitelist
 * useGlobal: false → use the pair's own whitelist
 * whitelist: []    → empty = no bots allowed (even when enabled)
 */
export const DEFAULT_BOT_SYNC = {
  tgToDiscord: { enabled: false, useGlobal: true, whitelist: [] },
  discordToTg: { enabled: false, useGlobal: true, whitelist: [] }
};

/**
 * Default global bot whitelist.
 * Bot IDs (numeric string) or @usernames accepted for Telegram.
 * Bot application IDs (snowflake string) or usernames for Discord.
 */
export const DEFAULT_BOT_WHITELIST = {
  tgToDiscord: [],
  discordToTg: []
};

export function getBotWhitelist() {
  return read().botWhitelist ?? JSON.parse(JSON.stringify(DEFAULT_BOT_WHITELIST));
}

export function setBotWhitelist(wl) {
  const config = read();
  config.botWhitelist = {
    tgToDiscord: Array.isArray(wl.tgToDiscord) ? wl.tgToDiscord : [],
    discordToTg: Array.isArray(wl.discordToTg) ? wl.discordToTg : []
  };
  write(config);
}

// ── Persistent message map ─────────────────────────────────────────────────────
// Stored in data/msgmap.json (separate file) so frequent per-message writes
// do not affect the main config.json.
// Format: { [pairId]: [ { tg: string, dc: string }, … ] }  (oldest → newest)

function readMsgMap() {
  if (!existsSync(MSGMAP_FILE)) return {};
  try { return JSON.parse(readFileSync(MSGMAP_FILE, 'utf-8')); }
  catch { return {}; }
}

export function loadAllMsgMaps() {
  return readMsgMap();
}

export function saveMsgMap(pairId, entries) {
  const data = readMsgMap();
  data[pairId] = entries;
  writeFileSync(MSGMAP_FILE, JSON.stringify(data), 'utf-8');
}

export function deleteMsgMap(pairId) {
  const data = readMsgMap();
  delete data[pairId];
  writeFileSync(MSGMAP_FILE, JSON.stringify(data), 'utf-8');
}
