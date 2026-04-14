/**
 * media.js — shared download helpers and MIME utilities.
 */

import fetch from 'node-fetch';

export const DISCORD_MAX_BYTES  = 25 * 1024 * 1024; // 25 MB — Discord webhook limit
export const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024; // 20 MB — Telegram bot API getFile limit

/**
 * Download a URL to a Buffer.
 * Returns null if the download fails or the file exceeds maxBytes.
 *
 * @param {string} url
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
export async function downloadUrl(url, maxBytes = DISCORD_MAX_BYTES) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > maxBytes) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length <= maxBytes ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Guess MIME type from a filename extension.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function guessMime(fileName = '') {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
    pdf: 'application/pdf', zip: 'application/zip',
    txt: 'text/plain', json: 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Classify a MIME type into:
 *  - method:   Telegram send method name
 *  - category: broad category for mediaSync config ('image', 'video', 'audio', 'document')
 *
 * @param {string|null} mimeType
 * @param {string} fileName
 * @returns {{ method: string, category: string }}
 */
export function classifyMime(mimeType, fileName = '') {
  const mime = mimeType || guessMime(fileName);
  const [type, sub] = mime.split('/');

  if (type === 'image' && sub !== 'gif') return { method: 'sendPhoto',     category: 'image' };
  if (mime === 'image/gif')              return { method: 'sendAnimation',  category: 'video' };
  if (type === 'video')                  return { method: 'sendVideo',      category: 'video' };
  if (mime === 'audio/ogg' || mime === 'audio/oga') return { method: 'sendVoice', category: 'audio' };
  if (type === 'audio')                  return { method: 'sendAudio',      category: 'audio' };
  return                                        { method: 'sendDocument',   category: 'document' };
}
