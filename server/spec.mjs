import { expandTilde } from './config.mjs';

// Whitelist de comandos de manutenção executáveis pelo painel.
// Cada entrada constrói os args a partir de opções validadas; nada de shell.

const str = (v) => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('valor de texto inválido');
  return v.trim();
};

const num = (v, { min = 0, max = 10_000, int = true } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new Error(`número inválido (esperado ${min}–${max})`);
  }
  return n;
};

const bool = (v, def) => (v === undefined ? def : v === true || v === 'true');

const optNum = (v, flag, limits) => {
  if (v === undefined || v === null || v === '') return [];
  return [flag, String(num(v, limits))];
};

const optStr = (v, flag) => {
  if (v === undefined || v === null || typeof v !== 'string' || v.trim() === '') return [];
  return [flag, v.trim()];
};

const optBool = (v, flag, def) => (bool(v, def) ? [flag] : []);

export const SPEC = {
  // --- leitura / rápidos ---
  doctor: {
    group: 'fast',
    timeoutMs: 120_000,
    args: (o) => ['doctor', ...optNum(o.sinceDays, '--since-days', { min: 1, max: 365 })],
  },
  curator: {
    group: 'fast',
    timeoutMs: 120_000,
    args: (o) => ['curator', ...optBool(o.dryRun, '--dry-run', true), ...optStr(o.stage, '--stage')],
  },
  'auto-improve-report': {
    group: 'fast',
    timeoutMs: 120_000,
    args: (o) => [
      'auto-improve-report',
      ...optNum(o.days, '--days', { min: 1, max: 365 }),
      ...optNum(o.limit, '--limit', { min: 1, max: 100 }),
    ],
  },
  'audit-contamination': {
    group: 'fast',
    timeoutMs: 120_000,
    args: () => ['audit-contamination'],
  },
  lint: {
    group: 'fast',
    timeoutMs: 600_000,
    args: (o) => ['lint', ...optBool(o.noLlm, '--no-llm', true), ...optBool(o.dryRun, '--dry-run', true)],
  },

  // --- ações ---
  'forget-sweep': {
    group: 'actions',
    timeoutMs: 600_000,
    args: (o) => ['forget-sweep', ...optBool(o.dryRun, '--dry-run', true)],
  },
  'finalize-session': {
    group: 'actions',
    timeoutMs: 300_000,
    args: (o) => ['finalize-session', ...optBool(o.all, '--all', true)],
  },
  embed: {
    group: 'actions',
    timeoutMs: 1_800_000,
    args: (o) => ['embed', ...optBool(o.dryRun, '--dry-run', true), ...optBool(o.force, '--force', false)],
  },

  // --- pesados ---
  backfill: {
    group: 'heavy',
    timeoutMs: 3_600_000,
    args: (o) => ['backfill', ...optBool(o.dryRun, '--dry-run', true), ...optNum(o.maxSessions, '--max-sessions', { min: 1, max: 200 })],
  },
  bootstrap: {
    group: 'heavy',
    timeoutMs: 3_600_000,
    args: (o) => ['bootstrap', ...optBool(o.dryRun, '--dry-run', true)],
  },
  backup: {
    group: 'heavy',
    timeoutMs: 3_600_000,
    args: (o, ctx) => {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const out = o.out ? expandTilde(str(o.out)) : `${ctx.home}/ai-memory-backup-${ts}.tar.gz`;
      return ['backup', '-o', out];
    },
  },

  // --- zona de perigo (exigem confirmação no frontend; --confirm fica nos args) ---
  compact: {
    group: 'danger',
    timeoutMs: 3_600_000,
    confirmWord: 'compact',
    args: () => ['compact', '--confirm'],
  },
  reindex: {
    group: 'danger',
    timeoutMs: 3_600_000,
    confirmWord: 'reindex',
    args: () => ['reindex'],
  },
  'purge-project': {
    group: 'danger',
    timeoutMs: 3_600_000,
    confirmWord: 'purge-project',
    args: (o) => ['purge-project', '--project', str(o.project), '--confirm'],
  },
  'purge-session': {
    group: 'danger',
    timeoutMs: 3_600_000,
    confirmWord: 'purge-session',
    args: (o) => ['purge-session', '--session-id', str(o.sessionId), '--confirm'],
  },
};

export function buildMaintenanceArgs(command, options = {}, ctx = { home: '' }) {
  const entry = SPEC[command];
  if (!entry) throw new Error(`comando não permitido: ${command}`);
  if (typeof entry.args !== 'function') throw new Error(`comando sem builder: ${command}`);
  return { args: entry.args(options ?? {}, ctx), timeoutMs: entry.timeoutMs, group: entry.group, confirmWord: entry.confirmWord || null };
}

export function requiresConfirmation(command) {
  return Boolean(SPEC[command]?.confirmWord);
}

export function checkConfirmation(command, confirm) {
  const word = SPEC[command]?.confirmWord;
  if (!word) return;
  if (confirm !== word) throw new Error(`confirmação necessária: digite "${word}" para executar`);
}
