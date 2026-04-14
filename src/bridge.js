/**
 * bridge.js — Entry point.
 *
 * Wires together Telegram, Discord, the store and the web dashboard.
 * Message flow:
 *
 *   Telegram group → bridge → Discord webhook  (looks like a real user)
 *   Discord channel → bridge → Telegram group  (prefixed: [Username]: text)
 *
 * Translation (optional, disabled by default):
 *   Configurable per pair via the dashboard.
 *   Each direction (tg→dc, dc→tg) has its own target language.
 */

import 'dotenv/config';
import { startTelegram, sendToTelegram } from './telegram.js';
import { startDiscord, sendToDiscord } from './discord.js';
import { getPairByTelegramId, getPairByDiscordId } from './store.js';
import { maybeTranslate } from './translation.js';
import { startWeb } from './web.js';

// ── Telegram → Discord ──────────────────────────────────────────────────────

async function onTelegramMessage(chatId, senderName, avatarUrl, text) {
  const pair = getPairByTelegramId(chatId);
  if (!pair) return;

  const translated = await maybeTranslate(text, pair.translation, 'tgToDiscord');

  console.log(`[bridge] TG→DC | pair=${pair.id} | from="${senderName}" | chat=${chatId}`);
  await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, translated);
}

// ── Discord → Telegram ──────────────────────────────────────────────────────

async function onDiscordMessage(channelId, senderName, _avatarUrl, text) {
  const pair = getPairByDiscordId(channelId);
  if (!pair) return;

  const translated = await maybeTranslate(text, pair.translation, 'discordToTg');

  console.log(`[bridge] DC→TG | pair=${pair.id} | from="${senderName}" | channel=${channelId}`);
  await sendToTelegram(pair.telegramChatId, senderName, translated);
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

console.log('[bridge] Starting Telegram ↔ Discord bridge…');
startTelegram(onTelegramMessage);
startDiscord(onDiscordMessage);
startWeb();
