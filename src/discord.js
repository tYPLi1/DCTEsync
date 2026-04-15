import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import fetch from 'node-fetch';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) { console.error('[discord] DISCORD_TOKEN is not set. Exiting.'); process.exit(1); }

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ]
});

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Start the Discord bot.
 *
 * @param {(msg: object) => void} onMessage
 *   Called with { channelId, msgId, senderName, avatarUrl, text, attachments, roles, replyToMsgId }
 * @param {(reaction: object) => void} [onReaction]
 *   Called with { channelId, msgId, emoji, added: boolean }
 * @param {(del: object) => void} [onDelete]
 *   Called with { channelId, msgId }
 */
export function startDiscord(onMessage, onReaction, onDelete) {
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

    // Extract reply reference if this message is a reply
    const replyToMsgId = message.reference?.messageId ?? null;

    onMessage({
      channelId:   String(message.channel.id),
      msgId:       String(message.id),
      senderName:  message.member?.displayName || message.author.username,
      avatarUrl:   message.author.displayAvatarURL({ size: 128, extension: 'png' }),
      authorId:    String(message.author.id),
      text,
      attachments,
      roles,
      replyToMsgId
    });
  });

  // ── Reaction events ────────────────────────────────────────────────────────
  if (onReaction) {
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return;
      // Fetch partial reactions/messages if needed
      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch { return; }
      // Only forward standard Unicode emoji (not custom guild emoji)
      const emoji = reaction.emoji.id ? null : reaction.emoji.name;
      if (!emoji) return;
      onReaction({
        channelId: String(reaction.message.channelId),
        msgId:     String(reaction.message.id),
        emoji,
        added: true
      });
    });

    client.on(Events.MessageReactionRemove, async (reaction, user) => {
      if (user.bot) return;
      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch { return; }
      const emoji = reaction.emoji.id ? null : reaction.emoji.name;
      if (!emoji) return;
      onReaction({
        channelId: String(reaction.message.channelId),
        msgId:     String(reaction.message.id),
        emoji,
        added: false
      });
    });
  }

  // ── Delete events (DC → TG deletion sync) ─────────────────────────────────
  if (onDelete) {
    client.on(Events.MessageDelete, (message) => {
      onDelete({
        channelId: String(message.channelId),
        msgId:     String(message.id)
      });
    });
  }

  client.login(DISCORD_TOKEN).catch(err => {
    console.error('[discord] Login error:', err);
    process.exit(1);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Send a message to Discord via webhook.
 * Supports text-only and single file upload (with optional text).
 * Returns the Discord message ID (snowflake string) or null on error.
 *
 * When options.replyToMsgId AND options.channelId are both provided, the
 * message is sent via the bot client instead of the webhook so Discord's
 * native reply threading ("Replying to X") is shown correctly.
 * (Webhook executions do not support message_reference for reply threading.)
 *
 * @param {string} webhookUrl
 * @param {string} username        Display name
 * @param {string|null} avatarUrl
 * @param {string|null} text
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }|null} fileAttachment
 * @param {{ replyToMsgId?: string, channelId?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function sendToDiscord(webhookUrl, username, avatarUrl, text, fileAttachment = null, options = {}) {
  // Replies must go through the bot client — webhooks don't support threading
  if (options.replyToMsgId && options.channelId) {
    return await sendReply(options.channelId, username, text, options.replyToMsgId, fileAttachment);
  }
  try {
    if (fileAttachment) {
      return await sendWithFile(webhookUrl, username, avatarUrl, text, fileAttachment, options);
    } else {
      return await sendText(webhookUrl, username, avatarUrl, text, options);
    }
  } catch (err) {
    console.error('[discord] Webhook error:', err.message);
    return null;
  }
}

/**
 * Send a threaded reply via the Discord bot client.
 * Used when a TG→DC message is a reply — webhooks don't support reply threading.
 * The sender name is shown in bold at the start of the message content.
 *
 * @param {string} channelId
 * @param {string} username
 * @param {string|null} text
 * @param {string} replyToMsgId   Discord message snowflake to reply to
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }|null} fileAttachment
 * @returns {Promise<string|null>}
 */
async function sendReply(channelId, username, text, replyToMsgId, fileAttachment = null) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return null;
    const content = `**${username.slice(0, 80)}**${text ? `: ${text}` : ''}`;
    const opts    = { reply: { messageReference: replyToMsgId } };
    let msg;
    if (fileAttachment) {
      const att = new AttachmentBuilder(fileAttachment.buffer, { name: fileAttachment.fileName });
      msg = await channel.send({ ...opts, content, files: [att] });
    } else {
      msg = await channel.send({ ...opts, content });
    }
    return msg?.id ?? null;
  } catch (err) {
    console.error('[discord] sendReply error:', err.message);
    return null;
  }
}

async function sendText(webhookUrl, username, avatarUrl, text, options = {}) {
  if (!text) return null;
  const body = { username: username.slice(0, 80), content: text };
  if (avatarUrl) body.avatar_url = avatarUrl;
  if (options.replyToMsgId) {
    body.message_reference = { message_id: options.replyToMsgId };
  }

  // ?wait=true makes Discord return the created Message object (including its ID)
  const res = await fetch(webhookUrl + '?wait=true', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    console.error(`[discord] Webhook text error ${res.status}:`, await res.text());
    return null;
  }
  const data = await res.json();
  return data.id ?? null;
}

/**
 * Add an emoji reaction to a Discord message using the bot client.
 * Used to mirror Telegram reactions onto the corresponding Discord message.
 *
 * @param {string} channelId
 * @param {string} messageId   Discord message snowflake
 * @param {string} emoji       Unicode emoji string (e.g. "👍")
 */
export async function reactOnDiscord(channelId, messageId, emoji) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const msg = await channel.messages.fetch(messageId);
    await msg.react(emoji);
  } catch (err) {
    console.error(`[discord] reactOnDiscord error (${channelId}/${messageId} ${emoji}):`, err.message);
  }
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

async function sendWithFile(webhookUrl, username, avatarUrl, text, { buffer, mimeType, fileName }, options = {}) {
  const payload = { username: username.slice(0, 80), content: text || '' };
  if (avatarUrl) payload.avatar_url = avatarUrl;
  if (options.replyToMsgId) {
    payload.message_reference = { message_id: options.replyToMsgId };
  }

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([buffer], { type: mimeType }), fileName);

  // ?wait=true so we get the message ID back
  const res = await fetch(webhookUrl + '?wait=true', { method: 'POST', body: form });
  if (!res.ok) {
    console.error(`[discord] Webhook file error ${res.status}:`, await res.text());
    return null;
  }
  const data = await res.json();
  return data.id ?? null;
}
