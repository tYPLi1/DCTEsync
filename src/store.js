import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DATA_FILE = process.env.DATA_FILE || './data/config.json';

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
