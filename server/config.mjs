import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  port: Number(process.env.AIM_APP_PORT || 4790),
  host: process.env.AIM_APP_HOST || '127.0.0.1',
  bin: process.env.AI_MEMORY_BIN || path.join(home, '.local', 'bin', 'ai-memory'),
  dataDir: process.env.AI_MEMORY_DATA_DIR || path.join(home, 'Library', 'Application Support', 'ai-memory'),
  serverUrl: (process.env.AI_MEMORY_SERVER_URL || 'http://127.0.0.1:49374').replace(/\/+$/, ''),
  grokDir: process.env.AIM_IMPORT_GROK_DIR || path.join(home, '.grok'),
  kiroDir: process.env.AIM_IMPORT_KIRO_DIR || path.join(home, '.kiro'),
  jobHistoryLimit: 30,
  jobLineLimit: 5000,
  sessionBufferLimit: 200_000,
};

export function expandTilde(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
