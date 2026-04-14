import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import { classifyMime, TELEGRAM_MAX_BYTES } from './media.js';

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) { console.error('[telegram] TELEGRAM_TOKEN is not set. Exiting.'); process.exit(1); }

export const bot = new Telegraf(BOT_TOKEN);
const TG_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

// ── Avatar ────────────────────────────────────────────────────────────────────

async function getAvatarUrl(userId) {
  try {
    const photos = await bot.telegram.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.total_count) return null;
    const file = await bot.telegram.getFile(photos.photos[0][0].file_id);
    return `${TG_FILE_API}/${file.file_path}`;
  } catch { return null; }
}

// ── Media extraction ──────────────────────────────────────────────────────────
// Returns a media descriptor object or null for text-only messages.

function extractMedia(msg) {
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1]; // largest resolution
    return { type: 'photo', fileId: p.file_id, fileName: 'photo.jpg', mimeType: 'image/jpeg', size: p.file_size ?? 0, caption: msg.caption ?? null };
  }
  if (msg.video) {
    const v = msg.video;
    return { type: 'video', fileId: v.file_id, fileName: v.file_name || 'video.mp4', mimeType: v.mime_type || 'video/mp4', size: v.file_size ?? 0, caption: msg.caption ?? null };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { type: 'audio', fileId: a.file_id, fileName: a.file_name || 'audio.mp3', mimeType: a.mime_type || 'audio/mpeg', size: a.file_size ?? 0, caption: msg.caption ?? null };
  }
  if (msg.voice) {
    return { type: 'voice', fileId: msg.voice.file_id, fileName: 'voice.ogg', mimeType: msg.voice.mime_type || 'audio/ogg', size: msg.voice.file_size ?? 0, caption: null };
  }
  if (msg.document) {
    const d = msg.document;
    return { type: 'document', fileId: d.file_id, fileName: d.file_name || 'file', mimeType: d.mime_type || 'application/octet-stream', size: d.file_size ?? 0, caption: msg.caption ?? null };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    if (s.is_animated) return { type: 'sticker_animated', emoji: s.emoji || '🎭' };
    if (s.is_video)    return { type: 'sticker_video',    fileId: s.file_id, fileName: 'sticker.webm', mimeType: 'video/webm', size: s.file_size ?? 0, emoji: s.emoji };
    return               { type: 'sticker',              fileId: s.file_id, fileName: 'sticker.webp', mimeType: 'image/webp', size: s.file_size ?? 0, emoji: s.emoji };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { type: 'animation', fileId: a.file_id, fileName: a.file_name || 'animation.gif', mimeType: a.mime_type || 'video/mp4', size: a.file_size ?? 0, caption: msg.caption ?? null };
  }
  if (msg.video_note) {
    return { type: 'videoNote', fileId: msg.video_note.file_id, fileName: 'video_note.mp4', mimeType: 'video/mp4', size: msg.video_note.file_size ?? 0 };
  }
  if (msg.location) {
    return { type: 'location', latitude: msg.location.latitude, longitude: msg.location.longitude };
  }
  if (msg.poll) {
    return { type: 'poll', question: msg.poll.question, options: msg.poll.options.map(o => o.text) };
  }
  return null;
}

// ── File download ─────────────────────────────────────────────────────────────

/**
 * Download a Telegram file by its file_id.
 * Returns null if the file is too large or the download fails.
 *
 * @param {string} fileId
 * @param {number} sizeHint  Known file size in bytes (used for early reject)
 * @returns {Promise<Buffer|null>}
 */
export async function downloadTelegramFile(fileId, sizeHint = 0) {
  if (sizeHint > TELEGRAM_MAX_BYTES) return null;
  try {
    const file = await bot.telegram.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`${TG_FILE_API}/${file.file_path}`);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= TELEGRAM_MAX_BYTES ? buf : null;
  } catch { return null; }
}

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Start the Telegram bot.
 *
 * @param {(msg: object) => void} onMessage
 *   Called with { chatId, senderName, avatarUrl, text, media }
 */
export function startTelegram(onMessage) {
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    if (msg.from?.is_bot) return;

    const chatId     = String(ctx.chat.id);
    const sender     = msg.from;
    const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || 'Unknown';
    const text       = msg.text ?? null;
    const media      = extractMedia(msg);

    if (!text && !media) return; // nothing to forward

    const avatarUrl = await getAvatarUrl(sender.id);
    onMessage({ chatId, senderName, avatarUrl, text, media });
  });

  bot.launch()
    .then(() => console.log('[telegram] Bot started.'))
    .catch(err => { console.error('[telegram] Launch error:', err); process.exit(1); });

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Send a text message or file from Discord to a Telegram group.
 *
 * @param {string} chatId
 * @param {string} senderName
 * @param {string|null} text        Plain text (used as caption when attachment is present)
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }|null} attachment
 */
export async function sendToTelegram(chatId, senderName, text, attachment = null) {
  const caption = `[${senderName}]${text ? `: ${text}` : ''}`;

  try {
    if (!attachment) {
      if (text) await bot.telegram.sendMessage(chatId, caption);
      return;
    }

    const { buffer, mimeType, fileName } = attachment;
    const { method } = classifyMime(mimeType, fileName);
    const fileInput  = { source: buffer, filename: fileName };
    const extra      = { caption };

    switch (method) {
      case 'sendPhoto':     await bot.telegram.sendPhoto(chatId, fileInput, extra);     break;
      case 'sendVideo':     await bot.telegram.sendVideo(chatId, fileInput, extra);     break;
      case 'sendAnimation': await bot.telegram.sendAnimation(chatId, fileInput, extra); break;
      case 'sendAudio':     await bot.telegram.sendAudio(chatId, fileInput, extra);     break;
      case 'sendVoice':     await bot.telegram.sendVoice(chatId, fileInput, extra);     break;
      default:              await bot.telegram.sendDocument(chatId, fileInput, extra);  break;
    }
  } catch (err) {
    console.error(`[telegram] Send error to ${chatId}:`, err.message);
  }
}
