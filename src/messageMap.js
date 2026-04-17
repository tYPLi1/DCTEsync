/**
 * messageMap.js — Bidirectional in-memory message-ID mapping.
 *
 * Maps Telegram message IDs ↔ Discord message IDs, scoped per bridge pair.
 * Used by reply sync and reaction sync so each side can reference the
 * corresponding forwarded message on the other platform.
 *
 * The in-memory store is bounded to msgMapLimit per pair (default 200).
 * bridge.js persists the store to disk (debounced) and loads it on startup
 * so mappings survive restarts.
 */

const DEFAULT_LIMIT = 200;

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
 * @param {string} pairId
 * @param {number|string} tgMsgId
 * @param {string} dcMsgId
 * @param {number} [limit]  Max entries to keep (default 200, max enforced by caller)
 */
export function store(pairId, tgMsgId, dcMsgId, limit = DEFAULT_LIMIT) {
  if (!tgMsgId || !dcMsgId) return;
  const tg = String(tgMsgId);
  const dc = String(dcMsgId);
  const m  = getOrCreate(pairId);

  // Evict oldest entries until we are below the limit
  while (m.order.length >= limit) {
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
 * Populate a pair's store from persisted entries (called once on startup).
 * Entries are [ { tg, dc }, … ] ordered oldest → newest.
 *
 * @param {string} pairId
 * @param {Array<{tg:string, dc:string}>} entries
 * @param {number} [limit]
 */
export function loadPersisted(pairId, entries, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(entries) || !entries.length) return;
  // Take only the last `limit` entries to respect the current limit even if
  // the persisted file was written with a higher limit.
  const slice = entries.slice(-limit);
  for (const { tg, dc } of slice) {
    if (tg && dc) store(pairId, tg, dc, limit);
  }
}

/**
 * Export all stored entries for a pair as an ordered array (oldest → newest).
 * Used by bridge.js to persist the map to disk.
 *
 * @param {string} pairId
 * @returns {Array<{tg:string, dc:string}>}
 */
export function getAll(pairId) {
  const m = maps.get(pairId);
  if (!m) return [];
  return m.order.map(tg => ({ tg, dc: m.tgToDc.get(tg) }));
}

export function tgToDc(pairId, tgMsgId) {
  return maps.get(pairId)?.tgToDc.get(String(tgMsgId)) ?? null;
}

export function dcToTg(pairId, dcMsgId) {
  return maps.get(pairId)?.dcToTg.get(String(dcMsgId)) ?? null;
}

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

export function size(pairId) {
  return maps.get(pairId)?.order.length ?? 0;
}
