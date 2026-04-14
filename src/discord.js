import { Client, GatewayIntentBits, Events } from 'discord.js';
import fetch from 'node-fetch';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) { console.error('[discord] DISCORD_TOKEN is not set. Exiting.'); process.exit(1); }

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Start the Discord bot.
 *
 * @param {(msg: object) => void} onMessage
 *   Called with { channelId, senderName, avatarUrl, text, attachments }
 *   attachments: Array<{ url, name, contentType, size }>
 */
export function startDiscord(onMessage) {
  client.once(Events.ClientReady, c => {
    console.log(`[discord] Logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, message => {
    if (message.author.bot) return; // ignore bots and webhook messages
    if (!message.guild) return;     // ignore DMs — guild messages only

    const text        = message.content || null;
    const attachments = [...message.attachments.values()].map(a => ({
      url:         a.url,
      name:        a.name,
      contentType: a.contentType ?? null,
      size:        a.size
    }));

    if (!text && attachments.length === 0) return;

    // Collect the member's roles (exclude @everyone, sort by position desc)
    const roles = message.member?.roles.cache
      .filter(r => r.id !== message.guild.id)
      .map(r => ({ id: r.id, name: r.name }))
      .sort((a, b) => {
        const ra = message.guild.roles.cache.get(a.id);
        const rb = message.guild.roles.cache.get(b.id);
        return (rb?.position ?? 0) - (ra?.position ?? 0);
      }) ?? [];

    onMessage({
      channelId:   String(message.channel.id),
      senderName:  message.member?.displayName || message.author.username,
      avatarUrl:   message.author.displayAvatarURL({ size: 128, extension: 'png' }),
      text,
      attachments,
      roles
    });
  });

  client.login(DISCORD_TOKEN).catch(err => {
    console.error('[discord] Login error:', err);
    process.exit(1);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Send a message to Discord via webhook.
 * Supports text-only and single file upload (with optional text).
 *
 * @param {string} webhookUrl
 * @param {string} username        Display name
 * @param {string|null} avatarUrl
 * @param {string|null} text
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }|null} fileAttachment
 */
export async function sendToDiscord(webhookUrl, username, avatarUrl, text, fileAttachment = null) {
  try {
    if (fileAttachment) {
      await sendWithFile(webhookUrl, username, avatarUrl, text, fileAttachment);
    } else {
      await sendText(webhookUrl, username, avatarUrl, text);
    }
  } catch (err) {
    console.error('[discord] Webhook error:', err.message);
  }
}

async function sendText(webhookUrl, username, avatarUrl, text) {
  if (!text) return;
  const body = { username: username.slice(0, 80), content: text };
  if (avatarUrl) body.avatar_url = avatarUrl;

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!res.ok) console.error(`[discord] Webhook text error ${res.status}:`, await res.text());
}

/**
 * Return all non-managed, non-everyone roles for the guild that owns channelId.
 * Sorted by position descending (highest-ranked role first).
 *
 * @param {string} channelId
 * @returns {Promise<Array<{id:string, name:string, color:string}>>}
 */
export async function getGuildRoles(channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.guild) return [];
    await channel.guild.roles.fetch();
    return channel.guild.roles.cache
      .filter(r => r.id !== channel.guild.id && !r.managed)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
      .sort((a, b) => {
        const ra = channel.guild.roles.cache.get(a.id);
        const rb = channel.guild.roles.cache.get(b.id);
        return (rb?.position ?? 0) - (ra?.position ?? 0);
      });
  } catch (err) {
    console.error('[discord] getGuildRoles error:', err.message);
    return [];
  }
}

async function sendWithFile(webhookUrl, username, avatarUrl, text, { buffer, mimeType, fileName }) {
  const payload = { username: username.slice(0, 80), content: text || '' };
  if (avatarUrl) payload.avatar_url = avatarUrl;

  // FormData is available globally in Node 18+
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([buffer], { type: mimeType }), fileName);

  const res = await fetch(webhookUrl, { method: 'POST', body: form });
  if (!res.ok) console.error(`[discord] Webhook file error ${res.status}:`, await res.text());
}
