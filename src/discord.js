import { Client, GatewayIntentBits, Events } from 'discord.js';
import fetch from 'node-fetch';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error('[discord] DISCORD_TOKEN is not set. Exiting.');
  process.exit(1);
}

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/**
 * Start the Discord bot and register the message handler.
 *
 * @param {(channelId: string, senderName: string, avatarUrl: string|null, text: string) => void} onMessage
 */
export function startDiscord(onMessage) {
  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] Logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, (message) => {
    // Ignore all bots (including webhook messages forwarded from Telegram)
    if (message.author.bot) return;

    // Only handle guild (server) messages
    if (!message.guild) return;

    const text = message.content;
    if (!text) return;

    const channelId = String(message.channel.id);
    const senderName = message.member?.displayName || message.author.username;
    const avatarUrl = message.author.displayAvatarURL({ size: 128, extension: 'png' });

    onMessage(channelId, senderName, avatarUrl, text);
  });

  client.login(DISCORD_TOKEN).catch(err => {
    console.error('[discord] Login error:', err);
    process.exit(1);
  });
}

/**
 * Send a message to Discord via webhook, impersonating a Telegram user.
 *
 * @param {string} webhookUrl
 * @param {string} username      Display name (Telegram first name)
 * @param {string|null} avatarUrl Telegram profile picture URL
 * @param {string} text
 */
export async function sendToDiscord(webhookUrl, username, avatarUrl, text) {
  const body = {
    username: username.slice(0, 80),  // Discord limit: 80 chars
    content: text
  };

  if (avatarUrl) body.avatar_url = avatarUrl;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[discord] Webhook error ${res.status}:`, errText);
    }
  } catch (err) {
    console.error('[discord] Failed to send via webhook:', err.message);
  }
}
