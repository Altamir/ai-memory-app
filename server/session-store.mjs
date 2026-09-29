import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Persistência da lista de sessões do painel (em memória os PTYs morrem com o
// processo; o arquivo guarda os metadados para os cards sobreviverem a restarts).

const stateFile = () => process.env.AIM_APP_STATE_FILE || path.join(config.root, '.sessions.json');

export function stateFilePath() {
  return stateFile();
}

export function saveSessions(list) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(list, null, 2));
  } catch {
    // best-effort: perder o histórico de cards não pode derrubar o painel
  }
}

export function loadSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // ausente ou corrompido: começa vazio
  }
}
