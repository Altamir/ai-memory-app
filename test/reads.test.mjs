import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageItem } from '../server/reads.mjs';

test('normaliza hit de busca global (workspace_name/project_name)', () => {
  const item = normalizePageItem({
    workspace_name: 'default',
    project_name: 'refinamento-engine',
    path: 'decisions/mcp-http-auth.md',
    title: 'MCP HTTP Auth',
    snippet: '…<mark>auth</mark>…',
    rank: -10.45,
  });
  assert.equal(item.path, 'decisions/mcp-http-auth.md');
  assert.equal(item.workspace, 'default');
  assert.equal(item.project, 'refinamento-engine');
  assert.equal(item.score, -10.45);
  assert.equal(item.snippet, '…<mark>auth</mark>…');
});

test('normaliza hit de busca com escopo (score/updated_at)', () => {
  const item = normalizePageItem({
    path: 'notes/budget.md',
    title: 'Budget',
    snippet: 'plain snippet',
    score: 0.9,
    updated_at: '2026-09-28T12:00:00Z',
    tags: ['financas'],
    pinned: true,
  });
  assert.equal(item.path, 'notes/budget.md');
  assert.equal(item.workspace, null);
  assert.equal(item.project, null);
  assert.equal(item.score, 0.9);
  assert.equal(item.updatedAt, '2026-09-28T12:00:00Z');
  assert.deepEqual(item.tags, ['financas']);
  assert.equal(item.pinned, true);
});

test('título cai para o basename quando ausente', () => {
  const item = normalizePageItem({ path: 'gotchas/meu-gotcha' });
  assert.equal(item.title, 'meu-gotcha');
});

test('item sem path é descartado', () => {
  assert.equal(normalizePageItem({ title: 'sem path' }), null);
  assert.equal(normalizePageItem(null), null);
  assert.equal(normalizePageItem('string'), null);
});
