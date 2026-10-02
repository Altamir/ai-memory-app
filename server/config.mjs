import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Campos de conexão são mutáveis em runtime: ativar um servidor cadastrado
// (server/servers.mjs) reescreve estes no objeto e o painel inteiro passa a
// falar com o destino escolhido, sem reiniciar o processo. O resto do config
// (dirs do painel, limites) é fixo por processo.

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  port: Number(process.env.AIM_APP_PORT || 4790),
  host: process.env.AIM_APP_HOST || '127.0.0.1',
  bin: process.env.AI_MEMORY_BIN || path.join(home, '.local', 'bin', 'ai-memory'),
  dataDir: process.env.AI_MEMORY_DATA_DIR || path.join(home, 'Library', 'Application Support', 'ai-memory'),
  serverUrl: (process.env.AI_MEMORY_SERVER_URL || 'http://127.0.0.1:49374').replace(/\/+$/, ''),
  // token do perfil ativo; null = cair no AI_MEMORY_AUTH_TOKEN / <data-dir>/auth-token
  token: process.env.AI_MEMORY_AUTH_TOKEN || null,
  // true enquanto o perfil ativo é o do ambiente: é o que permite ao MCP usar o
  // AI_MEMORY_AUTH_TOKEN do processo. Com outro perfil ativo, o env pertence ao
  // boot e não pode vazar para o destino novo (mesma regra do cliEnv).
  activeIsEnv: true,
  // volume do servidor ai-memory (wiki + db). O painel lê daqui para exportar;
  // no Docker é o bind de `AI_MEMORY_DATA_DIR` do compose.
  storeDir: process.env.AIM_STORE_DIR || path.join(home, '.ai-memory-data', 'ai-memory'),
  exportsDir: process.env.AIM_APP_EXPORT_DIR || path.join(root, 'exports'),
  // coleção de skills dona do painel (gestor de skills) e onde os bundles de
  // skills são gravados/lidos
  skillsDir: process.env.AIM_APP_SKILLS_DIR || path.join(home, '.ai-memory-app', 'skills'),
  skillsExportsDir: process.env.AIM_APP_SKILLS_EXPORT_DIR || path.join(root, 'exports', 'skills'),
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
