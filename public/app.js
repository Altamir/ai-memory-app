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
    if (data?.needsForce) err.needsForce = true;
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
  import: 'Importar memórias',
  skills: 'Skills dos harnesses',
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
//
// A tela é montada a partir do catálogo do servidor (server/spec.mjs):
// escopo, efeitos colaterais, flags e confirmação vêm de lá — o frontend não
// repete metadado nenhum, então a tela não sai de sincronia com a whitelist.

const EFFECT_CHIPS = [
  ['readOnly', 'somente leitura', 'chip'],
  ['writesStore', 'escreve no store', 'chip chip-info'],
  ['deletesData', 'apaga dados', 'chip chip-err'],
  ['blocksWrites', 'bloqueia escritas', 'chip chip-warn'],
  ['costsTokens', 'consome tokens', 'chip chip-warn'],
  ['touchesGit', 'git do wiki', 'chip'],
  ['writesFile', 'escreve arquivo', 'chip'],
];

function effectChips(cmd) {
  return EFFECT_CHIPS
    .filter(([key]) => cmd.effects?.[key])
    .map(([key, label, cls]) => el('span', { class: cls, text: label, title: key }));
}

/** Valor da flag como a tela enviaria (default do spec quando não informado). */
function flagDefault(cmd, key) {
  return (cmd.flags || []).find((f) => f.key === key)?.def;
}

/** Confirmação exigida para ESTAS opções (o spec pode exigir só fora do dry-run). */
function confirmFor(cmd, options) {
  if (!cmd.confirm) return null;
  if (cmd.confirm.when) {
    const raw = options?.[cmd.confirm.when.flag];
    const v = raw === undefined ? flagDefault(cmd, cmd.confirm.when.flag) : raw;
    if (v !== cmd.confirm.when.value) return null;
  }
  return cmd.confirm;
}

function sysLine(text) {
  return el('div', { class: 'small muted', text });
}

/** Cabeçalho de seção de um bloco de ajuda. */
function helpSection(title, ...children) {
  return el('div', { class: 'stack', style: 'gap:4px' },
    el('div', { class: 'field-label', text: title }),
    ...children,
  );
}

function argvBlock(lines) {
  return el('div', { class: 'codeblock mono', text: lines.join(' ') });
}

function bullets(items) {
  return el('ul', { class: 'small', style: 'margin:4px 0; padding-left:18px' }, ...items.map((t) => el('li', { text: t })));
}

function scopeText(cmd, scopeLabel) {
  if (cmd.scope === 'global') {
    return `Global: age na store INTEIRA — todos os workspaces e projetos. O seletor de escopo não muda nada aqui.`;
  }
  if (cmd.scopeInput === 'own-flag') {
    return `Um projeto por execução. O campo "projeto" manda; se ficar vazio, usa o projeto do seletor de escopo (hoje: ${scopeLabel}).`;
  }
  return `Um projeto por execução — hoje: ${scopeLabel}. Não existe modo "todos os projetos": para varrer tudo, rode uma vez por projeto.`;
}

let activeEs = null;
// cresce a cada "ver log"/Executar: descarta o resultado de um clique que ficou obsoleto
let showJobSeq = 0;

function stopLogStream() {
  if (activeEs) { activeEs.close(); activeEs = null; }
}

async function showJob(jobId, panel, statusChip, { scopeNote = null } = {}) {
  // o histórico de jobs vive em memória no servidor: depois de um restart do
  // painel o id não existe mais, e abrir o stream só falharia em silêncio
  const seq = (showJobSeq += 1);
  let job;
  try {
    job = await api(`/api/jobs/${jobId}`);
  } catch {
    toast('log indisponível: o painel foi reiniciado depois desta execução', 'err');
    return;
  }
  // outro clique aconteceu enquanto este buscava: o último vence
  if (seq !== showJobSeq) return;
  stopLogStream();
  // o botão "ver log" abre o painel por aqui (ao contrário de um job novo, que
  // já vem de um clique em Executar): sem isso o log roda num painel escondido
  panel.style.display = '';
  panel.dataset.onDone = 'history';
  // job.args já começa pelo nome do comando (é o argv completo)
  const argv = (job.args || []).length ? job.args.join(' ') : job.command;
  panel.querySelector('[data-job-label]').textContent = [argv, scopeNote].filter(Boolean).join('   ·   ');

  const log = panel.querySelector('.log-panel');
  log.replaceChildren();
  log.dataset.autoscroll = 'true';
  // onscroll (e não addEventListener): showJob roda a cada "ver log" e os
  // listeners se acumulariam no mesmo elemento
  log.onscroll = () => {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.dataset.autoscroll = String(atBottom);
  };
  statusChip.className = 'chip chip-info';
  statusChip.textContent = job.status === 'running' ? 'executando…' : 'carregando log…';

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
      el('td', {}, el('button', { class: 'btn btn-secondary btn-sm', text: 'ver log', onclick: async () => {
        // o painel só é revelado dentro do showJob: rolar antes não faria nada
        await showJob(j.id, panel, statusChip);
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } })),
    ));
  }
  const table = histCard.querySelector('table');
  table.replaceChildren(el('thead', {}, el('tr', {},
    el('th', { text: 'quando' }), el('th', { text: 'comando' }), el('th', { text: 'status' }), el('th', { text: 'duração' }), el('th', { text: '' }),
  )), tbody);
}

/** Modal de ajuda: o que o comando faz, o que ele toca e a linha de comando exata. */
async function commandHelp(cmd, ctxInfo) {
  const { getOptions, advancedEls } = ctxInfo;
  const scopeLabel = ctxInfo.scopeLabel();
  const options = getOptions();
  const argvBox = el('div', { class: 'small muted', text: 'montando a linha de comando…' });
  const confirmBox = el('div', { class: 'small' });
  const body = el('div', { class: 'stack' },
    el('div', { class: 'small', text: cmd.details || cmd.summary }),
    helpSection('Efeitos colaterais',
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' }, ...effectChips(cmd)),
      cmd.sideEffects?.length ? bullets(cmd.sideEffects) : sysLine('nenhum declarado — ainda assim, confira a linha de comando'),
    ),
    helpSection('Onde age (escopo)', el('div', { class: 'small', text: scopeText(cmd, scopeLabel) })),
    helpSection('Confirmação', confirmBox),
    helpSection('Linha de comando', argvBox, sysLine('caminhos de saída em branco recebem data/hora no momento da execução.')),
    advancedEls.length
      ? helpSection('Opções avançadas',
        el('div', { class: 'stack' }, advancedEls),
        sysLine('valores preenchidos aqui valem para o próximo "Executar".'))
      : null,
    sysLine(`tempo máximo: ${fmtDuration(cmd.timeoutMs)} · id: ${cmd.id}`),
  );

  const updateConfirm = () => {
    const need = confirmFor(cmd, getOptions());
    confirmBox.replaceChildren(...(need
      ? [el('span', { class: 'chip chip-err', text: `digitar "${need.word}"` }),
        el('div', { class: 'small muted', text: need.hint || 'Operação destrutiva ou bloqueante: exige digitar o nome do comando.' })]
      : [el('span', { class: 'chip chip-ok', text: 'não exige confirmação' })]));
  };
  updateConfirm();

  modal({
    title: `${cmd.label} · ${cmd.id}`,
    wide: true,
    bodyNode: body,
    actions: [{ label: 'Fechar' }],
  });

  try {
    // fill: campos ainda vazios viram <placeholder> nesta linha — o Executar valida de verdade
    const pv = await api('/api/jobs', { method: 'POST', body: { command: cmd.id, options, scope: ctxInfo.scope(), preview: true, fill: true } });
    argvBox.replaceChildren(
      argvBlock([`${ctxInfo.bin} --data-dir ${ctxInfo.dataDir}`, ...pv.args]),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
        el('span', { class: 'chip', text: cmd.scope === 'global' ? 'global (toda a store)' : `projeto: ${pv.scope?.project || scopeLabel}` }),
        cmd.timeoutMs ? el('span', { class: 'chip', text: `máx ${fmtDuration(cmd.timeoutMs)}` }) : null,
      ),
    );
  } catch (err) {
    argvBox.replaceChildren(el('div', { class: 'small', text: `não deu para montar sem preencher os campos: ${err.message}` }));
  }
}

/** Modal de confirmação digitada, mostrando a linha de comando e os efeitos. */
function confirmRunModal(cmd, preview, scopeLabel, onConfirm) {
  const input = el('input', { class: 'field', placeholder: `digite "${preview.confirmWord}" para confirmar`, autocomplete: 'off' });
  const confirmBtn = el('button', { class: 'btn btn-danger', text: 'Confirmar', disabled: true });
  input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== preview.confirmWord; });
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  const close = modal({
    title: `Executar ${cmd.label}`,
    bodyNode: el('div', { class: 'stack' },
      el('div', { class: 'small', text: cmd.summary }),
      el('div', { class: 'small muted', text: preview.confirmHint || 'Operação destrutiva ou bloqueante.' }),
      helpSection('Escopo', el('div', { class: 'small', text: scopeText(cmd, scopeLabel) })),
      cmd.sideEffects?.length ? helpSection('O que vai acontecer', bullets(cmd.sideEffects)) : null,
      helpSection('Linha de comando', argvBlock(preview.args)),
      input,
    ),
    actions: [confirmBtn],
  });
  setTimeout(() => input.focus(), 50);
}

async function runCommand(cmd, ctxInfo) {
  const options = ctxInfo.getOptions();
  const scope = ctxInfo.scope();
  // o preview valida as opções (e devolve a linha exata) antes de qualquer coisa
  let preview;
  try {
    preview = await api('/api/jobs', { method: 'POST', body: { command: cmd.id, options, scope, preview: true } });
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const start = (confirm) => {
    api('/api/jobs', { method: 'POST', body: { command: cmd.id, options, scope, confirm } })
      .then((job) => {
        const { panel, statusChip, root } = ctxInfo;
        const target = cmd.scope === 'global' ? 'escopo global (toda a store)' : `escopo: ${ctxInfo.scopeLabel()}`;
        showJob(job.id, panel, statusChip, { scopeNote: target })
          .then(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
        refreshHistory(root, panel, statusChip);
        toast(`job iniciado: ${job.command}`);
      })
      .catch((err) => toast(err.message, 'err'));
  };
  if (preview.confirmWord) {
    confirmRunModal(cmd, preview, ctxInfo.scopeLabel(), () => start(preview.confirmWord));
  } else {
    start(undefined);
  }
}

function commandCard(cmd, ctxInfo) {
  const inputs = {};
  const basicEls = [];
  const advancedEls = [];

  for (const f of cmd.flags || []) {
    const label = f.label || f.flag || f.key;
    const hint = f.help ? el('div', { class: 'small muted', text: f.help }) : null;
    let wrapper;
    if (f.type === 'bool') {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = f.def === true;
      inputs[f.key] = () => cb.checked;
      wrapper = el('div', {}, el('label', { class: 'check' }, cb, label), hint);
    } else if (f.type === 'number') {
      const inp = el('input', { class: 'field', type: 'number', style: 'max-width:110px', value: f.def ?? '' });
      inputs[f.key] = () => (inp.value === '' ? undefined : Number(inp.value));
      wrapper = el('div', {}, el('label', { class: 'field-label', text: label }), inp, hint);
    } else if (f.type === 'select') {
      const sel = el('select', { class: 'field', style: 'max-width:220px' },
        ...(f.def === undefined ? [el('option', { value: '', text: '…' })] : []),
        ...(f.options || []).map((o) => el('option', { value: o, text: o })),
      );
      if (f.def !== undefined) sel.value = f.def;
      inputs[f.key] = () => (sel.value === '' ? undefined : sel.value);
      wrapper = el('div', {}, el('label', { class: 'field-label', text: label }), sel, hint);
    } else {
      const inp = el('input', { class: 'field', type: 'text', placeholder: f.placeholder || '', autocomplete: 'off', value: f.def ?? '' });
      inputs[f.key] = () => (inp.value.trim() === '' ? undefined : inp.value.trim());
      wrapper = el('div', {}, el('label', { class: 'field-label', text: label }), inp, hint);
    }
    (f.advanced ? advancedEls : basicEls).push(wrapper);
  }

  const getOptions = () => {
    const options = {};
    for (const [k, get] of Object.entries(inputs)) {
      const v = get();
      if (v !== undefined) options[k] = v;
    }
    return options;
  };

  const scopeLabel = el('span', { class: 'chip' });
  const refreshScope = () => {
    if (cmd.scope === 'global') {
      scopeLabel.className = 'chip';
      scopeLabel.textContent = 'global · toda a store';
      scopeLabel.title = 'Age em todos os workspaces e projetos; o seletor de escopo não se aplica.';
    } else {
      scopeLabel.className = 'chip chip-info';
      scopeLabel.textContent = `projeto: ${ctxInfo.scopeLabel()}`;
      scopeLabel.title = 'Age em UM projeto por execução (veja o botão ? para detalhes).';
    }
  };
  refreshScope();
  ctxInfo.onScopeChange.push(refreshScope);

  const card = el('div', { class: 'card stack' },
    el('div', { class: 'row-between' },
      el('strong', { text: cmd.label }),
      el('div', { class: 'row', style: 'gap:4px' }, scopeLabel,
        el('button', { class: 'btn btn-secondary btn-sm', text: '?', title: 'o que este comando faz, o que ele toca e a linha de comando', onclick: () => commandHelp(cmd, { ...ctxInfo, getOptions, advancedEls }) }),
      ),
    ),
    el('div', { class: 'small muted mono', text: cmd.id }),
    el('div', { class: 'small muted', text: cmd.summary }),
    el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' }, ...effectChips(cmd)),
    basicEls.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px; align-items:flex-end' }, basicEls) : null,
    el('div', {}, el('button', {
      class: `btn ${cmd.group === 'danger' ? 'btn-danger' : 'btn-primary'} btn-sm`,
      text: 'Executar',
      onclick: () => runCommand(cmd, { ...ctxInfo, getOptions }),
    })),
  );
  return card;
}

VIEWS.maintenance = async (main) => {
  const root = el('div', { class: 'stack' });
  main.append(root);
  root.append(el('div', { class: 'empty', text: 'carregando catálogo de manutenção…' }));

  let catalog;
  try {
    catalog = await api('/api/maintenance');
  } catch (err) {
    root.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro ao carregar o catálogo: ${err.message}` })));
    return;
  }
  let scopes = [];
  try {
    scopes = (await api('/api/scopes')).scopes || [];
  } catch {
    scopes = [];
  }
  // escopo implícito: é o que a CLI resolve pela pasta do painel quando o
  // seletor fica em "automático" — vale mostrar, não adivinhar
  let resolved = null;
  try {
    resolved = await api('/api/maintenance/scope');
  } catch (err) {
    resolved = { error: err.message };
  }

  const state = { mode: 'auto', workspace: '', project: '', onScopeChange: [] };

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

  // ---- seletor de escopo ----
  const scopeSel = el('select', { class: 'field', style: 'max-width:340px' });
  const wsInput = el('input', { class: 'field', style: 'max-width:180px', placeholder: 'workspace', autocomplete: 'off' });
  const projInput = el('input', { class: 'field', style: 'max-width:220px', placeholder: 'projeto', autocomplete: 'off' });
  const manualRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; display:none' }, wsInput, projInput);
  const effectiveChip = el('span', { class: 'chip chip-info' });

  const resolvedLabel = resolved?.workspace && resolved?.project
    ? `${resolved.workspace}/${resolved.project}`
    : null;

  function scopeLabelFor() {
    if (state.mode === 'manual') {
      const ws = state.workspace || '?';
      const pr = state.project || '?';
      return `${ws}/${pr} (digitado)`;
    }
    if (state.mode === 'pick') return `${state.workspace}/${state.project}`;
    return resolvedLabel
      ? `${resolvedLabel} (automático, cwd do painel)`
      : 'projeto do cwd do painel (não resolvido)';
  }

  function currentScope() {
    if (state.mode === 'manual') {
      const ws = state.workspace.trim();
      const pr = state.project.trim();
      if (!ws && !pr) return null;
      return { workspace: ws || null, project: pr || null };
    }
    if (state.mode === 'pick') return { workspace: state.workspace, project: state.project };
    return null; // automático: deixa a CLI resolver do cwd
  }

  function syncEffective() {
    const scopes2 = {
      auto: resolvedLabel ? `automático → ${resolvedLabel}` : 'automático → resolvido pela CLI (cwd do painel)',
      pick: `${state.workspace}/${state.project}`,
      manual: `${state.workspace || '?'}/${state.project || '?'}`,
    };
    effectiveChip.textContent = `comandos por projeto: ${scopes2[state.mode]}`;
    manualRow.style.display = state.mode === 'manual' ? '' : 'none';
    for (const fn of state.onScopeChange) fn();
  }

  scopeSel.addEventListener('change', () => {
    const v = scopeSel.value;
    if (v === 'auto') { state.mode = 'auto'; state.workspace = ''; state.project = ''; }
    else if (v === 'manual') { state.mode = 'manual'; state.workspace = ''; state.project = ''; }
    else {
      const [ws, pr] = v.split('/');
      state.mode = 'pick';
      state.workspace = ws;
      state.project = pr;
    }
    syncEffective();
  });
  wsInput.addEventListener('input', () => { state.workspace = wsInput.value; syncEffective(); });
  projInput.addEventListener('input', () => { state.project = projInput.value; syncEffective(); });

  scopeSel.replaceChildren(
    el('option', { value: 'auto', text: 'automático — a CLI resolve pela pasta do painel' }),
    ...scopes.map((s) => el('option', { value: `${s.workspace}/${s.project}`, text: `${s.workspace} / ${s.project}${s.path ? ` — ${s.path}` : ''}` })),
    el('option', { value: 'manual', text: 'digitar workspace/projeto…' }),
  );
  syncEffective();

  const ctxInfo = {
    getOptions: () => ({}),
    scope: currentScope,
    scopeLabel: scopeLabelFor,
    onScopeChange: state.onScopeChange,
    bin: catalog.runtime?.bin || 'ai-memory',
    dataDir: catalog.runtime?.dataDir || '',
    root,
    panel,
    statusChip,
  };

  // ---- cabeçalho explicativo ----
  const globalCmds = catalog.commands.filter((c) => c.scope === 'global');
  const projCmds = catalog.commands.filter((c) => c.scope !== 'global');
  const header = el('div', { class: 'card stack' },
    el('div', { class: 'row-between' },
      el('strong', { text: 'Como esta tela executa' }),
      el('button', {
        class: 'btn btn-secondary btn-sm',
        text: '? entender a manutenção',
        onclick: () => modal({
          title: 'Manutenção do ai-memory — como funciona',
          wide: true,
          bodyNode: el('div', { class: 'stack' },
            helpSection('Quem executa',
              el('div', { class: 'small', text: `Cada botão roda o binário ${catalog.runtime?.bin} como um processo separado, com o data-dir ${catalog.runtime?.dataDir}, e transmite a saída ao vivo. Nada de shell: os args vêm de uma whitelist no servidor.` }),
            ),
            helpSection('Escopo: global ou um projeto',
              bullets([
                `${projCmds.length} comandos agem em UM projeto por execução (doctor, curator, lint, forget-sweep, finalize-session, embed, backfill, bootstrap, restore-page, purge-*, export-okf).`,
                `${globalCmds.length} comandos agem na store INTEIRA — todos os workspaces e projetos (compact, reindex, backup, restore, checkpoints, commit, reset, reorg, llm-test, audit-contamination).`,
                'Não existe "todos os projetos" num comando por projeto: para varrer tudo, rode uma vez por projeto.',
                'No modo automático, o comando por projeto cai no projeto que a CLI deriva da pasta onde o painel foi iniciado — não é o projeto que você está navegando em Memórias.',
              ]),
            ),
            helpSection('A store e o data-dir',
              el('div', { class: 'small', text: `A store real vive no servidor ai-memory (${catalog.runtime?.serverUrl}). O data-dir acima é o lado cliente (token, config) — e é o alvo de reset/restore/reindex. Se o servidor roda em Docker, confira qual volume está montado antes de usar esses três.` }),
            ),
            helpSection('Rede de segurança',
              el('div', { class: 'small', text: 'Os botões destrutivos exigem digitar o nome do comando e mostram a linha exata antes. Um Backup antes de purge/reset/reindex é sempre uma boa ideia.' }),
            ),
          ),
          actions: [{ label: 'Fechar' }],
        }),
      }),
    ),
    el('div', { class: 'small muted', text: 'Os comandos por projeto usam o escopo escolhido abaixo. Os globais ignoram o seletor e avisam no próprio card.' }),
    el('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px; align-items:center' },
      el('span', { class: 'small muted', text: 'escopo dos comandos por projeto:' }),
      scopeSel,
      manualRow,
    ),
    el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; align-items:center' },
      effectiveChip,
      el('span', { class: 'small muted', text: scopes.length ? `${scopes.length} projeto(s) vinculado(s) no client-projects.json — ou digite outro` : 'nenhum projeto vinculado; use "digitar workspace/projeto" para apontar outro' }),
    ),
    el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
      el('span', { class: 'chip mono', text: catalog.runtime?.bin || 'ai-memory' }),
      el('span', { class: 'chip mono', text: `--data-dir ${catalog.runtime?.dataDir || '?'}` }),
      el('span', { class: 'chip mono', text: `store ${catalog.runtime?.serverUrl || '?'}` }),
      resolved && resolved.error ? el('span', { class: 'chip chip-warn', text: `escopo do cwd não resolvido: ${resolved.error}` }) : null,
      resolved && resolved.uncaptured ? el('span', { class: 'chip chip-warn', text: `${resolved.uncaptured} harness sem captura no projeto do cwd` }) : null,
    ),
  );

  // ---- seções ----
  const sections = el('div', { class: 'stack' });
  const historyCard = el('div', { class: 'card stack', 'data-history': '1' },
    el('div', { class: 'row-between' },
      el('strong', { text: 'Execuções recentes' }),
      el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => refreshHistory(root, panel, statusChip) }),
    ),
    el('table', { class: 'table' }),
  );

  const renderSections = () => {
    state.onScopeChange.length = 0; // os closures dos cards antigos morrem com eles
    sections.replaceChildren();
    for (const group of catalog.groups) {
      const cmds = catalog.commands.filter((c) => c.group === group.id);
      if (!cmds.length) continue;
      sections.append(
        el('h2', { class: 'view-head' },
          el('span', { text: group.label }),
          el('span', { class: 'chip', text: `${cmds.length} comando${cmds.length > 1 ? 's' : ''}` }),
        ),
        group.hint ? el('div', { class: 'small muted', style: 'margin:-4px 0 6px', text: group.hint }) : null,
        el('div', { class: 'grid grid-cards' }, cmds.map((c) => commandCard(c, ctxInfo))),
      );
    }
    syncEffective();
  };
  renderSections();

  root.replaceChildren(header, sections, historyCard, panel);
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

// ---------- view: importar memórias (Grok / Kiro) ----------

const IMPORT_STATUS = {
  new: { cls: 'chip-info', label: 'novo' },
  changed: { cls: 'chip-warn', label: 'alterado' },
  same: { cls: 'chip-ok', label: 'já importado' },
  duplicate: { cls: 'chip', label: 'duplicado' },
  collision: { cls: 'chip-err', label: 'mesma página' },
};
const NO_TARGET = '∅';

VIEWS.import = async (main) => {
  const state = {
    sources: [],
    runtime: null,
    links: [],
    source: null,
    scan: null,
    query: '',
    showRaw: true,
    only: 'all',
    selected: new Set(),
    overrides: {},
    busy: false,
  };

  const runtimeChips = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' });
  const sourcesGrid = el('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fill, minmax(330px, 1fr))' });
  const scanHost = el('div', { class: 'stack' });
  const statusChip = el('span', { class: 'chip', text: 'idle' });
  const logCard = el(
    'div',
    { class: 'card stack', style: 'display:none' },
    el('div', { class: 'row-between' },
      el('div', { class: 'row' }, el('strong', { text: 'Log da importação' }), el('span', { class: 'mono small muted', 'data-job-label': '', text: '' })),
      el('div', { class: 'row' }, statusChip, el('button', { class: 'btn btn-secondary btn-sm', text: 'fechar', onclick: () => { stopLogStream(); logCard.style.display = 'none'; } })),
    ),
    el('div', { class: 'log-panel' }),
  );
  const historyCard = el('div', { class: 'card stack' });

  const headerCard = el('div', { class: 'card stack' },
    el('div', { class: 'row-between' },
      el('strong', { text: 'De onde vêm as memórias' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => loadSources() }),
        el('button', { class: 'btn btn-secondary btn-sm', text: '? como funciona', onclick: importHelpModal }),
      ),
    ),
    el('div', { class: 'small muted', text: 'O painel lê as memórias curadas do Grok e do Kiro no seu home, resolve o projeto de cada uma pelos vínculos do client-projects.json e grava páginas no ai-memory (via MCP, com a CLI como reserva). Nada é gravado antes de você revisar a lista: o scan é somente leitura e cada item pode ser aberto, redirecionado ou descartado.' }),
    runtimeChips,
  );

  main.append(el('div', { class: 'stack' }, headerCard, sourcesGrid, scanHost, logCard, historyCard));

  // ---- fontes ----

  async function loadSources() {
    sourcesGrid.replaceChildren(el('div', { class: 'empty', text: 'lendo fontes…' }));
    let data;
    try {
      data = await api('/api/import/sources');
    } catch (err) {
      sourcesGrid.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${err.message}` })));
      return;
    }
    state.sources = data.sources || [];
    state.runtime = data.runtime || null;
    try {
      state.links = (await api('/api/scopes')).scopes || [];
    } catch {
      state.links = [];
    }
    renderRuntime();
    renderSources();
    await renderHistory();
  }

  function renderRuntime() {
    const rt = state.runtime;
    if (!rt) return;
    runtimeChips.replaceChildren(
      el('span', { class: 'chip mono', text: `grok ${rt.grokDir}` }),
      el('span', { class: 'chip mono', text: `kiro ${rt.kiroDir}` }),
      el('span', { class: `chip ${rt.sqlite ? 'chip-ok' : 'chip-warn'}`, text: rt.sqlite ? 'sqlite3 ok (memórias do crew)' : 'sqlite3 ausente (crew fica de fora)' }),
      el('span', { class: 'chip', text: `${rt.links} projeto(s) vinculado(s)` }),
      rt.bin ? el('span', { class: 'chip mono', text: `escreve via ${'memory_write_page'} ou ${rt.bin} write-page` }) : null,
    );
  }

  function renderSources() {
    sourcesGrid.replaceChildren(...state.sources.map(sourceCard));
    if (!state.sources.length) sourcesGrid.append(el('div', { class: 'empty', text: 'nenhuma fonte configurada' }));
  }

  function sourceCard(src) {
    const last = src.lastRun;
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: src.label }),
        el('span', { class: `chip ${src.available ? 'chip-ok' : 'chip-err'}`, text: src.available ? 'disponível' : 'não encontrada' }),
      ),
      el('div', { class: 'mono small muted', text: src.root }),
      el('div', { class: 'small muted', text: src.hint }),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' },
        el('span', { class: 'chip', text: `${src.counts.curated} entrada(s) curada(s)` }),
        el('span', { class: 'chip', text: `${src.counts.raw} cru(s)` }),
        last
          ? el('span', { class: `chip ${last.failed ? 'chip-warn' : 'chip-ok'}`, text: last.dryRun ? `dry-run ${timeAgo(last.endedAt) || 'agora'} · ${last.planned} simulada(s)` : `último: ${timeAgo(last.endedAt) || 'agora'} · ${last.imported} importada(s)${last.failed ? ` · ${last.failed} falha(s)` : ''}` })
          : el('span', { class: 'chip', text: 'nunca importado' }),
      ),
      src.warnings.length ? el('div', { class: 'small', style: 'color:var(--attention)', text: src.warnings.slice(0, 3).join(' · ') }) : null,
      el('div', {}, el('button', {
        class: 'btn btn-primary btn-sm',
        text: 'Escanear',
        disabled: !src.available,
        onclick: () => doScan(src.id),
      })),
    );
  }

  // ---- scan ----

  async function doScan(id) {
    state.source = id;
    state.selected = new Set();
    state.overrides = {};
    state.scan = null;
    state.busy = true;
    scanHost.replaceChildren(el('div', { class: 'empty', text: `escaneando ${id}…` }));
    let scan;
    try {
      scan = await api('/api/import/scan', { method: 'POST', body: { source: id } });
    } catch (err) {
      scanHost.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro no scan: ${err.message}` })));
      state.busy = false;
      return;
    }
    state.busy = false;
    state.scan = scan;
    // sugestão inicial: memória curada, nova/alterada e com destino resolvido
    for (const it of scan.items) {
      if (!it.raw && it.target && (it.status === 'new' || it.status === 'changed')) state.selected.add(it.key);
    }
    renderScan();
  }

  function effectiveGroup(item) {
    const ov = state.overrides[item.key];
    if (ov?.global) return '_global';
    if (ov?.workspace && ov?.project) return `${ov.workspace}/${ov.project}`;
    if (item.target?.global) return '_global';
    if (item.target) return `${item.target.workspace}/${item.target.project}`;
    return NO_TARGET;
  }

  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    return (state.scan?.items || []).filter((it) => {
      if (!state.showRaw && it.raw) return false;
      if (state.only !== 'all' && it.status !== state.only) return false;
      if (q && !`${it.title} ${it.suggested.path} ${it.key}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function chipFilter(label, value, count) {
    const active = state.only === value;
    return el('button', {
      class: `chip chip-btn ${active ? 'chip-info' : ''}`,
      text: `${label} ${count}`,
      onclick: () => { state.only = active ? 'all' : value; renderScan(); },
    });
  }

  function renderScan() {
    if (!state.scan) return;
    const scroll = main.scrollTop;
    const s = state.scan.summary;
    const items = visibleItems();
    const groups = new Map();
    for (const it of items) {
      const g = effectiveGroup(it);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    const order = [...groups.keys()].sort((a, b) => (a === '_global' ? -1 : b === '_global' ? 1 : a === NO_TARGET ? 1 : b === NO_TARGET ? -1 : a.localeCompare(b)));

    const searchInput = el('input', { class: 'field', placeholder: 'filtrar por título, path ou chave…', autocomplete: 'off', value: state.query, style: 'max-width:340px' });
    searchInput.addEventListener('input', () => { state.query = searchInput.value; renderScan(); });

    const selectAll = () => { for (const it of items) state.selected.add(it.key); renderScan(); };
    const clearAll = () => { for (const it of items) state.selected.delete(it.key); renderScan(); };

    const selectedCount = [...state.selected].filter((k) => state.scan.items.some((i) => i.key === k)).length;
    const chosen = state.scan.items.filter((i) => state.selected.has(i.key));
    const counts = { novo: 0, alterado: 0, atualiza: 0, global: 0, proj: 0, noTarget: 0, raw: 0 };
    for (const it of chosen) {
      if (it.status === 'new') counts.novo += 1;
      if (it.status === 'changed') counts.alterado += 1;
      if (it.status === 'same') counts.atualiza += 1;
      if (it.raw) counts.raw += 1;
      const g = effectiveGroup(it);
      if (g === '_global') counts.global += 1;
      else if (g === NO_TARGET) counts.noTarget += 1;
      else counts.proj += 1;
    }

    const actionBar = el('div', { class: 'imp-actions' },
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
        el('strong', { text: `${selectedCount} selecionado(s)` }),
        counts.novo ? el('span', { class: 'chip chip-info', text: `${counts.novo} novo(s)` }) : null,
        counts.alterado ? el('span', { class: 'chip chip-warn', text: `${counts.alterado} atualiza(ão/ções)` }) : null,
        counts.atualiza ? el('span', { class: 'chip', text: `${counts.atualiza} reescrita(s)` }) : null,
        counts.raw ? el('span', { class: 'chip', text: `${counts.raw} cru(s)` }) : null,
        counts.noTarget ? el('span', { class: 'chip chip-err', text: `${counts.noTarget} sem destino — serão pulados` }) : null,
      ),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-secondary btn-sm', text: 'simular (dry-run)', disabled: !selectedCount, onclick: () => startImport(true) }),
        el('button', { class: 'btn btn-primary btn-sm', text: 'Importar selecionados', disabled: !selectedCount, onclick: () => startImport(false) }),
      ),
    );

    const groupNodes = order.map((g) => {
      const list = groups.get(g);
      const header = el('div', { class: 'imp-group' },
        el('strong', { text: g === NO_TARGET ? 'sem destino (escolha um projeto)' : g === '_global' ? '_global (todos os projetos)' : g }),
        el('span', { class: 'chip', text: `${list.length} item(ns)` }),
        el('div', { class: 'row', style: 'gap:4px' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'marcar', onclick: () => { for (const it of list) state.selected.add(it.key); renderScan(); } }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'desmarcar', onclick: () => { for (const it of list) state.selected.delete(it.key); renderScan(); } }),
        ),
      );
      if (g === NO_TARGET) header.append(targetPicker(list));
      return el('div', { class: 'stack', style: 'gap:6px' }, header, ...list.map(itemRow));
    });

    scanHost.replaceChildren(
      el('div', { class: 'card stack' },
        el('div', { class: 'row-between', style: 'flex-wrap:wrap' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('strong', { text: `Scan: ${state.scan.source}` }),
            el('span', { class: 'chip', text: `${s.total} item(ns)` }),
            chipFilter('todos', 'all', s.total),
            chipFilter('novos', 'new', s.new || 0),
            chipFilter('alterados', 'changed', s.changed || 0),
            chipFilter('já importados', 'same', s.same || 0),
            chipFilter('duplicados', 'duplicate', s.duplicate || 0),
            chipFilter('mesma página', 'collision', s.collision || 0),
          ),
          el('div', { class: 'row' },
            el('label', { class: 'check' }, (() => { const cb = el('input', { type: 'checkbox' }); cb.checked = state.showRaw; cb.addEventListener('change', () => { state.showRaw = cb.checked; renderScan(); }); return cb; })(), 'mostrar itens crus (sessões/observações)'),
          ),
        ),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, searchInput,
          el('button', { class: 'btn btn-secondary btn-sm', text: 'marcar visíveis', onclick: selectAll }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'limpar seleção', onclick: clearAll }),
        ),
        state.scan.warnings.length
          ? el('div', { class: 'small', style: 'color:var(--attention)', text: `avisos: ${state.scan.warnings.slice(0, 4).join(' · ')}${state.scan.warnings.length > 4 ? ` (+${state.scan.warnings.length - 4})` : ''}` })
          : null,
        el('div', { class: 'small muted', text: 'itens crus (sessões, observações, diários, episódicos) entram desmarcados por padrão. "duplicado" = o mesmo conteúdo já foi importado por outra fonte; "mesma página" = outro item deste scan quer o mesmo path (importe um por vez).' }),
      ),
      groupNodes.length ? el('div', { class: 'stack' }, ...groupNodes) : el('div', { class: 'empty', text: 'nenhum item com os filtros atuais' }),
      actionBar,
    );
    main.scrollTop = scroll;
  }

  function targetPicker(list) {
    const sel = el('select', { class: 'field', style: 'max-width:360px' },
      el('option', { value: '', text: 'escolher projeto…' }),
      el('option', { value: '__global', text: '→ _global (todos os projetos)' }),
      ...state.links.map((l) => el('option', { value: `${l.workspace}/${l.project}`, text: `${l.workspace} / ${l.project}${l.path ? ` — ${l.path}` : ''}` })),
    );
    return el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' }, sel,
      el('button', {
        class: 'btn btn-secondary btn-sm',
        text: 'aplicar ao grupo',
        onclick: () => {
          if (!sel.value) return;
          for (const it of list) {
            if (sel.value === '__global') state.overrides[it.key] = { ...(state.overrides[it.key] || {}), global: true };
            else {
              const [workspace, project] = sel.value.split('/');
              state.overrides[it.key] = { ...(state.overrides[it.key] || {}), workspace, project };
            }
          }
          renderScan();
        },
      }),
    );
  }

  function itemRow(it) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = state.selected.has(it.key);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(it.key);
      else state.selected.delete(it.key);
      renderScan();
    });
    const st = IMPORT_STATUS[it.status] || { cls: 'chip', label: it.status };
    const ov = state.overrides[it.key];
    const adjusted = Boolean(ov && (ov.global || ov.workspace || ov.path || ov.kind || ov.tier || typeof ov.pinned === 'boolean'));
    return el('div', { class: 'imp-item' },
      el('label', { class: 'check', style: 'align-self:flex-start; margin-top:2px' }, cb),
      el('div', { class: 'stack', style: 'gap:2px; flex:1; min-width:0' },
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('strong', { style: 'font-size:13px', text: it.title }),
          el('span', { class: `chip ${st.cls}`, text: st.label }),
          it.raw ? el('span', { class: 'chip chip-warn', text: 'cru' }) : null,
          it.suggested.pinned ? el('span', { class: 'chip chip-info', text: 'pinned' }) : null,
          el('span', { class: 'chip', text: `${it.suggested.kind} · ${it.suggested.tier}` }),
        ),
        el('div', { class: 'mono small muted', text: it.suggested.path }),
        el('div', { class: 'small muted', style: 'opacity:.8', text: `${it.originKind} · ${it.originPath}` }),
        el('div', { class: 'small muted', text: adjusted ? 'destino/opções ajustados na tela' : it.targetReason }),
      ),
      el('div', { class: 'row', style: 'gap:4px; align-self:flex-start' },
        el('button', { class: 'btn btn-secondary btn-sm', text: 'ver', onclick: () => openItem(it) }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'destino', onclick: () => openTarget(it) }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'opções', onclick: () => openOptions(it) }),
      ),
    );
  }

  // ---- modais de item ----

  async function openItem(it) {
    const box = el('div', { class: 'stack' }, el('div', { class: 'empty', text: 'carregando conteúdo…' }));
    modal({ title: it.title, wide: true, bodyNode: box, actions: [{ label: 'Fechar' }] });
    let full;
    try {
      full = await api('/api/import/item', { method: 'POST', body: { source: state.source, key: it.key } });
    } catch (err) {
      box.replaceChildren(el('div', { class: 'small', text: `Erro: ${err.message}` }));
      return;
    }
    const rt = state.runtime || {};
    const target = effectiveGroup(it);
    const place = target === '_global' ? '--workspace default --project _global' : target === NO_TARGET ? '(escolha um destino)' : `--workspace ${target.split('/')[0]} --project ${target.split('/')[1]}`;
    const argv = `memory_write_page  path=${it.suggested.path}  scope=${target === '_global' ? 'global' : target}  kind=${it.suggested.kind}  tier=${it.suggested.tier}${it.suggested.pinned ? '  pinned' : ''}\n${rt.bin || 'ai-memory'} --data-dir ${rt.dataDir || '?'} write-page --path ${it.suggested.path} --body - ${place} --kind ${it.suggested.kind} --tier ${it.suggested.tier}${it.suggested.pinned ? ' --pinned' : ''}`;
    let bodyHtml = null;
    if (window.marked) {
      try { bodyHtml = marked.parse(full.body || ''); } catch { bodyHtml = null; }
    }
    box.replaceChildren(
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
        el('span', { class: 'chip', text: target === NO_TARGET ? 'sem destino' : target }),
        el('span', { class: 'chip', text: `${(full.body || '').length} chars` }),
        el('span', { class: 'chip', text: full.originKind }),
        el('span', { class: 'chip mono', text: it.suggested.path }),
      ),
      el('div', { class: 'small muted', text: `origem: ${full.originPath}` }),
      bodyHtml ? el('div', { class: 'md-body', html: bodyHtml }) : el('div', { class: 'codeblock', text: full.body || '(vazio)' }),
      helpSection('Como será gravado', el('div', { class: 'codeblock', text: argv })),
    );
  }

  function openTarget(it) {
    const current = effectiveGroup(it);
    const radios = [];
    const group = (value, label) => {
      const radio = el('input', { type: 'radio', name: 'imp-target', value });
      radio.checked = current === value;
      radios.push(radio);
      return el('label', { class: 'check' }, radio, label);
    };
    const sel = el('select', { class: 'field', style: 'max-width:380px' },
      ...state.links.map((l) => el('option', { value: `${l.workspace}/${l.project}`, text: `${l.workspace} / ${l.project}${l.path ? ` — ${l.path}` : ''}` })),
    );
    const listValue = `${(it.target?.workspace || state.links[0]?.workspace || '')}/${(it.target?.project || state.links[0]?.project || '')}`;
    if (state.links.some((l) => `${l.workspace}/${l.project}` === listValue)) sel.value = listValue;

    const wsInput = el('input', { class: 'field', placeholder: 'workspace (digitado)', autocomplete: 'off', style: 'max-width:170px' });
    const prInput = el('input', { class: 'field', placeholder: 'projeto (digitado)', autocomplete: 'off', style: 'max-width:200px' });

    modal({
      title: `Destino · ${it.title}`,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'small muted', text: it.target ? `sugestão do scan: ${it.targetReason}` : it.targetReason }),
        group('__suggest', 'usar a sugestão do scan'),
        group('_global', '→ _global (aparece em todos os projetos)'),
        el('div', { class: 'stack', style: 'gap:4px' }, group('__list', 'projeto vinculado:'), sel),
        el('div', { class: 'stack', style: 'gap:4px' }, group('__custom', 'workspace/projeto digitado:'), el('div', { class: 'row', style: 'flex-wrap:wrap' }, wsInput, prInput)),
        group('__none', 'sem destino (não importar este item)'),
      ),
      actions: [
        {
          label: 'Salvar',
          kind: 'primary',
          onClick: (close) => {
            const picked = radios.find((r) => r.checked)?.value || '__suggest';
            const next = { ...(state.overrides[it.key] || {}) };
            delete next.global;
            delete next.workspace;
            delete next.project;
            if (picked === '_global') next.global = true;
            else if (picked === '__list') {
              const [workspace, project] = sel.value.split('/');
              next.workspace = workspace;
              next.project = project;
            } else if (picked === '__custom') {
              next.workspace = wsInput.value.trim();
              next.project = prInput.value.trim();
              if (!next.workspace || !next.project) {
                delete next.workspace;
                delete next.project;
              }
            } else if (picked === '__none') {
              state.selected.delete(it.key);
            }
            if (Object.keys(next).length) state.overrides[it.key] = next;
            else delete state.overrides[it.key];
            close();
            renderScan();
          },
        },
      ],
    });
  }

  function openOptions(it) {
    const pathInput = el('input', { class: 'field', value: state.overrides[it.key]?.path || it.suggested.path, autocomplete: 'off' });
    const kindSel = el('select', { class: 'field', style: 'max-width:160px' }, ...['fact', 'rule', 'decision', 'gotcha'].map((k) => el('option', { value: k, text: k })));
    kindSel.value = state.overrides[it.key]?.kind || it.suggested.kind;
    const tierSel = el('select', { class: 'field', style: 'max-width:160px' }, ...['working', 'episodic', 'semantic', 'procedural'].map((t) => el('option', { value: t, text: t })));
    tierSel.value = state.overrides[it.key]?.tier || it.suggested.tier;
    const pinCb = el('input', { type: 'checkbox' });
    pinCb.checked = state.overrides[it.key]?.pinned ?? it.suggested.pinned;
    modal({
      title: `Opções · ${it.title}`,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'small muted', text: 'regra → _rules/<slug>.md (pinned), problema → gotchas/, resto → notes/imported/<fonte>/. Ajuste se a heurística errou.' }),
        el('div', {}, el('label', { class: 'field-label', text: 'path no wiki' }), pathInput),
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px; align-items:flex-end' },
          el('div', {}, el('label', { class: 'field-label', text: 'kind' }), kindSel),
          el('div', {}, el('label', { class: 'field-label', text: 'tier' }), tierSel),
          el('label', { class: 'check' }, pinCb, 'pinned'),
        ),
      ),
      actions: [
        {
          label: 'Salvar',
          kind: 'primary',
          onClick: (close) => {
            const next = { ...(state.overrides[it.key] || {}) };
            next.path = pathInput.value.trim();
            next.kind = kindSel.value;
            next.tier = tierSel.value;
            next.pinned = pinCb.checked;
            state.overrides[it.key] = next;
            close();
            renderScan();
          },
        },
      ],
    });
  }

  // ---- importação ----

  function startImport(dryRun) {
    const chosen = (state.scan?.items || []).filter((i) => state.selected.has(i.key));
    if (!chosen.length) return;
    const byStatus = { new: 0, changed: 0, same: 0, duplicate: 0, collision: 0 };
    let global = 0;
    let proj = 0;
    let noTarget = 0;
    let raw = 0;
    for (const it of chosen) {
      byStatus[it.status] = (byStatus[it.status] || 0) + 1;
      if (it.raw) raw += 1;
      const g = effectiveGroup(it);
      if (g === '_global') global += 1;
      else if (g === NO_TARGET) noTarget += 1;
      else proj += 1;
    }
    modal({
      title: dryRun ? 'Simular importação (dry-run)' : `Importar ${chosen.length} item(ns)`,
      wide: true,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('span', { class: 'chip chip-info', text: `${byStatus.new || 0} nova(s)` }),
          el('span', { class: 'chip chip-warn', text: `${byStatus.changed || 0} com nova versão` }),
          el('span', { class: 'chip', text: `${byStatus.same || 0} reescrita(s) sem mudança` }),
          byStatus.duplicate ? el('span', { class: 'chip', text: `${byStatus.duplicate} duplicada(s)` }) : null,
          byStatus.collision ? el('span', { class: 'chip chip-err', text: `${byStatus.collision} na mesma página` }) : null,
          raw ? el('span', { class: 'chip', text: `${raw} cru(s)` }) : null,
        ),
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('span', { class: 'chip', text: `${global} em _global` }),
          el('span', { class: 'chip', text: `${proj} em projeto` }),
          noTarget ? el('span', { class: 'chip chip-err', text: `${noTarget} sem destino — pulado(s)` }) : null,
        ),
        el('div', { class: 'small muted', text: dryRun ? 'O dry-run não grava nada: só lista o que cada item faria, no log.' : 'A gravação é página a página: itens com o mesmo path viram NOVAS versões da página existente (o ai-memory versiona, não duplica o arquivo). Falhas ficam isoladas por item no log.' }),
        el('div', { class: 'small muted', text: `${chosen.slice(0, 8).map((i) => i.suggested.path).join(' · ')}${chosen.length > 8 ? ` … (+${chosen.length - 8})` : ''}` }),
      ),
      actions: [
        {
          label: dryRun ? 'Simular' : 'Importar',
          kind: 'primary',
          onClick: (close) => { close(); runApply(dryRun); },
        },
      ],
    });
  }

  async function runApply(dryRun) {
    if (state.busy) return;
    state.busy = true;
    const keys = [...state.selected];
    const overrides = { ...state.overrides };
    let started;
    try {
      started = await api('/api/import/apply', { method: 'POST', body: { source: state.source, keys, overrides, dryRun } });
    } catch (err) {
      state.busy = false;
      toast(err.message, 'err');
      return;
    }
    logCard.style.display = '';
    logCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(`import iniciado: ${started.total} item(ns)`);
    showJob(started.id, logCard, statusChip, { scopeNote: `${started.total} item(ns) · ${state.source}` });
    const watch = setInterval(async () => {
      let j;
      try {
        j = await api(`/api/jobs/${started.id}`);
      } catch {
        clearInterval(watch);
        state.busy = false;
        return;
      }
      if (j.status === 'running') return;
      clearInterval(watch);
      state.busy = false;
      toast(j.status === 'ok' ? `import concluído (${j.status})` : `import terminou com ${j.status}`, j.status === 'ok' ? 'ok' : 'err');
      await loadSources();
      if (state.source) await doScan(state.source);
      await renderHistory();
    }, 1500);
  }

  // ---- histórico ----

  async function renderHistory() {
    let data;
    try {
      data = await api('/api/import/state');
    } catch (err) {
      historyCard.replaceChildren(el('div', { class: 'small', text: `histórico indisponível: ${err.message}` }));
      return;
    }
    const tbody = el('tbody');
    if (!data.runs?.length) {
      tbody.append(el('tr', {}, el('td', { colspan: '7', class: 'muted', text: 'nenhuma importação ainda' })));
    }
    for (const run of data.runs || []) {
      tbody.append(el('tr', {},
        el('td', { text: timeAgo(run.endedAt) || new Date(run.endedAt).toLocaleString() }),
        el('td', {}, el('span', { class: 'chip', text: run.source }), run.dryRun ? el('span', { class: 'chip chip-warn', text: ' dry-run' }) : null),
        el('td', { text: run.dryRun ? `${run.planned ?? 0} simulada(s)` : `${run.imported} importada(s)` }),
        el('td', { class: run.failed ? 'mono' : 'mono muted', text: run.failed ? `${run.failed} falha(s)` : '—' }),
        el('td', { class: 'mono muted', text: `${run.skipped || 0} ignorada(s)` }),
        el('td', { text: fmtDuration((run.endedAt || 0) - (run.startedAt || 0)) }),
        el('td', {}, run.jobId ? el('button', {
          class: 'btn btn-secondary btn-sm',
          text: 'ver log',
          onclick: async () => {
            logCard.style.display = '';
            await showJob(run.jobId, logCard, statusChip, { scopeNote: run.source });
            logCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          },
        }) : null),
      ));
    }
    historyCard.replaceChildren(
      el('div', { class: 'row-between' },
        el('strong', { text: 'Importações recentes' }),
        el('div', { class: 'row' },
          el('span', { class: 'chip', text: `${data.imported} página(s) registradas` }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => renderHistory() }),
        ),
      ),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'quando' }), el('th', { text: 'fonte' }), el('th', { text: 'resultado' }), el('th', { text: 'falhas' }), el('th', { text: 'ignoradas' }), el('th', { text: 'duração' }), el('th', { text: '' }),
        )),
        tbody,
      ),
    );
  }

  await loadSources();
};

function importHelpModal() {
  modal({
    title: 'Importar memórias — como funciona',
    wide: true,
    bodyNode: el('div', { class: 'stack' },
      helpSection('Fontes', bullets([
        'Grok v1 (~/.grok/memory): MEMORY.md global e de cada projeto, divididos por seção (## ...). Sessões (sessions/*.md) entram como itens crus, desmarcados.',
        'Grok v2 (~/.grok/memory-v2): um item por tópico (topics/*.md) do global e de cada workspace; observações da _inbox entram como crus.',
        'Kiro (~/.kiro): steering (inclusion: always vira regra), memórias semantic do crew agrupadas por projeto, episodic agrupadas por dia e diários do crew.',
        'knowledge.db do Kiro e implement-memory do Grok ficam fora: são biblioteca de documentos, não memória curada.',
      ])),
      helpSection('Destino de cada página', bullets([
        'Tópicos globais do Grok (estilo, fluxo, VPS) e memórias sem projeto identificado vão para _global, o escopo reservado que aparece em todos os projetos.',
        'Memórias de projeto aterrissam no projeto vinculado no client-projects.json (mesmo mapa da tela de Memórias), resolvido pelo caminho do projeto ou pelos caminhos indexados do workspace.',
        'Sem projeto vinculado, o item aparece no grupo "sem destino" — escolha um projeto (ou _global) antes de importar.',
      ])),
      helpSection('Paths e tiers (heurística, ajustável por item)', bullets([
        'Regra ("nunca", "sempre", "preferência", "estilo"...) → _rules/<slug>.md, kind rule, tier procedural, pinned.',
        'Problema ("erro", "não funciona", "Is a directory"...) → gotchas/<slug>.md, kind gotcha.',
        'O resto → notes/imported/<fonte>/<slug>.md, kind fact, tier semantic.',
        'Cru (sessão/observação/diário) → tier episodic e desmarcado por padrão.',
      ])),
      helpSection('Segurança da operação', bullets([
        'O scan é somente leitura — ele lê os arquivos das outras ferramentas e os .md são mostrados antes de qualquer gravação.',
        'A gravação usa a tool MCP memory_write_page (com scope global) e cai para o binário da CLI (write-page --body -) se o MCP falhar; o log diz qual caminho foi usado por item.',
        'Reimportar atualiza a página (o ai-memory versiona por path) — não cria arquivos duplicados. Duplicados entre fontes já vêm marcados.',
        'Nada é importado sem destino: itens "sem destino" são pulados no lote.',
      ])),
    ),
    actions: [{ label: 'Fechar' }],
  });
}

// ---------- view: skills dos harnesses ----------

/** Separa o frontmatter YAML do corpo do SKILL.md (block scalars incluídos). */
function parseSkillFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content || '');
  if (!m) return { meta: {}, body: content || '' };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const parts = [];
      i++;
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) {
        parts.push(lines[i].trim());
        i++;
      }
      i--;
      value = parts.filter(Boolean).join(folded ? ' ' : '\n');
    }
    meta[kv[1].toLowerCase()] = value.replace(/^["']+|["']+$/g, '').trim();
  }
  return { meta, body: content.slice(m[0].length) };
}

VIEWS.skills = async (main) => {
  const wrap = el('div', { class: 'stack' });
  main.append(wrap);

  const state = {
    data: null,
    harness: 'todos',
    query: '',
    tab: 'globais', // globais | workspaces
    wsParent: '',
    wsData: null,
    wsError: null,
    wsLoading: false,
    wsDetail: null,
  };
  const list = el('div', { class: 'stack' });

  async function load() {
    wrap.replaceChildren(el('div', { class: 'empty', text: 'carregando skills…' }));
    try {
      state.data = await api('/api/skills');
    } catch (err) {
      wrap.replaceChildren(el('div', { class: 'card' }, el('p', { text: `Erro: ${err.message}` })));
      return;
    }
    renderControls();
    renderList();
  }

  function renderControls() {
    const data = state.data;
    const tabs = el('div', { class: 'subtabs' },
      el('button', {
        class: `subtab ${state.tab === 'globais' ? 'active' : ''}`,
        text: 'Globais',
        onclick: () => { state.tab = 'globais'; renderControls(); renderList(); },
      }),
      el('button', {
        class: `subtab ${state.tab === 'workspaces' ? 'active' : ''}`,
        text: 'Por workspace',
        onclick: () => {
          state.tab = 'workspaces';
          state.wsDetail = null;
          if (state.wsData || state.wsLoading) { renderControls(); renderList(); }
          else loadWorkspaces();
        },
      }),
    );

    const parts = [tabs];
    if (state.tab === 'workspaces') {
      const parentInput = el('input', {
        class: 'field',
        placeholder: `diretório-pai (padrão: ${data?.home ? '~/projetos' : '~/projetos'})`,
        value: state.wsParent,
        list: 'dir-suggestions',
        autocomplete: 'off',
        onkeydown: (e) => { if (e.key === 'Enter') loadWorkspaces(e.target.value.trim()); },
      });
      parts.push(
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, parentInput,
          el('button', { class: 'btn btn-secondary btn-sm', text: 'varrer', onclick: () => loadWorkspaces(parentInput.value.trim()) })),
        el('div', { class: 'small muted', text: 'workspaces com skills de projeto (.claude, .agents, .opencode, .zcode, .grok, .kiro, .devin) — inclui projetos vinculados ao ai-memory' }),
      );
    } else {
      const counts = { todos: data.skills.length };
      for (const h of data.harnesses) counts[h.id] = data.skills.filter((s) => s.installed?.[h.id]).length;
      const chip = (id, label) => el('button', {
        class: `subtab ${state.harness === id ? 'active' : ''}`,
        text: `${label} · ${counts[id] ?? 0}`,
        onclick: () => { state.harness = id; renderControls(); renderList(); },
      });
      parts.push(
        el('div', { class: 'subtabs', style: 'flex-wrap:wrap' },
          chip('todos', 'Todos'),
          ...data.harnesses.map((h) => chip(h.id, h.label)),
        ),
        el('input', {
          class: 'field',
          placeholder: 'buscar por nome ou descrição…',
          value: state.query,
          oninput: (e) => { state.query = e.target.value; renderList(); },
        }),
        data.managedError
          ? el('div', { class: 'chip chip-warn', text: `catálogo gerenciado indisponível (${data.managedError}) — listando só o que está em disco` })
          : null,
      );
    }
    wrap.replaceChildren(el('div', { class: 'card stack' }, ...parts), list);
  }

  async function loadWorkspaces(parent = state.wsParent) {
    state.wsParent = parent;
    state.wsLoading = true;
    state.wsError = null;
    renderControls();
    renderList();
    try {
      const q = parent ? `?parent=${encodeURIComponent(parent)}` : '';
      state.wsData = await api(`/api/skills/workspaces${q}`);
      state.wsLoading = false;
    } catch (err) {
      state.wsData = null;
      state.wsError = err.message;
      state.wsLoading = false;
    }
    renderControls();
    renderList();
  }

  async function openWorkspace(path) {
    state.wsDetail = { loading: true, dir: path };
    renderList();
    try {
      state.wsDetail = await api(`/api/skills/workspace?dir=${encodeURIComponent(path)}`);
    } catch (err) {
      state.wsDetail = { error: err.message, dir: path };
    }
    renderList();
  }

  function sectionTitle(text) {
    return el('div', { class: 'view-head' }, el('strong', { text }));
  }

  function locationChips(skill) {
    return state.data.harnesses.map((h) => {
      const locs = (skill.locations || []).filter((l) => l.harness === h.id);
      if (!locs.length) return el('span', { class: 'chip', style: 'opacity:.4', text: h.label });
      const ordered = [...locs.filter((l) => l.kind === 'user'), ...locs.filter((l) => l.kind !== 'user')];
      return ordered.map((loc) => {
        const suffix = loc.kind !== 'user' ? ` · ${loc.kind}` : '';
        const cls = loc.outdated ? 'chip chip-warn' : (loc.kind === 'user' ? 'chip chip-ok' : 'chip chip-info');
        return el('span', {
          class: `${cls}`,
          style: 'cursor:pointer',
          text: `${h.label}${suffix}${loc.outdated ? ' · desatualizada' : ''}`,
          title: `${loc.path} — clique para ver o SKILL.md`,
          onclick: () => previewSkill(skill, loc),
        });
      });
    }).flat();
  }

  function skillCard(skill) {
    const copies = (skill.locations || []).length;
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: skill.name }),
        el('div', { class: 'row' },
          skill.managed ? el('span', { class: 'chip chip-info', text: 'ai-memory' }) : null,
          skill.diverged
            ? el('button', {
                class: 'chip chip-warn chip-btn',
                text: 'cópias diferentes · conciliar…',
                title: 'Mesmo nome com conteúdos diferentes entre harnesses — comparar, ver o diff e alinhar as cópias',
                onclick: () => openReconcile(skill),
              })
            : null,
          el('button', { class: 'btn btn-secondary btn-sm', text: 'SKILL.md', onclick: () => previewSkill(skill) }),
          copies > 1
            ? el('button', {
                class: 'btn btn-secondary btn-sm',
                text: 'Cópias…',
                title: `${copies} cópias desta skill em disco — comparar e conciliar`,
                onclick: () => openReconcile(skill),
              })
            : null,
          el('button', {
            class: 'btn btn-primary btn-sm',
            text: 'Instalar…',
            disabled: !skill.installable,
            onclick: () => openInstall(skill),
          }),
        ),
      ),
      skill.description
        ? el('div', { class: 'small muted', text: skill.description.length > 240 ? `${skill.description.slice(0, 240)}…` : skill.description })
        : null,
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, locationChips(skill)),
    );
  }

  function renderList() {
    if (state.tab === 'workspaces') renderWorkspaces();
    else renderGlobalList();
  }

  function renderGlobalList() {
    const data = state.data;
    const q = state.query.trim().toLowerCase();
    let skills = data.skills;
    if (q) skills = skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));

    const parts = [];
    if (state.harness === 'todos') {
      const managed = skills.filter((s) => s.managed);
      const others = skills.filter((s) => !s.managed);
      if (managed.length) parts.push(sectionTitle(`Gerenciadas do ai-memory · ${managed.length}`), ...managed.map(skillCard));
      if (others.length) parts.push(sectionTitle(`Outras skills · ${others.length}`), ...others.map(skillCard));
    } else {
      const target = data.harnesses.find((h) => h.id === state.harness);
      const here = skills.filter((s) => s.installed?.[state.harness]);
      const missing = skills.filter((s) => !s.installed?.[state.harness] && s.installable);
      if (here.length) parts.push(sectionTitle(`Instaladas em ${target.label} · ${here.length}`), ...here.map(skillCard));
      if (missing.length) parts.push(sectionTitle(`Não instaladas — instaláveis em ${target.label} · ${missing.length}`), ...missing.map(skillCard));
    }
    list.replaceChildren(...(parts.length ? parts : [el('div', { class: 'empty', text: 'nenhuma skill encontrada' })]));
  }

  function renderWorkspaces() {
    if (state.wsDetail) return renderWorkspaceDetail();
    if (state.wsLoading) {
      list.replaceChildren(el('div', { class: 'empty', text: 'varrendo workspaces…' }));
      return;
    }
    if (state.wsError) {
      list.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${state.wsError}` })));
      return;
    }
    const data = state.wsData;
    if (!data) {
      list.replaceChildren(el('div', { class: 'empty', text: 'informe um diretório-pai e clique em varrer' }));
      return;
    }
    const items = data.items || [];
    const header = el('div', { class: 'view-head' },
      el('strong', { text: `${items.length} workspace(s) com skills de projeto` }),
      el('span', { class: 'small muted mono', text: data.parent }),
    );
    if (!items.length) {
      list.replaceChildren(header, el('div', { class: 'card empty', text: 'nenhum workspace com skills de projeto encontrado neste diretório' }));
      return;
    }
    const cards = items.map((it) => el('div', { class: 'card stack clickable', title: it.path, onclick: () => openWorkspace(it.path) },
      el('div', { class: 'row-between' },
        el('strong', { text: it.name }),
        el('span', { class: 'chip', text: `${it.skillCount} skill(s)` }),
      ),
      el('div', { class: 'small muted mono', style: 'word-break:break-all', text: it.path }),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' },
        it.harnesses.map((h) => el('span', { class: 'chip chip-ok', text: `${h.label} · ${h.count}` })),
      ),
    ));
    list.replaceChildren(header, el('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))' }, cards));
  }

  function renderWorkspaceDetail() {
    const d = state.wsDetail;
    const back = el('button', {
      class: 'btn btn-secondary btn-sm',
      text: '← todos os workspaces',
      onclick: () => { state.wsDetail = null; renderControls(); renderList(); },
    });
    const parts = [el('div', { class: 'view-head' }, el('strong', { text: d.name || d.dir }), back)];
    if (d.loading) {
      list.replaceChildren(...parts, el('div', { class: 'empty', text: 'carregando workspace…' }));
      return;
    }
    if (d.error) {
      list.replaceChildren(...parts, el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${d.error}` })));
      return;
    }
    parts.push(el('div', { class: 'small muted mono', style: 'word-break:break-all', text: d.dir }));
    const withSkills = d.harnesses.filter((h) => h.skills.length);
    if (!withSkills.length) {
      list.replaceChildren(...parts, el('div', { class: 'card empty', text: 'sem skills de projeto neste workspace' }));
      return;
    }
    for (const h of withSkills) {
      parts.push(sectionTitle(`${h.label} · ${h.skills.length} — ${h.root}`));
      parts.push(el('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))' },
        h.skills.map((sk) => wsSkillCard(d, h, sk)),
      ));
    }
    list.replaceChildren(...parts);
  }

  function wsSkillCard(d, h, sk) {
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: sk.name }),
        el('div', { class: 'row' },
          sk.managed ? el('span', { class: 'chip chip-info', text: 'ai-memory' }) : null,
          el('button', {
            class: 'btn btn-secondary btn-sm',
            text: 'SKILL.md',
            onclick: () => openSkillViewer({
              title: `${sk.name} · ${d.name}`,
              managed: sk.managed,
              sources: [{ label: `${h.label} · projeto`, title: sk.path, params: { name: sk.name, harness: h.id, ws: d.dir } }],
            }),
          }),
        ),
      ),
      sk.description
        ? el('div', { class: 'small muted', text: sk.description.length > 240 ? `${sk.description.slice(0, 240)}…` : sk.description })
        : null,
    );
  }

  /** Viewer compartilhado: SKILL.md renderizado + árvore de arquivos por fonte. */
  async function openSkillViewer({ title, managed, diverged, sources }) {
    let index = Math.max(0, sources.findIndex((s) => s.preferred));

    const headRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' });
    const srcRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' });
    const treePane = el('div', { class: 'stack', style: 'gap:4px' });
    const viewPane = el('div', { class: 'stack' });
    let activeFile = 'SKILL.md';

    modal({
      title: `${title} · SKILL.md`,
      wide: true,
      bodyNode: el('div', { class: 'stack' },
        headRow,
        sources.length > 1 ? el('div', { class: 'small muted', text: 'cópias da skill (clique para inspecionar cada uma):' }) : null,
        srcRow,
        el('div', { class: 'split', style: 'grid-template-columns:280px 1fr' },
          el('div', { class: 'stack', style: 'gap:6px; max-height:58vh; overflow:auto' },
            el('div', { class: 'field-label', text: 'arquivos e recursos' }),
            treePane,
          ),
          el('div', { class: 'stack', style: 'max-height:58vh; overflow:auto' }, viewPane),
        ),
      ),
      actions: [{ label: 'Fechar' }],
    });

    headRow.replaceChildren(...[
      managed ? el('span', { class: 'chip chip-info', text: 'ai-memory' }) : el('span', { class: 'chip', text: 'skill de terceiros' }),
      diverged ? el('span', { class: 'chip chip-warn', text: 'cópias diferentes', title: 'mesmo nome, conteúdos diferentes entre harnesses' }) : null,
    ].filter(Boolean));

    const renderSrcRow = () => {
      srcRow.replaceChildren(...sources.map((s, i) => el('button', {
        class: `subtab ${i === index ? 'active' : ''}`,
        text: s.label,
        title: s.title || '',
        onclick: () => { index = i; activeFile = 'SKILL.md'; renderSrcRow(); loadCopy(); },
      })));
    };

    function renderMarkdownInto(pane, content) {
      const fm = parseSkillFrontmatter(content);
      const metaChips = Object.entries(fm.meta).filter(([k]) => k !== 'description')
        .map(([k, v]) => el('span', { class: 'chip', text: `${k}: ${v}` }));
      let html = null;
      if (window.marked) {
        try { html = marked.parse(fm.body); } catch { html = null; }
      }
      pane.replaceChildren(...[
        fm.meta.description ? el('div', { class: 'small muted', text: fm.meta.description }) : null,
        metaChips.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, metaChips) : null,
        html ? el('div', { class: 'md-body', html }) : el('div', { class: 'codeblock', text: fm.body }),
      ].filter(Boolean));
    }

    async function openFile(rel) {
      activeFile = rel;
      for (const row of treePane.querySelectorAll('[data-rel]')) {
        row.classList.toggle('active', row.dataset.rel === rel);
      }
      viewPane.replaceChildren(el('div', { class: 'empty', text: `carregando ${rel}…` }));
      try {
        const q = new URLSearchParams({ ...sources[index].params, rel });
        const file = await api(`/api/skills/file?${q}`);
        if (file.kind === 'image') {
          viewPane.replaceChildren(
            el('div', { class: 'small muted mono', text: `${file.rel} · ${fmtBytes(file.size) ?? ''}` }),
            el('img', { src: file.dataUrl, style: 'max-width:100%; border:1px solid var(--line); border-radius:var(--radius)' }),
          );
        } else if (file.kind === 'binary') {
          viewPane.replaceChildren(
            el('div', { class: 'small muted mono', text: file.rel }),
            el('div', { class: 'chip', text: `arquivo binário · ${fmtBytes(file.size) ?? '?'}` }),
          );
        } else if (/\.(md|markdown)$/i.test(file.rel)) {
          renderMarkdownInto(viewPane, file.content);
        } else {
          viewPane.replaceChildren(
            el('div', { class: 'small muted mono', text: `${file.rel} · ${fmtBytes(file.size) ?? ''}` }),
            el('div', { class: 'codeblock', style: 'max-height:52vh; overflow:auto', text: file.content }),
          );
        }
      } catch (err) {
        viewPane.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
      }
    }

    function renderTree(files) {
      const parts = [];
      for (const f of files) {
        const depth = f.rel.split('/').length - 1;
        const indent = { paddingLeft: `${8 + depth * 14}px` };
        if (f.type === 'dir') {
          parts.push(el('div', { class: 'small muted', style: `${indent.paddingLeft}`, text: `📁 ${f.rel.split('/').pop()}/` }));
        } else {
          parts.push(el('div', {
            class: `result-item ${f.rel === activeFile ? 'active' : ''}`,
            style: `padding:5px 8px; ${indent.paddingLeft}`,
            'data-rel': f.rel,
            title: f.rel,
            onclick: () => openFile(f.rel),
          },
            el('div', { class: 'row-between' },
              el('span', { class: 'small mono', text: f.rel.split('/').pop() }),
              el('span', { class: 'small muted', text: f.kind === 'image' ? 'img' : (fmtBytes(f.size) ?? '') }),
            ),
          ));
        }
      }
      treePane.replaceChildren(...(parts.length ? parts : [el('div', { class: 'small muted', text: 'sem arquivos listados' })]));
    }

    async function loadCopy() {
      const src = sources[index];
      if (src.catalog) {
        treePane.replaceChildren(el('div', { class: 'small muted', text: 'skill só existe no catálogo do binário — instale-a num harness para ver os arquivos' }));
        viewPane.replaceChildren(el('div', { class: 'empty', text: 'carregando do catálogo…' }));
        try {
          const { content } = await api(`/api/skills/content?${new URLSearchParams(src.params)}`);
          renderMarkdownInto(viewPane, content);
        } catch (err) {
          viewPane.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
        }
        return;
      }
      treePane.replaceChildren(el('div', { class: 'empty', text: 'carregando arquivos…' }));
      try {
        const { files, dir } = await api(`/api/skills/files?${new URLSearchParams(src.params)}`);
        treePane.append(el('div', { class: 'small muted mono', style: 'word-break:break-all', text: dir }));
        renderTree(files);
        await openFile('SKILL.md');
      } catch (err) {
        treePane.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
        viewPane.replaceChildren(el('div', { class: 'empty', text: '—' }));
      }
    }

    renderSrcRow();
    await loadCopy();
  }

  function previewSkill(skill, initialLoc) {
    const locs = skill.locations || [];
    const sources = locs.map((l) => ({
      label: `${l.harness}${l.kind !== 'user' ? ` · ${l.kind}` : ''}${l.outdated ? ' · desatualizada' : ''}`,
      title: l.path,
      params: { name: skill.name, harness: l.harness, kind: l.kind },
      preferred: Boolean(initialLoc && l.harness === initialLoc.harness && l.kind === initialLoc.kind),
    }));
    if (!sources.length) {
      sources.push({ label: 'catálogo gerenciado do ai-memory', catalog: true, params: { name: skill.name } });
    }
    openSkillViewer({ title: skill.name, managed: skill.managed, diverged: skill.diverged, sources });
  }

  /**
   * Painel de conciliação de cópias: compara as cópias da skill, mostra o diff
   * contra a referência escolhida e propaga a referência para as demais.
   */
  async function openReconcile(skill) {
    let data;
    try {
      data = await api(`/api/skills/compare?name=${encodeURIComponent(skill.name)}`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    const copies = data.copies || [];
    if (!copies.length) {
      toast(`"${skill.name}" não tem cópia em disco para comparar`, 'err');
      return;
    }

    const sameDir = (x, y) => x.id === y.id || x.sameDirAs === y.id || y.sameDirAs === x.id;
    const ref = () => copies.find((c) => c.id === state.refId) || copies[0];
    /** Grupo de conteúdo majoritário, com preferência por cópia gravável. */
    const pickDefaultRef = () => {
      const count = new Map();
      for (const c of copies) count.set(c.signature, (count.get(c.signature) || 0) + 1);
      const best = Math.max(...copies.map((c) => count.get(c.signature)));
      const group = copies.filter((c) => count.get(c.signature) === best);
      return (group.find((c) => c.writable) || group.find((c) => c.catalog) || group[0]).id;
    };
    const state = {
      refId: pickDefaultRef(),
      targets: new Set(),
      extras: new Set(),
      includeResources: true,
      removeExtra: false,
      diff: null,
    };
    const resetTargets = () => {
      const r = ref();
      state.targets = new Set(
        copies.filter((c) => c.writable && c.id !== r.id && !sameDir(c, r) && c.signature !== r.signature).map((c) => c.id),
      );
    };
    resetTargets();

    const body = el('div', { class: 'stack' });
    let closePlan = null;
    const statusOf = (c) => {
      if (c.id === state.refId) return { cls: 'chip-info', text: 'referência' };
      if (sameDir(c, ref())) return { cls: 'chip-ok', text: 'mesma pasta (symlink)' };
      if (c.signature === ref().signature) return { cls: 'chip-ok', text: 'idêntica' };
      if (c.skillHash && c.skillHash === ref().skillHash) return { cls: 'chip-warn', text: 'recursos diferem' };
      return { cls: 'chip-warn', text: 'SKILL.md difere' };
    };

    function peekCopy(c) {
      if (c.catalog) {
        openSkillViewer({
          title: skill.name,
          managed: true,
          sources: [{ label: 'catálogo gerenciado do ai-memory', catalog: true, params: { name: skill.name } }],
        });
        return;
      }
      openSkillViewer({
        title: skill.name,
        managed: c.managed,
        sources: [{ label: c.label, title: c.path, params: { name: skill.name, harness: c.harness, kind: c.kind } }],
      });
    }

    async function toggleDiff(c) {
      if (state.diff?.id === c.id) {
        state.diff = null;
        render();
        return;
      }
      state.diff = { id: c.id, loading: true };
      render();
      try {
        const q = new URLSearchParams({ name: skill.name, a: state.refId, b: c.id });
        state.diff = { id: c.id, data: await api(`/api/skills/diff?${q}`) };
      } catch (err) {
        state.diff = { id: c.id, error: err.message };
      }
      render();
    }

    function diffPane(c) {
      const d = state.diff;
      if (d.error) return el('div', { class: 'chip chip-err', text: d.error });
      if (d.loading) return el('div', { class: 'small muted', text: 'comparando…' });
      const out = d.data;
      const parts = [el('div', { class: 'small muted', text: `SKILL.md · ${out.a.label} → ${out.b.label}` })];
      if (out.diff.truncated) parts.push(el('span', { class: 'chip chip-warn', text: 'diff truncado' }));
      if (out.diff.coarse) parts.push(el('span', { class: 'chip chip-warn', text: 'arquivo grande: comparação por blocos' }));
      if (out.diff.hunks.length) {
        const box = el('div', { class: 'diff' });
        for (const h of out.diff.hunks) {
          const hunk = el('div', { class: 'diff-hunk' });
          for (const l of h.lines) {
            hunk.append(el('div', { class: `diff-line ${l.type}` },
              el('span', { class: 'diff-sign', text: l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }),
              el('span', { class: 'diff-num', text: String(l.type === 'add' ? l.b : l.a ?? '') }),
              el('span', { class: 'diff-text', text: l.text }),
            ));
          }
          box.append(hunk);
        }
        parts.push(box);
      } else {
        parts.push(el('span', { class: 'chip chip-ok', text: 'SKILL.md igual' }));
      }
      const changed = out.files.filter((f) => f.status !== 'same');
      if (changed.length) {
        parts.push(el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          ...changed.map((f) => el('span', {
            class: `diff-file ${f.status === 'differs' ? '' : f.status === 'only-a' ? 'add' : 'del'}`,
            text: `${f.status === 'differs' ? '≠ ' : f.status === 'only-a' ? '+ ' : '- '}${f.rel}`,
          })),
        ));
      } else {
        parts.push(el('div', { class: 'small muted', text: `${out.sameFiles} arquivo(s) iguais, SKILL.md incluído` }));
      }
      return el('div', { class: 'stack', style: 'gap:6px' }, ...parts);
    }

    function copyRow(c) {
      const st = statusOf(c);
      const isRef = c.id === state.refId;
      const readOnly = !c.writable;
      return el('div', { class: 'card stack', style: `padding:10px; gap:6px${isRef ? '; border-color:var(--primary)' : ''}` },
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:10px' },
          el('label', { class: 'check', title: 'usar esta cópia como referência' },
            el('input', {
              type: 'radio',
              name: 'skill-ref',
              checked: isRef,
              onchange: () => { state.refId = c.id; state.diff = null; resetTargets(); render(); },
            }),
            el('span', { text: 'referência' }),
          ),
          el('label', {
            class: 'check',
            title: readOnly ? 'cópia somente leitura (bundled/plugin/catálogo): serve como origem, não como destino' : 'alinhar esta cópia com a referência',
          },
            el('input', {
              type: 'checkbox',
              checked: state.targets.has(c.id),
              disabled: readOnly || isRef,
              onchange: (e) => {
                if (e.target.checked) state.targets.add(c.id);
                else state.targets.delete(c.id);
                refreshSummary();
              },
            }),
            el('span', { text: 'conciliar' }),
          ),
          el('strong', { text: c.label }),
          el('span', { class: st.cls, text: st.text }),
          c.catalog ? el('span', { class: 'chip chip-info', text: 'catálogo do binário' }) : null,
          c.managed ? el('span', { class: 'chip chip-info', text: 'ai-memory' }) : null,
          c.outdated ? el('span', { class: 'chip chip-warn', text: 'desatualizada' }) : null,
          c.sameDirAs ? el('span', { class: 'chip', text: `symlink de ${c.sameDirAs}` }) : null,
        ),
        el('div', { class: 'small muted mono', style: 'word-break:break-all', text: c.dir || '(só no catálogo do ai-memory)' }),
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' },
          el('span', { class: 'small muted', text: `${c.fileCount} arquivo(s)` }),
          c.mtime ? el('span', { class: 'small muted', text: `atualizada ${timeAgo(c.mtime)}` }) : null,
          c.skillHash ? el('span', { class: 'small muted mono', text: c.skillHash.slice(0, 8) }) : null,
          el('button', { class: 'btn btn-secondary btn-sm', text: 'ver cópia', onclick: () => peekCopy(c) }),
          isRef ? null : el('button', {
            class: 'btn btn-secondary btn-sm',
            text: state.diff?.id === c.id ? 'ocultar diff' : 'diff',
            onclick: () => toggleDiff(c),
          }),
        ),
        ...(state.diff?.id === c.id ? [diffPane(c)] : []),
      );
    }

    const summaryLine = el('div', { class: 'small muted' });
    function summaryText() {
      const ids = [...state.targets, ...state.extras];
      if (!ids.length) return 'nenhum destino marcado — marque as cópias que devem ficar iguais à referência.';
      const names = ids.map((id) => {
        const c = copies.find((x) => x.id === id);
        if (!c) return id.replace(':user', '');
        return `${c.label}${statusOf(c).text === 'idêntica' ? ' (já igual)' : ''}`;
      });
      return `destinos: ${names.join(', ')}`;
    }
    function refreshSummary() {
      summaryLine.textContent = summaryText();
      reconcileBtn.disabled = !(state.targets.size + state.extras.size);
    }

    function render() {
      const r = ref();
      const semCopia = (data.harnesses || []).filter((h) => h.writable && !h.hasCopy);
      body.replaceChildren(...[
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('span', { class: 'chip chip-info', text: `${copies.length} cópia(s) em disco` }),
          data.catalogError
            ? el('span', { class: 'chip chip-warn', text: 'catálogo gerenciado indisponível', title: data.catalogError })
            : null,
        ),
        el('div', { class: 'small muted', text: 'Escolha a referência e marque as cópias que devem ficar iguais a ela. O diff mostra o que muda antes de gravar.' }),
        el('div', { class: 'stack', style: 'gap:8px' }, ...copies.map(copyRow)),
        el('div', { class: 'card stack', style: 'padding:10px; gap:6px' },
          el('div', { class: 'field-label', text: 'opções da cópia' }),
          el('label', { class: 'check' },
            el('input', {
              type: 'checkbox',
              checked: state.includeResources,
              onchange: (e) => { state.includeResources = e.target.checked; refreshSummary(); },
            }),
            el('span', { text: 'copiar também os arquivos de recursos (scripts, references, assets…)' }),
          ),
          r.catalog ? el('div', { class: 'small muted', text: 'a referência é o catálogo do binário: ele carrega só o SKILL.md — recursos e arquivos a mais no destino não são mexidos' }) : null,
          el('label', { class: 'check', title: r.catalog ? 'indisponível com o catálogo como referência: ele não tem inventário de recursos' : '' },
            el('input', {
              type: 'checkbox',
              checked: state.removeExtra && !r.catalog,
              disabled: Boolean(r.catalog),
              onchange: (e) => { state.removeExtra = e.target.checked; refreshSummary(); },
            }),
            el('span', { text: 'remover arquivos que só existem no destino (vão para o backup)' }),
          ),
        ),
        semCopia.length
          ? el('div', { class: 'card stack', style: 'padding:10px; gap:6px' },
              el('div', { class: 'field-label', text: 'harnesses sem cópia' }),
              el('div', { class: 'small muted', text: 'opcional: aplicar a referência também nestes roots (a skill é criada lá)' }),
              el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' },
                ...semCopia.map((h) => el('label', { class: 'check', title: h.root },
                  el('input', {
                    type: 'checkbox',
                    checked: state.extras.has(`${h.id}:user`),
                    onchange: (e) => {
                      if (e.target.checked) state.extras.add(`${h.id}:user`);
                      else state.extras.delete(`${h.id}:user`);
                      refreshSummary();
                    },
                  }),
                  el('span', { text: h.label }),
                  el('span', { class: 'small muted mono', text: h.root }),
                )),
              ),
            )
          : null,
        summaryLine,
      ]);
      refreshSummary();
    }

    /** Plano (dry-run) antes de gravar: mostra arquivo por arquivo e o backup. */
    function showPlan(plan) {
      const pendencias = plan.summary.needsConfirm
        ? el('div', { class: 'chip chip-err', text: 'há sobrescrita de cópia sem o marker gerenciado ou remoção de arquivos' })
        : null;
      const rows = plan.plan.map((p) => {
        if (p.skipped) {
          return el('div', { class: 'card row', style: 'padding:10px; flex-wrap:wrap; gap:6px' },
            el('strong', { text: p.label }),
            el('span', { class: 'chip', text: 'ignorada' }),
            el('span', { class: 'small muted', text: p.skipped }),
          );
        }
        const nada = !p.create.length && !p.overwrite.length && !p.remove.length;
        return el('div', { class: 'card stack', style: 'padding:10px; gap:6px' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('strong', { text: p.label }),
            el('span', {
              class: `chip ${nada ? 'chip-ok' : p.existing ? 'chip-warn' : 'chip-info'}`,
              text: nada ? 'sem mudanças' : p.existing ? 'atualiza' : 'cria',
            }),
            p.foreignOverwrite ? el('span', { class: 'chip chip-err', text: 'sem marker gerenciado' }) : null,
            nada ? el('span', { class: 'chip chip-ok', text: 'já está igual' }) : null,
          ),
          el('div', { class: 'small muted mono', style: 'word-break:break-all', text: p.dir }),
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            p.create.length ? el('span', { class: 'chip chip-ok', text: `${p.create.length} arquivo(s) novo(s)` }) : null,
            p.overwrite.length ? el('span', { class: 'chip chip-warn', text: `${p.overwrite.length} sobrescrito(s)` }) : null,
            p.remove.length ? el('span', { class: 'chip chip-err', text: `${p.remove.length} removido(s)` }) : null,
            p.extra.length && !p.remove.length ? el('span', { class: 'chip', text: `${p.extra.length} a mais (mantidos)` }) : null,
            p.same.length ? el('span', { class: 'chip', text: `${p.same.length} arquivo(s) igual(is)` }) : null,
          ),
          p.remove.length ? el('div', { class: 'small muted mono', text: `remover: ${p.remove.join(', ')}` }) : null,
          p.kept?.length ? el('div', { class: 'small muted mono', text: `backup preservado: ${p.kept.join(', ')}` }) : null,
        );
      });

      const runBtn = el('button', {
        class: `btn ${plan.summary.needsConfirm ? 'btn-danger' : 'btn-primary'}`,
        text: 'Executar',
        onclick: () => {
          if (!plan.summary.needsConfirm) {
            execute(plan);
            return;
          }
          confirmModal({
            title: 'Confirmar conciliação',
            message: `Conciliação de "${skill.name}" a partir de ${plan.source.label}:\n`
              + `${plan.summary.filesToWrite} arquivo(s) escrito(s) em ${plan.summary.destinations} destino(s)`
              + `${plan.summary.filesToRemove ? `, ${plan.summary.filesToRemove} removido(s)` : ''}.\n`
              + `O estado anterior de cada destino é copiado para ${plan.backupRoot}.`,
            word: 'conciliar',
            danger: true,
            onConfirm: () => execute(plan),
          });
        },
      });
      closePlan = modal({
        title: `Conciliar "${skill.name}"`,
        wide: true,
        bodyNode: el('div', { class: 'stack' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('span', { class: 'chip chip-info', text: `origem: ${plan.source.label}` }),
            el('span', { class: 'small muted', text: `${plan.summary.destinations} destino(s) · ${plan.summary.filesToWrite} arquivo(s)` }),
            pendencias,
          ),
          ...rows,
          el('div', { class: 'small muted', text: `backup do estado anterior em ${plan.backupRoot}` }),
        ),
        actions: [{ label: 'Cancelar' }, runBtn],
      });
      return closePlan;
    }

    async function execute(plan) {
      const targets = plan.plan.filter((p) => !p.skipped).map((p) => p.id);
      closePlan?.(); // o plano já cumpriu o papel: os resultados substituem o modal
      closePlan = null;
      let out;
      try {
        out = await api('/api/skills/reconcile', {
          method: 'POST',
          body: {
            name: skill.name,
            source: plan.source.id,
            targets,
            includeResources: plan.includeResources,
            removeExtra: plan.removeExtra,
            confirm: plan.summary.needsConfirm ? 'conciliar' : undefined,
          },
        });
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
      showResults(out);
      load();
    }

    function showResults(out) {
      const errs = out.results.filter((r) => r.status === 'erro');
      modal({
        title: `Conciliação de "${skill.name}"`,
        wide: true,
        bodyNode: el('div', { class: 'stack' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('span', {
              class: `chip ${errs.length ? 'chip-err' : 'chip-ok'}`,
              text: errs.length ? `${errs.length} erro(s)` : 'concluída',
            }),
            el('span', { class: 'small muted', text: `origem: ${out.source.label}` }),
          ),
          ...out.results.map((r) => el('div', { class: 'card stack', style: 'padding:10px; gap:6px' },
            el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
              el('strong', { text: r.label || r.id }),
              el('span', { class: `chip ${r.status === 'erro' ? 'chip-err' : r.status === 'ignorada' ? '' : 'chip-ok'}`, text: r.status }),
            ),
            r.dir ? el('div', { class: 'small muted mono', style: 'word-break:break-all', text: r.dir }) : null,
            r.error ? el('div', { class: 'small', style: 'color:var(--danger)', text: r.error }) : null,
            r.wrote?.length ? el('div', { class: 'small muted', text: `novos: ${r.wrote.join(', ')}` }) : null,
            r.overwritten?.length ? el('div', { class: 'small muted', text: `sobrescritos: ${r.overwritten.join(', ')}` }) : null,
            r.removed?.length ? el('div', { class: 'small muted', text: `removidos: ${r.removed.join(', ')}` }) : null,
            r.backup ? el('div', { class: 'small muted', text: `backup: ${r.backup}` }) : null,
          )),
        ),
        actions: [{ label: 'Fechar', kind: 'primary' }],
      });
      toast(errs.length ? 'conciliação terminou com erros' : 'cópias conciliadas', errs.length ? 'err' : 'ok');
    }

    async function runDry() {
      const targets = [...state.targets, ...state.extras];
      if (!targets.length) {
        toast('marque ao menos uma cópia de destino', 'err');
        return;
      }
      let plan;
      try {
        plan = await api('/api/skills/reconcile', {
          method: 'POST',
          body: {
            name: skill.name,
            source: state.refId,
            targets,
            includeResources: state.includeResources,
            removeExtra: state.removeExtra,
            dryRun: true,
          },
        });
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
      closeFn?.();
      showPlan(plan);
    }

    const reconcileBtn = el('button', {
      class: 'btn btn-primary',
      text: 'Conciliar…',
      disabled: !(state.targets.size + state.extras.size),
      onclick: () => runDry(),
    });

    const closeFn = modal({
      title: `Cópias de "${skill.name}"`,
      wide: true,
      bodyNode: body,
      actions: [{ label: 'Fechar' }, reconcileBtn],
    });
    render();
  }

  function openInstall(skill) {
    const targets = state.data.harnesses;
    const sel = el('select', { class: 'field' }, targets.map((h) => el('option', { value: h.id, text: h.label })));
    if (state.harness !== 'todos') sel.value = state.harness;

    const rbGlobal = el('input', { type: 'radio', name: 'skill-scope', value: 'global', checked: true });
    const rbProject = el('input', { type: 'radio', name: 'skill-scope', value: 'project' });
    const dirInput = el('input', {
      class: 'field',
      placeholder: 'diretório do projeto (ex.: ~/projetos/meu-app)',
      list: 'dir-suggestions',
      autocomplete: 'off',
      disabled: true,
    });
    const syncScope = () => { dirInput.disabled = !rbProject.checked; };
    rbGlobal.addEventListener('change', syncScope);
    rbProject.addEventListener('change', syncScope);

    const src = (skill.locations || []).find((l) => l.kind === 'user');
    const sourceText = skill.managed && !src
      ? 'conteúdo: catálogo gerenciado do ai-memory'
      : skill.managed
        ? `conteúdo: catálogo gerenciado do ai-memory (também existe em ${src.path})`
        : `conteúdo: cópia de ${src.path}`;
    const warn = el('div', { class: 'small', style: 'display:none; color: var(--attention); white-space:pre-wrap' });
    let forceMode = false;
    let closeFn = null;

    const run = (force) => {
      const payload = { name: skill.name, harness: sel.value, scope: rbProject.checked ? 'project' : 'global', force };
      if (payload.scope === 'project') {
        if (!dirInput.value.trim()) {
          toast('informe o diretório do projeto', 'err');
          return;
        }
        payload.projectDir = dirInput.value.trim();
      }
      api('/api/skills/install', { method: 'POST', body: payload })
        .then((out) => {
          closeFn?.();
          toast(`skill instalada em ${out.path}`, 'ok');
          load();
        })
        .catch((err) => {
          if (err.needsForce) {
            forceMode = true;
            warn.style.display = '';
            warn.textContent = err.message;
            installBtn.textContent = 'Forçar instalação…';
          } else {
            toast(err.message, 'err');
          }
        });
    };

    const installBtn = el('button', {
      class: 'btn btn-primary',
      text: 'Instalar',
      onclick: () => {
        if (forceMode) {
          confirmModal({
            title: 'Forçar instalação',
            message: `"${skill.name}" já existe no destino sem o marker gerenciado e será sobrescrita (será criado um backup .bak-*). Continuar?`,
            word: 'instalar',
            onConfirm: () => run(true),
          });
        } else {
          run(false);
        }
      },
    });

    closeFn = modal({
      title: `Instalar "${skill.name}"`,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'field-label', text: 'Harness de destino' }),
        sel,
        el('div', { class: 'row', style: 'gap:16px' },
          el('label', { class: 'check', style: 'display:flex; gap:6px; align-items:center' }, rbGlobal, 'Global (~ do harness)'),
          el('label', { class: 'check', style: 'display:flex; gap:6px; align-items:center' }, rbProject, 'Projeto'),
        ),
        dirInput,
        el('div', { class: 'small muted', text: sourceText }),
        warn,
      ),
      actions: [{ label: 'Cancelar' }, installBtn],
    });
  }

  await load();
};

// ---------- init ----------

refreshServerChip();
route();
