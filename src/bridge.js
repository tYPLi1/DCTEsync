/**
 * bridge.js — Entry point.
 *
 * Message flow:
 *   Telegram group  →  extract media  →  download  →  Discord webhook
 *   Discord channel →  extract attachments  →  download  →  Telegram bot
 *
 * Per-pair controls:
 *   pair.mediaSync   — which media types are forwarded (all on by default)
 *   pair.translation — AI translation per direction (off by default)
 */

import 'dotenv/config';
import { startTelegram, sendToTelegram, downloadTelegramFile } from './telegram.js';
import { startDiscord,  sendToDiscord  }                       from './discord.js';
import { getPairByTelegramId, getPairByDiscordId }             from './store.js';
import { maybeTranslate }                                       from './translation.js';
import { downloadUrl, classifyMime, DISCORD_MAX_BYTES, TELEGRAM_MAX_BYTES } from './media.js';
import { startWeb }                                             from './web.js';

// ── mediaSync helpers ─────────────────────────────────────────────────────────

// Map Telegram media types → mediaSync.tgToDiscord key
const TG_TYPE_KEY = {
  photo:           'photo',
  video:           'video',
  audio:           'audio',
  voice:           'voice',
  document:        'document',
  sticker:         'sticker',
  sticker_video:   'sticker',
  sticker_animated:'sticker',
  animation:       'animation',
  videoNote:       'videoNote',
  location:        'location',
  poll:            'poll',
};

function isTgAllowed(mediaSync, mediaType) {
  const key = TG_TYPE_KEY[mediaType];
  if (!key) return true;
  // If mediaSync is missing (legacy pair), default to allowed
  return mediaSync?.tgToDiscord?.[key] !== false;
}

function isDcAllowed(mediaSync, category) {
  return mediaSync?.discordToTg?.[category] !== false;
}

// ── Telegram → Discord ────────────────────────────────────────────────────────

async function onTelegramMessage({ chatId, senderName, avatarUrl, text, media }) {
  const pair = getPairByTelegramId(chatId);
  if (!pair) return;

  // ── Text-only ──────────────────────────────────────────────────────────────
  if (!media) {
    if (!text) return;
    const translated = await maybeTranslate(text, pair.translation, 'tgToDiscord');
    console.log(`[bridge] TG→DC | pair=${pair.id} | text | from="${senderName}"`);
    await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, translated);
    return;
  }

  // ── Check per-pair media type permission ───────────────────────────────────
  if (!isTgAllowed(pair.mediaSync, media.type)) {
    console.log(`[bridge] TG→DC | pair=${pair.id} | blocked type=${media.type}`);
    return;
  }

  // ── Non-file types (location, poll, animated sticker) ─────────────────────
  if (media.type === 'sticker_animated') {
    const msg = `[Sticker ${media.emoji}]`;
    await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, msg);
    return;
  }

  if (media.type === 'location') {
    const msg = `📍 Location: https://maps.google.com/?q=${media.latitude},${media.longitude}`;
    await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, msg);
    return;
  }

  if (media.type === 'poll') {
    const lines = [`📊 **Poll:** ${media.question}`, ...media.options.map(o => `• ${o}`)];
    await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, lines.join('\n'));
    return;
  }

  // ── File-based media ───────────────────────────────────────────────────────
  if (media.fileId) {
    // Telegram's bot API only allows downloading files up to TELEGRAM_MAX_BYTES (20 MB).
    // Discord webhooks cap at DISCORD_MAX_BYTES (25 MB), but the Telegram download
    // limit is the binding constraint, so we reject against it here.
    const effectiveLimit = Math.min(TELEGRAM_MAX_BYTES, DISCORD_MAX_BYTES);
    if ((media.size || 0) > effectiveLimit) {
      await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl,
        `[File too large to forward: ${media.fileName} (>${Math.round(effectiveLimit / 1024 / 1024)} MB)]`);
      return;
    }

    const buffer = await downloadTelegramFile(media.fileId, media.size);
    if (!buffer) {
      await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl,
        `[Could not download file: ${media.fileName}]`);
      return;
    }

    const captionRaw = media.caption || text || null;
    const caption    = captionRaw ? await maybeTranslate(captionRaw, pair.translation, 'tgToDiscord') : null;

    console.log(`[bridge] TG→DC | pair=${pair.id} | type=${media.type} | from="${senderName}"`);
    await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, caption, {
      buffer,
      mimeType: media.mimeType,
      fileName: media.fileName
    });
  }
}

// ── Discord → Telegram ────────────────────────────────────────────────────────

async function onDiscordMessage({ channelId, senderName, avatarUrl: _av, text, attachments }) {
  const pair = getPairByDiscordId(channelId);
  if (!pair) return;

  const translatedText = text
    ? await maybeTranslate(text, pair.translation, 'discordToTg')
    : null;

  // ── Text-only ──────────────────────────────────────────────────────────────
  if (!attachments.length) {
    if (translatedText) {
      console.log(`[bridge] DC→TG | pair=${pair.id} | text | from="${senderName}"`);
      await sendToTelegram(pair.telegramChatId, senderName, translatedText);
    }
    return;
  }

  // ── Attachments ────────────────────────────────────────────────────────────
  let captionUsed = false;

  for (const att of attachments) {
    const { category } = classifyMime(att.contentType, att.name);

    if (!isDcAllowed(pair.mediaSync, category)) {
      console.log(`[bridge] DC→TG | pair=${pair.id} | blocked category=${category}`);
      continue;
    }

    const buffer = await downloadUrl(att.url, DISCORD_MAX_BYTES);
    if (!buffer) {
      await sendToTelegram(pair.telegramChatId, senderName, `[Could not download: ${att.name}]`);
      captionUsed = true; // don't repeat error + text
      continue;
    }

    // Use text as caption on the first forwarded attachment
    const caption = !captionUsed ? translatedText : null;
    captionUsed = true;

    console.log(`[bridge] DC→TG | pair=${pair.id} | category=${category} | from="${senderName}"`);
    await sendToTelegram(pair.telegramChatId, senderName, caption, {
      buffer,
      mimeType: att.contentType || 'application/octet-stream',
      fileName: att.name
    });
  }

  // All attachments were blocked → still send text if present
  if (!captionUsed && translatedText) {
    await sendToTelegram(pair.telegramChatId, senderName, translatedText);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[bridge] Starting Telegram ↔ Discord bridge…');
startTelegram(onTelegramMessage);
startDiscord(onDiscordMessage);
startWeb();
