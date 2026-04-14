import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPairs, addPair, removePair, updatePair, DEFAULT_TRANSLATION, DEFAULT_MEDIA_SYNC } from './store.js';
import { getProviderStatus } from './translation.js';
import { bot } from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

export function startWeb() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));

  // ── GET /api/pairs ─────────────────────────────────────────────────────────
  app.get('/api/pairs', (_req, res) => {
    res.json(getPairs());
  });

  // ── POST /api/pairs ────────────────────────────────────────────────────────
  app.post('/api/pairs', async (req, res) => {
    const { telegramChatId, discordChannelId, discordWebhookUrl, label } = req.body;

    if (!telegramChatId || !discordChannelId || !discordWebhookUrl) {
      return res.status(400).json({ error: 'telegramChatId, discordChannelId and discordWebhookUrl are required.' });
    }

    // Validate Discord webhook URL format
    if (!discordWebhookUrl.startsWith('https://discord.com/api/webhooks/') &&
        !discordWebhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
      return res.status(400).json({ error: 'discordWebhookUrl must be a valid Discord webhook URL.' });
    }

    // ── Verify the Telegram bot can read messages in the target group ──────────
    // Two valid configurations allow the bot to receive ALL group messages:
    //   A) Privacy mode disabled globally (BotFather → Bot Settings → Group Privacy → Disable)
    //      → getMe() returns can_read_all_group_messages = true
    //   B) Bot is an administrator of this specific group
    //      → getChatMember() returns status "creator" or "administrator"
    // If neither applies, the bot only receives /commands and the bridge is silent.
    try {
      const me     = await bot.telegram.getMe();
      const member = await bot.telegram.getChatMember(String(telegramChatId), me.id);

      const privacyOff  = me.can_read_all_group_messages === true;          // (A)
      const isAdmin     = ['creator', 'administrator'].includes(member.status); // (B)

      if (!privacyOff && !isAdmin) {
        console.warn(
          `[web] Pair rejected: bot cannot read all messages in ${telegramChatId} ` +
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
    } catch (err) {
      const msg = err?.response?.description ?? err.message;
      console.warn(`[web] Telegram group check failed for ${telegramChatId}: ${msg}`);
      return res.status(400).json({
        error:
          `Cannot access Telegram group ${telegramChatId}: ${msg}. ` +
          'Make sure the bot is already a member of the group before adding the pair.'
      });
    }

    const pair = {
      id: uuidv4(),
      label: label || '',
      telegramChatId:    String(telegramChatId),
      discordChannelId:  String(discordChannelId),
      discordWebhookUrl,
      translation: { ...DEFAULT_TRANSLATION },
      mediaSync:   JSON.parse(JSON.stringify(DEFAULT_MEDIA_SYNC))
    };

    addPair(pair);
    console.log(`[web] Pair added: ${pair.id}`);
    res.status(201).json(pair);
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

  // ── GET /api/status ───────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      uptime:               process.uptime(),
      pairs:                getPairs().length,
      translationProviders: getProviderStatus()
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
