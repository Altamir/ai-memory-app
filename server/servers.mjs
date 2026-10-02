import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { callTool } from './mcp.mjs';
import { runCliJson } from './cli.mjs';

// Perfis de servidor do ai-memory: cada um aponta para um servidor (URL), um
// binário de CLI e um data-dir de cliente — de onde sai o auth-token daquele
// servidor. Ativar um perfil reescreve config.bin/dataDir/serverUrl, e o
// painel inteiro (leituras MCP, jobs da CLI, run, export) passa a falar com o
// destino escolhido, sem reiniciar o processo.
//
// Tokens: o padrão é o `<data-dir>/auth-token` de cada servidor (a mesma fonte
// da CLI, nada novo em disco). Um token digitado na tela é opcional e fica
// gravado no `.servers.json` — arquivo de credenciais, mode 0600, fora do git.

const LOCAL_ID = 'local';

const serversFile = () => process.env.AIM_APP_SERVERS_FILE || path.join(config.root, '.servers.json');

// Foto do ambiente como o processo subiu. `config` é reescrito a cada ativação,
// então guardar aqui é o que permite voltar ao perfil do ambiente sem perder o
// binário/data-dir/token originais — e é o que sobra quando o usuário apaga o
// último servidor cadastrado.
//
// ATENÇÃO: um `.servers.json` com `active` gravado tem precedência sobre o env
// do processo — é o comportamento pedido (o perfil escolhido sobrevive a
// restart), mas significa que um arquivo no root do repo redireciona o painel
// todo. Por isso AIM_APP_SERVERS_FILE existe: quem configura o painel por env
// (testes, painel em porta isolada) aponta o arquivo dele e o env volta a valer.
const BOOT = {
  url: config.serverUrl,
  bin: config.bin,
  dataDir: config.dataDir,
  token: config.token || null,
};

// O servidor do ambiente também é uma entrada da lista, e pode ser removida como
// qualquer outra. Só que ele é derivado do env, não cadastrado: quando some da
// lista, o destino implícito do painel continua sendo ele. É o que garante que
// não exista um estado "sem servidor nenhum" — o painel sempre tem para onde falar.
function envProfile() {
  return {
    id: LOCAL_ID,
    name: 'Servidor do ambiente',
    url: BOOT.url,
    bin: BOOT.bin,
    dataDir: BOOT.dataDir,
    token: BOOT.token,
    env: true,
    builtin: true,
  };
}

/** O ambiente está escondido da lista (foi removido) mas segue como destino. */
function envHidden(state) {
  return state.hideEnv === true;
}

function sanitize(raw, { fallback = envProfile() } = {}) {
  const url = String(raw?.url ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('url do servidor é obrigatória');
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`url de servidor inválida: ${url.slice(0, 120)}`);
  const out = {
    id: String(raw.id || randomUUID()),
    name: String(raw.name || '').trim().slice(0, 80) || url,
    url,
    bin: String(raw.bin || '').trim().slice(0, 500) || fallback.bin,
    dataDir: String(raw.dataDir || '').trim().slice(0, 500) || fallback.dataDir,
    env: false,
    builtin: false,
  };
  // token ausente = "manter o que está gravado" (a edição não pode apagar um
  // token que funciona só porque o usuário mudou o nome); '' = limpar de propósito
  if (raw.token !== undefined) out.token = String(raw.token ?? '').trim().slice(0, 500) || null;
  return out;
}

function load() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(serversFile(), 'utf8'));
  } catch {
    return { version: 1, active: LOCAL_ID, hideEnv: false, servers: [] };
  }
  const list = Array.isArray(parsed?.servers) ? parsed.servers : [];
  return {
    version: 1,
    active: typeof parsed?.active === 'string' ? parsed.active : LOCAL_ID,
    hideEnv: parsed?.hideEnv === true,
    servers: list.filter((s) => s && typeof s === 'object').map((s) => sanitize(s)),
  };
}

function save(state) {
  const file = serversFile();
  const tmp = `${file}.tmp`;
  // 0600: é a lista de destinos credenciados da máquina e pode conter tokens
  // digitados na tela (opcionais — o padrão é o auth-token do data-dir). Por
  // isso está fora do git.
  fs.writeFileSync(tmp, JSON.stringify({
    version: 1,
    active: state.active,
    hideEnv: state.hideEnv === true,
    servers: state.servers,
  }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // FS sem suporte a chmod (ex.: volume de rede): segue com o modo do umask
  }
}

let state = load();

/** Perfis visíveis: o de ambiente (salvo se foi removido) mais os cadastrados. */
function profiles() {
  const list = envHidden(state) ? [...state.servers] : [envProfile(), ...state.servers];
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    bin: p.bin,
    dataDir: p.dataDir,
    // nunca devolve o token: a tela só precisa saber se ele existe
    hasToken: Boolean(p.token) || tokenInDataDir(p),
    env: Boolean(p.env),
    builtin: Boolean(p.builtin),
  }));
}

/** True se o data-dir do perfil tem auth-token (mesma fonte da CLI). */
function tokenInDataDir(profile) {
  if (!profile?.dataDir) return false;
  try {
    return Boolean(fs.readFileSync(path.join(profile.dataDir, 'auth-token'), 'utf8').trim());
  } catch {
    return false;
  }
}

function findProfile(id) {
  if (id === LOCAL_ID) return envProfile();
  return state.servers.find((s) => s.id === id) || null;
}

/** Token efetivo do perfil: o do cadastro, senão o do <data-dir>/auth-token. */
function tokenFor(profile) {
  if (profile?.token) return profile.token;
  if (!profile?.dataDir) return null;
  try {
    return fs.readFileSync(path.join(profile.dataDir, 'auth-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function applyProfile(profile) {
  config.serverUrl = profile.url;
  config.bin = profile.bin;
  config.dataDir = profile.dataDir;
  config.token = profile.token || null;
  // o env do processo só é fonte de token para o perfil do ambiente — com
  // outro perfil ativo, o env pertence ao boot e vazaría para o destino novo
  config.activeIsEnv = Boolean(profile.env);
}

/** Reaplica o perfil ativo no config (chamado no boot do painel). */
export function initActiveServer() {
  const active = findProfile(state.active) || envProfile();
  state.active = active.id;
  applyProfile(active);
  return describe(active).active;
}

function describe(profile) {
  const token = tokenFor(profile);
  return {
    active: {
      id: profile.id,
      name: profile.name,
      url: profile.url,
      bin: profile.bin,
      dataDir: profile.dataDir,
      hasToken: Boolean(token),
      env: Boolean(profile.env),
      builtin: Boolean(profile.builtin),
      // ativo é o ambiente que o usuário removeu da lista: a tela diz isso em vez
      // de mostrar um servidor que não está mais lá
      hidden: Boolean(profile.env && envHidden(state)),
    },
    servers: profiles(),
  };
}

export function listServers() {
  return describe(findProfile(state.active) || envProfile());
}

export function getActiveServer() {
  return describe(findProfile(state.active) || envProfile()).active;
}

/**
 * O store em disco (AIM_STORE_DIR) é o volume do servidor do ambiente. Quando
 * o painel está conectado em outro ai-memory, esse diretório não descreve o
 * destino e não pode ser usado como fallback de leitura.
 */
export function isEnvServerActive() {
  return state.active === LOCAL_ID;
}

export function saveServer(input) {
  // o perfil do ambiente não é uma entrada da lista: ele é derivado do processo,
  // então "editar" ele não tem onde gravar
  if (String(input?.id || '') === LOCAL_ID) throw new Error('o perfil do ambiente não pode ser editado');
  const draft = sanitize(input);
  const i = state.servers.findIndex((s) => s.id === draft.id);
  if (i >= 0) {
    // token ausente no input = manter o gravado (draft nem traz a chave, então o
    // spread preserva o token antigo); '' explícito vem como null e limpa
    state.servers[i] = { token: state.servers[i].token ?? null, ...draft };
  } else {
    state.servers.push({ token: null, ...draft });
  }
  save(state);
  // editar o perfil já ativo tem que valer na hora, sem reiniciar
  const stored = state.servers.find((s) => s.id === draft.id);
  if (draft.id === state.active) applyProfile(stored || draft);
  return describe(findProfile(state.active) || envProfile());
}

export function activateServer(id) {
  const profile = findProfile(String(id || ''));
  if (!profile) throw new Error('servidor não encontrado');
  state.active = profile.id;
  save(state);
  applyProfile(profile);
  return describe(profile);
}

/**
 * Devolve o servidor do ambiente à lista depois de removido. Sem isto, apagar
 * seria irreversível pela tela: o destino continuaria funcionando (ele é
 * derivado do env) mas sumiria da lista sem volta.
 */
export function restoreEnvServer() {
  state.hideEnv = false;
  save(state);
  return describe(findProfile(state.active) || envProfile());
}

/**
 * Aplica ao perfil ativo um caminho de CLI diferente do configurado.
 *
 * O ambiente é derivado do env e por isso não tem entrada editável — mas o
 * `bin` quebrado é justamente o caso que o painel precisa resolver (CLI
 * desinstalada, perfil apontando para onde ela não está). Guardar aqui como
 * override do processo mantém a semântica: o ambiente continua sendo o
 * ambiente, e o que muda é apenas de onde a CLI é executada.
 */
export function setActiveBin(bin) {
  const target = String(bin || '').trim();
  if (!target) throw new Error('caminho da CLI é obrigatório');
  const active = findProfile(state.active) || envProfile();
  if (active.env) {
    BOOT.bin = target;
    applyProfile({ ...active, bin: target });
    save(state);
  } else {
    const i = state.servers.findIndex((s) => s.id === active.id);
    if (i < 0) throw new Error('servidor não encontrado');
    state.servers[i] = { ...state.servers[i], bin: target };
    applyProfile(state.servers[i]);
    save(state);
  }
  return describe(findProfile(state.active) || envProfile());
}

export function deleteServer(id) {
  const target = String(id || '');

  if (target === LOCAL_ID) {
    // o ambiente sai da lista, mas continua sendo o destino implícito: sem ele o
    // painel ficaria sem servidor para onde falar
    state.hideEnv = true;
    // se for o ativo, volta para ele agora (a lista pode ter outros)
    if (state.active === LOCAL_ID) applyProfile(envProfile());
    save(state);
    return describe(findProfile(state.active) || envProfile());
  }

  const i = state.servers.findIndex((s) => s.id === target);
  if (i < 0) throw new Error('servidor não encontrado');
  state.servers.splice(i, 1);
  // remover o perfil ativo devolve o painel para o servidor do ambiente
  if (state.active === target) {
    state.active = LOCAL_ID;
    applyProfile(envProfile());
  }
  save(state);
  return describe(findProfile(state.active) || envProfile());
}

/**
 * Testa um destino sem trocar o que está ativo.
 *
 * A prova de vida é o MCP (`memory_status`): é o mesmo caminho que o painel usa
 * para ler memórias, então responder ali significa que o destino serve. A
 * **versão não vem por esse caminho** — o `memory_status` do MCP devolve só
 * `counts` e `scope` —, então ela é buscada na CLI, que é onde a saí. Quando a
 * CLI não responde (binário ausente, versão antiga), o probe continua válido e
 * a tela mostra que não deu para ler a versão, em vez de inventar um `?`.
 */
export async function probeServer({ url, token, dataDir, bin } = {}) {
  const draft = sanitize({ url, token, bin, dataDir: dataDir || config.dataDir }, { fallback: envProfile() });
  const target = { url: draft.url, token: tokenFor(draft), remote: true };

  let res;
  try {
    res = await callTool('memory_status', {}, { timeoutMs: 12_000, target });
  } catch (err) {
    return { ok: false, url: draft.url, hasToken: Boolean(target.token), error: err.message };
  }

  // o MCP responde: o destino existe. A versão é um extra.
  const out = { ok: true, url: draft.url, hasToken: Boolean(target.token), counts: res?.counts || null, version: null, versionNote: null };
  try {
    const status = await runCliJson(['status'], {
      timeoutMs: 20_000,
      bin: draft.bin,
      dataDir: draft.dataDir,
      env: { AI_MEMORY_SERVER_URL: draft.url, AI_MEMORY_AUTH_TOKEN: target.token || '' },
    });
    out.version = typeof status?.version === 'string' ? status.version : null;
    if (!out.version) out.versionNote = 'a CLI respondeu sem versão';
    // o status da CLI é do servidor inteiro, sem escopo: é o número que a tela
    // deve mostrar, diferente dos counts do MCP (que seguem o cwd do painel)
    out.totals = status?.counts && typeof status.counts === 'object' ? status.counts : null;
  } catch (err) {
    out.versionNote = `não deu para ler a versão: ${String(err.message || err).split('\n')[0].slice(0, 120)}`;
  }
  return out;
}
