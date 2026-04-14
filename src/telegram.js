import { Telegraf } from 'telegraf';

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

if (!BOT_TOKEN) {
  console.error('[telegram] TELEGRAM_TOKEN is not set. Exiting.');
  process.exit(1);
}

export const bot = new Telegraf(BOT_TOKEN);

/**
 * Fetch the public URL of a Telegram user's profile photo.
 * Returns null if the user has no photo or the request fails.
 *
 * @param {number} userId
 * @returns {Promise<string|null>}
 */
async function getAvatarUrl(userId) {
  try {
    const photos = await bot.telegram.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.total_count) return null;

    const fileId = photos.photos[0][0].file_id;
    const file = await bot.telegram.getFile(fileId);
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  } catch {
    return null;
  }
}

/**
 * Start the Telegram bot and register the message handler.
 *
 * @param {(chatId: string, senderName: string, avatarUrl: string|null, text: string, extra: object) => void} onMessage
 */
export function startTelegram(onMessage) {
  // Only handle messages in groups / supergroups
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const chatType = ctx.chat?.type;

    if (!['group', 'supergroup'].includes(chatType)) return;

    // Ignore messages from other bots
    if (msg.from?.is_bot) return;

    const chatId = String(ctx.chat.id);
    const sender = msg.from;
    const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || 'Unknown';

    // Resolve text content (plain text or caption for media)
    const text = msg.text || msg.caption || null;
    if (!text) return; // skip stickers, pure media without caption, etc.

    const avatarUrl = await getAvatarUrl(sender.id);

    onMessage(chatId, senderName, avatarUrl, text, { messageId: msg.message_id });
  });

  bot.launch()
    .then(() => console.log('[telegram] Bot started.'))
    .catch(err => console.error('[telegram] Launch error:', err));

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

/**
 * Send a message to a Telegram group.
 *
 * @param {string} chatId
 * @param {string} senderName  Discord username shown as prefix
 * @param {string} text
 */
export async function sendToTelegram(chatId, senderName, text) {
  try {
    await bot.telegram.sendMessage(chatId, `[${senderName}]: ${text}`);
  } catch (err) {
    console.error(`[telegram] Failed to send message to ${chatId}:`, err.message);
  }
}
