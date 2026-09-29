import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Cliente MCP streamable-HTTP mínimo: initialize handshake + tools/call.
// A sessão é reutilizada entre chamadas e re-negociada se o servidor a invalidar.

const state = {
  sessionId: null,
  protocolVersion: null,
  initPromise: null,
  nextId: 1,
};

const PROTOCOL_VERSION = '2025-06-18';

function authToken() {
  try {
    return fs.readFileSync(path.join(config.dataDir, 'auth-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

function headers() {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const token = authToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (state.sessionId) h['Mcp-Session-Id'] = state.sessionId;
  if (state.protocolVersion) h['MCP-Protocol-Version'] = state.protocolVersion;
  return h;
}

async function post(body, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.serverUrl}/mcp`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Uma resposta JSON-RPC pode vir como application/json ou como SSE (linhas data:). */
async function extractJsonRpc(res, id) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const msg = JSON.parse(payload);
        if (msg.id === id || msg.method === undefined) return msg;
      } catch {
        // fragmento inválido: ignora
      }
    }
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resetSession() {
  state.sessionId = null;
  state.protocolVersion = null;
  state.initPromise = null;
}

async function initialize() {
  if (state.initPromise) return state.initPromise;
  state.initPromise = (async () => {
    const id = state.nextId++;
    const res = await post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-memory-app', version: '0.1.0' },
      },
    });
    if (!res.ok) {
      throw new Error(`initialize falhou com HTTP ${res.status}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) state.sessionId = sid;
    const msg = await extractJsonRpc(res, id);
    const version = msg?.result?.protocolVersion;
    if (version) state.protocolVersion = version;
    // notificação initialized (sem resposta esperada)
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    return true;
  })();
  try {
    return await state.initPromise;
  } catch (err) {
    resetSession();
    throw err;
  }
}

async function rpc(method, params, { timeoutMs = 60_000, retry = true } = {}) {
  await initialize();
  const id = state.nextId++;
  const res = await post({ jsonrpc: '2.0', id, method, params }, { timeoutMs });
  if (res.status === 404 || res.status === 400) {
    if (retry) {
      // sessão expirou: re-negocia e tenta uma vez
      resetSession();
      return rpc(method, params, { timeoutMs, retry: false });
    }
    throw new Error(`servidor MCP recusou ${method} com HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`servidor MCP respondeu HTTP ${res.status} para ${method}`);
  }
  const msg = await extractJsonRpc(res, id);
  if (!msg) throw new Error(`sem resposta JSON-RPC para ${method}`);
  if (msg.error) {
    const detail = typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error);
    throw new Error(detail);
  }
  return msg.result;
}

/** Chama uma tool MCP e devolve o payload útil (structuredContent, JSON do text, ou { raw }). */
export async function callTool(name, args = {}, opts = {}) {
  const result = await rpc('tools/call', { name, arguments: args }, opts);
  if (result?.isError) {
    const text = result?.content?.map((c) => c.text || '').join(' ') || 'tool reportou erro';
    throw new Error(text);
  }
  if (result?.structuredContent && Object.keys(result.structuredContent).length > 0) {
    return result.structuredContent;
  }
  const text = result?.content?.map((c) => c.text || '').join('\n') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** callTool que nunca lança: devolve { ok, data } ou { ok: false, error }. */
export async function tryTool(name, args = {}, opts = {}) {
  try {
    const data = await callTool(name, args, opts);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
