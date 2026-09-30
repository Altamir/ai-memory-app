import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Estado do importador: quais itens de origem já foram gravados (fingerprint +
// destino) e o histórico das execuções. Best-effort: perder o arquivo só faz o
// próximo scan reportar tudo como novo de novo.

const RUN_LIMIT = 20;

const stateFile = () => process.env.AIM_APP_IMPORT_FILE || path.join(config.root, '.import-state.json');

export function importStatePath() {
  return stateFile();
}

export function loadImportState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      version: 1,
      items: parsed && typeof parsed.items === 'object' && parsed.items ? parsed.items : {},
      runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
    };
  } catch {
    return { version: 1, items: {}, runs: [] };
  }
}

function save(state) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch {
    // best-effort: state perdido degrada para "tudo novo", não derruba o job
  }
}

/** Marca itens como importados: { key, fp, destPath, destTarget, importedAt }. */
export function markImported(entries) {
  if (!entries.length) return;
  const state = loadImportState();
  for (const e of entries) {
    state.items[e.key] = {
      fp: e.fp,
      destPath: e.destPath,
      destTarget: e.destTarget || null,
      importedAt: e.importedAt,
    };
  }
  save(state);
}

/** Registra o resumo de uma execução de import (últimas RUN_LIMIT). */
export function recordImportRun(run) {
  const state = loadImportState();
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, RUN_LIMIT);
  save(state);
  return state.runs;
}

export function importStateSummary() {
  const state = loadImportState();
  const byFingerprint = new Map();
  for (const [key, entry] of Object.entries(state.items)) {
    if (entry?.fp) byFingerprint.set(entry.fp, key);
  }
  return { items: state.items, runs: state.runs, byFingerprint };
}
