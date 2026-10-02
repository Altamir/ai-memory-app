import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, expandTilde } from './config.mjs';
import { runCli, stderrMessage } from './cli.mjs';

// Reescreve a entrada MCP do ai-memory nos harnesses para apontarem ao servidor
// conectado no painel. A escrita NÃO é feita aqui: o painel delega ao
// `ai-memory install-mcp --apply`, que já conhece o formato de cada cliente,
// é idempotente, preserva os outros servidores do usuário e grava um backup
// antes de tocar no arquivo. Reescrever JSON/TOML por conta própria seria
// duplicar esse conhecimento e o risco de estragar a config de uma ferramenta.

const HOME = os.homedir();

// Clientes que o `install-mcp` aceita. O `configFile` é o caminho padrão que a
// CLI usa; quando null, a CLI resolve sozinha (shim, config de projeto) e o
// painel só mostra o que ela resolver.
// `hooks`: o harness aceita `install-hooks --agent <id>` — é o que captura o
// trabalho e vincula o projeto no primeiro capture. Alguns são MCP-only.
const HOOK_AGENTS = new Set([
  'claude-code', 'codex', 'cursor', 'gemini-cli', 'open-code', 'opencode2', 'pi',
  'omp', 'openclaw', 'antigravity-cli', 'grok', 'zero', 'devin', 'kimi-code',
  'kiro-cli', 'command-code', 'pool', 'zcode', 'hermes',
]);

const CLIENTS = [
  { id: 'claude-code', label: 'Claude Code', configFile: '~/.claude.json', hooks: true },
  { id: 'codex', label: 'Codex CLI', configFile: '~/.codex/config.toml', hooks: true },
  { id: 'open-code', label: 'OpenCode', configFile: '~/.config/opencode/opencode.json', hooks: true },
  { id: 'opencode2', label: 'OpenCode 2', configFile: '~/.config/opencode/opencode.json', hooks: true },
  { id: 'cursor', label: 'Cursor', configFile: '~/.cursor/mcp.json', hooks: true },
  { id: 'claude-desktop', label: 'Claude Desktop', configFile: null, hooks: false },
  { id: 'gemini-cli', label: 'Gemini CLI', configFile: '~/.gemini/settings.json', hooks: true },
  { id: 'openclaw', label: 'OpenClaw', configFile: '~/.openclaw/config.json', hooks: true },
  { id: 'pi', label: 'Pi', configFile: '~/.pi/agent/mcp.json', hooks: true },
  { id: 'omp', label: 'Oh My Pi', configFile: '~/.omp/agent/mcp.json', hooks: true },
  { id: 'antigravity-cli', label: 'Antigravity CLI', configFile: '~/.gemini/config/mcp_config.json', hooks: true },
  { id: 'zero', label: 'Zero', configFile: '~/.config/zero/config.json', hooks: true },
  { id: 'zcode', label: 'ZCode', configFile: '~/.zcode/cli/config.json', hooks: true },
  { id: 'devin', label: 'Devin', configFile: '~/.devin/config.json', hooks: true },
  { id: 'grok', label: 'Grok', configFile: '~/.grok/config.toml', hooks: true },
  { id: 'kimi-code', label: 'Kimi Code', configFile: '~/.kimi-code/mcp.json', hooks: true },
  { id: 'kiro-cli', label: 'Kiro', configFile: '~/.kiro/settings/mcp.json', hooks: true },
  { id: 'command-code', label: 'Command Code', configFile: '~/.commandcode/mcp.json', hooks: true },
  { id: 'swival', label: 'Swival', configFile: null, hooks: false },
  { id: 'vscode-copilot', label: 'VS Code Copilot', configFile: null, hooks: false },
  { id: 'zed', label: 'Zed', configFile: '~/.config/zed/settings.json', hooks: false },
  { id: 'muse', label: 'Muse', configFile: '~/.config/muse/settings.json', hooks: false },
];

for (const c of CLIENTS) {
  if (c.hooks && !HOOK_AGENTS.has(c.id)) c.hooks = false; // defesa: a CLI valida
}

const byId = new Map(CLIENTS.map((c) => [c.id, c]));

function resolveConfigFile(client) {
  return client.configFile ? expandTilde(client.configFile) : null;
}

/**
 * A entrada ai-memory no arquivo do harness aponta para onde agora?
 * Só o suficiente para dizer "instalado / apontando para X / config ausente" —
 * sem devolver o token, que mora no mesmo arquivo.
 */
function inspectEntry(file) {
  if (!file || !fs.existsSync(file)) return { configExists: false, registered: false, url: null };
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { configExists: false, registered: false, url: null, unreadable: true };
  }
  // json e jsonc cobrem a maioria; toml entra por um casca grossa de aspas
  let url = null;
  if (/\.(json|jsonc)$/i.test(file)) {
    try {
      // jsonc: tira comentários de linha para o parse não explodir
      const cleaned = raw.replace(/^\s*\/\/.*$/gm, '');
      const data = JSON.parse(cleaned);
      url = findAiMemoryUrl(data);
    } catch {
      url = null;
    }
  } else {
    const m = raw.match(/\[mcp_servers\.ai-memory\][\s\S]{0,400}?url\s*=\s*"([^"]+)"/)
      || raw.match(/"ai-memory"[\s\S]{0,300}?url\s*=\s*"([^"]+)"/);
    url = m ? m[1] : null;
  }
  const registered = /"ai-memory"|\[mcp_servers\.ai-memory\]/.test(raw) || url !== null;
  return { configExists: true, registered, url };
}

/**
 * URL DA ENTRADA ai-memory — nunca a de outro servidor. Uma busca por "qualquer
 * url" acha o MCP que vem antes no arquivo (o context7 do OpenCode, o sbrain do
 * ZCode) e faz o painel mentir sobre para onde o harness aponta.
 */
function findAiMemoryUrl(node, depth = 0) {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'ai-memory' || k === 'ai_memory') && v && typeof v === 'object' && typeof v.url === 'string') {
      return v.url;
    }
    if (k === 'ai-memory' && typeof v === 'string') return v; // forma "name: url"
    const found = findAiMemoryUrl(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Compara URLs ignorando query de flavor e barra final. */
function sameEndpoint(a, b) {
  const strip = (u) => {
    try {
      const url = new URL(String(u));
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      return String(u).replace(/\/+$/, '');
    }
  };
  return strip(a) === strip(b);
}

/** Estado de todos os harnesses em relação ao servidor conectado. */
export async function listHarnessMcp() {
  const current = config.serverUrl;
  return CLIENTS.map((c) => {
    const file = resolveConfigFile(c);
    const info = inspectEntry(file);
    const mcpUrl = `${current}/mcp`;
    return {
      id: c.id,
      label: c.label,
      configFile: file,
      configExists: info.configExists,
      registered: info.registered,
      currentUrl: info.url,
      hooksSupported: Boolean(c.hooks),
      // aligned: já aponta para o servidor conectado (ou ainda não está instalado)
      aligned: !info.registered || sameEndpoint(info.url, mcpUrl),
      note: info.unreadable ? 'config ilegível' : null,
    };
  });
}

/**
 * Preview de um cliente: o snippet que a CLI geraria, sem escrever nada.
 * O snippet traz o token em texto puro — é o mesmo que a CLI imprime de saída
 * — então a tela mostra a URL e o cliente, nunca o token.
 */
export async function previewHarnessMcp(id) {
  const client = byId.get(String(id));
  if (!client) throw new Error(`harness desconhecido: ${id}`);
  const res = await runCli(['install-mcp', '--client', client.id], { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(stderrMessage(res));
  const snippet = res.stdout.trim();
  return {
    id: client.id,
    label: client.label,
    configFile: resolveConfigFile(client),
    snippet,
    hasAuth: /Authorization/i.test(snippet),
  };
}

/**
 * Aplica a entrada no harness indicado, apontando para o servidor conectado.
 * `AI_MEMORY_SERVER_URL`/`AI_MEMORY_AUTH_TOKEN` vêm do perfil ativo, então o
 * snippet nasce já com o destino e o token certos.
 */
export async function applyHarnessMcp(id) {
  const client = byId.get(String(id));
  if (!client) throw new Error(`harness desconhecido: ${id}`);

  const file = resolveConfigFile(client);
  const before = inspectEntry(file);
  const args = ['install-mcp', '--client', client.id, '--apply'];
  if (file) args.push('--config-file', file);

  const res = await runCli(args, { timeoutMs: 60_000 });
  if (res.code !== 0) {
    return {
      id: client.id,
      label: client.label,
      ok: false,
      error: stderrMessage(res),
      configFile: file,
      was: before.url,
      now: null,
    };
  }

  const after = inspectEntry(file);
  return {
    id: client.id,
    label: client.label,
    ok: true,
    configFile: file,
    was: before.url,
    now: after.url,
    // a CLI só grava o que ela conhece; conferir evita dizer "feito" à toa
    verified: after.registered,
    created: !before.configExists,
  };
}

/** Aplica em vários de uma vez, aggregating falhas sem abortar o resto. */
export async function applyHarnessMcpMany(ids = []) {
  const out = [];
  for (const id of ids.slice(0, 50)) {
    try {
      out.push(await applyHarnessMcp(id));
    } catch (err) {
      out.push({ id, ok: false, error: err.message });
    }
  }
  return out;
}

export const HARNESS_MCP_CLIENTS = CLIENTS.map((c) => c.id);
