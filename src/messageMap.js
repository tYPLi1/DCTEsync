/**
 * messageMap.js — Bidirectional in-memory message-ID mapping.
 *
 * Maps Telegram message IDs ↔ Discord message IDs, scoped per bridge pair.
 * Used by reply sync and reaction sync so each side can reference the
 * corresponding forwarded message on the other platform.
 *
 * The store is purely in-memory — it is intentionally NOT persisted.
 * After a restart, reactions/replies on pre-restart messages are simply
 * ignored (no crash, no incorrect targeting).
 *
 * Each pair's store is bounded to MAX_PER_PAIR entries.
 * When the limit is reached the oldest entry is evicted (FIFO).
 */

const MAX_PER_PAIR = 5000;

/**
 * Per-pair store:
 *   tgToDc : Map<string, string>   tgMsgId  → dcMsgId
 *   dcToTg : Map<string, string>   dcMsgId  → tgMsgId
 *   order  : string[]              insertion-ordered tgMsgIds for eviction
 */
const maps = new Map();

function getOrCreate(pairId) {
  if (!maps.has(pairId)) {
    maps.set(pairId, { tgToDc: new Map(), dcToTg: new Map(), order: [] });
  }
  return maps.get(pairId);
}

/**
 * Store a TG ↔ DC message-ID pair.
 *
 * @param {string} pairId   Bridge pair UUID
 * @param {number|string} tgMsgId   Telegram message_id
 * @param {string} dcMsgId          Discord message snowflake
 */
export function store(pairId, tgMsgId, dcMsgId) {
  if (!tgMsgId || !dcMsgId) return;
  const tg = String(tgMsgId);
  const dc = String(dcMsgId);
  const m  = getOrCreate(pairId);

  // Evict oldest entry when at capacity
  if (m.order.length >= MAX_PER_PAIR) {
    const oldest = m.order.shift();
    const oldDc  = m.tgToDc.get(oldest);
    m.tgToDc.delete(oldest);
    if (oldDc) m.dcToTg.delete(oldDc);
  }

  m.tgToDc.set(tg, dc);
  m.dcToTg.set(dc, tg);
  m.order.push(tg);
}

/**
 * Look up which Discord message ID corresponds to a Telegram message ID.
 *
 * @param {string} pairId
 * @param {number|string} tgMsgId
 * @returns {string|null}
 */
export function tgToDc(pairId, tgMsgId) {
  return maps.get(pairId)?.tgToDc.get(String(tgMsgId)) ?? null;
}

/**
 * Look up which Telegram message ID corresponds to a Discord message ID.
 *
 * @param {string} pairId
 * @param {string} dcMsgId
 * @returns {string|null}
 */
export function dcToTg(pairId, dcMsgId) {
  return maps.get(pairId)?.dcToTg.get(String(dcMsgId)) ?? null;
}

/**
 * Remove the mapping entry identified by its Discord message ID.
 * Cleans up both directions (tgToDc and dcToTg) and the order array.
 * Called when a Discord message is deleted so the mapping stays consistent.
 *
 * @param {string} pairId
 * @param {string} dcMsgId
 */
export function removeByDc(pairId, dcMsgId) {
  const m = maps.get(pairId);
  if (!m) return;
  const dc = String(dcMsgId);
  const tg = m.dcToTg.get(dc);
  if (tg) {
    m.tgToDc.delete(tg);
    m.order = m.order.filter(k => k !== tg);
  }
  m.dcToTg.delete(dc);
}

/**
 * Return the number of stored entries for a pair (for diagnostics).
 */
export function size(pairId) {
  return maps.get(pairId)?.order.length ?? 0;
}
