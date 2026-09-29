import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSessions, loadSessions, stateFilePath } from '../server/session-store.mjs';

function withStateFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-state-'));
  const prev = process.env.AIM_APP_STATE_FILE;
  process.env.AIM_APP_STATE_FILE = path.join(dir, 'state.json');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AIM_APP_STATE_FILE;
    else process.env.AIM_APP_STATE_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('arquivo de estado fica no projeto por padrão', () => {
  assert.ok(stateFilePath().endsWith('.sessions.json'));
});

test('save/load faz roundtrip da lista de sessões', () => {
  withStateFile(() => {
    assert.deepEqual(loadSessions(), []); // ausente → vazio
    const list = [{ id: 'abc', harness: 'grok', cwd: '/x', pid: 1, status: 'ended', createdAt: 1 }];
    saveSessions(list);
    assert.deepEqual(loadSessions(), list);
  });
});

test('arquivo corrompido devolve lista vazia em vez de quebrar', () => {
  withStateFile(() => {
    fs.writeFileSync(stateFilePath(), '{isso não é json');
    assert.deepEqual(loadSessions(), []);
  });
});

test('formato inesperado (não-array) devolve lista vazia', () => {
  withStateFile(() => {
    fs.writeFileSync(stateFilePath(), JSON.stringify({ sessions: [] }));
    assert.deepEqual(loadSessions(), []);
  });
});
