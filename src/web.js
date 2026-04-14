import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPairs, addPair, removePair, updatePair, DEFAULT_TRANSLATION } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

export function startWeb() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'public')));

  // ── GET /api/pairs ─────────────────────────────────────────────────────────
  app.get('/api/pairs', (_req, res) => {
    res.json(getPairs());
  });

  // ── POST /api/pairs ────────────────────────────────────────────────────────
  app.post('/api/pairs', (req, res) => {
    const { telegramChatId, discordChannelId, discordWebhookUrl, label } = req.body;

    if (!telegramChatId || !discordChannelId || !discordWebhookUrl) {
      return res.status(400).json({ error: 'telegramChatId, discordChannelId and discordWebhookUrl are required.' });
    }

    const pair = {
      id: uuidv4(),
      label: label || '',
      telegramChatId: String(telegramChatId),
      discordChannelId: String(discordChannelId),
      discordWebhookUrl,
      translation: { ...DEFAULT_TRANSLATION }
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
  // Update translation settings for a specific pair.
  // Body: full or partial translation config object.
  app.patch('/api/pairs/:id/translation', (req, res) => {
    const existing = getPairs().find(p => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pair not found.' });

    const merged = mergeTranslation(existing.translation ?? { ...DEFAULT_TRANSLATION }, req.body);
    const ok = updatePair(req.params.id, { translation: merged });
    if (!ok) return res.status(404).json({ error: 'Pair not found.' });

    console.log(`[web] Translation config updated for pair: ${req.params.id}`);
    res.json(merged);
  });

  // ── GET /api/status ───────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      uptime: process.uptime(),
      pairs: getPairs().length,
      translationProviders: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY
      }
    });
  });

  app.listen(PORT, () => {
    console.log(`[web] Dashboard listening on http://localhost:${PORT}`);
  });
}

// Deep-merge translation config — only overwrite keys that are provided
function mergeTranslation(current, incoming) {
  return {
    enabled: incoming.enabled ?? current.enabled,
    provider: incoming.provider ?? current.provider,
    tgToDiscord: {
      enabled: incoming.tgToDiscord?.enabled ?? current.tgToDiscord?.enabled,
      targetLanguage: incoming.tgToDiscord?.targetLanguage ?? current.tgToDiscord?.targetLanguage
    },
    discordToTg: {
      enabled: incoming.discordToTg?.enabled ?? current.discordToTg?.enabled,
      targetLanguage: incoming.discordToTg?.targetLanguage ?? current.discordToTg?.targetLanguage
    }
  };
}
