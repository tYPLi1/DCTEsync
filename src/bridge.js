/**
 * bridge.js — Entry point.
 *
 * Message flow:
 *   Telegram group/topic  →  extract media  →  download  →  Discord webhook
 *   Discord channel       →  extract attachments  →  download  →  Telegram bot
 *
 * Per-pair controls:
 *   pair.mediaSync        — which media types are forwarded (all on by default)
 *   pair.translation      — AI translation per direction (off by default)
 *   pair.telegramTopicId  — optional forum topic ID (null = whole chat)
 *
 * Reply sync:
 *   When a user replies to a message, the forwarded message is also sent as a
 *   reply to the corresponding message on the other platform.
 *   Requires the message ID mapping (messageMap.js) to be populated first.
 *
 * Reaction sync:
 *   Standard Unicode emoji reactions are mirrored in both directions.
 *   Custom Discord guild emoji are silently ignored (can't be sent to Telegram).
 *   Telegram custom/animated emoji are ignored (only type:'emoji' is forwarded).
 */

import 'dotenv/config';
import { startTelegram, sendToTelegram, downloadTelegramFile, bot, deleteFromTelegram } from './telegram.js';
import { startDiscord,  sendToDiscord, reactOnDiscord }                                from './discord.js';
import { getPairByTelegramId, getPairByDiscordId, getTranslationChain, getTranslationTiers, getPremiumAccess } from './store.js';
import { maybeTranslate }                                                              from './translation.js';
import { store, tgToDc, dcToTg, removeByDc }                                          from './messageMap.js';
import { downloadUrl, classifyMime, DISCORD_MAX_BYTES, TELEGRAM_MAX_BYTES } from './media.js';
import { startWeb }                                                  from './web.js';

// ── mediaSync helpers ─────────────────────────────────────────────────────────

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
  return mediaSync?.tgToDiscord?.[key] !== false;
}

function isDcAllowed(mediaSync, category) {
  return mediaSync?.discordToTg?.[category] !== false;
}

// ── Translation tier resolution ───────────────────────────────────────────────

/**
 * Resolves which translation provider and fallback chain to use for a given
 * user based on the two-tier access control config.
 *
 * Resolution order: per-pair override > global config.
 * If the user matches the premium access list → premium tier, otherwise standard.
 * If neither tier has a provider set → falls back to pair.translation.provider.
 * If neither tier has a chain set → falls back to the global translationChain.
 *
 * @param {object} pair
 * @param {{ platform: 'telegram'|'discord', userId?: string, roles?: Array<{id:string}> }} ctx
 * @returns {{ provider: string, chain: string[] }}
 */
function resolveTierForUser(pair, { platform, userId, roles = [] }) {
  const globalTiers  = getTranslationTiers();
  const globalAccess = getPremiumAccess();
  const globalChain  = getTranslationChain();

  // Merge: per-pair override > global
  const premiumCfg  = pair.translationTiersOverride?.premium  ?? globalTiers.premium  ?? { provider: null, chain: [] };
  const standardCfg = pair.translationTiersOverride?.standard ?? globalTiers.standard ?? { provider: null, chain: [] };
  const premiumRoleIds  = pair.premiumAccessOverride?.discordRoleIds  ?? globalAccess.discordRoleIds  ?? [];
  const premiumUserIds  = pair.premiumAccessOverride?.telegramUserIds ?? globalAccess.telegramUserIds ?? [];

  // Determine if this user qualifies for premium
  let isPremium = false;
  if (platform === 'discord' && premiumRoleIds.length) {
    isPremium = roles.some(r => premiumRoleIds.includes(r.id));
  } else if (platform === 'telegram' && premiumUserIds.length && userId) {
    isPremium = premiumUserIds.includes(userId);
  }

  const tier     = isPremium ? premiumCfg : standardCfg;
  const provider = tier.provider || null; // null = use pair.translation.provider (handled by maybeTranslate)
  const chain    = (tier.chain?.length > 0) ? tier.chain : globalChain;

  if (isPremium) {
    console.log(`[bridge] tier=premium provider=${provider ?? 'default'} for ${platform} user=${userId ?? 'unknown'}`);
  }

  return { provider, chain };
}

// ── Telegram → Discord ────────────────────────────────────────────────────────

async function onTelegramMessage({ chatId, msgId, senderName, avatarUrl, senderId, text, media, replyToMsgId, topicId }) {
  const pair = getPairByTelegramId(chatId, topicId);
  if (!pair) {
    console.log(`[bridge] TG→DC | no pair for chatId=${chatId}${topicId ? ` topicId=${topicId}` : ''} — message ignored`);
    return;
  }

  // Resolve reply: find the Discord message that corresponds to the TG message being replied to
  const dcReplyId = replyToMsgId ? tgToDc(pair.id, replyToMsgId) : null;

  const { provider: tierProvider, chain: tierChain } = resolveTierForUser(pair, { platform: 'telegram', userId: senderId });

  // ── Text-only ──────────────────────────────────────────────────────────────
  if (!media) {
    if (!text) return;
    const translated = await maybeTranslate(text, pair.translation, 'tgToDiscord', tierChain, tierProvider);
    console.log(`[bridge] TG→DC | pair=${pair.id} | text | from="${senderName}"${dcReplyId ? ' (reply)' : ''}`);
    const dcMsgId = await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, translated, null,
      dcReplyId ? { replyToMsgId: dcReplyId, channelId: pair.discordChannelId } : {});
    if (msgId && dcMsgId) store(pair.id, msgId, dcMsgId);
    return;
  }

  // ── Check per-pair media type permission ───────────────────────────────────
  if (!isTgAllowed(pair.mediaSync, media.type)) {
    console.log(`[bridge] TG→DC | pair=${pair.id} | blocked type=${media.type}`);
    return;
  }

  // ── Non-file types (location, poll, animated sticker) ─────────────────────
  if (media.type === 'sticker_animated') {
    const dcMsgId = await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, `[Sticker ${media.emoji}]`, null,
      dcReplyId ? { replyToMsgId: dcReplyId, channelId: pair.discordChannelId } : {});
    if (msgId && dcMsgId) store(pair.id, msgId, dcMsgId);
    return;
  }

  if (media.type === 'location') {
    const msg = `📍 Location: https://maps.google.com/?q=${media.latitude},${media.longitude}`;
    const dcMsgId = await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, msg, null,
      dcReplyId ? { replyToMsgId: dcReplyId, channelId: pair.discordChannelId } : {});
    if (msgId && dcMsgId) store(pair.id, msgId, dcMsgId);
    return;
  }

  if (media.type === 'poll') {
    const lines = [`📊 **Poll:** ${media.question}`, ...media.options.map(o => `• ${o}`)];
    const dcMsgId = await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, lines.join('\n'), null,
      dcReplyId ? { replyToMsgId: dcReplyId, channelId: pair.discordChannelId } : {});
    if (msgId && dcMsgId) store(pair.id, msgId, dcMsgId);
    return;
  }

  // ── File-based media ───────────────────────────────────────────────────────
  if (media.fileId) {
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
    const caption    = captionRaw ? await maybeTranslate(captionRaw, pair.translation, 'tgToDiscord', tierChain, tierProvider) : null;

    console.log(`[bridge] TG→DC | pair=${pair.id} | type=${media.type} | from="${senderName}"${dcReplyId ? ' (reply)' : ''}`);
    const dcMsgId = await sendToDiscord(pair.discordWebhookUrl, senderName, avatarUrl, caption,
      { buffer, mimeType: media.mimeType, fileName: media.fileName },
      dcReplyId ? { replyToMsgId: dcReplyId, channelId: pair.discordChannelId } : {});
    if (msgId && dcMsgId) store(pair.id, msgId, dcMsgId);
  }
}

// ── Discord → Telegram ────────────────────────────────────────────────────────

async function onDiscordMessage({ channelId, msgId, senderName, avatarUrl: _av, authorId, text, attachments, roles = [], replyToMsgId }) {
  const pair = getPairByDiscordId(channelId);
  if (!pair) return;

  // Append any configured display-roles to the sender name
  const displayRoleIds = pair.displayRoles ?? [];
  const matchedRoles   = displayRoleIds.length
    ? roles.filter(r => displayRoleIds.includes(r.id)).map(r => r.name)
    : [];
  const displayName = matchedRoles.length
    ? `${senderName} · ${matchedRoles.join(' · ')}`
    : senderName;

  // Resolve reply: find the Telegram message that corresponds to the DC message being replied to
  const tgReplyId = replyToMsgId ? dcToTg(pair.id, replyToMsgId) : null;
  const sendOpts  = {};
  if (tgReplyId)          sendOpts.replyToMsgId = Number(tgReplyId);
  if (pair.telegramTopicId) sendOpts.topicId    = pair.telegramTopicId;

  const { provider: tierProvider, chain: tierChain } = resolveTierForUser(pair, { platform: 'discord', userId: authorId, roles });

  const translatedText = text
    ? await maybeTranslate(text, pair.translation, 'discordToTg', tierChain, tierProvider)
    : null;

  // ── Text-only ──────────────────────────────────────────────────────────────
  if (!attachments.length) {
    if (translatedText) {
      console.log(`[bridge] DC→TG | pair=${pair.id} | text | from="${displayName}"${tgReplyId ? ' (reply)' : ''}`);
      const tgMsgId = await sendToTelegram(pair.telegramChatId, displayName, translatedText, null, sendOpts);
      if (msgId && tgMsgId) store(pair.id, tgMsgId, msgId);
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
      await sendToTelegram(pair.telegramChatId, displayName, `[Could not download: ${att.name}]`, null, sendOpts);
      captionUsed = true;
      continue;
    }

    const caption = !captionUsed ? translatedText : null;
    captionUsed = true;

    console.log(`[bridge] DC→TG | pair=${pair.id} | category=${category} | from="${displayName}"${tgReplyId ? ' (reply)' : ''}`);
    const tgMsgId = await sendToTelegram(pair.telegramChatId, displayName, caption,
      { buffer, mimeType: att.contentType || 'application/octet-stream', fileName: att.name },
      sendOpts);
    if (msgId && tgMsgId) store(pair.id, tgMsgId, msgId);
  }

  // All attachments were blocked → still send text if present
  if (!captionUsed && translatedText) {
    const tgMsgId = await sendToTelegram(pair.telegramChatId, displayName, translatedText, null, sendOpts);
    if (msgId && tgMsgId) store(pair.id, tgMsgId, msgId);
  }
}

// ── Telegram → Discord reaction sync ─────────────────────────────────────────

async function onTelegramReaction({ chatId, msgId, added, removed }) {
  // Find a pair for this chat (topic reactions don't carry topic info — use catch-all)
  const pair = getPairByTelegramId(chatId);
  if (!pair) return;

  const dcMsgId = tgToDc(pair.id, msgId);
  if (!dcMsgId) return; // message not in our mapping — ignore

  // Add new reactions on the Discord side
  for (const emoji of added) {
    console.log(`[bridge] TG→DC reaction | pair=${pair.id} | +${emoji}`);
    await reactOnDiscord(pair.discordChannelId, dcMsgId, emoji);
  }
  // Removing Discord reactions by another user isn't reliably possible — skip
}

// ── Discord → Telegram reaction sync ─────────────────────────────────────────

async function onDiscordReaction({ channelId, msgId, emoji, added }) {
  const pair = getPairByDiscordId(channelId);
  if (!pair) return;

  const tgMsgId = dcToTg(pair.id, msgId);
  if (!tgMsgId) return; // message not in our mapping — ignore

  try {
    if (added) {
      console.log(`[bridge] DC→TG reaction | pair=${pair.id} | +${emoji}`);
      await bot.telegram.setMessageReaction(pair.telegramChatId, Number(tgMsgId),
        [{ type: 'emoji', emoji }]);
    } else {
      // Remove: clear the bot's reaction on that message
      console.log(`[bridge] DC→TG reaction | pair=${pair.id} | -${emoji}`);
      await bot.telegram.setMessageReaction(pair.telegramChatId, Number(tgMsgId), []);
    }
  } catch (err) {
    console.error(`[bridge] DC→TG reaction error:`, err.message);
  }
}

// ── Discord → Telegram deletion sync ─────────────────────────────────────────
// Note: Telegram Bot API does NOT fire events when a message is deleted,
// so TG→DC deletion sync is impossible. Only DC→TG is supported here.

async function onDiscordDelete({ channelId, msgId }) {
  const pair = getPairByDiscordId(channelId);
  if (!pair) return;

  const tgMsgId = dcToTg(pair.id, msgId);
  if (!tgMsgId) return; // not a bridged message — ignore

  console.log(`[bridge] DC delete | pair=${pair.id} | DC msgId=${msgId} → TG msgId=${tgMsgId}`);
  await deleteFromTelegram(pair.telegramChatId, tgMsgId);
  removeByDc(pair.id, msgId);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[bridge] Starting Telegram ↔ Discord bridge…');
startTelegram(onTelegramMessage, onTelegramReaction);
startDiscord(onDiscordMessage, onDiscordReaction, onDiscordDelete);
startWeb();
