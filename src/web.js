import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPairs, addPair, removePair, updatePair, DEFAULT_TRANSLATION, DEFAULT_MEDIA_SYNC, DEFAULT_BOT_SYNC, DEFAULT_BOT_WHITELIST, getBotWhitelist, setBotWhitelist, getTranslationChain, setTranslationChain, setMicrosoftChars, getTranslationTiers, setTranslationTiers, getPremiumAccess, setPremiumAccess, setLibreUsage, getDeepLKeys, setDeepLKeys } from './store.js';
import { getProviderStatus, getExhaustedProviders, resetExhausted, getMicrosoftUsage, getLibreUsage, getExhaustedDeepLKeyIndices, resetExhaustedDeepLKey, rebuildExhaustedDeepLKeys } from './translation.js';
import { bot } from './telegram.js';
import { getGuildRoles } from './discord.js';
import { getRecentTelegramChats } from './bridge.js';

const ENV_PATH = resolve(process.cwd(), '.env');

const SENSITIVE_KEYS = new Set([
  'TELEGRAM_TOKEN', 'DISCORD_TOKEN',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GOOGLE_TRANSLATE_API_KEY',
  'LIBRETRANSLATE_API_KEY', 'MICROSOFT_TRANSLATOR_KEY'
]);

function parseEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const result = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    result[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return result;
}

function writeEnvVars(updates) {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const lines = raw.split('\n');
  const applied = new Set();

  const result = lines.map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq === -1) return line;
    const key = t.slice(0, eq).trim();
    if (key in updates) {
      applied.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys not already in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!applied.has(key)) result.push(`${key}=${val}`);
  }

  writeFileSync(ENV_PATH, result.join('\n'));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * One-time migration: resolve any @username telegramChatIds to numeric IDs.
 * Runs on startup so existing pairs created with a username work immediately.
 */
async function migrateUsernameChatIds() {
  const pairs = getPairs();
  for (const pair of pairs) {
    const id = String(pair.telegramChatId);
    if (!id.startsWith('@')) continue;
    try {
      const chatInfo = await bot.telegram.getChat(id);
      updatePair(pair.id, { telegramChatId: String(chatInfo.id) });
      console.log(`[web] Migration: resolved ${id} → ${chatInfo.id} for pair ${pair.id}`);
    } catch (err) {
      console.warn(`[web] Migration: could not resolve ${id} for pair ${pair.id}: ${err?.response?.description ?? err.message}`);
    }
  }
}

export function startWeb() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));

  // Migrate any username-based chat IDs to numeric IDs on startup
  migrateUsernameChatIds().catch(err => console.warn('[web] Migration error:', err.message));

  // ── GET /api/pairs ─────────────────────────────────────────────────────────
  app.get('/api/pairs', (_req, res) => {
    res.json(getPairs());
  });

  // ── POST /api/pairs ────────────────────────────────────────────────────────
  app.post('/api/pairs', async (req, res) => {
    const { telegramChatId, discordChannelId, discordWebhookUrl, label, telegramTopicId } = req.body;

    if (!telegramChatId || !discordChannelId || !discordWebhookUrl) {
      return res.status(400).json({ error: 'telegramChatId, discordChannelId and discordWebhookUrl are required.' });
    }

    // Validate Discord webhook URL format
    if (!discordWebhookUrl.startsWith('https://discord.com/api/webhooks/') &&
        !discordWebhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
      return res.status(400).json({ error: 'discordWebhookUrl must be a valid Discord webhook URL.' });
    }

    // ── Resolve @username → numeric chat ID ───────────────────────────────────
    // Telegram delivers incoming updates with numeric IDs only. If the user
    // supplied a @username we resolve it once here so the stored ID matches.
    let resolvedChatId = String(telegramChatId).trim();
    if (resolvedChatId.startsWith('@')) {
      try {
        const chatInfo = await bot.telegram.getChat(resolvedChatId);
        console.log(`[web] Resolved ${resolvedChatId} → ${chatInfo.id} (${chatInfo.title || chatInfo.username || ''})`);
        resolvedChatId = String(chatInfo.id);
      } catch (err) {
        return res.status(400).json({
          error: `Cannot resolve Telegram username ${resolvedChatId}: ${err?.response?.description ?? err.message}`
        });
      }
    }

    // ── Verify the Telegram bot can read messages in the target chat ───────────
    // Supports groups, supergroups, and channels.
    //
    // For groups/supergroups, at least one of the following must be true:
    //   A) Privacy mode disabled globally (BotFather → Bot Settings → Group Privacy → Disable)
    //      → getMe() returns can_read_all_group_messages = true
    //   B) Bot is an administrator of this specific group
    //      → getChatMember() returns status "creator" or "administrator"
    //
    // For channels the bot must be an admin (required to post there anyway).
    try {
      const [me, chat] = await Promise.all([
        bot.telegram.getMe(),
        bot.telegram.getChat(resolvedChatId)
      ]);
      const member = await bot.telegram.getChatMember(resolvedChatId, me.id);
      const isAdmin = ['creator', 'administrator'].includes(member.status);

      if (chat.type === 'channel') {
        // Channels: bot must be admin (to post) – privacy mode doesn't apply
        if (!isAdmin) {
          console.warn(`[web] Pair rejected: bot is not admin in channel ${resolvedChatId} (status=${member.status})`);
          return res.status(400).json({
            error:
              `The bot is not an administrator of this channel (status: "${member.status}"). ` +
              'Add the bot as an admin with "Post Messages" permission.'
          });
        }
      } else {
        // Groups / supergroups: need privacy off OR admin status
        const privacyOff = me.can_read_all_group_messages === true;
        if (!privacyOff && !isAdmin) {
          console.warn(
            `[web] Pair rejected: bot cannot read all messages in ${resolvedChatId} ` +
            `(status=${member.status}, can_read_all=${me.can_read_all_group_messages})`
          );
          return res.status(400).json({
            error:
              `The bot cannot read regular messages in this group (status: "${member.status}"). ` +
              'Fix one of these: ' +
              '(A) Make the bot an administrator of this group, OR ' +
              '(B) Disable privacy mode globally via BotFather: ' +
              '@BotFather → /mybots → your bot → Bot Settings → Group Privacy → Turn off.'
          });
        }
      }
    } catch (err) {
      const msg = err?.response?.description ?? err.message;
      console.warn(`[web] Telegram chat check failed for ${resolvedChatId}: ${msg}`);
      return res.status(400).json({
        error:
          `Cannot access Telegram chat ${resolvedChatId}: ${msg}. ` +
          'Make sure the bot is already a member of the group/channel before adding the pair.'
      });
    }

    // Parse optional forum topic ID (integer or null)
    const parsedTopicId = telegramTopicId != null && telegramTopicId !== ''
      ? parseInt(telegramTopicId, 10)
      : null;

    const pair = {
      id: uuidv4(),
      label: label || '',
      telegramChatId:    resolvedChatId,
      telegramTopicId:   parsedTopicId,
      discordChannelId:  String(discordChannelId),
      discordWebhookUrl,
      translation: { ...DEFAULT_TRANSLATION },
      mediaSync:   JSON.parse(JSON.stringify(DEFAULT_MEDIA_SYNC)),
      botSync:     { ...DEFAULT_BOT_SYNC }
    };

    addPair(pair);
    console.log(`[web] Pair added: ${pair.id}`);
    res.status(201).json(pair);
  });

  // ── PATCH /api/pairs/:id ──────────────────────────────────────────────────
  // Update basic pair fields: label, telegramChatId, discordChannelId, discordWebhookUrl.
  // Re-validates Telegram access whenever the chat ID changes.
  app.patch('/api/pairs/:id', async (req, res) => {
    const existing = getPairs().find(p => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pair not found.' });

    const { label, telegramChatId, discordChannelId, discordWebhookUrl, telegramTopicId } = req.body;
    const updates = {};

    if (label !== undefined)  updates.label = String(label);

    if (telegramTopicId !== undefined) {
      updates.telegramTopicId = telegramTopicId !== null && telegramTopicId !== ''
        ? parseInt(telegramTopicId, 10)
        : null;
    }

    if (discordWebhookUrl !== undefined && discordWebhookUrl !== existing.discordWebhookUrl) {
      if (!discordWebhookUrl.startsWith('https://discord.com/api/webhooks/') &&
          !discordWebhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
        return res.status(400).json({ error: 'discordWebhookUrl must be a valid Discord webhook URL.' });
      }
      updates.discordWebhookUrl = discordWebhookUrl;
    }

    if (discordChannelId !== undefined && String(discordChannelId) !== existing.discordChannelId) {
      updates.discordChannelId = String(discordChannelId);
    }

    if (telegramChatId !== undefined && String(telegramChatId) !== existing.telegramChatId) {
      const newId = String(telegramChatId);
      try {
        const [me, chat] = await Promise.all([
          bot.telegram.getMe(),
          bot.telegram.getChat(newId)
        ]);
        const member  = await bot.telegram.getChatMember(newId, me.id);
        const isAdmin = ['creator', 'administrator'].includes(member.status);
        if (chat.type === 'channel') {
          if (!isAdmin) return res.status(400).json({ error: 'Bot is not admin in this channel.' });
        } else {
          const privacyOff = me.can_read_all_group_messages === true;
          if (!privacyOff && !isAdmin) {
            return res.status(400).json({
              error: 'Bot cannot read messages in this group. Make it admin or disable privacy mode.'
            });
          }
        }
      } catch (err) {
        return res.status(400).json({
          error: `Cannot access Telegram chat ${newId}: ${err?.response?.description ?? err.message}`
        });
      }
      updates.telegramChatId = newId;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No changes provided.' });
    }

    updatePair(req.params.id, updates);
    console.log(`[web] Pair updated: ${req.params.id} — ${Object.keys(updates).join(', ')}`);
    const updated = getPairs().find(p => p.id === req.params.id);
    res.json(updated);
  });

  // ── DELETE /api/pairs/:id ──────────────────────────────────────────────────
  app.delete('/api/pairs/:id', (req, res) => {
    const removed = removePair(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Pair not found.' });
    console.log(`[web] Pair removed: ${req.params.id}`);
    res.json({ ok: true });
  });

  // ── PATCH /api/pairs/:id/translation ──────────────────────────────────────
  app.patch('/api/pairs/:id/translation', (req, res) => {
    const existing = getPairs().find(p => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pair not found.' });

    const merged = mergeTranslation(existing.translation ?? { ...DEFAULT_TRANSLATION }, req.body);
    if (!updatePair(req.params.id, { translation: merged })) {
      return res.status(404).json({ error: 'Pair not found.' });
    }

    console.log(`[web] Translation updated: ${req.params.id}`);
    res.json(merged);
  });

  // ── PATCH /api/pairs/:id/media-sync ───────────────────────────────────────
  // Update individual media type toggles for a pair.
  // Body example: { "tgToDiscord": { "sticker": false } }
  app.patch('/api/pairs/:id/media-sync', (req, res) => {
    const existing = getPairs().find(p => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pair not found.' });

    const base   = existing.mediaSync ?? JSON.parse(JSON.stringify(DEFAULT_MEDIA_SYNC));
    const merged = mergeMediaSync(base, req.body);

    if (!updatePair(req.params.id, { mediaSync: merged })) {
      return res.status(404).json({ error: 'Pair not found.' });
    }

    console.log(`[web] MediaSync updated: ${req.params.id}`);
    res.json(merged);
  });

  // ── PATCH /api/pairs/:id/bot-sync ─────────────────────────────────────────
  // Merge bot-sync config for one or both directions.
  // Body example:
  //   { "tgToDiscord": { "enabled": true, "useGlobal": false, "whitelist": ["123456"] } }
  app.patch('/api/pairs/:id/bot-sync', (req, res) => {
    const existing = getPairs().find(p => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pair not found.' });

    const base = existing.botSync ?? JSON.parse(JSON.stringify(DEFAULT_BOT_SYNC));
    const merged = {
      tgToDiscord: req.body.tgToDiscord !== undefined
        ? { ...base.tgToDiscord, ...req.body.tgToDiscord }
        : base.tgToDiscord,
      discordToTg: req.body.discordToTg !== undefined
        ? { ...base.discordToTg, ...req.body.discordToTg }
        : base.discordToTg
    };

    if (!updatePair(req.params.id, { botSync: merged })) {
      return res.status(404).json({ error: 'Pair not found.' });
    }

    console.log(`[web] BotSync updated: ${req.params.id}`);
    res.json(merged);
  });

  // ── GET /api/bot-whitelist ─────────────────────────────────────────────────
  app.get('/api/bot-whitelist', (_req, res) => {
    res.json(getBotWhitelist());
  });

  // ── PATCH /api/bot-whitelist ───────────────────────────────────────────────
  // Replace one or both direction lists.
  // Body example: { "tgToDiscord": ["123456", "@mybot"] }
  app.patch('/api/bot-whitelist', (req, res) => {
    const current = getBotWhitelist();
    const updated = {
      tgToDiscord: Array.isArray(req.body.tgToDiscord) ? req.body.tgToDiscord : current.tgToDiscord,
      discordToTg: Array.isArray(req.body.discordToTg) ? req.body.discordToTg : current.discordToTg
    };
    setBotWhitelist(updated);
    console.log('[web] Global bot-whitelist updated');
    res.json(updated);
  });

  // ── GET /api/microsoft-usage ─────────────────────────────────────────────
  // Returns the locally-tracked Microsoft Translator character count for the
  // current calendar month. Azure has no usage API, so we count ourselves.
  app.get('/api/microsoft-usage', (_req, res) => {
    res.json(getMicrosoftUsage());
  });

  // ── POST /api/microsoft-usage ─────────────────────────────────────────────
  // Manually override the character counter. Body: { chars: <number> }
  app.post('/api/microsoft-usage', (req, res) => {
    const chars = Number(req.body?.chars);
    if (!Number.isFinite(chars) || chars < 0) {
      return res.status(400).json({ error: 'chars must be a non-negative number.' });
    }
    setMicrosoftChars(chars);
    console.log(`[web] Microsoft usage counter set to ${chars}`);
    res.json(getMicrosoftUsage());
  });

  // ── GET /api/libretranslate-usage ────────────────────────────────────────
  // Returns the locally-tracked LibreTranslate counters for the current month.
  app.get('/api/libretranslate-usage', (_req, res) => {
    res.json(getLibreUsage());
  });

  // ── POST /api/libretranslate-usage ───────────────────────────────────────
  // Manually override the counters. Body: { chars?: number, requests?: number }
  app.post('/api/libretranslate-usage', (req, res) => {
    const chars    = req.body?.chars    !== undefined ? Number(req.body.chars)    : undefined;
    const requests = req.body?.requests !== undefined ? Number(req.body.requests) : undefined;
    if (chars    !== undefined && (!Number.isFinite(chars)    || chars    < 0)) return res.status(400).json({ error: 'chars must be a non-negative number.' });
    if (requests !== undefined && (!Number.isFinite(requests) || requests < 0)) return res.status(400).json({ error: 'requests must be a non-negative number.' });
    const current = getLibreUsage();
    setLibreUsage({
      chars:    chars    ?? current.chars,
      requests: requests ?? current.requests
    });
    console.log(`[web] LibreTranslate usage set to chars=${chars ?? current.chars}, requests=${requests ?? current.requests}`);
    res.json(getLibreUsage());
  });

  // ── GET /api/deepl-keys ──────────────────────────────────────────────────
  // Returns all registered DeepL keys (values masked) + per-key exhaustion state.
  app.get('/api/deepl-keys', (req, res) => {
    const keys      = getDeepLKeys();
    const exhausted = new Set(getExhaustedDeepLKeyIndices());
    const masked = keys.map((k, i) => ({
      index:     i,
      masked:    k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****',
      isFree:    k.endsWith(':fx'),
      exhausted: exhausted.has(i)
    }));
    res.json({ keys: masked });
  });

  // ── PUT /api/deepl-keys ───────────────────────────────────────────────────
  // Replace the full list of DeepL keys. Body: { keys: string[] }
  app.put('/api/deepl-keys', (req, res) => {
    if (!Array.isArray(req.body.keys)) {
      return res.status(400).json({ error: 'keys must be an array of strings.' });
    }
    setDeepLKeys(req.body.keys);
    console.log(`[web] DeepL keys updated: ${req.body.keys.length} key(s)`);
    res.json({ ok: true, count: getDeepLKeys().length });
  });

  // ── POST /api/deepl-keys/add ──────────────────────────────────────────────
  // Append a single key. Body: { key: string }
  app.post('/api/deepl-keys/add', (req, res) => {
    const key = (req.body?.key ?? '').trim();
    if (!key) return res.status(400).json({ error: 'key is required.' });
    const current = getDeepLKeys();
    if (current.length >= 20) return res.status(400).json({ error: 'Maximum of 20 keys reached.' });
    setDeepLKeys([...current, key]);
    console.log(`[web] DeepL key added (total: ${getDeepLKeys().length})`);
    res.json({ ok: true, count: getDeepLKeys().length });
  });

  // ── DELETE /api/deepl-keys/:index ────────────────────────────────────────
  app.delete('/api/deepl-keys/:index', (req, res) => {
    const idx = Number(req.params.index);
    const current = getDeepLKeys();
    if (idx < 0 || idx >= current.length) return res.status(404).json({ error: 'Key index out of range.' });
    setDeepLKeys(current.filter((_, i) => i !== idx));
    // Shift exhaustion indices: remove idx, decrement all indices > idx
    const shifted = getExhaustedDeepLKeyIndices()
      .filter(i => i !== idx)
      .map(i => i > idx ? i - 1 : i);
    rebuildExhaustedDeepLKeys(shifted);
    console.log(`[web] DeepL key #${idx} removed (total: ${getDeepLKeys().length})`);
    res.json({ ok: true, count: getDeepLKeys().length });
  });

  // ── POST /api/deepl-keys/reset-exhausted ─────────────────────────────────
  // Reset exhaustion for one key (body: { index: number }) or all (no index).
  app.post('/api/deepl-keys/reset-exhausted', (req, res) => {
    const index = req.body?.index ?? null;
    resetExhaustedDeepLKey(index == null ? null : Number(index));
    res.json({ ok: true });
  });

  // ── GET /api/deepl-usage ─────────────────────────────────────────────────
  // Proxies DeepL /v2/usage for every registered key in parallel.
  // Returns { keys: [{ index, masked, isFree, exhausted, usage?: {...}, error?: string }] }
  app.get('/api/deepl-usage', async (req, res) => {
    const keys      = getDeepLKeys();
    if (!keys.length) return res.status(404).json({ error: 'No DeepL keys configured.' });
    const exhausted = new Set(getExhaustedDeepLKeyIndices());

    const results = await Promise.all(keys.map(async (k, i) => {
      const base = k.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
      const entry = {
        index:     i,
        masked:    k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****',
        isFree:    k.endsWith(':fx'),
        exhausted: exhausted.has(i)
      };
      try {
        const r = await fetch(`${base}/v2/usage`, { headers: { Authorization: `DeepL-Auth-Key ${k}` } });
        if (!r.ok) {
          entry.error = `${r.status}`;
        } else {
          const d = await r.json();
          entry.usage = { character_count: d.character_count, character_limit: d.character_limit };
          // Auto-clear exhaustion if DeepL says quota is not yet exceeded
          if (exhausted.has(i) && d.character_count < d.character_limit) {
            resetExhaustedDeepLKey(i);
            entry.exhausted = false;
          }
        }
      } catch (err) {
        entry.error = err.message;
      }
      return entry;
    }));

    res.json({ keys: results });
  });

  // ── GET /api/pairs/:id/discord-roles ─────────────────────────────────────
  // Returns all selectable roles of the Discord guild linked to this pair.
  app.get('/api/pairs/:id/discord-roles', async (req, res) => {
    const pair = getPairs().find(p => p.id === req.params.id);
    if (!pair) return res.status(404).json({ error: 'Pair not found.' });
    const roles = await getGuildRoles(pair.discordChannelId);
    res.json(roles);
  });

  // ── PATCH /api/pairs/:id/display-roles ───────────────────────────────────
  // Update which Discord role IDs are appended to the sender name in Telegram.
  // Body: { roleIds: ["123", "456"] }
  app.patch('/api/pairs/:id/display-roles', (req, res) => {
    const { roleIds } = req.body;
    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'roleIds must be an array of role ID strings.' });
    }
    if (!updatePair(req.params.id, { displayRoles: roleIds })) {
      return res.status(404).json({ error: 'Pair not found.' });
    }
    console.log(`[web] DisplayRoles updated: ${req.params.id} → [${roleIds.join(', ')}]`);
    res.json({ ok: true, displayRoles: roleIds });
  });

  // ── GET /api/translation-chain ───────────────────────────────────────────
  // Returns the current fallback chain and exhaustion state per provider.
  app.get('/api/translation-chain', (_req, res) => {
    res.json({
      chain:     getTranslationChain(),
      exhausted: getExhaustedProviders()
    });
  });

  // ── POST /api/translation-chain ──────────────────────────────────────────
  // Replace the fallback chain. Body: { chain: ["deepl", "google", "none"] }
  app.post('/api/translation-chain', (req, res) => {
    const { chain } = req.body;
    if (!Array.isArray(chain)) {
      return res.status(400).json({ error: 'chain must be an array.' });
    }
    const VALID = new Set(['anthropic','openai','ollama','google','deepl','libretranslate','microsoft','none']);
    const invalid = chain.filter(p => !VALID.has(p));
    if (invalid.length) {
      return res.status(400).json({ error: `Unknown providers: ${invalid.join(', ')}` });
    }
    setTranslationChain(chain);
    console.log(`[web] Translation chain updated: [${chain.join(', ')}]`);
    res.json({ ok: true, chain });
  });

  // ── DELETE /api/translation-chain/exhausted ──────────────────────────────
  // Reset all exhausted providers.
  app.delete('/api/translation-chain/exhausted', (_req, res) => {
    resetExhausted();
    console.log('[web] All exhausted providers reset');
    res.json({ ok: true });
  });

  // ── DELETE /api/translation-chain/exhausted/:provider ───────────────────
  // Reset a single exhausted provider.
  app.delete('/api/translation-chain/exhausted/:provider', (req, res) => {
    resetExhausted(req.params.provider);
    console.log(`[web] Exhausted provider reset: ${req.params.provider}`);
    res.json({ ok: true, provider: req.params.provider });
  });

  // ── GET /api/status ───────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      uptime:               process.uptime(),
      pairs:                getPairs().length,
      translationProviders: getProviderStatus(),
      translationChain:     getTranslationChain(),
      exhaustedProviders:   getExhaustedProviders()
    });
  });

  // ── GET /api/config ───────────────────────────────────────────────────────
  // Returns current .env values. Sensitive keys are masked (first 6 chars + ****)
  app.get('/api/config', (_req, res) => {
    const env = parseEnvFile();
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = SENSITIVE_KEYS.has(k) && v
        ? v.slice(0, 6) + '****'
        : v;
    }
    res.json(out);
  });

  // ── POST /api/config ──────────────────────────────────────────────────────
  // Updates .env. Omit a field or send empty string to keep the current value.
  app.post('/api/config', (req, res) => {
    const updates = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (typeof v === 'string' && v.trim() !== '') {
        updates[k] = v.trim();
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No values provided.' });
    }
    try {
      writeEnvVars(updates);
      // Also update process.env so changes take effect without a restart
      for (const [k, v] of Object.entries(updates)) {
        process.env[k] = v;
      }
      console.log(`[web] Config updated: ${Object.keys(updates).join(', ')}`);
      res.json({ ok: true, updated: Object.keys(updates) });
    } catch (err) {
      console.error('[web] Failed to write .env:', err.message);
      res.status(500).json({ error: 'Failed to write .env: ' + err.message });
    }
  });

  // ── GET /api/translation-tiers ───────────────────────────────────────────
  // Returns the global tier config (provider + chain per tier) and premium access lists.
  app.get('/api/translation-tiers', (_req, res) => {
    res.json({
      translationTiers: getTranslationTiers(),
      premiumAccess:    getPremiumAccess()
    });
  });

  // ── PATCH /api/translation-tiers ─────────────────────────────────────────
  // Update global tier providers + chains.
  // Body: { premium?: { provider?, chain? }, standard?: { provider?, chain? } }
  app.patch('/api/translation-tiers', (req, res) => {
    const VALID = new Set(['anthropic','openai','ollama','google','deepl','libretranslate','microsoft','none',null]);
    const current = getTranslationTiers();
    const incoming = req.body;

    for (const tier of ['premium', 'standard']) {
      if (incoming[tier] === undefined) continue;
      if (incoming[tier].provider !== undefined && !VALID.has(incoming[tier].provider)) {
        return res.status(400).json({ error: `Unknown provider for ${tier}: ${incoming[tier].provider}` });
      }
      if (incoming[tier].chain !== undefined) {
        if (!Array.isArray(incoming[tier].chain)) {
          return res.status(400).json({ error: `${tier}.chain must be an array.` });
        }
        const invalid = incoming[tier].chain.filter(p => !VALID.has(p));
        if (invalid.length) {
          return res.status(400).json({ error: `Unknown providers in ${tier}.chain: ${invalid.join(', ')}` });
        }
      }
    }

    const merged = {
      premium: {
        provider: incoming.premium?.provider  !== undefined ? incoming.premium.provider  : current.premium.provider,
        chain:    incoming.premium?.chain     !== undefined ? incoming.premium.chain     : current.premium.chain
      },
      standard: {
        provider: incoming.standard?.provider !== undefined ? incoming.standard.provider : current.standard.provider,
        chain:    incoming.standard?.chain    !== undefined ? incoming.standard.chain    : current.standard.chain
      }
    };
    setTranslationTiers(merged);
    console.log('[web] Translation tiers updated');
    res.json({ ok: true, translationTiers: merged });
  });

  // ── PATCH /api/premium-access ─────────────────────────────────────────────
  // Update global premium access lists (Discord role IDs + Telegram user IDs).
  // Body: { discordRoleIds?: string[], telegramUserIds?: string[] }
  app.patch('/api/premium-access', (req, res) => {
    const { discordRoleIds, telegramUserIds } = req.body;
    if (discordRoleIds !== undefined && !Array.isArray(discordRoleIds)) {
      return res.status(400).json({ error: 'discordRoleIds must be an array of strings.' });
    }
    if (telegramUserIds !== undefined && !Array.isArray(telegramUserIds)) {
      return res.status(400).json({ error: 'telegramUserIds must be an array of strings.' });
    }
    const current = getPremiumAccess();
    const merged = {
      discordRoleIds:  discordRoleIds  !== undefined ? discordRoleIds.map(String)  : current.discordRoleIds,
      telegramUserIds: telegramUserIds !== undefined ? telegramUserIds.map(String) : current.telegramUserIds
    };
    setPremiumAccess(merged);
    console.log(`[web] Premium access updated`);
    res.json({ ok: true, premiumAccess: merged });
  });

  // ── PATCH /api/pairs/:id/translation-tiers-override ──────────────────────
  // Set or clear a per-pair tier override. Send null to remove the override.
  // Body: { premium?: { provider?, chain? }, standard?: { provider?, chain? } } | null
  app.patch('/api/pairs/:id/translation-tiers-override', (req, res) => {
    const pair = getPairs().find(p => p.id === req.params.id);
    if (!pair) return res.status(404).json({ error: 'Pair not found.' });

    const body = req.body;
    if (body === null || body.remove === true) {
      updatePair(req.params.id, { translationTiersOverride: null });
      return res.json({ ok: true, translationTiersOverride: null });
    }

    const VALID = new Set(['anthropic','openai','ollama','google','deepl','libretranslate','microsoft','none',null]);
    for (const tier of ['premium', 'standard']) {
      if (body[tier] === undefined) continue;
      if (body[tier].provider !== undefined && !VALID.has(body[tier].provider)) {
        return res.status(400).json({ error: `Unknown provider for ${tier}: ${body[tier].provider}` });
      }
      if (body[tier].chain !== undefined) {
        if (!Array.isArray(body[tier].chain)) {
          return res.status(400).json({ error: `${tier}.chain must be an array.` });
        }
        const invalid = body[tier].chain.filter(p => !VALID.has(p));
        if (invalid.length) {
          return res.status(400).json({ error: `Unknown providers in ${tier}.chain: ${invalid.join(', ')}` });
        }
      }
    }

    const current = pair.translationTiersOverride ?? { premium: { provider: null, chain: [] }, standard: { provider: null, chain: [] } };
    const merged = {
      premium: {
        provider: body.premium?.provider  !== undefined ? body.premium.provider  : current.premium?.provider  ?? null,
        chain:    body.premium?.chain     !== undefined ? body.premium.chain     : current.premium?.chain     ?? []
      },
      standard: {
        provider: body.standard?.provider !== undefined ? body.standard.provider : current.standard?.provider ?? null,
        chain:    body.standard?.chain    !== undefined ? body.standard.chain    : current.standard?.chain    ?? []
      }
    };
    updatePair(req.params.id, { translationTiersOverride: merged });
    console.log(`[web] Translation tiers override updated for pair ${req.params.id}`);
    res.json({ ok: true, translationTiersOverride: merged });
  });

  // ── PATCH /api/pairs/:id/premium-access-override ─────────────────────────
  // Set or clear a per-pair premium access override. Send null to remove.
  // Body: { discordRoleIds?: string[], telegramUserIds?: string[] } | null
  app.patch('/api/pairs/:id/premium-access-override', (req, res) => {
    const pair = getPairs().find(p => p.id === req.params.id);
    if (!pair) return res.status(404).json({ error: 'Pair not found.' });

    const body = req.body;
    if (body === null || body.remove === true) {
      updatePair(req.params.id, { premiumAccessOverride: null });
      return res.json({ ok: true, premiumAccessOverride: null });
    }

    const { discordRoleIds, telegramUserIds } = body;
    if (discordRoleIds !== undefined && !Array.isArray(discordRoleIds)) {
      return res.status(400).json({ error: 'discordRoleIds must be an array of strings.' });
    }
    if (telegramUserIds !== undefined && !Array.isArray(telegramUserIds)) {
      return res.status(400).json({ error: 'telegramUserIds must be an array of strings.' });
    }
    const current = pair.premiumAccessOverride ?? { discordRoleIds: [], telegramUserIds: [] };
    const merged = {
      discordRoleIds:  discordRoleIds  !== undefined ? discordRoleIds.map(String)  : current.discordRoleIds,
      telegramUserIds: telegramUserIds !== undefined ? telegramUserIds.map(String) : current.telegramUserIds
    };
    updatePair(req.params.id, { premiumAccessOverride: merged });
    console.log(`[web] Premium access override updated for pair ${req.params.id}`);
    res.json({ ok: true, premiumAccessOverride: merged });
  });

  // ── GET /api/telegram-chats ──────────────────────────────────────────────
  // Returns recent Telegram chat IDs (for auto-detect UI).
  // Sorted by most recent first.
  app.get('/api/telegram-chats', (_req, res) => {
    res.json({
      chats: getRecentTelegramChats()
    });
  });

  app.listen(PORT, () => {
    console.log(`[web] Dashboard listening on http://localhost:${PORT}`);
  });
}

// ── Merge helpers ─────────────────────────────────────────────────────────────

function mergeTranslation(current, incoming) {
  return {
    enabled:  incoming.enabled  ?? current.enabled,
    provider: incoming.provider ?? current.provider,
    tgToDiscord: {
      enabled:        incoming.tgToDiscord?.enabled        ?? current.tgToDiscord?.enabled,
      targetLanguage: incoming.tgToDiscord?.targetLanguage ?? current.tgToDiscord?.targetLanguage
    },
    discordToTg: {
      enabled:        incoming.discordToTg?.enabled        ?? current.discordToTg?.enabled,
      targetLanguage: incoming.discordToTg?.targetLanguage ?? current.discordToTg?.targetLanguage
    }
  };
}

function mergeMediaSync(current, incoming) {
  return {
    tgToDiscord: {
      ...current.tgToDiscord,
      ...(incoming.tgToDiscord ?? {})
    },
    discordToTg: {
      ...current.discordToTg,
      ...(incoming.discordToTg ?? {})
    }
  };
}
