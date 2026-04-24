import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR  = process.env.LOG_DIR || './data';
const LOG_FILE = join(LOG_DIR, 'bridge.log');

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function getLogPath() {
  return LOG_FILE;
}

export function readLogs(lines = 1000) {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const content = readFileSync(LOG_FILE, 'utf-8');
    const all = content.split('\n').filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function clearLogs() {
  try {
    ensureDir();
    writeFileSync(LOG_FILE, '');
  } catch {}
}
