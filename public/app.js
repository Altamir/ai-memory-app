/* ai-memory-app — frontend vanilla (sem build) */

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Permite apenas <mark> em snippets vindos do servidor. */
function safeSnippet(s) {
  if (!s) return '';
  return esc(s).replace(/&lt;(\/?mark)&gt;/g, '<$1>');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // corpo vazio
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    if (data?.detail) err.detail = data.detail;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const node = el('div', { class: `toast ${kind ? `toast-${kind}` : ''}`, text: msg });
  $('#toast-root').append(node);
  setTimeout(() => node.remove(), 3800);
}

function modal({ title, bodyNode, actions = [], onClose, wide }) {
  const root = $('#modal-root');
  const close = () => {
    overlay.remove();
    if (onClose) onClose();
  };
  const actionsRow = el('div', { class: 'modal-actions' });
  for (const a of actions) {
    if (a && a.nodeType) {
      // botão já montado (ex.: confirmar do modal digitado) — usa como está
      actionsRow.append(a);
      continue;
    }
    actionsRow.append(
      el('button', {
        class: `btn btn-${a.kind || 'secondary'}`,
        text: a.label,
        // sem onClick explícito, a ação padrão é fechar
        onclick: () => (a.onClick ? a.onClick(close) : close()),
      }),
    );
  }
  const overlay = el(
    'div',
    { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    el(
      'div',
      { class: `modal ${wide ? 'modal-wide' : ''}` },
      el('h3', { text: title }),
      el('div', { class: 'modal-body' }, bodyNode),
      actionsRow,
    ),
  );
  root.append(overlay);
  return close;
}

/** Modal de confirmação que exige digitar uma palavra. */
function confirmModal({ title, message, word, danger, onConfirm }) {
  const input = el('input', { class: 'field', placeholder: `digite "${word}" para confirmar`, autocomplete: 'off' });
  const confirmBtn = el('button', { class: `btn btn-${danger ? 'danger' : 'primary'}`, text: 'Confirmar', disabled: true });
  input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== word; });
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  const body = el('div', { class: 'stack' }, el('div', { class: 'small', text: message }), input);
  const close = modal({
    title,
    bodyNode: body,
    actions: [confirmBtn],
  });
  setTimeout(() => input.focus(), 50);
}

function fmtBytes(n) {
  if (n === undefined || n === null || n === '' || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(d)) return '';
  const s = Math.max(1, Math.round((Date.now() - d) / 1000));
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
  return `${Math.floor(s / 86400)}d atrás`;
}

function metric(label, value, sub) {
  return el(
    'div',
    { class: 'card metric' },
    el('div', { class: 'metric-label', text: label }),
    el('div', { class: 'metric-value', text: value }),
    sub ? el('div', { class: 'metric-sub', text: sub }) : null,
  );
}

function renderJsonPretty(data) {
  return el('div', { class: 'codeblock', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
}

// ---------- roteamento ----------

const TITLES = {
  dashboard: 'Painel',
  maintenance: 'Manutenção',
  pending: 'Pendências de escrita',
  mail: 'Handoffs e mensagens',
  sessions: 'Sessões run',
  memories: 'Memórias',
};

const VIEWS = {};

function route() {
  const view = (location.hash || '#dashboard').slice(1);
  const main = $('#main');
  // resgata o host de terminais para o body antes de limpar o main (senão os panes morrem)
  const termHost = $('#term-host');
  document.body.append(termHost);
  termHost.style.display = 'none';
  main.replaceChildren();
  $('#view-title').textContent = TITLES[view] || view;
  for (const item of document.querySelectorAll('.menu-item')) {
    item.classList.toggle('active', item.dataset.view === view);
  }
  const fn = VIEWS[view] || VIEWS.dashboard;
  fn(main).catch((err) => {
    main.append(el('div', { class: 'card' }, el('div', { class: 'chip chip-err', text: 'erro' }), el('p', { text: err.message })));
  });
}

for (const item of document.querySelectorAll('.menu-item')) {
  item.addEventListener('click', () => { location.hash = item.dataset.view; });
}
window.addEventListener('hashchange', route);

// ---------- chip de status no header ----------

async function refreshServerChip() {
  const chip = $('#server-chip');
  try {
    const s = await api('/api/status');
    chip.className = 'chip chip-ok';
    chip.textContent = `servidor ok · v${s.version || '?'}`;
  } catch {
    chip.className = 'chip chip-err';
    chip.textContent = 'servidor offline';
  }
}
setInterval(refreshServerChip, 60_000);

// ---------- view: dashboard ----------

VIEWS.dashboard = async (main) => {
  const wrap = el('div', { class: 'stack' });
  main.append(wrap);
  const load = async () => {
    wrap.replaceChildren(el('div', { class: 'empty', text: 'carregando status…' }));
    let s;
    try {
      s = await api('/api/status');
    } catch (err) {
      wrap.replaceChildren(
        el('div', { class: 'card' },
          el('div', { class: 'row-between' },
            el('strong', { text: 'Servidor ai-memory inacessível' }),
            el('button', { class: 'btn btn-secondary btn-sm', text: 'Tentar de novo', onclick: load }),
          ),
          el('p', { class: 'small muted', text: err.message }),
          el('p', { class: 'small muted', text: `Verifique o container (docker ps) e a URL ${''}http://127.0.0.1:49374.` }),
        ),
      );
      return;
    }

    const c = s.counts || {};
    const prov = s.providers || {};
    const chips = [];
    if (prov.llm) chips.push(el('span', { class: `chip ${prov.llm.status === 'ok' ? 'chip-ok' : 'chip-warn'}`, text: `LLM ${prov.llm.status} · ${prov.llm.model || prov.llm.provider || ''}` }));
    if (prov.embedding) chips.push(el('span', { class: `chip ${prov.embedding.status === 'ok' ? 'chip-ok' : 'chip-warn'}`, text: `Embeddings ${prov.embedding.status} · ${prov.embedding.model || ''}` }));

    const spool = s.spool || {};
    const storageRows = Object.entries(s.storage || {})
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => el('div', { class: 'row-between small' },
        el('span', { class: 'muted mono', text: k }),
        el('span', { class: 'mono', text: k.endsWith('_bytes') ? (fmtBytes(v) || v) : String(v) }),
      ));

    wrap.replaceChildren(
      el('div', { class: 'view-head' },
        el('div', { class: 'row', style: 'gap:8px' }, chips),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'Atualizar', onclick: load }),
      ),
      el('div', { class: 'grid grid-metrics' },
        metric('Páginas', c.pages_latest ?? '—', `${c.pages_all ?? '—'} versões`),
        metric('Sessões', c.sessions ?? '—'),
        metric('Observações', (c.observations ?? '—').toLocaleString?.() ?? c.observations),
        metric('Spool pendente', spool.pending ?? '—', spool.pending ? `mais antigo: ${Math.round((spool.oldest_age_ms || 0) / 1000)}s` : 'nada na fila'),
        metric('Captura', s.capture_mode || '—'),
        metric('Ingest aceito', (s.ingest?.accepted ?? '—')?.toLocaleString?.() ?? '—'),
      ),
      el('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))' },
        el('div', { class: 'card stack' },
          el('strong', { text: 'Servidor' }),
          el('div', { class: 'row-between small' }, el('span', { class: 'muted', text: 'URL' }), el('span', { class: 'mono', text: s.client?.server_url || '—' })),
          el('div', { class: 'row-between small' }, el('span', { class: 'muted', text: 'Bind' }), el('span', { class: 'mono', text: s.bind || '—' })),
          el('div', { class: 'row-between small' }, el('span', { class: 'muted', text: 'Data dir' }), el('span', { class: 'mono', text: s.data_dir || '—' })),
          el('div', { class: 'row-between small' }, el('span', { class: 'muted', text: 'DB' }), el('span', { class: 'mono', text: s.db_path || '—' })),
        ),
        el('div', { class: 'card stack' },
          el('strong', { text: 'Armazenamento' }),
          ...storageRows,
        ),
      ),
    );
  };
  await load();
};

// ---------- view: manutenção ----------

const CATALOG = [
  { group: 'Rápidos e leitura', cmds: [
    { id: 'doctor', label: 'Doctor', desc: 'Cobertura de captura por harness nos últimos N dias.', flags: [{ key: 'sinceDays', flag: '--since-days', type: 'number', def: 30, label: 'dias' }] },
    { id: 'curator', label: 'Curator', desc: 'Relatório rule-based sobre páginas do wiki (não escreve por padrão).', flags: [{ key: 'dryRun', type: 'bool', def: true, label: 'dry-run' }, { key: 'stage', type: 'text', label: 'stage' }] },
    { id: 'auto-improve-report', label: 'Auto-improve report', desc: 'Telemetria read-only das revisões automáticas de sessão.', flags: [{ key: 'days', flag: '--days', type: 'number', def: 30, label: 'dias' }, { key: 'limit', flag: '--limit', type: 'number', def: 10, label: 'limite' }] },
    { id: 'audit-contamination', label: 'Auditoria de contaminação', desc: 'Auditoria SQL read-only de conteúdo cross-project.', flags: [] },
    { id: 'lint', label: 'Lint', desc: 'Detecta páginas stale, duplicatas e contradições (escreve wiki/_lint/report.md).', flags: [{ key: 'noLlm', flag: '--no-llm', def: true, type: 'bool', label: 'sem LLM (rápido)' }, { key: 'dryRun', flag: '--dry-run', def: true, type: 'bool', label: 'dry-run' }] },
  ] },
  { group: 'Ações', cmds: [
    { id: 'forget-sweep', label: 'Forget sweep', desc: 'Sweep de retenção: expira TTLs, evicta páginas episódicas frias.', flags: [{ key: 'dryRun', flag: '--dry-run', def: true, type: 'bool', label: 'dry-run' }] },
    { id: 'finalize-session', label: 'Finalizar sessões', desc: 'Fecha sessões abertas de agentes sem evento SessionEnd (ex.: ZCode).', flags: [{ key: 'all', flag: '--all', def: true, type: 'bool', label: 'todas' }] },
    { id: 'embed', label: 'Embeddings', desc: 'Gera embeddings das latest pages para busca semântica.', flags: [{ key: 'dryRun', flag: '--dry-run', def: true, type: 'bool', label: 'dry-run' }, { key: 'force', flag: '--force', def: false, type: 'bool', label: 'forçar' }] },
  ] },
  { group: 'Pesados (podem levar minutos)', cmds: [
    { id: 'backfill', label: 'Backfill', desc: 'Importa histórico local de harness para o store.', flags: [{ key: 'dryRun', flag: '--dry-run', def: true, type: 'bool', label: 'dry-run' }, { key: 'maxSessions', flag: '--max-sessions', type: 'number', def: 25, label: 'máx sessões' }] },
    { id: 'bootstrap', label: 'Bootstrap', desc: 'Pré-carga de histórico via LLM (git log, README, docs).', flags: [{ key: 'dryRun', flag: '--dry-run', def: true, type: 'bool', label: 'dry-run' }] },
    { id: 'backup', label: 'Backup', desc: 'Exporta o store inteiro como tar.gz.', flags: [{ key: 'out', flag: '-o', type: 'text', label: 'arquivo de saída (vazio = padrão)' }] },
  ] },
];

const DANGER_CATALOG = [
  { id: 'compact', label: 'Compact', desc: 'VACUUM + rebuild FTS. Bloqueia escritas por minutos; requer espaço livre ≈ tamanho do DB.', flags: [] },
  { id: 'reindex', label: 'Reindex', desc: 'Rebuild do SQLite a partir do wiki/. Deve rodar com o servidor parado.', flags: [] },
  { id: 'purge-project', label: 'Purge projeto', desc: 'Remove um projeto inteiro do store (irreversível).', flags: [{ key: 'project', flag: '--project', type: 'text', label: 'nome do projeto' }] },
  { id: 'purge-session', label: 'Purge sessão', desc: 'Remove uma sessão e todas as observações dela (irreversível).', flags: [{ key: 'sessionId', flag: '--session-id', type: 'text', label: 'session id (UUID)' }] },
];

let activeEs = null;

function stopLogStream() {
  if (activeEs) { activeEs.close(); activeEs = null; }
}

function showJob(jobId, panel, statusChip) {
  stopLogStream();
  const log = panel.querySelector('.log-panel');
  log.replaceChildren();
  log.dataset.autoscroll = 'true';
  log.addEventListener('scroll', () => {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.dataset.autoscroll = String(atBottom);
  });
  statusChip.className = 'chip chip-info';
  statusChip.textContent = 'executando…';

  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  activeEs = es;
  const appendLine = (line) => {
    log.append(el('span', { class: `log-line-${line.kind}`, text: line.text }));
    if (log.dataset.autoscroll === 'true') log.scrollTop = log.scrollHeight;
  };
  es.onmessage = (ev) => {
    try { appendLine(JSON.parse(ev.data)); } catch { /* ignora */ }
  };
  es.addEventListener('end', () => {
    es.close();
    if (activeEs === es) activeEs = null;
    api(`/api/jobs/${jobId}`).then((j) => {
      const ok = j.status === 'ok';
      statusChip.className = `chip ${ok ? 'chip-ok' : j.status === 'timeout' ? 'chip-warn' : 'chip-err'}`;
      statusChip.textContent = `${j.status} · código ${j.exitCode ?? '?'} · ${fmtDuration(j.durationMs)}`;
      if (panel.dataset.onDone === 'history') refreshHistory(panel.parentElement);
    }).catch(() => {});
  });
  es.onerror = () => { es.close(); if (activeEs === es) activeEs = null; };
}

async function refreshHistory(container, panel, statusChip) {
  const histCard = container.querySelector('[data-history]');
  if (!histCard) return;
  const { jobs } = await api('/api/jobs');
  const tbody = el('tbody');
  if (!jobs.length) {
    tbody.append(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'nenhuma execução ainda' })));
  }
  for (const j of jobs.slice(0, 12)) {
    tbody.append(el('tr', {},
      el('td', { text: timeAgo(j.startedAt) || new Date(j.startedAt).toLocaleTimeString() }),
      el('td', { class: 'mono', text: j.command }),
      el('td', {}, el('span', { class: `chip ${j.status === 'ok' ? 'chip-ok' : j.status === 'running' ? 'chip-info' : j.status === 'timeout' ? 'chip-warn' : 'chip-err'}`, text: j.status })),
      el('td', { text: fmtDuration(j.durationMs) }),
      el('td', {}, el('button', { class: 'btn btn-secondary btn-sm', text: 'ver log', onclick: () => { showJob(j.id, panel, statusChip); panel.scrollIntoView({ behavior: 'smooth' }); } })),
    ));
  }
  const table = histCard.querySelector('table');
  table.replaceChildren(el('thead', {}, el('tr', {},
    el('th', { text: 'quando' }), el('th', { text: 'comando' }), el('th', { text: 'status' }), el('th', { text: 'duração' }), el('th', { text: '' }),
  )), tbody);
}

function runCommand(cmd, options, panel, statusChip, root) {
  const doRun = (confirm) => {
    api('/api/jobs', { method: 'POST', body: { command: cmd.id, options, confirm } })
      .then((job) => {
        panel.style.display = '';
        panel.dataset.onDone = 'history';
        panel.querySelector('[data-job-label]').textContent = job.args.join(' ');
        showJob(job.id, panel, statusChip);
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        refreshHistory(root, panel, statusChip);
        toast(`job iniciado: ${job.command}`);
      })
      .catch((err) => toast(err.message, 'err'));
  };
  if (cmd.id === 'compact' || cmd.id === 'reindex' || cmd.id === 'purge-project' || cmd.id === 'purge-session') {
    confirmModal({
      title: `Executar ${cmd.id}`,
      message: `${cmd.desc}\nConfirme digitando o nome do comando. Esta operação é destrutiva ou bloqueante.`,
      word: cmd.id,
      danger: true,
      onConfirm: () => doRun(cmd.id),
    });
  } else {
    doRun(undefined);
  }
}

function commandCard(cmd, panel, statusChip, root) {
  const inputs = {};
  const flagEls = cmd.flags.map((f) => {
    if (f.type === 'bool') {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = f.def;
      inputs[f.key] = () => cb.checked;
      return el('label', { class: 'check' }, cb, f.label || f.flag || f.key);
    }
    if (f.type === 'number') {
      const inp = el('input', { class: 'field', type: 'number', style: 'max-width:90px', value: f.def ?? '' });
      inputs[f.key] = () => (inp.value === '' ? undefined : Number(inp.value));
      return el('div', {}, el('label', { class: 'field-label', text: f.label || f.flag || f.key }), inp);
    }
    const inp = el('input', { class: 'field', type: 'text', placeholder: f.placeholder || '', autocomplete: 'off' });
    inputs[f.key] = () => (inp.value.trim() === '' ? undefined : inp.value.trim());
    return el('div', {}, el('label', { class: 'field-label', text: f.label || f.flag || f.key }), inp);
  });

  return el(
    'div',
    { class: 'card stack' },
    el('div', { class: 'row-between' },
      el('strong', { text: cmd.label }),
      el('span', { class: 'chip chip-info mono', text: cmd.id }),
    ),
    el('div', { class: 'small muted', text: cmd.desc }),
    flagEls.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' }, flagEls) : null,
    el('div', {}, el('button', { class: 'btn btn-primary btn-sm', text: 'Executar', onclick: () => {
      const options = {};
      for (const [k, get] of Object.entries(inputs)) {
        const v = get();
        if (v !== undefined) options[k] = v;
      }
      runCommand(cmd, options, panel, statusChip, root);
    } })),
  );
}

VIEWS.maintenance = async (main) => {
  const root = el('div', { class: 'stack' });
  main.append(root);

  const statusChip = el('span', { class: 'chip', text: 'idle' });
  const panel = el(
    'div',
    { class: 'card stack', style: 'display:none' },
    el('div', { class: 'row-between' },
      el('div', { class: 'row' }, el('strong', { text: 'Execução' }), el('span', { class: 'mono small muted', 'data-job-label': '', text: '' })),
      el('div', { class: 'row' }, statusChip, el('button', { class: 'btn btn-secondary btn-sm', text: 'fechar', onclick: () => { stopLogStream(); panel.style.display = 'none'; } })),
    ),
    el('div', { class: 'log-panel' }),
  );

  for (const section of CATALOG) {
    root.append(
      el('h2', { class: 'view-head', text: section.group }),
      el('div', { class: 'grid grid-cards' }, section.cmds.map((c) => commandCard(c, panel, statusChip, root))),
    );
  }

  root.append(
    el('h2', { class: 'view-head' }, el('span', { text: 'Zona de perigo' }), el('span', { class: 'chip chip-err', text: 'requer confirmação digitada' })),
    el('div', { class: 'grid grid-cards' }, DANGER_CATALOG.map((c) => commandCard(c, panel, statusChip, root))),
  );

  root.append(
    el('div', { class: 'card stack', 'data-history': '1' },
      el('div', { class: 'row-between' },
        el('strong', { text: 'Execuções recentes' }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => refreshHistory(root, panel, statusChip) }),
      ),
      el('table', { class: 'table' }),
    ),
  );
  root.append(panel);
  await refreshHistory(root, panel, statusChip);
};

// ---------- view: pendências ----------

VIEWS.pending = async (main) => {
  const wrap = el('div', { class: 'stack' });
  main.append(wrap);
  const load = async () => {
    wrap.replaceChildren(el('div', { class: 'empty', text: 'carregando…' }));
    let data;
    try {
      data = await api('/api/pending');
    } catch (err) {
      wrap.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${err.message}` })));
      return;
    }
    const items = data.items || [];
    if (!items.length) {
      wrap.replaceChildren(
        el('div', { class: 'view-head' },
          el('strong', { text: 'Propostas de escrita aguardando revisão' }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Atualizar', onclick: load }),
        ),
        el('div', { class: 'card empty', text: 'Nenhuma pendência — o auto-improve ainda não propôs nada (ou já foi revisado).' }),
      );
      return;
    }
    const cards = items.map((it) => {
      const id = it.id ?? it.proposal_id ?? it.write_id ?? it.pending_id;
      const title = it.title ?? it.kind ?? '(sem título)';
      const meta = [it.kind, it.tier, it.path, it.created_at, it.source].filter(Boolean).map((m) => el('span', { class: 'chip', text: String(m).slice(0, 60) }));
      return el('div', { class: 'card stack' },
        el('div', { class: 'row-between' },
          el('strong', { text: String(title).slice(0, 90) }),
          el('span', { class: 'mono small muted', text: String(id).slice(0, 18) }),
        ),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, meta),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'ver diff', onclick: async () => {
            try {
              const d = await api(`/api/pending/${encodeURIComponent(id)}/diff`);
              modal({ title: `Diff · ${String(id).slice(0, 12)}`, bodyNode: renderJsonPretty(d), actions: [{ label: 'Fechar' }] });
            } catch (err) { toast(err.message, 'err'); }
          } }),
          el('button', { class: 'btn btn-primary btn-sm', text: 'aprovar', onclick: () => {
            api(`/api/pending/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} })
              .then(() => { toast('proposta aprovada', 'ok'); load(); })
              .catch((err) => toast(err.message, 'err'));
          } }),
          el('button', { class: 'btn btn-danger btn-sm', text: 'rejeitar', onclick: () => {
            const reason = el('textarea', { class: 'field', placeholder: 'motivo da rejeição (opcional)' });
            modal({
              title: `Rejeitar ${String(id).slice(0, 12)}?`,
              bodyNode: reason,
              actions: [
                { label: 'Cancelar', onClick: (close) => close() },
                { label: 'Rejeitar', kind: 'danger', onClick: (close) => {
                  close();
                  api(`/api/pending/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason: reason.value } })
                    .then(() => { toast('proposta rejeitada'); load(); })
                    .catch((err) => toast(err.message, 'err'));
                } },
              ],
            });
          } }),
        ),
      );
    });
    wrap.replaceChildren(
      el('div', { class: 'view-head' },
        el('strong', { text: `${items.length} proposta(s) aguardando revisão` }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'Atualizar', onclick: load }),
      ),
      ...cards,
    );
  };
  await load();
};

// ---------- view: handoffs e mensagens ----------

VIEWS.mail = async (main) => {
  const wrap = el('div', { class: 'stack' });
  main.append(wrap);
  let current = 'handoffs';

  const subtabs = el('div', { class: 'subtabs' });
  const content = el('div');
  wrap.append(subtabs, content);

  function refreshCurrent() {
    if (current === 'handoffs') loadHandoffs();
    else loadMessages(current);
  }

  const renderSubtabs = () => {
    subtabs.replaceChildren(
      el('button', { class: `subtab ${current === 'handoffs' ? 'active' : ''}`, text: 'Handoffs abertos', onclick: () => { current = 'handoffs'; renderSubtabs(); loadHandoffs(); } }),
      el('button', { class: `subtab ${current === 'inbox' ? 'active' : ''}`, text: 'Mensagens · inbox', onclick: () => { current = 'inbox'; renderSubtabs(); loadMessages('inbox'); } }),
      el('button', { class: `subtab ${current === 'outbox' ? 'active' : ''}`, text: 'Mensagens · outbox', onclick: () => { current = 'outbox'; renderSubtabs(); loadMessages('outbox'); } }),
    );
  };

  const loading = () => el('div', { class: 'empty', text: 'carregando…' });

  async function loadHandoffs() {
    content.replaceChildren(loading());
    let data;
    try {
      data = await api('/api/handoffs');
    } catch (err) {
      content.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${err.message}` })));
      return;
    }
    const items = data.items || [];
    const sendBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Enviar mensagem…', onclick: () => openComposer(refreshCurrent) });
    const header = el('div', { class: 'view-head' },
      el('strong', { text: `${items.length} handoff(s) aberto(s)` }),
      sendBtn,
    );
    if (!items.length) {
      content.replaceChildren(header, el('div', { class: 'card empty', text: 'Nenhum handoff aberto.' }));
      return;
    }
    const cards = items.map((it) => {
      const id = it.handoff_id ?? it.id;
      const steps = Array.isArray(it.next_steps) ? it.next_steps : [];
      const files = Array.isArray(it.files_touched) ? it.files_touched : [];
      return el('div', { class: 'card stack' },
        el('div', { class: 'row-between' },
          el('strong', { text: String(it.summary ?? it.title ?? '(sem resumo)').slice(0, 120) }),
          el('span', { class: 'mono small muted', text: String(id).slice(0, 8) }),
        ),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, [
          it.created_at ? el('span', { class: 'chip', text: timeAgo(it.created_at) }) : null,
          it.owner ? el('span', { class: 'chip', text: it.owner }) : null,
          it.workspace ? el('span', { class: 'chip', text: `${it.workspace}/${it.project ?? ''}` }) : null,
        ].filter(Boolean)),
        steps.length ? el('div', { class: 'small' }, el('div', { class: 'muted', text: 'Próximos passos:' }), el('ul', { style: 'margin:4px 0' }, steps.slice(0, 5).map((s) => el('li', { text: String(s).slice(0, 200) })))) : null,
        files.length ? el('div', { class: 'row', style: 'flex-wrap:wrap' }, files.slice(0, 6).map((f) => el('span', { class: 'chip mono', text: String(f).slice(0, 48) }))) : null,
        el('div', {}, el('button', { class: 'btn btn-primary btn-sm', text: 'Aceitar (consome o handoff)', onclick: () => {
          confirmModal({
            title: 'Aceitar handoff',
            message: 'Handoffs são single-use: aceitar consome o registro e o marca como aceito. Continuar?',
            word: 'aceitar',
            onConfirm: () => {
              api('/api/handoffs/accept', { method: 'POST', body: { handoffId: id } })
                .then((accepted) => {
                  toast('handoff aceito', 'ok');
                  modal({ title: 'Handoff aceito', bodyNode: renderJsonPretty(accepted), actions: [{ label: 'Fechar' }] });
                  loadHandoffs();
                })
                .catch((err) => toast(err.message, 'err'));
            },
          });
        } })),
      );
    });
    content.replaceChildren(
      header,
      el('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))' }, cards),
    );
  }

  async function loadMessages(box) {
    content.replaceChildren(loading());
    let data;
    try {
      data = await api(`/api/messages?box=${box}`);
    } catch (err) {
      content.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${err.message}` })));
      return;
    }
    const items = data.items || [];
    const parts = [];
    const sendBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Enviar mensagem…', onclick: () => openComposer(refreshCurrent) });
    parts.push(el('div', { class: 'view-head' },
      el('strong', { text: `Caixa de ${box === 'outbox' ? 'saída' : 'entrada'} · ${items.length} mensagem(ns)` }),
      sendBtn,
    ));

    if (!items.length) {
      parts.push(el('div', { class: 'card empty', text: box === 'inbox' ? 'Nenhuma mensagem na caixa de entrada.' : 'Nada na caixa de saída.' }));
      content.replaceChildren(...parts);
      return;
    }

    const rows = items.map((it) => {
      const id = it.id ?? it.message_id;
      const from = [it.from_workspace, it.from_project].filter(Boolean).join('/');
      const to = [it.to_workspace, it.to_project].filter(Boolean).join('/');
      return el('tr', {},
        el('td', { class: 'mono small', text: String(id).slice(0, 8) }),
        el('td', { text: box === 'inbox' ? from : to }),
        el('td', { text: String(it.subject ?? '(sem assunto)').slice(0, 60) }),
        el('td', { class: 'small muted', text: timeAgo(it.created_at) }),
        el('td', {},
          box === 'inbox'
            ? el('button', { class: 'btn btn-secondary btn-sm', text: 'ler', onclick: () => {
                confirmModal({
                  title: 'Ler mensagem',
                  message: 'Ler (pop) consome a mensagem: ela sai da fila e só pode ser lida uma vez. Continuar?',
                  word: 'ler',
                  onConfirm: () => {
                    api('/api/messages/pop', { method: 'POST', body: { messageId: id } })
                      .then((m) => {
                        const msg = m.message ?? m;
                        const bodyNode = el('div', { class: 'stack' },
                          el('div', { class: 'small muted', text: `de: ${msg.from_workspace ?? '?'}/${msg.from_project ?? '?'} · ${msg.subject ?? ''}` }),
                          el('div', { class: 'codeblock', text: msg.body ?? JSON.stringify(msg, null, 2) }),
                        );
                        modal({ title: 'Mensagem', bodyNode, actions: [{ label: 'Fechar' }] });
                      })
                      .catch((err) => toast(err.message, 'err'));
                  },
                });
              } })
            : el('button', { class: 'btn btn-danger btn-sm', text: 'cancelar', onclick: () => {
                api('/api/messages/cancel', { method: 'POST', body: { messageId: id } })
                  .then(() => { toast('mensagem cancelada'); loadMessages('outbox'); })
                  .catch((err) => toast(err.message, 'err'));
              } }),
        ),
      );
    });
    parts.push(el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'id' }), el('th', { text: box === 'inbox' ? 'de' : 'para' }), el('th', { text: 'assunto' }), el('th', { text: 'quando' }), el('th', { text: '' }))),
      el('tbody', {}, rows),
    ));
    content.replaceChildren(...parts);
  }

  renderSubtabs();
  await loadHandoffs();
};

// ---------- view: sessões (run) ----------

const HARNESS_OPTIONS = ['opencode', 'grok', 'claude'];
const terms = new Map(); // id -> { session, term, ws, pane, fit }

// ---- seletor de diretório: sugestões + navegador de pastas ----

function ensureDatalist() {
  let dl = document.getElementById('dir-suggestions');
  if (!dl) {
    dl = el('datalist', { id: 'dir-suggestions' });
    document.body.append(dl);
  }
  return dl;
}

async function loadDirSuggestions() {
  const dl = ensureDatalist();
  try {
    const { scopes } = await api('/api/scopes');
    dl.replaceChildren(
      ...scopes
        .filter((s) => s.path)
        .map((s) => el('option', { value: s.path, label: `${s.workspace}/${s.project}` })),
    );
  } catch {
    // sem sugestões: o navegador de pastas segue funcionando
  }
}

async function loadWsSuggestions() {
  let dl = document.getElementById('ws-suggestions');
  if (!dl) {
    dl = el('datalist', { id: 'ws-suggestions' });
    document.body.append(dl);
  }
  try {
    const { items } = await api('/api/workstreams');
    dl.replaceChildren(...items.map((w) => el('option', { value: w.name, label: w.project || w.path || '' })));
    return items;
  } catch {
    return [];
  }
}

/** Seletor de workspace/projeto: escolhe dos existentes ou digita manualmente. */
function scopeChooser() {
  const wsSel = el('select', { class: 'field' });
  const projSel = el('select', { class: 'field' });
  const wsFree = el('input', { class: 'field', placeholder: 'workspace (ex.: default)', autocomplete: 'off' });
  const projFree = el('input', { class: 'field', placeholder: 'projeto (ex.: refinamento-engine)', autocomplete: 'off' });
  const selBox = el('div', { class: 'row', style: 'flex-wrap:wrap' }, wsSel, projSel);
  const freeBox = el('div', { class: 'stack', style: 'display:none' }, wsFree, projFree);
  const toggle = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'digitar manualmente' });
  let free = false;
  let scopes = [];

  toggle.addEventListener('click', () => {
    free = !free;
    selBox.style.display = free ? 'none' : '';
    freeBox.style.display = free ? '' : 'none';
    toggle.textContent = free ? 'escolher dos existentes' : 'digitar manualmente';
  });

  function fillProjects() {
    const ws = wsSel.value;
    const projects = [...new Set(scopes.filter((s) => s.workspace === ws).map((s) => s.project))];
    projSel.replaceChildren(
      el('option', { value: '', text: 'projeto…' }),
      ...projects.map((p) => el('option', { value: p, text: p })),
    );
  }

  async function load() {
    try {
      scopes = (await api('/api/scopes')).scopes;
    } catch {
      scopes = [];
    }
    const workspaces = [...new Set(scopes.map((s) => s.workspace))];
    wsSel.replaceChildren(
      el('option', { value: '', text: 'workspace…' }),
      ...workspaces.map((w) => el('option', { value: w, text: w })),
    );
    wsSel.addEventListener('change', fillProjects);
    if (workspaces.length === 1) {
      wsSel.value = workspaces[0];
      fillProjects();
    }
  }

  function read() {
    if (free) return { workspace: wsFree.value.trim(), project: projFree.value.trim() };
    return { workspace: wsSel.value, project: projSel.value };
  }

  const node = el('div', { class: 'stack' }, selBox, freeBox, el('div', {}, toggle));
  return { node, read, load };
}

/** Composer de mensagem com chooser de workspace/projeto. */
function openComposer(onSent) {
  const chooser = scopeChooser();
  const subj = el('input', { class: 'field', placeholder: 'assunto (opcional)', autocomplete: 'off' });
  const bodyTa = el('textarea', { class: 'field', placeholder: 'mensagem para o agente do outro projeto — ele vai ler isso sozinho' });
  chooser.load();
  modal({
    title: 'Enviar mensagem para outro projeto',
    bodyNode: el('div', { class: 'stack' }, chooser.node, subj, bodyTa),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Enviar',
        kind: 'primary',
        onClick: (close) => {
          const { workspace, project } = chooser.read();
          if (!workspace || !project) {
            toast('informe workspace e projeto de destino', 'err');
            return;
          }
          if (!bodyTa.value.trim()) {
            toast('escreva a mensagem', 'err');
            return;
          }
          api('/api/messages/send', {
            method: 'POST',
            body: { toWorkspace: workspace, toProject: project, subject: subj.value.trim(), body: bodyTa.value },
          })
            .then(() => {
              toast('mensagem enviada', 'ok');
              close();
              onSent?.();
            })
            .catch((err) => toast(err.message, 'err'));
        },
      },
    ],
  });
}

function openDirPicker(onPick) {
  let current = null;
  const bread = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:2px' });
  const listEl = el('div', { class: 'stack', style: 'gap:4px; max-height:300px; overflow-y:auto; padding-right:4px' });
  const footerPath = el('span', { class: 'mono small', text: '' });

  const crumbBtn = (label, target) =>
    el('button', { class: 'btn btn-secondary btn-sm', style: 'padding:2px 8px', text: label, onclick: () => load(target) });

  function renderBread(data) {
    bread.replaceChildren();
    const parts = [];
    if (data.path.startsWith(data.home)) {
      parts.push({ label: '~', path: data.home });
      const rest = data.path.slice(data.home.length).replace(/^\//, '');
      for (const seg of rest ? rest.split('/') : []) {
        parts.push({ label: seg, path: `${parts[parts.length - 1].path}/${seg}` });
      }
    } else {
      for (const seg of data.path.split('/').filter(Boolean)) {
        parts.push({ label: seg, path: `${parts.length ? parts[parts.length - 1].path : ''}/${seg}` });
      }
    }
    parts.forEach((p, i) => {
      if (i > 0) bread.append(el('span', { class: 'muted', text: '/' }));
      bread.append(crumbBtn(p.label, p.path));
    });
  }

  const row = (d) =>
    el(
      'div',
      { class: 'result-item row-between', onclick: () => load(d.path) },
      el('div', { class: 'row' },
        el('span', { text: '📁', style: 'font-size:14px' }),
        el('span', { class: 'small', style: 'font-weight:600', text: d.name }),
      ),
      d.isRepo ? el('span', { class: 'chip chip-ok', text: 'repo' }) : null,
    );

  async function load(p) {
    listEl.replaceChildren(el('div', { class: 'empty', text: 'carregando…' }));
    try {
      const data = await api(`/api/dirs?path=${encodeURIComponent(p || '')}`);
      current = data;
      footerPath.textContent = data.path;
      renderBread(data);
      listEl.replaceChildren(
        ...(data.dirs.length
          ? data.dirs.map(row)
          : [el('div', { class: 'empty', text: 'sem subpastas — pode usar este diretório' })]),
      );
    } catch (err) {
      listEl.replaceChildren(el('div', { class: 'empty', text: `erro: ${err.message}` }));
    }
  }

  modal({
    title: 'Escolher diretório do projeto',
    bodyNode: el('div', { class: 'stack' }, bread, listEl, el('div', { class: 'row-between' }, footerPath)),
    actions: [
      { label: 'Fechar' },
      { label: 'Usar este diretório', kind: 'primary', onClick: (close) => { if (current) { close(); onPick(current.path); } } },
    ],
  });
  load('');
}

function closeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  try { t.ro.disconnect(); } catch { /* */ }
  try { t.ws.close(); } catch { /* */ }
  try { t.term.dispose(); } catch { /* */ }
  t.win?.remove();
  t.pane.remove();
  terms.delete(id);
}

// ---- janelas flutuantes de terminal: várias ao mesmo tempo, arrastáveis e redimensionáveis ----

let winZTop = 300;
let winCascade = 0;

function buildTermWindow(session, t) {
  const titleEl = el('span', { class: 'term-window-title', text: `${session.harness} · ${session.cwd}` });
  const closeBtn = el('button', { class: 'btn btn-secondary btn-sm', text: '×', title: 'Fechar (a sessão continua rodando)' });
  const head = el('div', { class: 'term-window-head' },
    el('div', { class: 'row', style: 'flex:1; min-width:0' }, titleEl),
    el('div', { class: 'term-window-actions' }, closeBtn),
  );
  const body = el('div', { class: 'term-window-body' });
  const win = el('div', { class: 'term-window' }, head, body);
  body.append(t.pane);

  // tamanho inicial generoso; janelas novas abrem em cascata
  const w = Math.min(Math.round(window.innerWidth * 0.82), 1280);
  const h = Math.min(Math.round(window.innerHeight * 0.82), 860);
  win.style.width = `${w}px`;
  win.style.height = `${h}px`;
  const off = (winCascade++ % 6) * 32;
  win.style.left = `${Math.max(8, Math.round((window.innerWidth - w) / 2) + off)}px`;
  win.style.top = `${Math.max(8, Math.round((window.innerHeight - h) / 2) + off)}px`;
  win.style.zIndex = ++winZTop;

  const bringToFront = () => { win.style.zIndex = ++winZTop; };
  win.addEventListener('mousedown', bringToFront);

  closeBtn.addEventListener('click', () => {
    win.remove();
    t.win = null;
    $('#term-host').append(t.pane); // estaciona o pane; a sessão segue viva
  });

  // arrastar pela barra de título
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    bringToFront();
    const startX = e.clientX - win.offsetLeft;
    const startY = e.clientY - win.offsetTop;
    head.classList.add('dragging');
    const move = (ev) => {
      const left = Math.min(Math.max(ev.clientX - startX, -win.offsetWidth + 140), window.innerWidth - 140);
      const top = Math.min(Math.max(ev.clientY - startY, 0), window.innerHeight - 44);
      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      head.classList.remove('dragging');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // clicar em qualquer lugar do corpo devolve o foco ao terminal
  body.addEventListener('pointerdown', () => t.term.focus());

  document.body.append(win);
  t.win = win;
  setTimeout(() => { try { t.fit.fit(); } catch { /* */ } t.term.focus(); }, 60);
  return win;
}

function openTermWindow(session, onStatus) {
  if (session.lostIo) {
    toast('essa sessão perdeu o I/O na reinicialização do painel — não há terminal para abrir', 'err');
    return null;
  }

  let t = terms.get(session.id);
  if (t) {
    if (t.win?.isConnected) {
      // janela já aberta: traz para a frente
      t.win.style.zIndex = ++winZTop;
      t.term.focus();
      return t;
    }
    // terminal vivo com janela fechada: remonta a janela em volta do pane
    buildTermWindow(session, t);
    return t;
  }

  // IMPORTANTE: a janela precisa estar visível ANTES de term.open() — o xterm
  // mede o container para bindar o textarea de teclado; aberto escondido
  // (pane estacionado), o terminal renderiza mas o teclado não funciona.
  const pane = el('div', { class: 'term-pane' });
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    theme: {
      background: '#ffffff',
      foreground: '#2a2e36',
      cursor: '#3859ff',
      selectionBackground: '#eef1ff',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  t = { session, term, ws: null, pane, fit, ro: null, win: null };
  terms.set(session.id, t);
  buildTermWindow(session, t);
  term.open(pane);
  fit.fit();

  const ws = new WebSocket(`ws://${location.host}/api/pty/${session.id}`);
  t.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'exit') {
      term.write(`\r\n\x1b[38;5;245m— sessão encerrada (código ${msg.exitCode}) —\x1b[0m\r\n`);
      onStatus?.(session.id, 'ended', msg.exitCode);
    }
  };
  ws.onopen = () => {
    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'input', data: d })); });
  };
  term.onResize(({ cols, rows }) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

  const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* pane fora do DOM */ } });
  ro.observe(pane);
  t.ro = ro;
  return t;
}

VIEWS.sessions = async (main) => {
  const harnessSel = el('select', { class: 'field', style: 'max-width:170px' },
    HARNESS_OPTIONS.map((h) => el('option', { value: h, text: h })));
  const cwdInput = el('input', { class: 'field', list: 'dir-suggestions', placeholder: 'escolha um projeto conhecido ou clique em Procurar…', autocomplete: 'off' });
  const browseBtn = el('button', {
    class: 'btn btn-secondary',
    text: 'Procurar…',
    title: 'Navegar pelas pastas e escolher',
    onclick: () => openDirPicker((chosen) => { cwdInput.value = chosen; }),
  });
  const wsMode = el('select', { class: 'field', style: 'max-width:170px' },
    el('option', { value: 'none', text: 'sem workstream' }),
    el('option', { value: 'new', text: 'nova workstream' }),
    el('option', { value: 'existing', text: 'workstream existente' }),
  );
  const wsName = el('input', { class: 'field', placeholder: 'nome da workstream', disabled: true, autocomplete: 'off' });
  wsMode.addEventListener('change', () => {
    wsName.disabled = wsMode.value === 'none';
    if (wsMode.value === 'existing') {
      wsName.setAttribute('list', 'ws-suggestions');
      wsName.placeholder = 'escolha ou digite o nome';
      loadWsSuggestions();
    } else {
      wsName.removeAttribute('list');
      wsName.placeholder = 'nome da nova workstream (ex.: feature-x)';
    }
  });
  const yolo = el('input', { type: 'checkbox' });
  const fresh = el('input', { type: 'checkbox' });

  const cardsEl = el('div', { class: 'grid grid-cards' });

  function onStatus(id, status) {
    refreshList().catch(() => {});
  }

  async function killSession(id) {
    try {
      await api(`/api/sessions/${id}/kill`, { method: 'POST', body: {} });
      toast('sessão encerrada');
    } catch (err) {
      toast(err.message, 'err');
    }
    refreshList().catch(() => {});
  }

  async function removeSession(id) {
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      // sai da lista: derruba janela/terminal estacionado também
      closeTerm(id);
      toast('sessão removida da lista (nada apagado no ai-memory)');
    } catch (err) {
      toast(err.message, 'err');
    }
    refreshList().catch(() => {});
  }

  function clearEnded() {
    confirmModal({
      title: 'Limpar sessões encerradas',
      message: 'Remove da lista todos os cards de sessões que já terminaram (inclusive as perdidas em reinicializações do painel). Nada é apagado no ai-memory.',
      word: 'limpar',
      danger: true,
      onConfirm: async () => {
        const { sessions } = await api('/api/sessions');
        const ended = sessions.filter((s) => s.status !== 'running');
        for (const s of ended) {
          try { await api(`/api/sessions/${s.id}`, { method: 'DELETE' }); } catch { /* segue */ }
          closeTerm(s.id);
        }
        toast(ended.length ? `${ended.length} sessão(ões) removida(s) da lista` : 'nenhuma sessão encerrada para limpar');
        refreshList().catch(() => {});
      },
    });
  }

  async function refreshList() {
    const { sessions } = await api('/api/sessions');
    cardsEl.replaceChildren();
    if (!sessions.length) {
      cardsEl.append(el('div', { class: 'card empty', text: 'nenhuma sessão ainda — inicie uma acima' }));
      return;
    }
    for (const s of [...sessions].reverse()) {
      const running = s.status === 'running';
      const dirName = String(s.cwd).split('/').pop();
      cardsEl.append(
        el('div', { class: 'card stack clickable', onclick: () => openTermWindow(s, onStatus) },
          el('div', { class: 'row-between' },
            el('div', { class: 'row' },
              el('strong', { text: s.harness }),
              el('span', { class: `chip ${running ? 'chip-ok' : ''}`, text: running ? '• rodando' : '○ encerrada' }),
            ),
            el('span', { class: 'mono small muted', text: `pid ${s.pid}` }),
          ),
          el('div', { class: 'small' },
            el('div', { style: 'font-weight:600', text: dirName }),
            s.workstream ? el('div', { class: 'muted', text: `workstream: ${s.workstream}` }) : null,
            el('div', { class: 'mono muted', style: 'font-size:11px; word-break:break-all', text: s.cwd }),
            el('div', { class: 'muted', text: `iniciada ${timeAgo(s.createdAt)}` }),
            s.lostIo ? el('div', { class: 'small', style: 'color: var(--attention)', text: s.endedNote || 'perdida na reinicialização do painel' }) : null,
          ),
          el('div', { class: 'row', onclick: (e) => e.stopPropagation() },
            !s.lostIo ? el('button', { class: 'btn btn-primary btn-sm', text: 'Terminal', onclick: () => openTermWindow(s, onStatus) }) : null,
            running ? el('button', { class: 'btn btn-danger btn-sm', text: 'Encerrar', onclick: () => killSession(s.id) }) : null,
            !running && terms.has(s.id) ? el('button', { class: 'btn btn-secondary btn-sm', text: 'descartar terminal', onclick: () => { closeTerm(s.id); refreshList().catch(() => {}); } }) : null,
            !running ? el('button', {
              class: 'btn btn-danger btn-sm',
              text: 'excluir',
              title: 'Remove o card da lista do painel — não apaga nada no ai-memory',
              onclick: () => removeSession(s.id),
            }) : null,
          ),
        ),
      );
    }
  }

  const startBtn = el('button', { class: 'btn btn-primary', text: 'Iniciar sessão' });
  startBtn.addEventListener('click', () => {
    const cwd = cwdInput.value.trim();
    if (!cwd) { toast('escolha o diretório do projeto', 'err'); return; }
    const body = { harness: harnessSel.value, cwd };
    if (wsMode.value === 'new' && wsName.value.trim()) body.newWorkstream = wsName.value.trim();
    if (wsMode.value === 'existing' && wsName.value.trim()) body.workstream = wsName.value.trim();
    body.yolo = yolo.checked;
    body.fresh = fresh.checked;
    startBtn.disabled = true;
    api('/api/sessions', { method: 'POST', body })
      .then((s) => {
        toast(`sessão ${s.harness} iniciada (pid ${s.pid})`, 'ok');
        openTermWindow({ id: s.id, harness: s.harness, cwd: s.cwd }, onStatus);
        refreshList().catch(() => {});
      })
      .catch((err) => toast(err.message, 'err'))
      .finally(() => { startBtn.disabled = false; });
  });

  // sessões ai-memory run vivas fora do painel (no terminal do usuário)
  const hostEl = el('div', { class: 'stack', style: 'gap:6px' });

  async function refreshHost() {
    try {
      const { items } = await api('/api/host-sessions');
      hostEl.replaceChildren();
      if (!items.length) {
        hostEl.append(el('div', { class: 'card empty', text: 'nenhum ai-memory run vivo fora do painel' }));
        return;
      }
      hostEl.append(
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'harness' }), el('th', { text: 'terminal' }), el('th', { text: 'iniciada' }), el('th', { text: 'pid' }), el('th', { text: '' }),
          )),
          el('tbody', {}, items.map((p) => el('tr', {},
            el('td', {}, el('span', { class: 'chip chip-info', text: p.kind === 'run' ? (p.harness || p.kind) : p.kind })),
            el('td', { class: 'mono small', text: p.tty || '—' }),
            el('td', { class: 'small muted', text: p.started ? timeAgo(p.started) : '—' }),
            el('td', { class: 'mono small', text: String(p.pid) }),
            el('td', { class: 'row', style: 'gap:6px' }, p.protected ? [
              el('span', { class: 'chip', title: 'pid em .protected-pids.json — o painel não oferece ações para ele', text: '🔒 protegido' }),
            ] : [
              p.kind === 'run' && p.cwd && p.harness && p.isRepo ? el('button', {
                class: 'btn btn-primary btn-sm',
                text: 'Retomar no painel',
                title: `Cria uma sessão do painel em ${p.cwd} (o harness restaura a conversa mais recente) e encerra o processo externo`,
                onclick: () => confirmModal({
                  title: `Retomar ${p.harness} no painel`,
                  message: `Abre uma sessão do painel em ${p.cwd} sem --fresh (o harness restaura a conversa mais recente) e encerra o processo externo do terminal ${p.tty || '—'}. O ai-memory segura um lease do workstream por ~90s após o processo morrer, então pode levar alguns minutos. Continuar?`,
                  word: 'retomar',
                  onConfirm: async () => {
                    toast('retomando: encerrando o processo externo e aguardando a liberação do workstream…');
                    try {
                      const nova = await api('/api/host-sessions/retomar', { method: 'POST', body: { pid: p.pid } });
                      toast(`sessão retomada no painel (pid ${nova.pid})`, 'ok');
                      openTermWindow({ id: nova.id, harness: nova.harness, cwd: nova.cwd }, onStatus);
                    } catch (err) {
                      toast(err.message, 'err');
                      if (err.detail) {
                        modal({ title: 'Detalhe do erro', bodyNode: el('div', { class: 'codeblock', text: err.detail }), actions: [{ label: 'Fechar' }] });
                      }
                    }
                    refreshHost().catch(() => {});
                    refreshList().catch(() => {});
                  },
                }),
              }) : null,
              el('button', {
                class: 'btn btn-danger btn-sm',
                text: 'Encerrar',
                title: 'Envia SIGTERM ao processo (o painel não tem o I/O dele)',
                onclick: () => confirmModal({
                  title: `Encerrar ${p.kind === 'run' ? (p.harness || 'run') : p.kind} (pid ${p.pid})`,
                  message: `Processo no terminal ${p.tty || '—'}, vivo há ${p.started ? timeAgo(p.started) : '?'}. Enviar SIGTERM?`,
                  word: 'encerrar',
                  danger: true,
                  onConfirm: async () => {
                    try {
                      await api('/api/host-sessions/kill', { method: 'POST', body: { pid: p.pid } });
                      toast('processo encerrado', 'ok');
                    } catch (err) {
                      toast(err.message, 'err');
                    }
                    refreshHost().catch(() => {});
                  },
                }),
              }),
              p.kind === 'run' && p.cwd && !p.isRepo ? el('span', { class: 'chip chip-warn', title: `${p.cwd} não tem .git — o ai-memory run tende a falhar aqui`, text: 'não é repo' }) : null,
            ].filter(Boolean),
          ))),
        ),
      ));
    } catch (err) {
      hostEl.replaceChildren(el('div', { class: 'card empty', text: `erro ao listar processos: ${err.message}` }));
    }
  }

  main.append(
    el('div', { class: 'card stack' },
      el('strong', { text: 'ai-memory run' }),
      el('div', { class: 'small muted', text: 'Lança um agente (harness) dentro de um workstream gerenciado pelo ai-memory, com hooks e MCP autowired. Requer um diretório de repositório.' }),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' },
        el('div', {}, el('label', { class: 'field-label', text: 'harness' }), harnessSel),
        el('div', { style: 'flex:1; min-width:240px' },
          el('label', { class: 'field-label', text: 'diretório do projeto' }),
          el('div', { class: 'row' }, cwdInput, browseBtn),
        ),
        el('div', {}, el('label', { class: 'field-label', text: 'workstream' }), wsMode),
        el('div', { style: 'flex:1; min-width:180px' }, el('label', { class: 'field-label', text: 'nome' }), wsName),
      ),
      el('div', { class: 'row' },
        el('label', { class: 'check' }, yolo, '--yolo (permissivo)'),
        el('label', { class: 'check' }, fresh, '--fresh (sessão nova)'),
        startBtn,
      ),
    ),
    el('h2', { class: 'view-head' },
      el('span', { text: 'Sessões' }),
      el('button', { class: 'btn btn-secondary btn-sm', text: 'limpar encerradas', title: 'Remove da lista todas as sessões que já terminaram', onclick: clearEnded }),
    ),
    cardsEl,
    el('h2', { class: 'view-head' }, el('span', { text: 'Rodando fora do painel' }), el('span', { class: 'chip', text: 'no seu terminal' })),
    el('div', { class: 'small muted', text: 'Sessões ai-memory run vivas iniciadas fora daqui. O painel não tem o I/O delas — siga nelas onde estão ou encerre por aqui. As iniciadas pelo painel não aparecem nesta lista.' }),
    hostEl,
  );

  loadDirSuggestions();
  await refreshList();
  refreshHost();
  // mantém os cards atualizados (encerramentos feitos por fora, novas sessões); para ao sair da aba
  const poll = setInterval(() => {
    if (!cardsEl.isConnected) {
      clearInterval(poll);
      return;
    }
    refreshList().catch(() => {});
    refreshHost().catch(() => {});
  }, 15_000);
};

// ---------- view: memórias ----------

VIEWS.memories = async (main) => {
  const state = { scopes: [], scopeKey: 'global', items: [], activePath: null };

  const scopeSel = el('select', { class: 'field', style: 'max-width:280px' });
  const searchInput = el('input', { class: 'field', placeholder: 'buscar nas memórias…', autocomplete: 'off', style: 'flex:1' });
  const resultList = el('div', { class: 'stack', style: 'gap:6px' });
  const reader = el('div', { class: 'card stack', style: 'min-height:300px' }, el('div', { class: 'empty', text: 'selecione uma memória à esquerda' }));
  const resultsNote = el('div', { class: 'small muted' });

  async function loadScopes() {
    const { scopes } = await api('/api/scopes');
    state.scopes = scopes;
    scopeSel.replaceChildren(
      el('option', { value: 'global', text: '🌐 Global — todos os projetos' }),
      ...scopes.map((s) => el('option', { value: `${s.workspace}/${s.project}`, text: `${s.workspace} / ${s.project}` })),
    );
    if (scopes.length) state.scopeKey = 'global';
  }

  function currentScope() {
    if (state.scopeKey === 'global') return null;
    const [workspace, project] = state.scopeKey.split('/');
    return { workspace, project };
  }

  function resultNode(item, idx) {
    const meta = [];
    if (item.workspace && item.project) meta.push(`${item.workspace}/${item.project}`);
    if (item.score !== null && item.score !== undefined) {
      const v = Number(item.score);
      // memory_recent usa rank como timestamp (µs); busca usa rank pequeno
      if (Number.isFinite(v) && Math.abs(v) >= 1e12) {
        const ago = timeAgo(v / 1000);
        if (ago) meta.push(ago);
      } else {
        meta.push(`relevância ${Math.abs(v).toFixed(1)}`);
      }
    }
    if (item.updatedAt) meta.push(timeAgo(item.updatedAt));
    return el(
      'div',
      { class: `result-item ${state.activePath === item.path ? 'active' : ''}`, 'data-idx': String(idx), onclick: () => openPage(item) },
      el('div', { class: 'row-between' },
        el('strong', { style: 'font-size:13px', text: item.title }),
      ),
      el('div', { class: 'mono muted small', style: 'margin-top:2px', text: item.path }),
      item.snippet ? el('div', { class: 'small', style: 'margin-top:4px', html: safeSnippet(item.snippet) }) : null,
      meta.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px; margin-top:6px' }, meta.map((m) => el('span', { class: 'chip', text: String(m).slice(0, 60) }))) : null,
    );
  }

  function renderResults(source, note) {
    resultList.replaceChildren();
    if (!state.items.length) {
      resultList.append(el('div', { class: 'empty', text: note || 'nada encontrado' }));
    } else {
      resultList.append(...state.items.map((item, idx) => resultNode(item, idx)));
    }
    resultsNote.textContent = `${state.items.length} resultado(s)${source ? ` · via ${source}` : ''}${note ? ` · ${note}` : ''}`;
  }

  async function runSearch() {
    const q = searchInput.value.trim();
    const scope = currentScope();
    if (!q) {
      if (scope) await loadRecent();
      else { state.items = []; renderResults(); }
      return;
    }
    resultList.replaceChildren(el('div', { class: 'empty', text: 'buscando…' }));
    try {
      const out = await api('/api/search', { method: 'POST', body: { query: q, limit: 30, ...(scope || {}) } });
      state.items = out.items || [];
      renderResults(out.source, out.note);
    } catch (err) {
      resultList.replaceChildren(el('div', { class: 'empty', text: `erro: ${err.message}` }));
    }
  }

  async function loadRecent() {
    const scope = currentScope();
    if (!scope) {
      state.items = [];
      renderResults(null, 'selecione um projeto para ver as páginas recentes (a busca global cobre tudo)');
      return;
    }
    resultList.replaceChildren(el('div', { class: 'empty', text: 'carregando recentes…' }));
    try {
      const out = await api(`/api/recent?limit=30&workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}`);
      state.items = out.items || [];
      renderResults(out.source, out.note || (state.items.length ? null : 'nenhuma página'));
    } catch (err) {
      resultList.replaceChildren(el('div', { class: 'empty', text: `erro: ${err.message}` }));
    }
  }

  async function openPage(item) {
    state.activePath = item.path;
    for (const node of resultList.querySelectorAll('.result-item')) {
      node.classList.toggle('active', node.dataset.idx !== undefined && state.items[Number(node.dataset.idx)]?.path === item.path);
    }
    reader.replaceChildren(el('div', { class: 'empty', text: 'carregando página…' }));
    try {
      const scope = item.workspace && item.project ? item : currentScope();
      const page = await api(`/api/page?path=${encodeURIComponent(item.path)}${scope?.workspace ? `&workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}` : ''}`);
      const fm = page.frontmatter && typeof page.frontmatter === 'object' ? page.frontmatter : {};
      const chips = [];
      for (const key of ['workspace', 'project']) {
        if (item[key]) chips.push(el('span', { class: 'chip chip-info', text: item[key] }));
      }
      if (fm.kind) chips.push(el('span', { class: 'chip', text: fm.kind }));
      if (fm.tier) chips.push(el('span', { class: 'chip', text: fm.tier }));
      if (fm.pinned) chips.push(el('span', { class: 'chip chip-warn', text: 'pinned' }));
      for (const tag of Array.isArray(fm.tags) ? fm.tags : []) chips.push(el('span', { class: 'chip', text: `#${tag}` }));
      if (fm.updated_at || fm.updatedAt) chips.push(el('span', { class: 'chip', text: timeAgo(fm.updated_at || fm.updatedAt) }));

      let bodyHtml;
      if (window.marked) {
        try { bodyHtml = marked.parse(page.body || ''); } catch { bodyHtml = null; }
      }
      reader.replaceChildren(
        el('div', { class: 'row-between' },
          el('h2', { style: 'margin:0; font-size:16px', text: page.title }),
          el('span', { class: 'mono small muted', text: page.path }),
        ),
        chips.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, chips) : null,
        bodyHtml
          ? el('div', { class: 'md-body', html: bodyHtml })
          : el('div', { class: 'codeblock', text: page.body || '(página vazia)' }),
      );
    } catch (err) {
      reader.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `erro: ${err.message}` })));
    }
  }

  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 400);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounce); runSearch(); }
  });
  scopeSel.addEventListener('change', () => {
    state.scopeKey = scopeSel.value;
    state.activePath = null;
    searchInput.value = '';
    if (currentScope()) loadRecent();
    else { state.items = []; renderResults(null, 'modo global: use a busca'); }
  });

  main.append(
    el('div', { class: 'card' },
      el('div', { class: 'row', style: 'flex-wrap:wrap' }, scopeSel, searchInput),
      el('div', { class: 'small muted', style: 'margin-top:6px', text: 'Busca global cobre todos os projetos; escolhendo um projeto, as páginas recentes aparecem sem digitar nada.' }),
    ),
    el('div', { class: 'split' },
      el('div', { class: 'stack' }, resultsNote, resultList),
      reader,
    ),
  );

  await loadScopes();
  await runSearch();
};

// ---------- init ----------

refreshServerChip();
route();
