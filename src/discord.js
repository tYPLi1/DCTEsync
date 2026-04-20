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
    if (message.webhookId) return;  // ignore our own bridge webhooks (prevents loops)
    if (!message.guild) return;     // ignore DMs — guild messages only

    const mapAttachment = (a, idx = 0) => {
      if (!a) return null;
      return {
        url:         a.url ?? null,
        name:        a.name ?? a.filename ?? `attachment-${idx + 1}`,
        contentType: a.contentType ?? null,
        size:        a.size ?? null
      };
    };

    const toAttachmentList = (raw) => {
      if (!raw) return [];
      if (typeof raw.values === 'function') return [...raw.values()];
      if (Array.isArray(raw)) return raw;
      return [];
    };

    let text        = message.content || null;
    let attachments = toAttachmentList(message.attachments)
      .map((a, idx) => mapAttachment(a, idx))
      .filter(a => a?.url);

    if (!text && attachments.length === 0) {
      const snapshots = message.messageSnapshots;
      const snapshot = snapshots && typeof snapshots.first === 'function'
        ? snapshots.first()
        : null;
      const snapMsg  = snapshot?.message;
      if (snapMsg) {
        const snapAttachments = toAttachmentList(snapMsg.attachments);

        const snapText = snapMsg.content || null;
        const mappedSnapAttachments = snapAttachments
          .map((a, idx) => mapAttachment(a, idx))
          .filter(a => a?.url);
        if (snapText || mappedSnapAttachments.length > 0) {
          text = snapText ? `[⤴ Weitergeleitet]\n${snapText}` : '[⤴ Weitergeleitet]';
          attachments = mappedSnapAttachments;
        }
      }
    }

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
      channelId:      String(message.channel.id),
      msgId:          String(message.id),
      senderName:     message.member?.displayName || message.author.username,
      avatarUrl:      message.author.displayAvatarURL({ size: 128, extension: 'png' }),
      authorId:       String(message.author.id),
      authorUsername: message.author.username,
      isBot:          message.author.bot,
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
 * When options.replyToMsgId is set, Discord reply threading is used via
 * message_reference so the sender name is always the real person's name.
 * Returns the Discord message ID (snowflake string) or null on error.
 *
 * @param {string} webhookUrl
 * @param {string} username        Display name
 * @param {string|null} avatarUrl
 * @param {string|null} text
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }|null} fileAttachment
 * @param {{ replyToMsgId?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function sendToDiscord(webhookUrl, username, avatarUrl, text, fileAttachment = null, options = {}) {
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


async function sendText(webhookUrl, username, avatarUrl, text, options = {}) {
  if (!text) return null;
  const body = { username: username.slice(0, 80), content: text };
  if (avatarUrl) body.avatar_url = avatarUrl;
  if (options.replyToMsgId) body.message_reference = { message_id: options.replyToMsgId };

  // ?wait=true makes Discord return the created Message object (including its ID)
  let res = await fetch(webhookUrl + '?wait=true', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  // If reply threading failed (e.g. referenced message deleted), retry without it
  if (!res.ok && res.status === 400 && body.message_reference) {
    delete body.message_reference;
    res = await fetch(webhookUrl + '?wait=true', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
  }

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
  if (options.replyToMsgId) payload.message_reference = { message_id: options.replyToMsgId };

  const buildForm = (p) => {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(p));
    form.append('files[0]', new Blob([buffer], { type: mimeType }), fileName);
    return form;
  };

  // ?wait=true so we get the message ID back
  let res = await fetch(webhookUrl + '?wait=true', { method: 'POST', body: buildForm(payload) });

  // If reply threading failed (e.g. referenced message deleted), retry without it
  if (!res.ok && res.status === 400 && payload.message_reference) {
    delete payload.message_reference;
    res = await fetch(webhookUrl + '?wait=true', { method: 'POST', body: buildForm(payload) });
  }

  if (!res.ok) {
    console.error(`[discord] Webhook file error ${res.status}:`, await res.text());
    return null;
  }
  const data = await res.json();
  return data.id ?? null;
}
