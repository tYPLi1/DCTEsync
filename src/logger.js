import { appendFileSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const LOG_DIR  = process.env.LOG_DIR || './data';
const LOG_FILE = join(LOG_DIR, 'bridge.log');
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB — auto-truncate older half

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function rotateIfNeeded() {
  try {
    const { size } = statSync(LOG_FILE);
    if (size > MAX_SIZE) {
      const content = readFileSync(LOG_FILE, 'utf-8');
      const half = content.slice(content.length / 2);
      const firstNewline = half.indexOf('\n');
      writeFileSync(LOG_FILE, firstNewline >= 0 ? half.slice(firstNewline + 1) : half);
    }
  } catch {}
}

function writeLine(level, args) {
  try {
    ensureDir();
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    appendFileSync(LOG_FILE, `${timestamp()} [${level}] ${msg}\n`);
    rotateIfNeeded();
  } catch {}
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log   = (...args) => { _origLog(...args);   writeLine('INFO',  args); };
console.warn  = (...args) => { _origWarn(...args);   writeLine('WARN',  args); };
console.error = (...args) => { _origError(...args);  writeLine('ERROR', args); };

export function getLogPath() {
  return LOG_FILE;
}

export function readLogs(lines = 200) {
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
