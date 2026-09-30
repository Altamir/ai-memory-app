import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Leitura read-only dos sqlite do Grok/Kiro (via CLI do sistema, como ps/lsof
// em host-sessions). `mode=ro` + `-readonly` para nunca criar -shm/-wal nem
// tocar em banco aberto por outro processo.

export async function sqliteJsonQuery(dbFile, sql, { timeoutMs = 30_000 } = {}) {
  const uri = `file:${String(dbFile).replace(/[?#'\s]/g, encodeURIComponent)}?mode=ro`;
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', uri, sql], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  return JSON.parse(text);
}

export async function sqliteAvailable() {
  try {
    await execFileAsync('sqlite3', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
