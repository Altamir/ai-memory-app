/* ai-memory-app — frontend vanilla (sem build) */

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- log de erros do frontend ----------

// Erros de render morriam no catch de quem chamava e o único sintoma era um
// pedaço de tela faltando. Agora cada erro vai para o console com prefixo
// [aim] e fica num buffer consultável: window.__aimLogs (últimos 50).
const __aimLogs = [];
function aimLog(kind, detail) {
  const entry = { at: new Date().toISOString(), kind, detail: String(detail?.message || detail).slice(0, 500) };
  __aimLogs.push(entry);
  if (__aimLogs.length > 50) __aimLogs.shift();
  console.error(`[aim] ${kind}:`, detail);
}
window.addEventListener('error', (e) => aimLog('erro', e.message));
window.addEventListener('unhandledrejection', (e) => aimLog('promise rejeitada', e.reason));
window.__aimLogs = __aimLogs;
window.__aimLog = aimLog;

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
  // sem `word`, é só um sim/não: o input de confirmação não aparece (digitar
  // uma palavra quando não há palavra a digitar deixa o botão travado)
  const body = el('div', { class: 'stack' }, el('div', { class: 'small', text: message }));
  let confirmBtn;
  if (word) {
    const input = el('input', { class: 'field', placeholder: `digite "${word}" para confirmar`, autocomplete: 'off' });
    confirmBtn = el('button', { class: `btn btn-${danger ? 'danger' : 'primary'}`, text: 'Confirmar', disabled: true });
    input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== word; });
    body.append(input);
    setTimeout(() => input.focus(), 50);
  } else {
    confirmBtn = el('button', { class: `btn btn-${danger ? 'danger' : 'primary'}`, text: 'Confirmar' });
  }
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  const close = modal({
    title,
    bodyNode: body,
    actions: [confirmBtn],
  });
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
  export: 'Exportar bundle',
  skills: 'Skills · harnesses e coleção',
  logs: 'Logs do ai-memory',
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

// ---------- chip de status + troca de servidor no header ----------

let ACTIVE_SERVER = null; // { id, name, url, hasToken } do perfil conectado
let SETUP = null;         // diagnóstico de arranque (servidor + CLI)

async function refreshServerChip() {
  const chip = $('#server-chip');
  let text = 'servidor offline';
  let kind = 'chip-err';

  // o diagnóstico vem primeiro: é ele que diz se falta servidor ou falta CLI,
  // e o /api/status (que roda a CLI) falha justamente quando ela não existe
  try {
    SETUP = await api('/api/setup');
  } catch {
    SETUP = null;
  }

  try {
    const s = await api('/api/status');
    const srv = await api('/api/servers').catch(() => null);
    ACTIVE_SERVER = srv?.active || null;
    const name = ACTIVE_SERVER?.name || 'servidor';
    const ver = s.version ? ` · v${s.version}` : '';
    text = `${name}${ver}`;
    kind = ACTIVE_SERVER?.hasToken === false ? 'chip-warn' : 'chip-ok';
  } catch {
    // sem CLI o status não roda: o texto tem que dizer o que falta, senão
    // "servidor offline" aponta para o problema errado
    if (SETUP && !SETUP.cli.ok) {
      text = 'falta a CLI do ai-memory';
      kind = 'chip-warn';
    } else if (SETUP && !SETUP.server.ok) {
      text = 'servidor não responde';
      kind = 'chip-err';
    } else if (ACTIVE_SERVER) {
      text = `${ACTIVE_SERVER.name} · offline`;
    }
  }
  chip.className = `chip chip-btn ${kind}`;
  chip.textContent = text;
  // ativo e fora da lista: o chip precisa dizer, senão parece um servidor comum
  const hiddenNote = ACTIVE_SERVER?.hidden ? ' (removido da lista)' : '';
  chip.title = ACTIVE_SERVER
    ? `Conectado: ${ACTIVE_SERVER.name} (${ACTIVE_SERVER.url})${hiddenNote}\nClique para trocar de servidor`
    : 'Conectando ao servidor ai-memory…';
}
$('#server-chip').addEventListener('click', () => {
  // com algo faltando, o clique vai direto para o que precisa ser resolvido
  if (SETUP && SETUP.actions.length) return openSetupWizard();
  openServerManager();
});
setInterval(refreshServerChip, 60_000);

// ---------- primeiro uso: o que falta para o painel funcionar ----------

/**
 * Fluxo de primeiro uso, em passos — a ordem é a do que o usuário precisa fazer:
 *
 *   1. CLI do ai-memory      (oferece instalar, ou usar a que já existe no PATH)
 *   2. Servidor local ou remoto (pergunta, pré-preenche a URL do local)
 *   3. URL + token           (testa a conexão e salva)
 *
 * Cada passo é renderizado de novo (`render(step)`) porque o modal não é
 * navegável; ao terminar, o chip e a tela atual se refrescam.
 */
async function openSetupWizard(step = 'auto') {
  const setup = SETUP || await api('/api/setup').catch(() => null);
  if (!setup) {
    toast('não consegui ler o diagnóstico', 'err');
    return;
  }

  // um wizard por vez: navegar entre passos fecha o modal anterior
  $('#modal-root').replaceChildren();

  // passo automático: pula o que já está resolvido
  if (step === 'auto') {
    step = !setup.cli.ok ? 'cli' : !setup.server.ok ? 'server' : 'done';
  }

  // ---- passo 1: CLI ----
  if (step === 'cli') return renderStepCli(setup);
  // ---- passos 2 e 3: servidor ----
  if (step === 'server') return renderStepServer(setup);
  return renderStepDone(setup);
}

/** Passo 1 — instalar (ou reapontar) a CLI. */
async function renderStepCli(setup) {
  const card = el('div', { class: 'card stack', style: 'gap:8px' });
  const releaseOut = el('div', { class: 'small muted' });
  const installOut = el('div', { class: 'small muted' });
  const installBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Instalar a CLI' });
  let release = null;

  const showRelease = async () => {
    releaseOut.textContent = 'consultando a release oficial…';
    release = await api('/api/setup/cli-release').catch(() => null);
    if (!release?.ok) {
      releaseOut.textContent = `não consegui consultar a release: ${release?.error || 'erro'}`;
      installBtn.disabled = true;
      return;
    }
    releaseOut.textContent = `${release.name || release.tag} · ${release.asset?.name || 'sem binário para esta máquina'}`;
  };

  installBtn.addEventListener('click', async () => {
    // instalar escreve em disco e baixa de fora: só com confirmação explícita
    confirmModal({
      title: 'Instalar a CLI do ai-memory?',
      message: `Vai baixar ${release?.asset?.name || 'o binário'} da release oficial (${release?.url || 'github'}) para ${setup.cli.configuredPath}, conferindo o checksum SHA256 antes de extrair. Se já houver uma CLI no caminho, ela é guardada como .bak-<data>.`,
      onConfirm: async () => {
        installBtn.disabled = true;
        installOut.textContent = 'instalando…';
        // container próprio para o log do job: mensagens de status vão em
        // installOut — e textContent apaga os filhos, então o log NÃO pode
        // morar dentro dele
        const jobPanel = el('div', { class: 'stack', style: 'margin-top:4px' });
        card.querySelectorAll('[data-job-panel]').forEach((n) => n.remove());
        jobPanel.dataset.jobPanel = 'true';
        card.append(jobPanel);
        try {
          const job = await api('/api/setup/install-cli', { method: 'POST', body: { confirm: true } });
          await showJob(job.id, jobPanel, null, {});
          const t = setInterval(async () => {
            const j = await api(`/api/jobs/${job.id}`).catch((err) => { console.error('[aim-setup] job desapareceu:', err); return null; });
            if (!j || j.status === 'running') return;
            clearInterval(t);
            await refreshServerChip();
            if (j.status === 'ok') {
              toast('CLI instalada', 'ok');
              // segue a docs: depois de instalar, `ai-memory init` cria o
              // layout do data-dir (passo 1 do setup oficial)
              try {
                await api('/api/setup/init', { method: 'POST' });
              } catch (err) {
                aimLog('install-cli: init pós-instalação falhou', err);
              }
              openSetupWizard('server'); // segue para o servidor
            } else {
              // o porquê está no log do job acima (download, checksum, extração)
              __aimLogs.push({ at: new Date().toISOString(), kind: 'install-cli', detail: `job ${job.id} terminou ${j.status}` });
              installOut.textContent = `a instalação falhou (código ${j.exitCode ?? '?'}) — o motivo está no log acima`;
              installBtn.disabled = false;
            }
          }, 1500);
        } catch (err) {
          aimLog('install-cli: não consegui criar o job', err);
          installOut.textContent = err.message;
          installBtn.disabled = false;
        }
      },
    });
  });

  // CLI achada no PATH, mas o perfil aponta para onde ela não está: oferecer
  // realinhar sem instalar nada
  const elsewhereRow = () => {
    if (!setup.cli.foundElsewhere) return null;
    const btn = el('button', { class: 'btn btn-secondary btn-sm', text: 'usar este caminho' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/setup/use-cli', { method: 'POST', body: { path: setup.cli.foundElsewhere } });
        toast('caminho da CLI atualizado', 'ok');
        await refreshServerChip();
        openSetupWizard('server');
      } catch (err) {
        aimLog('install-cli: usar-caminho-alternativo falhou', err);
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
    return el('div', { class: 'row', style: 'gap:6px; align-items:center' },
      el('span', { class: 'small muted', text: `há uma CLI em ${setup.cli.foundElsewhere}${setup.cli.foundElsewhereVersion ? ` · v${setup.cli.foundElsewhereVersion}` : ''}` }),
      btn,
    );
  };

  replaceKids(card,
      el('div', { class: 'row-between' },
        el('strong', { text: 'CLI do ai-memory' }),
        el('span', { class: 'chip chip-warn', text: 'não instalada' }),
      ),
      el('div', { class: 'small muted', text: `O painel procura a CLI em ${setup.cli.configuredPath}, que não existe.` }),
      el('div', { class: 'row', style: 'gap:6px' }, installBtn),
      releaseOut,
      installOut,
      elsewhereRow(),
  );

  const body = el('div', { class: 'stack' },
    el('div', { class: 'small muted', text: 'Passo 1 de 2 — a CLI do ai-memory. Sem ela, manutenção e sessões run não funcionam; a leitura de memórias pelo servidor não é afetada.' }),
    card,
    el('div', { class: 'row', style: 'justify-content:flex-end' },
      el('button', { class: 'btn btn-secondary btn-sm', text: 'configurar servidor primeiro', onclick: () => openSetupWizard('server') }),
    ),
  );

  const close = modal({ title: 'Preparar o painel', wide: true, bodyNode: body, actions: [{ label: 'Fechar' }] });
  showRelease();
  return close;
}

/** Passos 2 e 3 — local ou remoto, depois URL + token. */
async function renderStepServer(setup) {
  const card = el('div', { class: 'card stack', style: 'gap:8px' });
  const nameIn = el('input', { class: 'field', placeholder: 'meu ai-memory', autocomplete: 'off' });
  const urlIn = el('input', { class: 'field mono', placeholder: 'http://127.0.0.1:49374', autocomplete: 'off' });
  const tokenIn = el('input', { class: 'field', type: 'password', placeholder: 'token do servidor (Bearer)', autocomplete: 'off' });
  const probeOut = el('div', { class: 'small muted' });
  const LOCAL_URL = 'http://127.0.0.1:49374';

  // ---- pergunta: local ou remoto? ----
  let kind = 'remote';
  const kindRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' });
  const radio = (value, label, hint) => {
    const rb = el('input', { type: 'radio', name: 'setup-kind' });
    rb.addEventListener('change', () => {
      if (!rb.checked) return;
      kind = value;
      urlIn.value = value === 'local' ? LOCAL_URL : '';
      tokenIn.value = '';
      hintEl.textContent = value === 'local'
        ? 'Um ai-memory nesta máquina (Docker ou `ai-memory serve`). A URL padrão já vem preenchida; o token é o do auth-token local, se houver.'
        : 'Um ai-memory em outra máquina. Precisa da URL exposta e do token (Bearer) dela.';
      urlIn.focus();
    });
    if (value === kind) rb.checked = true;
    return el('label', { class: 'check', style: 'flex-direction:column; align-items:flex-start; gap:2px' },
      el('span', { class: 'row', style: 'gap:6px; align-items:center' }, rb, el('strong', { text: label })),
      el('span', { class: 'small muted', text: hint }),
    );
  };
  const hintEl = el('div', { class: 'small muted', text: 'Um ai-memory em outra máquina. Precisa da URL exposta e do token (Bearer) dela.' });
  kindRow.append(
    radio('local', 'Servidor local', 'nesta máquina (Docker ou `ai-memory serve`)'),
    radio('remote', 'Servidor remoto', 'em outra máquina, com URL + token'),
  );

  const probeBtn = el('button', { class: 'btn btn-secondary btn-sm', text: 'Testar conexão' });
  probeBtn.addEventListener('click', async () => {
    if (!urlIn.value.trim()) return toast('informe a URL', 'err');
    probeBtn.disabled = true;
    probeOut.textContent = 'testando…';
    try {
      const res = await api('/api/servers/probe', {
        method: 'POST',
        body: { url: urlIn.value.trim(), token: tokenIn.value.trim() },
      });
      probeOut.textContent = res.ok
        ? `respondeu${res.version ? ` · v${res.version}` : ''}${res.hasToken ? ' · com token' : ' · sem token'}${res.totals?.pages_latest !== undefined ? ` · ${res.totals.pages_latest} página(s) no servidor` : ''}`
        : `não respondeu: ${res.error}`;
    } catch (err) {
      probeOut.textContent = err.message;
    } finally {
      probeBtn.disabled = false;
    }
  });

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Salvar e conectar' });
  saveBtn.addEventListener('click', async () => {
    if (!urlIn.value.trim()) return toast('informe a URL do servidor', 'err');
    saveBtn.disabled = true;
    try {
      const saved = await api('/api/servers', {
        method: 'POST',
        body: {
          name: nameIn.value.trim() || (kind === 'local' ? 'ai-memory local' : 'ai-memory remoto'),
          url: urlIn.value.trim(),
          token: tokenIn.value.trim() || null,
        },
      });
      const target = saved.servers.find((s) => !s.env && s.url === urlIn.value.trim().replace(/\/+$/, ''));
      if (target) await api('/api/servers/activate', { method: 'POST', body: { id: target.id } });
      toast('servidor salvo e conectado', 'ok');
      await refreshServerChip();
      openSetupWizard('done');
    } catch (err) {
      aimLog('setup-server: salvar/conectar falhou', err);
      toast(err.message, 'err');
      saveBtn.disabled = false;
    }
  });

  replaceKids(card,
    el('div', { class: 'row-between' },
      el('strong', { text: 'Servidor do ai-memory' }),
      el('span', { class: 'chip chip-err', text: 'não configurado' }),
    ),
    el('div', { class: 'small muted', text: 'O painel precisa de um servidor para ler e escrever memórias. Onde ele está?' }),
    kindRow,
    hintEl,
    el('label', { class: 'field-label' }, 'Nome (opcional)', nameIn),
    el('label', { class: 'field-label' }, 'URL', urlIn),
    el('label', { class: 'field-label' }, 'Token', tokenIn),
    el('div', { class: 'row', style: 'gap:6px' }, probeBtn, saveBtn),
    probeOut,
  );

  const body = el('div', { class: 'stack' },
    el('div', { class: 'small muted', text: setup.cli.ok
      ? 'Passo 2 de 2 — a CLI está instalada, falta apontar o servidor.'
      : 'Configuração do servidor (a CLI ainda não está instalada — dá para voltar nela depois pelo chip.' }),
    card,
    setup.cli.ok ? null : el('div', { class: 'row', style: 'justify-content:flex-end' },
      el('button', { class: 'btn btn-secondary btn-sm', text: 'voltar para a CLI', onclick: () => openSetupWizard('cli') }),
    ),
  );

  return modal({ title: 'Preparar o painel', wide: true, bodyNode: body, actions: [{ label: 'Fechar' }] });
}

/** Fim — tudo resolvido. */
async function renderStepDone(setup) {
  let closeFn = null;
  const body = el('div', { class: 'stack' },
    el('div', { class: 'card stack', style: 'gap:6px' },
      el('strong', { text: 'Tudo pronto' }),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'CLI' }),
        el('span', { class: 'mono', text: setup.cli.ok
          ? `${setup.cli.path}${setup.cli.version ? ` · v${setup.cli.version}` : ''}`
          : 'não instalada — oferecida de novo no próximo boot, ou pelo chip' }),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'Servidor' }),
        el('span', { class: 'mono', text: `${setup.server.name} · ${setup.server.url}` }),
      ),
      el('div', { class: 'small muted', text: 'Para trocar de servidor depois, use o chip no topo. Para apontar o MCP dos harnesses para este servidor, o gestor de servidores tem a seção "MCP dos harnesses".' }),
    ),
    el('div', { class: 'row', style: 'justify-content:flex-end' },
      el('button', { class: 'btn btn-secondary btn-sm', text: 'abrir gestão de servidores', onclick: () => { closeFn?.(); openServerManager(); } }),
    ),
  );
  // formato objeto do modal(): sem onClick, o botão fecha sozinho — nós crus
  // entram SEM handler (era o "Começar a usar não faz nada")
  const ret = modal({
    title: 'Preparar o painel',
    wide: true,
    bodyNode: body,
    actions: [{
      label: 'Começar a usar',
      kind: 'primary',
      onClick: (close) => {
        close();
        refreshServerChip();
        route(); // o dashboard atrás pode estar no cartão "Falta preparar"
      },
    }],
  });
  closeFn = ret;
  return ret;
}

/**
 * Libera o modal substituindo o conteúdo: `replaceChildren` não filtra null, e
 * um `cond ? el(...) : null` solto vira a palavra "null" na tela.
 */
function replaceKids(node, ...kids) {
  node.replaceChildren(...kids.flat().filter(Boolean));
}

// ---------- modal: servidores do ai-memory ----------

/**
 * Troca o ai-memory que o painel inteiro usa (leituras, manutenção, run,
 * exportação e importação). Cada perfil carrega URL + data-dir do cliente, e
 * o token vem do <data-dir>/auth-token daquele servidor — o mesmo lugar de onde
 * a CLI já lê. A URL e o data-dir seguem o servidor; o binário é opcional e
 * cai no do ambiente quando o servidor remoto usa o mesmo executável local.
 */
async function openServerManager() {
  let data;
  try {
    data = await api('/api/servers');
  } catch (err) {
    toast(`não consegui ler os servidores: ${err.message}`, 'err');
    return;
  }

  const body = el('div', { class: 'stack' });
  const form = {
    id: null,
    name: '',
    url: '',
    dataDir: '',
    bin: '',
    token: '',
    clearToken: false,
  };

  const listBox = el('div', { class: 'stack' });
  const formBox = el('div', { class: 'card stack', style: 'gap:8px' });

  function renderList() {
    const doRemove = async (s) => {
      try {
        data = await api(`/api/servers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        toast('servidor removido', 'ok');
        renderList();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    const rows = data.servers.map((s) => {
      const isActive = s.id === data.active.id;
      const remove = async () => {
        // o ambiente é diferente: ele é o destino implícito do painel. Avisar
        // que pode ser o último destino evita a surpresa de sumir com ele.
        if (s.env) {
          const last = data.servers.length === 1;
          confirmModal({
            title: 'Remover o servidor do ambiente?',
            message: last
              ? `É o único servidor da lista. Removendo, o painel continua funcionando e o ambiente (${s.url}) segue como destino — ele só some da lista, sem botão para voltar. Para recuperá-lo, apague o .servers.json do painel.`
              : `Ele sai da lista, mas o painel continua funcionando: o ambiente (${s.url}) segue como destino implícito e pode voltar pelo botão "mostrar na lista".`,
            danger: true,
            onConfirm: () => doRemove(s),
          });
          return;
        }
        await doRemove(s);
      };
      return el('div', { class: 'card row-between', style: 'gap:8px; padding:10px 12px' },
        el('div', { class: 'stack', style: 'gap:2px; min-width:0' },
          el('div', { class: 'row', style: 'gap:6px; align-items:center' },
            el('strong', { text: s.name }),
            isActive ? el('span', { class: 'chip chip-ok', text: 'ativo' }) : null,
            s.env ? el('span', { class: 'chip', text: 'ambiente' }) : null,
            !s.hasToken ? el('span', { class: 'chip chip-warn', text: 'sem token' }) : null,
          ),
          el('span', { class: 'small muted mono', text: s.url }),
          el('span', { class: 'small muted mono', text: `data-dir: ${s.dataDir}` }),
        ),
        el('div', { class: 'row', style: 'gap:6px' },
          isActive
            ? el('span', { class: 'small muted', text: 'conectado' })
            : el('button', {
                class: 'btn btn-primary btn-sm',
                text: 'conectar',
                onclick: async () => {
                  try {
                    data = await api('/api/servers/activate', { method: 'POST', body: { id: s.id } });
                    toast(`conectado em ${s.name}`, 'ok');
                    close();
                    refreshServerChip();
                    route();
                  } catch (err) {
                    toast(err.message, 'err');
                  }
                },
              }),
          s.env ? null : el('button', {
            class: 'btn btn-secondary btn-sm',
            text: 'editar',
            onclick: () => fillForm(s),
          }),
          el('button', {
            class: 'btn btn-secondary btn-sm',
            text: 'remover',
            title: s.env
              ? 'Some da lista; o ambiente continua como destino implícito do painel'
              : 'Remove este servidor do painel',
            onclick: remove,
          }),
        ),
      );
    });

    // o ambiente removido some da lista: sem isso não haveria como trazê-lo de volta
    const hiddenEnv = data.active.hidden;
    const isEnvActive = data.active.id === 'local';
    if (hiddenEnv) {
      rows.push(el('div', { class: 'card row-between', style: 'gap:8px; padding:10px 12px' },
        el('div', { class: 'stack', style: 'gap:2px; min-width:0' },
          el('div', { class: 'row', style: 'gap:6px; align-items:center' },
            el('strong', { text: data.active.name, style: 'opacity:.7' }),
            el('span', { class: 'chip', text: 'removido da lista' }),
            isEnvActive ? el('span', { class: 'chip chip-ok', text: 'ativo' }) : null,
          ),
          el('span', { class: 'small muted mono', text: data.active.url }),
          el('span', { class: 'small muted', text: 'O painel continua conectado aqui: é o destino implícito das variáveis de ambiente.' }),
        ),
        el('button', {
          class: 'btn btn-secondary btn-sm',
          text: 'mostrar na lista',
          onclick: async () => {
            try {
              data = await api('/api/servers/env', { method: 'POST' });
              toast('servidor do ambiente restaurado', 'ok');
              renderList();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        }),
      ));
    }
    listBox.replaceChildren(...rows);
  }

  function fillForm(s) {
    form.id = s.id;
    form.name = s.name;
    form.url = s.url;
    form.dataDir = s.dataDir;
    form.bin = s.bin;
    form.token = '';
    form.clearToken = false;
    form.hasToken = s.hasToken;
    clearTokenCheck.checked = false;
    nameInput.value = s.name;
    urlInput.value = s.url;
    dataDirInput.value = s.dataDir;
    binInput.value = s.bin === data.active.bin ? '' : s.bin;
    tokenInput.value = '';
    tokenInput.placeholder = s.hasToken
      ? 'deixe em branco para manter o token gravado'
      : 'token (opcional — senão usa o data-dir)';
    title.textContent = 'Editar servidor';
    saveBtn.textContent = 'Salvar';
    renderForm();
  }

  function clearForm() {
    form.id = null;
    form.clearToken = false;
    nameInput.value = '';
    urlInput.value = '';
    dataDirInput.value = '';
    binInput.value = '';
    tokenInput.value = '';
    tokenInput.placeholder = 'token (opcional — senão usa o data-dir)';
    title.textContent = 'Adicionar servidor';
    saveBtn.textContent = 'Adicionar';
    renderForm();
  }

  const title = el('strong', { text: 'Adicionar servidor' });
  const nameInput = el('input', { class: 'field', placeholder: 'VPS de produção' });
  const urlInput = el('input', { class: 'field mono', placeholder: 'http://10.0.0.5:49374', autocomplete: 'off' });
  const dataDirInput = el('input', { class: 'field mono', placeholder: '~/.ai-memory-data-cliente', autocomplete: 'off' });
  const binInput = el('input', { class: 'field mono', placeholder: 'binário do ai-memory (opcional)', autocomplete: 'off' });
  const tokenInput = el('input', { class: 'field', type: 'password', placeholder: 'token (opcional — senão usa o data-dir)', autocomplete: 'off' });
  const clearTokenCheck = el('input', { type: 'checkbox' });
  clearTokenCheck.addEventListener('change', () => { form.clearToken = clearTokenCheck.checked; });
  const clearTokenLabel = el('label', { class: 'check', style: 'gap:4px' }, clearTokenCheck, 'limpar token gravado');
  const probeOut = el('div', { class: 'small muted' });

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Adicionar' });
  const probeBtn = el('button', { class: 'btn btn-secondary btn-sm', text: 'Testar conexão' });
  const resetBtn = el('button', { class: 'btn btn-secondary btn-sm', text: 'Limpar' });

  function renderForm() {
    saveBtn.textContent = form.id ? 'Salvar' : 'Adicionar';
    formBox.replaceChildren(
      title,
      el('label', { class: 'field-label' }, 'Nome', nameInput),
      el('label', { class: 'field-label' }, 'URL do servidor', urlInput),
      el('label', { class: 'field-label' }, 'Data-dir do cliente (dai o token)', dataDirInput),
      el('label', { class: 'field-label' }, 'Binário da CLI', binInput),
      el('label', { class: 'field-label' }, 'Token', tokenInput),
      form.id && form.hasToken ? clearTokenLabel : null,
      el('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' }, saveBtn, probeBtn, resetBtn),
      probeOut,
    );
  }

  const collect = () => {
    const t = tokenInput.value.trim();
    return {
      id: form.id || undefined,
      name: nameInput.value.trim(),
      url: urlInput.value.trim(),
      dataDir: dataDirInput.value.trim(),
      bin: binInput.value.trim(),
      // edição: em branco = manter o gravado (chave omitida); "limpar token"
      // marcado = '' explícito. Criação: valor ou null.
      ...(form.id
        ? (form.clearToken ? { token: '' } : (t ? { token: t } : {}))
        : { token: t || null }),
    };
  };

  saveBtn.addEventListener('click', async () => {
    const payload = collect();
    if (!payload.url) return toast('informe a URL do servidor', 'err');
    try {
      const out = await api('/api/servers', { method: 'POST', body: payload });
      data = out;
      toast('servidor salvo', 'ok');
      clearForm();
      renderList();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  probeBtn.addEventListener('click', async () => {
    const payload = collect();
    if (!payload.url) return toast('informe a URL do servidor', 'err');
    probeOut.textContent = 'testando…';
    const res = await api('/api/servers/probe', { method: 'POST', body: payload });
    // servidor no ar mas sem página alguma quase sempre é store não restaurado
    // (o `up.sh` da migração só sobe o container; o store entra depois)
    const empty = res.ok && res.totals && !res.totals.pages_latest;
    probeOut.textContent = res.ok
      ? `respondeu${res.version ? ` · v${res.version}` : ''}${res.hasToken ? ' · com token' : ' · sem token'}`
        + (res.totals?.pages_latest !== undefined ? ` · ${res.totals.pages_latest} página(s) no servidor` : '')
        + (empty ? ' — responde, mas está vazio: falta restaurar o store (bundle de backup) nesse servidor' : '')
        + (res.versionNote ? ` · ${res.versionNote}` : '')
      : `não respondeu: ${res.error}`;
  });

  resetBtn.addEventListener('click', clearForm);

  const cancelBtn = el('button', { class: 'btn btn-secondary', text: 'Fechar' });
  const harnessBox = el('div', { class: 'stack', id: 'harness-mcp-box' });
  const close = modal({
    title: 'Servidores do ai-memory',
    wide: true,
    bodyNode: el('div', { class: 'stack' },
      el('div', { class: 'small muted' },
        'O painel inteiro passa a falar com o servidor escolhido: dashboard, memórias, manutenção, sessões run e importação. O token vem do ',
        el('code', { text: 'auth-token' }),
        ' do data-dir informado; um token digitado no formulário é opcional e fica gravado em ',
        el('code', { text: '.servers.json' }),
        ' (modo 0600, fora do git).'),
      listBox,
      formBox,
      harnessBox,
    ),
    actions: [cancelBtn],
  });
  cancelBtn.addEventListener('click', close);

  renderList();
  renderForm();
  renderHarnesses(harnessBox);
  return { close };
}

/**
 * MCP dos harnesses: reescreve a entrada do ai-memory nas configs das
 * ferramentas para apontarem ao servidor conectado. A escrita é do próprio
 * `ai-memory install-mcp --apply` (a CLI conhece o formato de cada cliente,
 * preserva os outros servidores e faz backup) — o painel só escolhe quais.
 */
async function renderHarnesses(box) {
  const selected = new Set();
  const statusLine = el('div', { class: 'small muted' });
  const listBox = el('div', { class: 'stack', style: 'gap:6px' });

  const applyBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Aplicar selecionados', disabled: true });
  applyBtn.addEventListener('click', async () => {
    const ids = [...selected];
    if (!ids.length) return;
    applyBtn.disabled = true;
    statusLine.textContent = `aplicando em ${ids.length} harness(es)…`;
    try {
      const out = await api('/api/harness-mcp/apply', { method: 'POST', body: { harnesses: ids } });
      const ok = out.results.filter((r) => r.ok).length;
      const bad = out.results.filter((r) => !r.ok);
      for (const b of bad) toast(`${b.id || b.label || 'harness'}: ${b.error}`, 'err');
      toast(bad.length ? `${ok} aplicado(s), ${bad.length} com erro` : `MCP atualizado em ${ok} harness(es)`, bad.length ? 'err' : 'ok');
      // recarrega a lista para refletir o que foi mudado, sem re-renderizar tudo
      applyBtn.disabled = true;
      statusLine.textContent = 'atualizando a lista…';
      await loadHarnessRows();
      applyBtn.disabled = selected.size === 0;
    } catch (err) {
      toast(err.message, 'err');
      statusLine.textContent = `falhou: ${err.message}`;
      applyBtn.disabled = false;
    }
  });

  // (re)carrega só as linhas: na abertura e depois de aplicar, sem recriar o
  // botão nem perder a seleção
  async function loadHarnessRows() {
    let data;
    try {
      data = await api('/api/harness-mcp');
    } catch (err) {
      listBox.replaceChildren(el('div', { class: 'small', style: 'color:var(--danger)', text: err.message }));
      return;
    }
    const rows = data.harnesses.map((h) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = selected.has(h.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(h.id);
        else selected.delete(h.id);
        applyBtn.disabled = selected.size === 0;
      });
      const state = !h.registered
        ? (h.configExists ? el('span', { class: 'chip', text: 'não instalado' }) : el('span', { class: 'chip', text: 'sem config' }))
        : h.aligned
          ? el('span', { class: 'chip chip-ok', text: 'em dia' })
          : el('span', { class: 'chip chip-warn', text: 'aponta p/ outro' });

      // hooks: o que captura o trabalho e vincula o projeto no primeiro capture
      let hooksBtn = null;
      if (h.hooksSupported) {
        hooksBtn = el('button', {
          class: 'btn btn-secondary btn-sm',
          text: 'hooks',
          title: `install-hooks --agent ${h.id} --apply — captura prompts/ferramentas/sessões e vincula o projeto (idempotente, com backup)`,
          onclick: async () => {
            hooksBtn.disabled = true;
            hooksBtn.textContent = '…';
            try {
              const job = await api('/api/harness-hooks/apply', { method: 'POST', body: { agents: [h.id] } });
              // o job é assíncrono: um GET único quase sempre vê "running" e
              // diria "falhou" com a instalação ainda rodando — poll até terminar
              const fim = await new Promise((resolve) => {
                const t = setInterval(async () => {
                  const j = await api(`/api/jobs/${job.id}`).catch(() => null);
                  if (!j || j.status === 'running') return;
                  clearInterval(t);
                  resolve(j);
                }, 1000);
              });
              if (fim.status === 'ok') {
                hooksBtn.textContent = 'hooks ✓';
                toast(`hooks do ${h.label} instalados`, 'ok');
              } else {
                hooksBtn.textContent = 'hooks';
                toast(`hooks do ${h.label} falharam — veja o histórico`, 'err');
              }
            } catch (err) {
              aimLog('harness-hooks: aplicação falhou', err);
              toast(err.message, 'err');
              hooksBtn.textContent = 'hooks';
            } finally {
              hooksBtn.disabled = false;
            }
          },
        });
      }

      return el('div', { class: 'card row-between', style: 'gap:8px; padding:8px 10px' },
        el('label', { class: 'check row', style: 'gap:8px; align-items:center; min-width:0; cursor:pointer' },
          cb,
          el('strong', { text: h.label }),
          state,
        ),
        el('div', { class: 'row', style: 'gap:6px; align-items:center' },
          hooksBtn,
          el('span', { class: 'small muted mono', style: 'font-size:11px; word-break:break-all', text: h.currentUrl || h.configFile || '—' }),
        ),
      );
    });
    listBox.replaceChildren(...rows);
    const inSync = data.harnesses.filter((h) => h.aligned && h.registered).length;
    const stale = data.harnesses.filter((h) => h.registered && !h.aligned).length;
    statusLine.textContent = `${inSync} harness(es) em dia com ${data.serverUrl}`
      + (stale ? ` · ${stale} apontando para outro servidor` : '');
  }

  box.replaceChildren(
    el('div', { class: 'stack', style: 'gap:2px' },
      el('strong', { text: 'MCP e hooks dos harnesses' }),
      el('span', { class: 'small muted', text: 'MCP: reescreve a entrada do ai-memory nas configs das ferramentas para apontarem ao servidor conectado. Hooks: instala a captura de prompts/ferramentas/sessões — é o que vincula o projeto ao servidor no primeiro capture. O backup de cada arquivo é feito pela própria CLI, e os outros servidores que você tenha configurado são preservados. Depois de aplicar, reinicie a ferramenta para ela reler a config.' }),
      statusLine,
    ),
    listBox,
    el('div', { class: 'row', style: 'gap:6px' }, applyBtn),
  );

  await loadHarnessRows();
}

// ---------- view: dashboard ----------

VIEWS.dashboard = async (main) => {
  const wrap = el('div', { class: 'stack' });
  main.append(wrap);
  const load = async () => {
    wrap.replaceChildren(el('div', { class: 'empty', text: 'carregando status…' }));

    // sem servidor ou sem CLI, o dashboard não tem dado para mostrar: o cartão
    // de preparação é a resposta certa, com o botão que reabre o wizard
    const setup = SETUP || await api('/api/setup').catch(() => null);
    if (setup && setup.actions.length) {
      const faltas = [
        ...(!setup.server.ok ? ['servidor do ai-memory não configurado/inalcançável'] : []),
        ...(!setup.cli.ok ? [`CLI não instalada (${setup.cli.configuredPath})`] : []),
      ];
      wrap.replaceChildren(
        el('div', { class: 'card stack', style: 'gap:8px' },
          el('div', { class: 'row-between' },
            el('strong', { text: 'Falta preparar o painel' }),
            el('button', { class: 'btn btn-primary btn-sm', text: 'Preparar agora', onclick: () => openSetupWizard() }),
          ),
          el('ul', { class: 'small muted', style: 'margin:0; padding-left:18px' },
            faltas.map((f) => el('li', { text: f })),
          ),
          el('div', { class: 'small muted', text: 'O assistente instala a CLI do ai-memory (se você quiser) e cadastra o servidor — local ou remoto — com URL e token.' }),
        ),
      );
      return;
    }

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
          el('p', { class: 'small muted', text: `Verifique o container (docker ps) e a URL ${ACTIVE_SERVER?.url || 'configurada no painel'}.` }),
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

    // CLI e dados locais: onde está o binário e os dados do lado desta máquina.
    // Vem do diagnóstico (GET /api/setup) já buscado no início do load — a
    // mesma fonte do chip e do wizard.
    const mark = (ok) => el('span', { class: `chip ${ok ? 'chip-ok' : 'chip-warn'}`, text: ok ? '✓' : '—' });
    const cliRows = setup ? [
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'Binário' }),
        setup.cli.ok
          ? el('span', { class: 'mono', style: 'text-align:right; word-break:break-all', text: `${setup.cli.path}${setup.cli.version ? ` · v${setup.cli.version}` : ''}` })
          : el('button', { class: 'chip chip-btn chip-warn', text: 'não instalada — preparar', onclick: () => openSetupWizard() }),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'Data-dir do cliente' }),
        el('span', { class: 'mono', style: 'text-align:right; word-break:break-all', text: setup.paths.dataDir }),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'auth-token' }), mark(setup.paths.dataDirToken),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'client-projects.json' }), mark(setup.paths.dataDirProjects),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'config.toml' }), mark(setup.paths.dataDirConfig),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'Volume do store (export)' }),
        el('span', { class: 'mono', style: 'text-align:right; word-break:break-all', text: setup.paths.storeDir }),
      ),
      el('div', { class: 'row-between small' },
        el('span', { class: 'muted', text: 'wiki + db no volume' }),
        el('span', { class: 'row', style: 'gap:4px' }, mark(setup.paths.storeDirWiki), mark(setup.paths.storeDirDb)),
      ),
      // a exportação lê o store LOCAL: a entrada só existe quando ele existe
      (setup.paths.storeDirWiki && setup.paths.storeDirDb)
        ? el('div', { class: 'row-between small' },
            el('span', { class: 'muted', text: 'Exportação' }),
            el('button', { class: 'btn btn-secondary btn-sm', text: 'Exportar memórias', onclick: () => { location.hash = 'export'; } }),
          )
        : null,
    ] : [el('div', { class: 'small muted', text: 'diagnóstico indisponível' })];

    wrap.replaceChildren(
      el('div', { class: 'view-head' },
        el('div', { class: 'row', style: 'gap:8px' },
          ...chips,
          ACTIVE_SERVER
            ? el('button', { class: 'chip chip-btn', text: `servidor: ${ACTIVE_SERVER.name}`, title: 'Trocar de servidor', onclick: () => { openServerManager(); } })
            : null,
        ),
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
          el('div', { class: 'row-between' },
            el('strong', { text: 'CLI e dados locais' }),
            setup?.cli.ok
              ? el('span', { class: 'chip chip-ok', text: `v${setup.cli.version}` })
              : el('span', { class: 'chip chip-warn', text: 'CLI ausente' }),
          ),
          ...cliRows,
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

// ---------- view: logs do ai-memory ----------

// Fontes: "cliente" (logs da CLI no data-dir do perfil ativo) e "servidor"
// (volume do ai-memory local — só existe quando o ativo é o ambiente).
VIEWS.logs = async (main) => {
  const state = {
    sources: null,          // resposta de /api/logs
    source: 'client',
    file: null,
    tail: 400,
    filter: '',
    live: false,
    es: null,               // EventSource do modo ao vivo
    atBottom: true,
  };

  const wrap = el('div', { class: 'stack' });
  main.append(wrap);

  const sourceSel = el('select', { class: 'field', style: 'max-width:260px' });
  const fileSel = el('select', { class: 'field', style: 'max-width:300px' });
  const tailSel = el('select', { class: 'field', style: 'max-width:130px' },
    el('option', { value: '200', text: 'últimas 200' }),
    el('option', { value: '400', text: 'últimas 400', selected: true }),
    el('option', { value: '1000', text: 'últimas 1000' }),
    el('option', { value: '5000', text: 'últimas 5000' }),
  );
  const filterIn = el('input', { class: 'field', style: 'max-width:220px', placeholder: 'filtrar linhas…', autocomplete: 'off' });
  const liveBtn = el('button', { class: 'btn btn-secondary btn-sm', text: 'Ao vivo' });
  const reloadBtn = el('button', { class: 'btn btn-secondary btn-sm', text: 'Atualizar', onclick: () => loadContent() });
  const note = el('div', { class: 'small muted' });
  const logPanel = el('div', { class: 'log-panel', style: 'height:min(60vh, 640px)' }, el('div', { class: 'empty', text: 'carregando logs…' }));

  logPanel.onscroll = () => {
    state.atBottom = logPanel.scrollTop + logPanel.clientHeight >= logPanel.scrollHeight - 30;
  };
  filterIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { state.filter = filterIn.value; state.live ? restartLive() : loadContent(); }
  });
  sourceSel.addEventListener('change', () => { state.source = sourceSel.value; pickNewestFile(); stopLive(); loadContent(); });
  fileSel.addEventListener('change', () => { state.file = fileSel.value; stopLive(); loadContent(); });
  tailSel.addEventListener('change', () => { state.tail = Number(tailSel.value); state.live ? restartLive() : loadContent(); });
  liveBtn.addEventListener('click', () => { state.live ? stopLive() : startLive(); });
  // sair da view encerra o stream (route() limpa o main, mas o ES sobreviveria)
  window.addEventListener('hashchange', () => stopLive(), { once: true });

  function stopLive() {
    state.live = false;
    if (state.es) { state.es.close(); state.es = null; }
    liveBtn.classList.remove('btn-danger');
    liveBtn.classList.add('btn-secondary');
    liveBtn.textContent = 'Ao vivo';
  }

  function restartLive() { stopLive(); startLive(); }

  function startLive() {
    if (!state.file) return toast('escolha um arquivo de log', 'err');
    state.live = true;
    liveBtn.classList.remove('btn-secondary');
    liveBtn.classList.add('btn-danger');
    liveBtn.textContent = '■ parar';
    const params = new URLSearchParams({ source: state.source, file: state.file });
    if (state.filter) params.set('filter', state.filter);
    logPanel.replaceChildren();
    const es = new EventSource(`/api/logs/stream?${params}`);
    state.es = es;
    es.onmessage = (ev) => {
      try {
        const line = JSON.parse(ev.data);
        appendLine(line);
      } catch { /* ignora */ }
    };
    es.onerror = () => { /* reconexão é do EventSource; estado segue */ };
  }

  function appendLine(line) {
    const keep = state.atBottom;
    logPanel.append(el('span', { class: `log-line-${line.kind || 'out'}`, text: line.text }));
    if (keep) logPanel.scrollTop = logPanel.scrollHeight;
  }

  function pickNewestFile() {
    const src = state.sources?.[state.source];
    const files = src?.files || [];
    state.file = files[0]?.name || null;
    renderFileOptions();
  }

  function renderFileOptions() {
    const src = state.sources?.[state.source];
    const files = src?.files || [];
    fileSel.replaceChildren(
      ...files.map((f) => el('option', {
        value: f.name,
        selected: f.name === state.file,
        text: `${f.name} · ${fmtBytes(f.size) || `${f.size} B`}`,
      })),
    );
    fileSel.disabled = !files.length;
  }

  async function loadSources() {
    state.sources = await api('/api/logs');
    const opts = [
      ['client', `CLI do ai-memory (cliente)${state.sources.client.available ? '' : ' · vazia'}`],
      ['server', `Servidor local (store)${state.sources.server.available ? '' : ' · indisponível'}`],
    ];
    sourceSel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, selected: state.source === v, text: t })));
    pickNewestFile();
    const src = state.sources[state.source];
    note.textContent = src?.note || '';
  }

  async function loadContent() {
    if (!state.file) {
      const src = state.sources?.[state.source];
      logPanel.replaceChildren(el('div', { class: 'empty', text: src?.note || 'nenhum arquivo de log nesta fonte' }));
      return;
    }
    logPanel.replaceChildren(el('div', { class: 'empty', text: 'carregando…' }));
    try {
      const params = new URLSearchParams({ source: state.source, file: state.file, tail: String(state.tail) });
      if (state.filter) params.set('filter', state.filter);
      const out = await api(`/api/logs/content?${params}`);
      if (!out.ok) {
        logPanel.replaceChildren(el('div', { class: 'empty', text: out.error }));
        return;
      }
      state.atBottom = true;
      logPanel.replaceChildren();
      for (const text of out.lines) appendLine({ kind: lineKind(text), text: `${text}\n` });
      logPanel.scrollTop = logPanel.scrollHeight;
      note.textContent = [
        state.sources?.[state.source]?.note,
        `${out.lines.length} linha(s)${out.filter ? ` · filtro "${out.filter}"` : ''} · ${fmtBytes(out.sizeBytes) || `${out.sizeBytes} B`} no arquivo`,
        out.truncated ? `· janela limitada às últimas ${fmtBytes(out.readBytes) || `${out.readBytes} B`}` : null,
      ].filter(Boolean).join(' · ');
    } catch (err) {
      logPanel.replaceChildren(el('div', { class: 'empty', text: `erro: ${err.message}` }));
    }
  }

  function lineKind(line) {
    if (/\bERROR\b/.test(line)) return 'err';
    if (/\bWARN\b/.test(line)) return 'out';
    if (/^INFO\b/.test(line) || /^\d{4}-\d{2}-\d{2}T/.test(line)) return 'out';
    return 'sys';
  }

  wrap.append(
    el('div', { class: 'view-head' },
      el('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' },
        sourceSel, fileSel, tailSel, filterIn, liveBtn, reloadBtn,
      ),
      note,
    ),
    logPanel,
    el('div', { class: 'small muted', text: 'Cliente: logs da CLI no data-dir do perfil ativo (rotação por data). Servidor: volume do ai-memory LOCAL — quando o painel está conectado a outro ai-memory (ex.: VPS), os logs dele ficam na outra máquina.' }),
  );

  await loadSources();
  await loadContent();
};
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
  } catch (err) {
    console.error('[aim] log do job indisponível:', jobId, err);
    toast('log indisponível: o painel foi reiniciado depois desta execução', 'err');
    return;
  }
  // outro clique aconteceu enquanto este buscava: o último vence
  if (seq !== showJobSeq) return;
  stopLogStream();
  panel.style.display = '';
  panel.dataset.onDone = 'history';

  // Chamadores de manutenção passam um painel completo ([data-job-label] +
  // .log-panel + chip de status). Chamadores leves — como o wizard de preparação —
  // passam uma div simples e chip null: aqui a estrutura faltante é criada em
  // vez de estourar em "Cannot set properties of null".
  const label = panel.querySelector('[data-job-label]');
  if (label) label.textContent = [job.args?.length ? job.args.join(' ') : job.command, scopeNote].filter(Boolean).join('   ·   ');

  let log = panel.querySelector('.log-panel');
  if (!log) {
    log = el('div', { class: 'log-panel', style: 'max-height:220px; overflow:auto; margin:6px 0' });
    panel.append(log);
  }
  log.replaceChildren();
  log.dataset.autoscroll = 'true';
  // onscroll (e não addEventListener): showJob roda a cada "ver log" e os
  // listeners se acumulariam no mesmo elemento
  log.onscroll = () => {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.dataset.autoscroll = String(atBottom);
  };
  if (statusChip) {
    statusChip.className = 'chip chip-info';
    statusChip.textContent = job.status === 'running' ? 'executando…' : 'carregando log…';
  }

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
      if (statusChip) {
        statusChip.className = `chip ${ok ? 'chip-ok' : j.status === 'timeout' ? 'chip-warn' : 'chip-err'}`;
        statusChip.textContent = `${j.status} · código ${j.exitCode ?? '?'} · ${fmtDuration(j.durationMs)}`;
      }
      console.info(`[aim] job ${jobId} (${job.command}): ${j.status}, código ${j.exitCode}`);
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

// ---------- busca de projeto/workspace ----------
//
// O seletor de escopo é um <select>: serve quando a lista é curta, mas o
// inventário do servidor é de dezenas de projetos (e o <select> só costuma
// mostrar os vinculados na máquina). A busca é o caminho para achar um
// workspace/projeto pelo nome ou pelo caminho local.

const normText = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Modal com filtro por workspace, projeto ou caminho. `entries` são
 * { workspace, project, path, pages, linked, pathExists }.
 */
function projectPickerModal({ entries, current, onPick }) {
  let closeFn = null;
  const search = el('input', { class: 'field', placeholder: 'filtrar por workspace, projeto ou caminho…', autocomplete: 'off' });
  const list = el('div', { class: 'stack', style: 'gap:6px; max-height:420px; overflow-y:auto' });
  const note = el('div', { class: 'small muted' });

  const rows = () => {
    const q = normText(search.value.trim());
    if (!q) return entries;
    return entries.filter((e) => normText(`${e.workspace} ${e.project} ${e.path || ''}`).includes(q));
  };

  const choose = (e) => {
    closeFn?.();
    onPick(e);
  };

  function render() {
    const found = rows();
    const q = search.value.trim();
    note.textContent = q
      ? `${found.length} de ${entries.length} projeto(s)`
      : `${entries.length} projeto(s) — filtre por workspace, projeto ou caminho`;
    if (!found.length) {
      list.replaceChildren(el('div', {
        class: 'empty',
        text: entries.length
          ? 'nenhum projeto bate com o filtro — feche e use "digitar workspace/projeto" para apontar na mão'
          : 'nenhum projeto conhecido: o servidor não respondeu e nada está vinculado nesta máquina',
      }));
      return;
    }
    list.replaceChildren(...found.map((e) => {
      const key = `${e.workspace}/${e.project}`;
      const chips = [];
      if (e.pages !== undefined && e.pages !== null) chips.push(el('span', { class: 'chip', text: `${e.pages} pág.` }));
      if (e.linked) chips.push(el('span', { class: 'chip chip-ok', text: e.pathExists ? 'vinculada · pasta existe' : 'vinculada · pasta ausente' }));
      else chips.push(el('span', { class: 'chip', text: 'só no servidor' }));
      return el('div', {
        class: `result-item ${key === current ? 'active' : ''}`,
        title: 'usar este projeto como escopo',
        onclick: () => choose(e),
      },
        el('div', { class: 'row-between' },
          el('strong', { style: 'font-size:13px', text: `${e.workspace} / ${e.project}` }),
          key === current ? el('span', { class: 'chip chip-info', text: 'escopo atual' }) : null,
        ),
        chips.length ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px; margin-top:6px' }, chips) : null,
        e.path ? el('div', { class: 'mono small muted', style: 'margin-top:4px', text: e.path }) : null,
      );
    }));
  }

  search.addEventListener('input', render);
  // Enter pega o primeiro resultado — quem digita o nome do projeto não precisa
  // chegar no mouse
  search.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const first = rows()[0];
    if (first) choose(first);
  });

  render();
  closeFn = modal({
    title: 'Buscar projeto / workspace',
    bodyNode: el('div', { class: 'stack' }, search, note, list),
    actions: [{ label: 'Fechar' }],
  });
  setTimeout(() => search.focus(), 50);
}

// ---------- view: manutenção ----------
//
// A tela é montada a partir do catálogo do servidor (server/spec.mjs):
// escopo, efeitos colaterais, flags e confirmação vêm de lá — o frontend não
// repete metadado nenhum, então a tela não sai de sincronia com a whitelist.

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
  const manualRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px', display: 'none' }, wsInput, projInput);
  const effectiveChip = el('span', { class: 'chip chip-info' });

  // A busca usa o inventário do SERVIDOR (admin/projects), não só os projetos
  // vinculados nesta máquina: é o único jeito de achar um projeto que o painel
  // nunca vinculou. Se o servidor não responder, cai na lista local + órfãos.
  let pickEntries = scopes.map((s) => ({ workspace: s.workspace, project: s.project, path: s.path || null }));
  let inventoryNote = null;

  async function loadPickEntries() {
    try {
      const inv = await api('/api/server-scopes');
      if (!inv?.ok) { inventoryNote = inv?.error || 'servidor não respondeu'; return; }
      const known = new Set(pickEntries.map((e) => `${e.workspace}/${e.project}`));
      const server = inv.projects.map((p) => ({ workspace: p.workspace, project: p.project, pages: p.pages, linked: p.linked, pathExists: p.pathExists, path: p.localPath }));
      for (const o of inv.orphans || []) {
        const [workspace, project] = String(o.key).split('/');
        if (workspace && project && !known.has(o.key)) server.push({ workspace, project, path: o.path, pathExists: o.pathExists, linked: true });
      }
      if (server.length) pickEntries = server;
    } catch (err) {
      inventoryNote = err.message;
    }
  }

  const searchBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    text: 'buscar projeto…',
    title: 'Buscar projeto/workspace pelo nome ou pelo caminho, em todos os projetos do servidor',
    onclick: async () => {
      searchBtn.disabled = true;
      searchBtn.textContent = 'carregando…';
      await loadPickEntries();
      searchBtn.disabled = false;
      searchBtn.textContent = 'buscar projeto…';
      projectPickerModal({
        entries: pickEntries,
        current: state.mode === 'pick' ? `${state.workspace}/${state.project}` : null,
        onPick: (e) => {
          state.mode = 'pick';
          state.workspace = e.workspace;
          state.project = e.project;
          ensureScopeOption(e.workspace, e.project);
          scopeSel.value = `${e.workspace}/${e.project}`;
          syncEffective();
          toast(`escopo: ${e.workspace}/${e.project}`);
        },
      });
      if (inventoryNote) toast(`busca parcial: ${inventoryNote}`, 'err');
    },
  });

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
  // um projeto escolhido na busca pode não estar na lista do <select>: ele vira
  // uma opção própria para o seletor não voltar sozinho para "automático"
  function ensureScopeOption(workspace, project) {
    const value = `${workspace}/${project}`;
    if (scopeSel.querySelector(`option[value="${CSS.escape(value)}"]`)) return;
    scopeSel.insertBefore(
      el('option', { value, text: `${workspace} / ${project} (busca)` }),
      scopeSel.lastElementChild,
    );
  }
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
      searchBtn,
      manualRow,
    ),
    el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; align-items:center' },
      effectiveChip,
      el('span', { class: 'small muted', text: scopes.length ? `${scopes.length} projeto(s) vinculado(s) no client-projects.json — a busca alcança todos os do servidor, ou digite outro` : 'nenhum projeto vinculado; use "buscar projeto" ou "digitar workspace/projeto" para apontar outro' }),
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
            // a run fica presa ao servidor em que nasceu: trocar de servidor no
            // painel não move uma sessão já aberta
            s.server ? el('div', { class: 'muted mono', style: 'font-size:11px; word-break:break-all', text: `servidor: ${s.server.name}` }) : null,
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
    // inventário completo: o que o SERVIDOR tem (admin/projects) cruzado com o
    // que ESTA MÁQUINA vinculou (client-projects.json). O antigo /api/scopes só
    // devolvia o segundo — numa máquina recém-instalada a lista saía vazia
    // mesmo com o servidor cheio de projetos.
    let inv = null;
    try {
      inv = await api('/api/server-scopes');
    } catch {
      inv = null;
    }
    const linked = (await api('/api/scopes').catch(() => ({ scopes: [] }))).scopes || [];

    state.inventory = inv;
    state.linked = linked;
    const serverList = inv?.ok ? inv.projects.map((p) => ({ workspace: p.workspace, project: p.project, pages: p.pages, linked: p.linked, pathExists: p.pathExists })) : [];
    state.scopes = serverList.length
      ? serverList
      : linked.map((s) => ({ workspace: s.workspace, project: s.project }));

    scopeSel.replaceChildren(
      el('option', { value: 'global', text: `🌐 Global — todos os projetos${inv?.ok ? ` (${inv.total} no servidor)` : ''}` }),
      ...state.scopes.map((s) => {
        const tag = s.linked === undefined ? '' : (s.linked ? ' · vinculada' : ' · só no servidor');
        const pages = s.pages !== undefined ? ` (${s.pages} pág.)` : '';
        return el('option', { value: `${s.workspace}/${s.project}`, text: `${s.workspace} / ${s.project}${pages}${tag}` });
      }),
    );
    if (state.scopes.length) state.scopeKey = 'global';
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

  const invNote = el('div', { class: 'small muted', style: 'margin-top:6px' });

  main.append(
    el('div', { class: 'card' },
      el('div', { class: 'row', style: 'flex-wrap:wrap' }, scopeSel, searchInput),
      el('div', { class: 'small muted', style: 'margin-top:6px', text: 'Busca global cobre todos os projetos; escolhendo um projeto, as páginas recentes aparecem sem digitar nada.' }),
      invNote,
    ),
    el('div', { class: 'split' },
      el('div', { class: 'stack' }, resultsNote, resultList),
      reader,
    ),
  );

  await loadScopes();

  // a nota explica a diferença entre "o servidor tem" e "esta máquina vincula"
  // — na instalação limpa o servidor tem dezenas e a máquina nenhuma, o que
  // antes parecia bug
  const inv = state.inventory;
  if (inv?.ok) {
    const semVinculo = inv.total - inv.linked;
    invNote.replaceChildren(
      el('div', { class: 'small muted', text: `${inv.total} projeto(s) no servidor (${inv.serverUrl}) · ${inv.linked} vinculados nesta máquina${semVinculo ? ` · ${semVinculo} ainda só no servidor` : ''}` }),
      inv.linked === 0
        ? el('div', { class: 'small', style: 'color:var(--attention)', text: 'Nenhum projeto vinculado a esta máquina ainda: o registry (client-projects.json) se preenche quando um harness com hooks captura daqui — `ai-memory run <harness>` num repositório faz isso sozinho (ele instala hooks + MCP na primeira execução).' })
        : null,
    );
  } else if (inv && !inv.ok) {
    invNote.replaceChildren(el('div', { class: 'small muted', text: `inventário do servidor indisponível: ${inv.error} — listando só os projetos vinculados nesta máquina` }));
  }

  await runSearch();
};

// ---------- view: importar memórias (Grok / Kiro / bundle do ai-memory) ----------

const IMPORT_STATUS = {
  new: { cls: 'chip-info', label: 'novo' },
  changed: { cls: 'chip-warn', label: 'alterado' },
  same: { cls: 'chip-ok', label: 'já importado' },
  duplicate: { cls: 'chip', label: 'duplicado' },
  collision: { cls: 'chip-err', label: 'mesma página' },
};
const NO_TARGET = '∅';

// bundle escolhido na aba Exportar e levado para o importador (só em memória)
let PENDING_BUNDLE = null;

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
    bundleFile: null,
    remote: { enabled: false, url: '', token: '' },
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
    el('div', { class: 'small muted', text: 'O painel lê as memórias curadas do Grok e do Kiro no seu home, os bundles exportados pelo próprio ai-memory, resolve o projeto de cada uma pelos vínculos do client-projects.json e grava páginas no ai-memory (via MCP, com a CLI como reserva). Nada é gravado antes de você revisar a lista: o scan é somente leitura e cada item pode ser aberto, redirecionado ou descartado.' }),
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
    // veio da aba Exportar com "usar no importador": já escaneia o bundle
    if (PENDING_BUNDLE) {
      const file = PENDING_BUNDLE;
      PENDING_BUNDLE = null;
      state.bundleFile = file;
      doScan('bundle');
    }
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
    if (src.needsFile) return bundleSourceCard(src);
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

  /**
   * Bundle: a fonte é um arquivo .tar.gz (da pasta de exports ou um caminho
   * digitado — o bundle pode ter vindo de outra máquina).
   */
  function bundleSourceCard(src) {
    const bundles = src.bundles || [];
    const last = src.lastRun;
    const known = bundles.some((b) => b.file === state.bundleFile);
    const sel = el('select', { class: 'field' },
      el('option', { value: '', text: bundles.length ? 'escolher bundle…' : 'nenhum bundle na pasta ainda' }),
      ...bundles.map((b) => el('option', {
        value: b.file,
        text: `${b.file} — ${b.pages ?? '?'} página(s)${b.scopes?.length ? ` · ${b.scopes.length} escopo(s)` : ''}${b.error ? ' · ilegível' : ''}`,
      })),
    );
    if (known) sel.value = state.bundleFile;
    const pathInput = el('input', {
      class: 'field mono',
      placeholder: 'ou o caminho do arquivo: ~/Downloads/bundle.tar.gz',
      autocomplete: 'off',
      value: state.bundleFile && !known ? state.bundleFile : '',
    });
    const chosen = () => pathInput.value.trim() || sel.value;
    const scanBtn = el('button', {
      class: 'btn btn-primary btn-sm',
      text: 'Escanear',
      onclick: () => { state.bundleFile = chosen(); if (!state.bundleFile) { toast('escolha o arquivo do bundle', 'err'); return; } doScan('bundle'); },
    });
    const selected = bundles.find((b) => b.file === state.bundleFile);
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: src.label }),
        el('span', { class: `chip ${bundles.length ? 'chip-ok' : 'chip-warn'}`, text: `${bundles.length} arquivo(s)` }),
      ),
      el('div', { class: 'mono small muted', text: src.root }),
      el('div', { class: 'small muted', text: src.hint }),
      el('div', { class: 'small muted', text: 'O destino de cada página é o mesmo escopo de origem do bundle (o projeto é criado no servidor de destino se ainda não existir) — e dá para apontar para outro ai-memory no campo "servidor de destino", depois do scan.' }),
      sel,
      pathInput,
      selected
        ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' },
            el('span', { class: 'chip', text: `${selected.pages ?? '?'} página(s)` }),
            selected.exportedAt ? el('span', { class: 'chip', text: `exportado ${timeAgo(selected.exportedAt) || selected.exportedAt}` }) : null,
            selected.origin ? el('span', { class: 'chip mono', text: `de ${selected.origin}` }) : null,
            selected.error ? el('span', { class: 'chip chip-err', text: selected.error }) : null,
          )
        : null,
      last
        ? el('div', { class: 'small muted', text: `último import desta fonte: ${timeAgo(last.endedAt) || 'agora'} · ${last.imported} importada(s)${last.failed ? ` · ${last.failed} falha(s)` : ''}` })
        : null,
      el('div', { class: 'row' }, scanBtn, el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => loadSources() })),
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
      scan = await api('/api/import/scan', { method: 'POST', body: { source: id, bundleFile: id === 'bundle' ? state.bundleFile : undefined } });
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

    // bundle: o destino pode ser OUTRO servidor do ai-memory (URL + token)
    const serverPanel = state.source === 'bundle' ? destinationServerPanel() : null;

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

    scanHost.replaceChildren(...[
      el('div', { class: 'card stack' },
        el('div', { class: 'row-between', style: 'flex-wrap:wrap' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('strong', { text: `Scan: ${state.scan.source}` }),
            el('span', { class: 'chip', text: `${s.total} item(ns)` }),
            state.scan.file ? el('span', { class: 'chip mono', text: String(state.scan.file).split('/').pop() }) : null,
            state.scan.bundle?.origin ? el('span', { class: 'chip mono', text: `de ${state.scan.bundle.origin}` }) : null,
            state.scan.bundle?.exportedAt ? el('span', { class: 'chip', text: `exportado ${timeAgo(state.scan.bundle.exportedAt) || state.scan.bundle.exportedAt}` }) : null,
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
      serverPanel,
      actionBar,
    ].filter(Boolean));
    main.scrollTop = scroll;
  }

  /**
   * Para onde o lote vai: o servidor do painel (padrão) ou outro ai-memory.
   * O token fica só na memória da página — não é salvo em lugar nenhum.
   */
  function destinationServerPanel() {
    const urlInput = el('input', { class: 'field mono', placeholder: 'http://outro-host:49374', autocomplete: 'off', value: state.remote.url });
    const tokenInput = el('input', { class: 'field', type: 'password', placeholder: 'token do outro servidor (Bearer)', autocomplete: 'off', value: state.remote.token });
    urlInput.addEventListener('input', () => { state.remote.url = urlInput.value.trim(); });
    tokenInput.addEventListener('input', () => { state.remote.token = tokenInput.value.trim(); });
    const radio = (value, label) => {
      const input = el('input', { type: 'radio', name: 'imp-server', value });
      input.checked = (value === 'remote') === Boolean(state.remote.enabled);
      input.addEventListener('change', () => { if (input.checked) { state.remote.enabled = value === 'remote'; renderScan(); } });
      return el('label', { class: 'check' }, input, label);
    };
    const rt = state.runtime || {};
    return el('div', { class: 'card stack', style: 'gap:6px' },
      el('strong', { text: 'Servidor de destino' }),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' },
        radio('local', `este painel (${rt.serverUrl || '?'})`),
        radio('remote', 'outro servidor do ai-memory'),
      ),
      state.remote.enabled
        ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' }, urlInput, tokenInput)
        : null,
      el('div', { class: 'small muted', text: state.remote.enabled
        ? 'Sem token local nenhum: o painel envia só o token digitado (e nada é salvo no disco). O destino cria o projeto se ele não existir.'
        : 'A gravação vai para o servidor configurado no painel — troque para "outro servidor" ao levar o bundle para outra máquina.' }),
    );
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
      full = await api('/api/import/item', { method: 'POST', body: { source: state.source, key: it.key, bundleFile: state.source === 'bundle' ? state.bundleFile : undefined } });
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
        state.source === 'bundle'
          ? el('div', { class: `small ${state.remote.enabled ? '' : 'muted'}`, text: state.remote.enabled
              ? `Destino: ${state.remote.url} — outro servidor do ai-memory${state.remote.token ? ' (com token digitado)' : ' (sem token)'}.`
              : `Destino: o servidor deste painel (${state.runtime?.serverUrl || '?'}).` })
          : null,
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
    const isBundle = state.source === 'bundle';
    if (isBundle && state.remote.enabled && (!state.remote.url || !/^https?:\/\/\S+$/i.test(state.remote.url))) {
      state.busy = false;
      toast('informe a URL do outro servidor (http://host:porta)', 'err');
      return;
    }
    const payload = {
      source: state.source,
      keys,
      overrides,
      dryRun,
      bundleFile: isBundle ? state.bundleFile : undefined,
      server: isBundle && state.remote.enabled ? { url: state.remote.url, token: state.remote.token } : undefined,
    };
    let started;
    try {
      started = await api('/api/import/apply', { method: 'POST', body: payload });
    } catch (err) {
      state.busy = false;
      toast(err.message, 'err');
      return;
    }
    logCard.style.display = '';
    logCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(`import iniciado: ${started.total} item(ns)`);
    const scopeNote = `${started.total} item(ns) · ${state.source}${isBundle && state.remote.enabled ? ` → ${state.remote.url}` : ''}`;
    showJob(started.id, logCard, statusChip, { scopeNote });
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
        'Bundle do ai-memory: um .tar.gz exportado na aba Exportar (ou por `ai-memory export-okf`). O destino padrão de cada página é o mesmo escopo de origem do bundle.',
        'knowledge.db do Kiro e implement-memory do Grok ficam fora: são biblioteca de documentos, não memória curada.',
      ])),
      helpSection('Importar um bundle em outro servidor', bullets([
        'Escolha o arquivo na fonte "Bundle do ai-memory" (pasta de exports do painel ou um caminho digitado) e clique em Escanear.',
        'No campo "servidor de destino", troque para "outro servidor do ai-memory" e informe a URL e o token (Bearer) da outra máquina: a gravação vai por MCP para lá.',
        'O token digitado não é salvo em disco, e o token local do painel nunca é enviado para o servidor remoto.',
        'Se o MCP remoto cair, a CLI é usada como reserva já apontada para a URL informada (mesmo token).',
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

// ---------- view: exportar bundle ----------

VIEWS.export = async (main) => {
  // deep link gateado: sem volume do store local, a exportação não tem o que
  // ler — mostra o porquê em vez do casco da ferramenta (a entrada oficial é o
  // botão condicional no card "CLI e dados locais" do dashboard)
  const setup = SETUP || await api('/api/setup').catch(() => null);
  if (setup && !(setup.paths.storeDirWiki && setup.paths.storeDirDb)) {
    main.append(
      el('div', { class: 'card stack', style: 'gap:8px' },
        el('strong', { text: 'Exportação indisponível' }),
        el('p', { class: 'small muted', style: 'margin:0', text: `A exportação lê o volume do store LOCAL (${setup.paths.storeDir}), que não existe nesta máquina — as memórias do servidor conectado (${setup.server.url}) ficam nele, não aqui.` }),
        el('p', { class: 'small muted', style: 'margin:0', text: 'Quando existir um store local (Docker ou ai-memory local), a entrada volta no dashboard — card "CLI e dados locais".' }),
        el('div', { class: 'row', style: 'gap:6px' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Voltar ao painel', onclick: () => { location.hash = 'dashboard'; } }),
        ),
      ),
    );
    return;
  }

  const state = {
    store: null,
    scopes: [],
    totals: null,
    bundles: [],
    exportsDir: null,
    runtime: null,
    selected: new Set(),
    includeRaw: false,
    name: '',
    busy: false,
  };

  const runtimeChips = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' });
  const scopesCard = el('div', { class: 'card stack' });
  const bundlesCard = el('div', { class: 'card stack' });
  const statusChip = el('span', { class: 'chip', text: 'idle' });
  const logCard = el(
    'div',
    { class: 'card stack', style: 'display:none' },
    el('div', { class: 'row-between' },
      el('div', { class: 'row' }, el('strong', { text: 'Log da exportação' }), el('span', { class: 'mono small muted', 'data-job-label': '', text: '' })),
      el('div', { class: 'row' }, statusChip, el('button', { class: 'btn btn-secondary btn-sm', text: 'fechar', onclick: () => { stopLogStream(); logCard.style.display = 'none'; } })),
    ),
    el('div', { class: 'log-panel' }),
  );

  const headerCard = el('div', { class: 'card stack' },
    el('div', { class: 'row-between' },
      el('strong', { text: 'Levar as memórias para outro servidor' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: () => load() }),
        el('button', { class: 'btn btn-secondary btn-sm', text: '? como funciona', onclick: exportHelpModal }),
      ),
    ),
    el('div', { class: 'small muted', text: 'O painel junta as páginas dos escopos escolhidos (o conteúdo vem do próprio wiki; a lista de páginas vem do SQLite do servidor) num .tar.gz com manifesto, e grava na pasta de exports. Esse arquivo é o que a aba Importar consome — aqui mesmo ou em outra máquina, apontando para o servidor de destino.' }),
    runtimeChips,
  );

  main.append(el('div', { class: 'stack' }, headerCard, scopesCard, logCard, bundlesCard));

  async function load() {
    scopesCard.replaceChildren(el('div', { class: 'empty', text: 'lendo o store…' }));
    let data;
    try {
      data = await api('/api/export/sources');
    } catch (err) {
      scopesCard.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${err.message}` })));
      return;
    }
    state.store = data.store;
    state.scopes = data.scopes || [];
    state.totals = data.totals || null;
    state.bundles = data.bundles || [];
    state.exportsDir = data.exportsDir;
    state.runtime = data.runtime || null;
    // primeira carga: tudo selecionado (menos _global, que é escolha explícita)
    if (!state.selected.size) {
      for (const s of state.scopes) state.selected.add(`${s.workspace}/${s.project}`);
    }
    renderRuntime();
    renderScopes();
    renderBundles();
  }

  function renderRuntime() {
    const st = state.store;
    if (!st) return;
    runtimeChips.replaceChildren(...[
      el('span', { class: `chip ${st.available ? 'chip-ok' : 'chip-err'}`, text: `store ${st.dir}` }),
      el('span', { class: `chip ${st.sqlite ? 'chip-ok' : 'chip-warn'}`, text: st.sqlite ? 'sqlite3 ok' : 'sqlite3 ausente' }),
      el('span', { class: 'chip mono', text: `exports ${state.exportsDir}` }),
      state.runtime?.serverUrl ? el('span', { class: 'chip mono', text: `servidor ${state.runtime.serverUrl}` }) : null,
      state.totals ? el('span', { class: 'chip', text: `${state.totals.pages} página(s) · ${state.totals.raw} crua(s) · ${state.totals.scopes} escopo(s)` }) : null,
      ...(st.note || []).map((n) => el('span', { class: 'chip chip-err', text: n })),
      st.error ? el('span', { class: 'chip chip-err', text: st.error }) : null,
    ].filter(Boolean));
  }

  function chosen() {
    return state.scopes.filter((s) => state.selected.has(`${s.workspace}/${s.project}`));
  }

  function renderScopes() {
    if (!state.scopes.length) {
      scopesCard.replaceChildren(el('div', { class: 'card stack' },
        el('strong', { text: 'Nenhum escopo no store' }),
        el('div', { class: 'small muted', text: state.store?.sqlite
          ? `O store em ${state.store.dir} não devolveu nenhuma página latest.`
          : 'Sem o sqlite3 no PATH o painel não lista as páginas do store — defina AIM_STORE_DIR se o volume estiver em outro lugar.' }),
      ));
      return;
    }
    const rows = state.scopes.map((s) => {
      const key = `${s.workspace}/${s.project}`;
      const cb = el('input', { type: 'checkbox' });
      cb.checked = state.selected.has(key);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(key);
        else state.selected.delete(key);
        renderScopes();
      });
      return el('div', { class: 'imp-item' },
        el('label', { class: 'check', style: 'align-self:flex-start; margin-top:2px' }, cb),
        el('div', { class: 'stack', style: 'gap:2px; flex:1; min-width:0' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('strong', { style: 'font-size:13px', text: key }),
            s.global ? el('span', { class: 'chip chip-info', text: '_global' }) : null,
            el('span', { class: 'chip', text: `${s.pages} página(s)` }),
            s.raw ? el('span', { class: 'chip chip-warn', text: `${s.raw} crua(s)` }) : null,
            s.pinned ? el('span', { class: 'chip', text: `${s.pinned} pinned` }) : null,
            el('span', { class: 'chip', text: fmtBytes(s.bytes) || '0 B' }),
          ),
          s.repoPath ? el('div', { class: 'mono small muted', text: s.repoPath }) : null,
        ),
      );
    });
    const pick = (on) => {
      state.selected = new Set(on ? state.scopes.map((s) => `${s.workspace}/${s.project}`) : []);
      renderScopes();
    };
    const rawCb = el('input', { type: 'checkbox' });
    rawCb.checked = state.includeRaw;
    rawCb.addEventListener('change', () => { state.includeRaw = rawCb.checked; renderScopes(); });
    const nameInput = el('input', { class: 'field mono', placeholder: 'nome do arquivo (opcional)', autocomplete: 'off', value: state.name, style: 'max-width:320px' });
    nameInput.addEventListener('input', () => { state.name = nameInput.value.trim(); });

    scopesCard.replaceChildren(
      el('div', { class: 'row-between', style: 'flex-wrap:wrap' },
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('strong', { text: 'O que entra no bundle' }),
          el('span', { class: 'chip', text: `${chosen().length} de ${state.scopes.length} escopo(s)` }),
        ),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'todos', onclick: () => pick(true) }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'nenhum', onclick: () => pick(false) }),
        ),
      ),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:12px' },
        el('label', { class: 'check' }, rawCb, 'incluir páginas cruas (sessões, logs, episódicas)'),
      ),
      el('div', { class: 'small muted', text: 'Sem os crus, ficam de fora as páginas de sessão/histórico (tier episodic, sessions/, log-*.md). As páginas de _rules, gotchas, decisions e notes vão sempre com frontmatter, tier, tags e pinned preservados.' }),
      el('div', { class: 'stack', style: 'gap:6px' }, ...rows),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' }, nameInput,
        el('button', { class: 'btn btn-secondary btn-sm', text: 'simular (dry-run)', disabled: !chosen().length, onclick: planExport }),
        el('button', { class: 'btn btn-primary btn-sm', text: 'Exportar bundle', disabled: !chosen().length || state.busy, onclick: startExport }),
      ),
    );
  }

  async function planExport() {
    let plan;
    try {
      plan = await api('/api/export/plan', { method: 'POST', body: { scopes: chosen().map((s) => ({ workspace: s.workspace, project: s.project })), includeRaw: state.includeRaw, name: state.name } });
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    modal({
      title: 'Simular exportação (dry-run)',
      wide: true,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('span', { class: 'chip chip-info', text: `${plan.pages} página(s)` }),
          el('span', { class: 'chip', text: fmtBytes(plan.bytes) || '0 B' }),
          el('span', { class: 'chip', text: `${plan.scopes.length} escopo(s)` }),
          plan.rawSkipped ? el('span', { class: 'chip chip-warn', text: `${plan.rawSkipped} crua(s) fora` }) : null,
        ),
        el('div', { class: 'mono small muted', text: `${state.exportsDir}/${plan.file}` }),
        el('div', { class: 'small muted', text: 'O dry-run não grava nada: só lista o que entraria, sem ler os arquivos do wiki.' }),
        plan.warnings?.length ? el('div', { class: 'small', style: 'color:var(--attention)', text: `avisos: ${plan.warnings.slice(0, 4).join(' · ')}` }) : null,
        el('div', { class: 'stack', style: 'gap:2px' },
          ...plan.scopes.map((s) => el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('span', { class: 'chip mono', text: s.key }),
            el('span', { class: 'chip', text: `${s.pages} página(s)` }),
            el('span', { class: 'chip', text: fmtBytes(s.bytes) || '0 B' }),
            s.rawSkipped ? el('span', { class: 'chip chip-warn', text: `${s.rawSkipped} crua(s) fora` }) : null,
          )),
        ),
        el('div', { class: 'small muted', text: `primeiras páginas: ${plan.preview.slice(0, 12).map((p) => p.path).join(' · ')}${plan.preview.length > 12 ? ` … (+${plan.pages - 12})` : ''}` }),
      ),
      actions: [
        { label: 'Fechar' },
        { label: 'Exportar agora', kind: 'primary', onClick: (close) => { close(); startExport(); } },
      ],
    });
  }

  async function startExport() {
    if (state.busy) return;
    state.busy = true;
    let started;
    try {
      started = await api('/api/export/run', { method: 'POST', body: { scopes: chosen().map((s) => ({ workspace: s.workspace, project: s.project })), includeRaw: state.includeRaw, name: state.name } });
    } catch (err) {
      state.busy = false;
      toast(err.message, 'err');
      return;
    }
    toast(`exportação iniciada: ${started.scopes.length} escopo(s)`);
    logCard.style.display = '';
    logCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showJob(started.id, logCard, statusChip, { scopeNote: `${started.scopes.length} escopo(s)${state.includeRaw ? ' · com cruas' : ''}` });
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
      toast(j.status === 'ok' ? 'bundle pronto' : `exportação terminou com ${j.status}`, j.status === 'ok' ? 'ok' : 'err');
      await load();
    }, 1200);
  }

  function renderBundles() {
    if (!state.bundles.length) {
      bundlesCard.replaceChildren(el('div', { class: 'row-between' },
        el('strong', { text: 'Bundles na pasta de exports' }),
        el('span', { class: 'chip', text: 'nenhum ainda' }),
      ), el('div', { class: 'small muted', text: `Os arquivos ficam em ${state.exportsDir} (mode 600: bundle tem memória privada).` }));
      return;
    }
    const rows = state.bundles.map((b) => el('tr', {},
      el('td', { class: 'mono', text: b.file }),
      el('td', { text: b.pages === null || b.pages === undefined ? '?' : String(b.pages) }),
      el('td', { text: (b.scopes || []).join(', ') || '—' }),
      el('td', { text: fmtBytes(b.bytes) || '—' }),
      el('td', { text: timeAgo(b.mtime) || '—' }),
      el('td', {}, el('div', { class: 'row', style: 'gap:4px' },
        el('a', { class: 'btn btn-secondary btn-sm', href: `/api/export/download?file=${encodeURIComponent(b.file)}`, download: b.file, text: 'baixar' }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'importar', onclick: () => { PENDING_BUNDLE = b.file; location.hash = 'import'; } }),
        el('button', { class: 'btn btn-secondary btn-sm', text: 'excluir', onclick: () => confirmModal({
          title: `Excluir ${b.file}`,
          message: `O arquivo ${b.file} será apagado de ${state.exportsDir}. O que já foi importado no ai-memory não muda.`,
          word: b.file,
          danger: true,
          onConfirm: async () => {
            try {
              await api('/api/export/delete', { method: 'POST', body: { file: b.file, confirm: b.file } });
              toast('bundle excluído');
              await load();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        }) }),
      )),
    ));
    const tbody = el('tbody', {}, ...rows);
    bundlesCard.replaceChildren(
      el('div', { class: 'row-between' },
        el('strong', { text: 'Bundles na pasta de exports' }),
        el('span', { class: 'chip', text: `${state.bundles.length} arquivo(s)` }),
      ),
      el('div', { class: 'small muted', text: 'Reimportar um bundle não duplica páginas (o ai-memory versiona por path). "importar" leva o arquivo já selecionado para a aba Importar.' }),
      el('table', {}, el('thead', {}, el('tr', {},
        el('th', { text: 'arquivo' }), el('th', { text: 'páginas' }), el('th', { text: 'escopos' }), el('th', { text: 'tamanho' }), el('th', { text: 'quando' }), el('th', {},
        ))), tbody),
    );
  }

  await load();
};

function exportHelpModal() {
  modal({
    title: 'Exportar bundle — como funciona',
    wide: true,
    bodyNode: el('div', { class: 'stack' },
      helpSection('O que é o bundle', bullets([
        'Um .tar.gz com as páginas de um ou mais escopos: manifest.json (escopo, path, kind, tier, tags, pinned e sha256 de cada página), README, _meta.md por escopo e os .md como estão no wiki.',
        'A lista de páginas vem do SQLite do servidor (só as latest) e o conteúdo do wiki; arquivos que não são páginas (log-*.md, _pending/) ficam fora.',
        'Por padrão as páginas cruas (sessões, logs, tier episodic) não entram — o botão do dry-run mostra quantas ficariam de fora.',
        'O ai-memory versiona por path: importar o mesmo bundle de novo atualiza as páginas em vez de duplicá-las.',
      ])),
      helpSection('Como importar em outro servidor', bullets([
        'Aba Importar → fonte "Bundle do ai-memory" → escolha o arquivo → Escanear → revisar item a item → Importar selecionados.',
        'Para gravar em OUTRO servidor, mude "servidor de destino" para "outro servidor do ai-memory" e informe URL + token: nada é salvo no disco e o token local fica de fora.',
        'Sem token no destino, nenhum Authorization é enviado.',
        'Alternativa sem painel: extrair em <store>/wiki/ do destino e rodar `ai-memory reindex` com o servidor parado.',
      ])),
      helpSection('Onde ficam os arquivos', bullets([
        'Pasta de exports do painel (AIM_APP_EXPORT_DIR, padrão <repo>/exports), gravados com permissão 600.',
        'Cada bundle é verificado ao final: o painel relê o arquivo e confere o sha256 de cada página antes de dizer "pronto".',
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
    tab: 'globais', // globais | workspaces | colecao
    wsParent: '',
    wsData: null,
    wsError: null,
    wsLoading: false,
    wsDetail: null,
    colData: null,
    colError: null,
    colQuery: '',
  };
  const list = el('div', { class: 'stack' });

  // log dos jobs de bundle (export/import) — nó único: re-renders da aba
  // re-usam o mesmo elemento, então o stream SSE sobrevive a eles
  const colStatusChip = el('span', { class: 'chip', text: 'idle' });
  const colLogCard = el(
    'div',
    { class: 'card stack', style: 'display:none' },
    el('div', { class: 'row-between' },
      el('div', { class: 'row' }, el('strong', { text: 'Log do bundle de skills' }), el('span', { class: 'mono small muted', 'data-job-label': '', text: '' })),
      el('div', { class: 'row' }, colStatusChip, el('button', { class: 'btn btn-secondary btn-sm', text: 'fechar', onclick: () => { stopLogStream(); colLogCard.style.display = 'none'; } })),
    ),
    el('div', { class: 'log-panel' }),
  );

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
      el('button', {
        class: `subtab ${state.tab === 'colecao' ? 'active' : ''}`,
        text: 'Coleção (gestor)',
        title: 'Coleção própria do painel: instalar em harness/projeto, importar dos harnesses, versões e bundles',
        onclick: () => {
          state.tab = 'colecao';
          if (state.colData || state.colError) { renderControls(); renderList(); }
          else loadCollection();
        },
      }),
    );

    const parts = [tabs];
    if (state.tab === 'colecao') {
      const col = state.colData;
      parts.push(
        el('div', { class: 'row', style: 'flex-wrap:wrap' },
          el('button', { class: 'btn btn-primary btn-sm', text: 'Importar do harness…', onclick: openImportFromHarness }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Exportar bundle…', onclick: openExportBundle }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Importar bundle…', onclick: openImportBundle }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'atualizar', onclick: loadCollection }),
        ),
        colLogCard,
        col
          ? el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
              el('span', { class: 'chip mono', text: col.dir }),
              el('span', { class: 'chip', text: `${col.totals.skills} skill(s) · ${col.totals.files} arquivo(s) · ${fmtBytes(col.totals.bytes) || '0 B'}` }),
              el('span', { class: 'chip', text: `${(col.bundles?.bundles || []).length} bundle(s) de skills` }),
            )
          : el('div', { class: 'small muted', text: 'carregando coleção…' }),
        state.colError ? el('div', { class: 'chip chip-err', text: state.colError }) : null,
        el('input', {
          class: 'field',
          placeholder: 'buscar na coleção…',
          value: state.colQuery,
          oninput: (e) => { state.colQuery = e.target.value; renderCollection(); },
        }),
      );
    } else if (state.tab === 'workspaces') {
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
    if (state.tab === 'colecao') return renderCollection();
    if (state.tab === 'workspaces') renderWorkspaces();
    else renderGlobalList();
  }

  async function loadCollection() {
    state.colData = null;
    state.colError = null;
    renderControls();
    renderList();
    try {
      state.colData = await api('/api/collection/skills');
    } catch (err) {
      state.colError = err.message;
    }
    renderControls();
    renderList();
  }

  /** Copia uma skill (de projeto ou de harness) para a coleção do gestor. */
  async function copyToGestor({ name, harness, ws, kind }) {
    try {
      const out = await api('/api/collection/skills/import', {
        method: 'POST',
        body: { name, harness, kind: kind || (ws ? 'project' : 'user'), ws },
      });
      if (out.skipped) toast(`"${out.name}" já está na coleção (idêntica)`);
      else toast(`"${out.name}" ${out.action} na coleção${out.snapshotId ? ` (estado anterior em v${out.snapshotId})` : ''}`, 'ok');
      loadCollection();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ---------- aba coleção (gestor de skills) ----------

  function renderCollection() {
    const data = state.colData;
    if (state.colError) {
      list.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'small', text: `Erro: ${state.colError}` })));
      return;
    }
    if (!data) {
      list.replaceChildren(el('div', { class: 'empty', text: 'carregando coleção…' }));
      return;
    }
    const q = state.colQuery.trim().toLowerCase();
    let skills = data.skills;
    if (q) skills = skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));

    const parts = [];
    if (skills.length) {
      parts.push(sectionTitle(`Coleção · ${skills.length} skill(s) — instalar copia a pasta inteira (SKILL.md + recursos)`), ...skills.map(colSkillCard));
    }
    if (!q && data.deleted?.length) {
      parts.push(sectionTitle(`Excluídas da coleção, com versões retidas · ${data.deleted.length}`), ...data.deleted.map(colDeletedCard));
    }
    if (!parts.length) {
      list.replaceChildren(el('div', { class: 'empty', text: q ? 'nenhuma skill na coleção para essa busca' : 'coleção vazia — importe skills dos harnesses ("Importar do harness…") ou de um bundle' }));
      return;
    }
    list.replaceChildren(...parts);
  }

  function colHarnessChips(skill) {
    return (state.colData?.harnesses || []).map((h) => {
      const on = (skill.installed || []).includes(h.id);
      return el('span', {
        class: on ? 'chip chip-ok' : 'chip',
        style: on ? 'cursor:pointer' : 'opacity:.4',
        text: h.label,
        title: on ? `instalada em ${h.label} — clique para reinstalar/atualizar` : `não instalada em ${h.label} — clique para instalar`,
        onclick: () => openCollectionInstall(skill, h.id),
      });
    });
  }

  /** Viewer completo (mesma view da aba Globais) com a coleção como fonte padrão. */
  function openCollectionView(skill) {
    const sources = [{
      label: 'coleção do gerenciador',
      title: skill.dir,
      collection: true,
      params: { name: skill.name },
      preferred: true,
    }];
    for (const c of skill.copies || []) {
      sources.push({
        label: `${c.harness}${c.kind !== 'user' ? ` · ${c.kind}` : ''}`,
        title: c.path,
        params: { name: skill.name, harness: c.harness, kind: c.kind },
      });
    }
    openSkillViewer({
      title: skill.name,
      managed: skill.managed,
      badge: 'coleção',
      onEdit: (src, rel) => openCollectionEditor(skill, rel),
      sources,
    });
  }

  function colSkillCard(skill) {
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: skill.name }),
        el('div', { class: 'row' },
          skill.versions ? el('span', { class: 'chip chip-info', text: `${skill.versions} versão(ões)` }) : null,
          el('span', { class: 'chip', text: `${skill.files} arquivo(s) · ${fmtBytes(skill.bytes) || '0 B'}` }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'ver…', title: 'arquivos e recursos com preview renderizado', onclick: () => openCollectionView(skill) }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Editar…', title: 'editar o SKILL.md e arquivos de texto da skill (salvar cria uma versão do estado anterior)', onclick: () => openCollectionEditor(skill) }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Versões…', onclick: () => openVersions(skill) }),
          el('button', { class: 'btn btn-primary btn-sm', text: 'Instalar…', onclick: () => openCollectionInstall(skill) }),
        ),
      ),
      skill.description
        ? el('div', { class: 'small muted', text: skill.description.length > 240 ? `${skill.description.slice(0, 240)}…` : skill.description })
        : null,
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, colHarnessChips(skill)),
    );
  }

  function colDeletedCard(item) {
    return el('div', { class: 'card stack' },
      el('div', { class: 'row-between' },
        el('strong', { text: item.name }),
        el('div', { class: 'row' },
          el('span', { class: 'chip chip-warn', text: `${item.versions} versão(ões) retidas` }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'Restaurar versão…', onclick: () => openVersions({ name: item.name }) }),
        ),
      ),
      el('div', { class: 'small muted', text: 'não está mais em <coleção>/<nome>; restaurar uma versão recria a pasta' }),
    );
  }

  /** Preview do SKILL.md atual ou de uma versão registrada. */
  function previewCollectionContent(name, version) {
    const q = new URLSearchParams({ name });
    if (version) q.set('version', String(version));
    const box = el('div', { class: 'stack' }, el('div', { class: 'small muted', text: 'carregando…' }));
    modal({ title: version ? `${name} · v${version} (SKILL.md)` : `${name} · SKILL.md da coleção`, wide: true, bodyNode: box, actions: [{ label: 'Fechar' }] });
    api(`/api/collection/skills/content?${q}`).then(({ content }) => {
      box.replaceChildren(el('div', { class: 'codeblock', style: 'max-height:60vh; overflow:auto', text: content }));
    }).catch((err) => {
      box.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
    });
  }

  /**
   * Editor dos arquivos de texto da skill da coleção (SKILL.md + recursos).
   * Salvar cria snapshot do estado anterior — o mesmo contrato das outras
   * escritas do gestor.
   */
  async function openCollectionEditor(skill, initialRel = 'SKILL.md') {
    let filesData;
    try {
      filesData = await api(`/api/collection/skills/files?name=${encodeURIComponent(skill.name)}`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    const editable = filesData.files.filter((f) => f.editable);
    if (!editable.length) {
      toast(`"${skill.name}" não tem arquivos de texto editáveis`, 'err');
      return;
    }

    const sel = el('select', { class: 'field' }, editable.map((f) => el('option', { value: f.rel, text: `${f.rel} · ${fmtBytes(f.size) || '0 B'}` })));
    if (editable.some((f) => f.rel === initialRel)) sel.value = initialRel;
    const ta = el('textarea', { class: 'field', style: 'min-height:48vh; white-space:pre; overflow:auto', spellcheck: 'false' });
    const warn = el('div', { class: 'small', style: 'display:none; color: var(--attention)' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: 'Salvar', onclick: saveCurrent });
    const closeFn = modal({
      title: `Editar "${skill.name}"`,
      wide: true,
      bodyNode: el('div', { class: 'stack' },
        editable.length > 1
          ? el('div', { class: 'stack', style: 'gap:4px' }, el('div', { class: 'field-label', text: 'Arquivo' }), sel)
          : null,
        ta,
        warn,
        el('div', { class: 'small muted', text: 'salvar grava o arquivo e registra o estado anterior da skill como nova versão ("antes de editar").' }),
      ),
      actions: [{ label: 'Cancelar' }, saveBtn],
    });

    function checkFrontmatter() {
      if (sel.value !== 'SKILL.md') {
        warn.style.display = 'none';
        return;
      }
      const hasFm = /^---\r?\n[\s\S]*?\r?\n---/.test(ta.value);
      warn.style.display = hasFm ? 'none' : '';
      warn.textContent = 'SKILL.md sem frontmatter — name/description deixam de ser lidos na listagem e nos harnesses.';
    }

    async function loadFile() {
      ta.value = 'carregando…';
      ta.disabled = true;
      saveBtn.disabled = true;
      warn.style.display = 'none';
      warn.textContent = '';
      try {
        const data = await api(`/api/collection/skills/file?name=${encodeURIComponent(skill.name)}&rel=${encodeURIComponent(sel.value)}`);
        if (data.kind !== 'text') {
          ta.value = '';
          warn.style.display = '';
          warn.textContent = 'arquivo binário ou grande demais para editar por aqui.';
          return;
        }
        ta.value = data.content;
        ta.disabled = false;
        saveBtn.disabled = false;
        checkFrontmatter();
      } catch (err) {
        ta.value = '';
        warn.style.display = '';
        warn.textContent = `erro ao ler: ${err.message}`;
      }
    }

    async function saveCurrent() {
      saveBtn.disabled = true;
      try {
        const out = await api('/api/collection/skills/file', { method: 'POST', body: { name: skill.name, rel: sel.value, content: ta.value } });
        if (out.same) toast(`${out.rel} já estava igual — nada salvo`);
        else toast(`${out.rel} salvo — estado anterior em v${out.snapshotId}`, 'ok');
        loadCollection();
      } catch (err) {
        toast(err.message, 'err');
      }
      saveBtn.disabled = false;
    }

    sel.addEventListener('change', loadFile);
    await loadFile();
  }

  function openCollectionInstall(skill, preselect) {
    const targets = state.colData?.harnesses || [];
    const sel = el('select', { class: 'field' }, targets.map((h) => el('option', { value: h.id, text: h.label })));
    if (preselect && targets.some((h) => h.id === preselect)) sel.value = preselect;
    else if (state.harness !== 'todos' && targets.some((h) => h.id === state.harness)) sel.value = state.harness;

    const rbGlobal = el('input', { type: 'radio', name: 'col-skill-scope', value: 'global', checked: true });
    const rbProject = el('input', { type: 'radio', name: 'col-skill-scope', value: 'project' });
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
      api('/api/collection/skills/install', { method: 'POST', body: payload })
        .then((out) => {
          closeFn?.();
          toast(`skill instalada em ${out.path}`, 'ok');
          loadCollection();
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
            message: `"${skill.name}" já existe no destino sem o marker gerenciado e será sobrescrita — a pasta atual vai para o root de backups (.skill-backups). Continuar?`,
            word: 'instalar',
            onConfirm: () => run(true),
          });
        } else {
          run(false);
        }
      },
    });

    closeFn = modal({
      title: `Instalar "${skill.name}" da coleção`,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'field-label', text: 'Harness de destino' }),
        sel,
        el('div', { class: 'row', style: 'gap:16px' },
          el('label', { class: 'check', style: 'display:flex; gap:6px; align-items:center' }, rbGlobal, 'Global (~ do harness)'),
          el('label', { class: 'check', style: 'display:flex; gap:6px; align-items:center' }, rbProject, 'Projeto'),
        ),
        dirInput,
        el('div', { class: 'small muted', text: `conteúdo: pasta completa da coleção (${skill.files ?? '?'} arquivo(s)) — scripts e referências vão junto` }),
        warn,
      ),
      actions: [{ label: 'Cancelar' }, installBtn],
    });
  }

  async function openVersions(skill) {
    const box = el('div', { class: 'stack' }, el('div', { class: 'small muted', text: 'carregando versões…' }));
    modal({ title: `Versões de "${skill.name}"`, wide: true, bodyNode: box, actions: [{ label: 'Fechar' }] });

    async function reload() {
      let data;
      try {
        data = await api(`/api/collection/skills/versions?name=${encodeURIComponent(skill.name)}`);
      } catch (err) {
        box.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
        return;
      }
      const noteInput = el('input', { class: 'field', placeholder: 'nota da versão (opcional)', autocomplete: 'off' });
      const saveBtn = el('button', {
        class: 'btn btn-primary btn-sm',
        text: 'Salvar versão agora',
        disabled: !data.inCollection,
        title: data.inCollection ? '' : 'a skill não está mais na coleção',
        onclick: async () => {
          try {
            const out = await api('/api/collection/skills/version', { method: 'POST', body: { name: skill.name, note: noteInput.value.trim() || null } });
            toast(`versão ${out.version} salva`, 'ok');
            loadCollection();
            reload();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      });

      const rows = data.versions.map((v) => el('div', { class: 'imp-item' },
        el('div', { class: 'stack', style: 'gap:2px; flex:1; min-width:0' },
          el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
            el('strong', { text: `v${v.id}` }),
            el('span', { class: 'chip', text: timeAgo(v.createdAt) || new Date(v.createdAt).toLocaleString() }),
            el('span', { class: 'chip', text: `${v.files} arquivo(s) · ${fmtBytes(v.bytes) || '0 B'}` }),
            v.sha256 ? el('span', { class: 'chip mono', text: v.sha256.slice(0, 8) }) : null,
            v.source && v.source !== 'manual' ? el('span', { class: 'chip chip-info', text: v.source }) : null,
            !v.exists ? el('span', { class: 'chip chip-warn', text: 'snapshot ausente no disco' }) : null,
          ),
          v.note ? el('div', { class: 'small muted', text: v.note }) : null,
        ),
        el('div', { class: 'row', style: 'gap:4px' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'ver', disabled: !v.exists, onclick: () => previewCollectionContent(skill.name, v.id) }),
          el('button', {
            class: 'btn btn-secondary btn-sm',
            text: 'restaurar',
            disabled: !v.exists,
            onclick: () => confirmModal({
              title: `Restaurar v${v.id} de "${skill.name}"`,
              message: `A pasta atual da coleção será substituída pelo conteúdo de v${v.id}. O estado atual é salvo antes como nova versão ("antes de restaurar").`,
              word: 'restaurar',
              onConfirm: async () => {
                try {
                  const out = await api('/api/collection/skills/restore', { method: 'POST', body: { name: skill.name, version: v.id } });
                  toast(`v${out.restored} restaurada (${out.files} arquivo(s)${out.snapshotId ? `, estado anterior salvo em v${out.snapshotId}` : ''})`, 'ok');
                  loadCollection();
                  reload();
                } catch (err) {
                  toast(err.message, 'err');
                }
              },
            }),
          }),
        ),
      ));

      box.replaceChildren(
        el('div', { class: 'small muted', text: data.inCollection
          ? 'Snapshots vivem em .versions/ dentro da coleção. Importar por cima, restaurar e "Salvar versão" registram o estado atual antes de mudar.'
          : 'Esta skill não está mais na coleção — restaurar uma versão recria a pasta.' }),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, noteInput, saveBtn),
        data.versions.length
          ? el('div', { class: 'stack', style: 'gap:6px' }, ...rows)
          : el('div', { class: 'small muted', text: 'nenhuma versão registrada ainda' }),
      );
    }

    await reload();
  }

  async function openImportFromHarness() {
    const targets = state.colData?.harnesses || [];
    if (!targets.length) {
      toast('nenhum harness conhecido', 'err');
      return;
    }
    const selH = el('select', { class: 'field' }, targets.map((h) => el('option', { value: h.id, text: h.label })));
    // aproveita o filtro de harness ativo na listagem, se houver
    if (state.harness !== 'todos' && targets.some((h) => h.id === state.harness)) selH.value = state.harness;

    const listBox = el('div', { class: 'stack', style: 'gap:6px; max-height:46vh; overflow:auto' },
      el('div', { class: 'small muted', text: 'carregando skills do harness…' }));
    const countChip = el('span', { class: 'chip chip-info', text: '0 selecionada(s)' });
    const boxes = new Map(); // nome -> { cb, item }
    const importBtn = el('button', { class: 'btn btn-primary', text: 'Importar selecionadas', disabled: true, onclick: run });
    const closeFn = modal({
      title: 'Importar skills do harness para a coleção',
      wide: true,
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'field-label', text: 'Harness de origem' }),
        selH,
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'todos', onclick: () => pick(true) }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'nenhum', onclick: () => pick(false) }),
          countChip,
        ),
        listBox,
        el('div', { class: 'small muted', text: 'a cópia para a coleção inclui os arquivos da skill (scripts, referências, assets). Importar por cima de uma versão divergente salva o estado atual como nova versão.' }),
      ),
      actions: [{ label: 'Cancelar' }, importBtn],
    });

    function syncCount() {
      const n = [...boxes.values()].filter((v) => v.cb.checked).length;
      countChip.textContent = `${n} selecionada(s)`;
      importBtn.disabled = n === 0;
    }
    function pick(on) {
      for (const v of boxes.values()) v.cb.checked = on;
      syncCount();
    }

    async function loadHarness() {
      boxes.clear();
      listBox.replaceChildren(el('div', { class: 'small muted', text: 'carregando skills do harness…' }));
      let data;
      try {
        data = await api(`/api/collection/harness-skills?harness=${encodeURIComponent(selH.value)}`);
      } catch (err) {
        listBox.replaceChildren(el('div', { class: 'chip chip-err', text: err.message }));
        return;
      }
      if (!data.skills.length) {
        listBox.replaceChildren(el('div', { class: 'small muted', text: `nenhuma skill em ${data.label || selH.value}` }));
        syncCount();
        return;
      }
      const rows = data.skills.map((s) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !s.exists || s.same === false; // padrão: o que fará algo (nova ou diverge)
        cb.addEventListener('change', syncCount);
        boxes.set(s.name, { cb, item: s });
        return el('div', { class: 'imp-item' },
          el('label', { class: 'check', style: 'align-self:flex-start; margin-top:2px' }, cb),
          el('div', { class: 'stack', style: 'gap:2px; flex:1; min-width:0' },
            el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
              el('strong', { style: 'font-size:13px', text: s.name }),
              ...(s.kinds || []).map((k) => el('span', { class: 'chip', text: k })),
              s.managedOnly ? el('span', { class: 'chip chip-info', text: 'catálogo ai-memory' }) : null,
              s.exists
                ? el('span', { class: `chip ${s.same ? 'chip-ok' : 'chip-warn'}`, text: s.same ? 'na coleção · idêntica' : 'na coleção · diverge' })
                : el('span', { class: 'chip chip-info', text: 'nova' }),
              s.fileCount != null ? el('span', { class: 'chip', text: `${s.fileCount} arquivo(s) · ${fmtBytes(s.bytes) || '0 B'}` }) : null,
            ),
            s.description ? el('div', { class: 'small muted', text: s.description.slice(0, 200) }) : null,
          ),
        );
      });
      listBox.replaceChildren(el('div', { class: 'stack', style: 'gap:6px' }, ...rows));
      syncCount();
    }

    async function run() {
      const items = [...boxes.entries()]
        .filter(([, v]) => v.cb.checked)
        .map(([name, v]) => ({ name, harness: selH.value, kind: v.item.managedOnly ? 'managed' : (v.item.kinds || [])[0] }));
      if (!items.length) return;
      importBtn.disabled = true;
      countChip.textContent = `importando ${items.length} skill(s)…`;
      let out;
      try {
        out = await api('/api/collection/skills/import-batch', { method: 'POST', body: { items } });
      } catch (err) {
        toast(err.message, 'err');
        importBtn.disabled = false;
        syncCount();
        return;
      }
      closeFn?.();
      const parts = [];
      if (out.created) parts.push(`${out.created} criada(s)`);
      if (out.updated) parts.push(`${out.updated} atualizada(s)`);
      if (out.same) parts.push(`${out.same} já idêntica(s)`);
      const errors = out.results.filter((r) => r.action === 'erro');
      toast(`importação: ${parts.join(', ') || 'nada a fazer'}${errors.length ? `, ${errors.length} erro(s)` : ''}`, errors.length ? 'err' : 'ok');
      if (errors.length) toast(`${errors[0].name}: ${errors[0].error}`, 'err');
      loadCollection();
    }

    selH.addEventListener('change', loadHarness);
    await loadHarness();
  }

  function watchCollectionJob(started, doneMsg) {
    colLogCard.style.display = '';
    showJob(started.id, colLogCard, colStatusChip);
    const watch = setInterval(async () => {
      let j;
      try {
        j = await api(`/api/jobs/${started.id}`);
      } catch {
        clearInterval(watch);
        return;
      }
      if (j.status === 'running') return;
      clearInterval(watch);
      toast(j.status === 'ok' ? doneMsg : `operação terminou com ${j.status}`, j.status === 'ok' ? 'ok' : 'err');
      loadCollection();
    }, 1000);
  }

  function openExportBundle() {
    const nameInput = el('input', { class: 'field mono', placeholder: 'nome do arquivo (opcional)', autocomplete: 'off' });
    const exportBtn = el('button', {
      class: 'btn btn-primary',
      text: 'Exportar bundle',
      onclick: async () => {
        let started;
        try {
          started = await api('/api/collection/bundle/export', { method: 'POST', body: { name: nameInput.value.trim() || null } });
        } catch (err) {
          toast(err.message, 'err');
          return;
        }
        closeFn?.();
        watchCollectionJob(started, 'bundle de skills pronto');
      },
    });
    const closeFn = modal({
      title: 'Exportar bundle de skills',
      bodyNode: el('div', { class: 'stack' },
        el('div', { class: 'small', text: 'Gera um .tar.gz com todas as skills da coleção (SKILL.md + recursos) e grava na pasta de exports de skills. O histórico de versões não entra — só o estado atual.' }),
        el('div', { class: 'small muted mono', text: `destino: ${state.colData?.bundles?.dir || ''}` }),
        nameInput,
      ),
      actions: [{ label: 'Cancelar' }, exportBtn],
    });
  }

  function openImportBundle() {
    const data = state.colData;
    const bundles = data?.bundles?.bundles || [];
    const sel = el('select', { class: 'field' }, bundles.map((b) => el('option', {
      value: b.file,
      text: `${b.file}${b.skills != null ? ` · ${b.skills} skill(s)` : ''}${b.exportedAt ? ` · ${timeAgo(Date.parse(b.exportedAt))}` : ''}`,
    })));
    const pathInput = el('input', { class: 'field mono', placeholder: '…ou caminho de um .tar.gz (sob o home)', autocomplete: 'off' });
    const chosen = () => pathInput.value.trim() || sel.value || '';
    const bodyBox = el('div', { class: 'stack' },
      bundles.length
        ? el('div', { class: 'stack', style: 'gap:4px' }, el('div', { class: 'field-label', text: 'Bundles na pasta de exports' }), sel)
        : el('div', { class: 'small muted', text: `nenhum bundle em ${data?.bundles?.dir || ''} — informe um caminho` }),
      pathInput,
      el('div', { class: 'small muted', text: 'O scan lista as skills do arquivo e compara com a coleção; a importação acontece depois da revisão.' }),
    );
    const closeFn = modal({ title: 'Importar bundle de skills', wide: true, bodyNode: bodyBox, actions: [{ label: 'Cancelar' }] });

    async function doScan() {
      const file = chosen();
      if (!file) {
        toast('escolha ou informe o arquivo do bundle', 'err');
        return;
      }
      scanBtn.disabled = true;
      let scan;
      try {
        scan = await api('/api/collection/bundle/scan', { method: 'POST', body: { file } });
      } catch (err) {
        scanBtn.disabled = false;
        toast(err.message, 'err');
        return;
      }
      scanBtn.disabled = false;
      renderResults(scan);
    }
    const scanBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Escanear', onclick: doScan });

    const scanRow = el('div', { class: 'row' }, scanBtn);

    function renderResults(scan) {
      const boxes = new Map(); // nome -> checkbox
      const updateCb = el('input', { type: 'checkbox', checked: true });
      const rows = scan.skills.map((s) => {
        const cb = el('input', { type: 'checkbox', checked: true });
        boxes.set(s.name, cb);
        return el('div', { class: 'imp-item' },
          el('label', { class: 'check', style: 'align-self:flex-start; margin-top:2px' }, cb),
          el('div', { class: 'stack', style: 'gap:2px; flex:1; min-width:0' },
            el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
              el('strong', { style: 'font-size:13px', text: s.name }),
              s.exists
                ? el('span', { class: `chip ${s.same ? 'chip-ok' : 'chip-warn'}`, text: s.same ? 'na coleção · idêntica' : 'na coleção · diverge' })
                : el('span', { class: 'chip chip-info', text: 'nova' }),
              el('span', { class: 'chip', text: `${s.files} arquivo(s) · ${fmtBytes(s.bytes) || '0 B'}` }),
            ),
            s.description ? el('div', { class: 'small muted', text: s.description.slice(0, 200) }) : null,
          ),
        );
      });
      const pick = (on) => () => { for (const cb of boxes.values()) cb.checked = on; };

      const importBtn = el('button', {
        class: 'btn btn-primary btn-sm',
        text: 'Importar selecionadas',
        onclick: async () => {
          const names = [...boxes.entries()].filter(([, cb]) => cb.checked).map(([name]) => name);
          if (!names.length) {
            toast('selecione ao menos uma skill', 'err');
            return;
          }
          importBtn.disabled = true;
          let started;
          try {
            started = await api('/api/collection/bundle/import', { method: 'POST', body: { file: scan.file, names, update: updateCb.checked } });
          } catch (err) {
            importBtn.disabled = false;
            toast(err.message, 'err');
            return;
          }
          closeFn?.();
          watchCollectionJob(started, 'importação do bundle concluída');
        },
      });

      // replaceChildren não tolera null (viraria texto "null" na tela)
      bodyBox.replaceChildren(...[
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' },
          el('span', { class: 'chip chip-info', text: `${scan.skills.length} skill(s) no bundle` }),
          el('span', { class: 'chip mono', text: String(scan.file).split('/').pop() }),
        ),
        scan.warnings?.length ? el('div', { class: 'small', style: 'color:var(--attention)', text: `avisos: ${scan.warnings.slice(0, 4).join(' · ')}` }) : null,
        el('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' },
          el('button', { class: 'btn btn-secondary btn-sm', text: 'todos', onclick: pick(true) }),
          el('button', { class: 'btn btn-secondary btn-sm', text: 'nenhum', onclick: pick(false) }),
          el('label', { class: 'check', style: 'display:flex; gap:6px; align-items:center' }, updateCb, 'atualizar divergentes (estado atual vira versão)'),
        ),
        el('div', { class: 'stack', style: 'gap:6px' }, ...rows),
        el('div', { class: 'row' }, importBtn),
      ].filter(Boolean));
      // o scan pode ser refeito (ex.: coleção mudou desde o último scan)
      bodyBox.append(scanRow);
    }

    bodyBox.append(scanRow);
  }

  await load();
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
            text: 'copiar p/ Gestor',
            title: `copia a pasta da skill (${d.name}) para a coleção do gestor — importar por cima de divergente salva o estado atual como versão`,
            onclick: () => copyToGestor({ name: sk.name, harness: h.id, ws: d.dir }),
          }),
          el('button', {
            class: 'btn btn-secondary btn-sm',
            text: 'SKILL.md',
            onclick: () => openSkillViewer({
              title: `${sk.name} · ${d.name}`,
              managed: sk.managed,
              sources: [{ label: `${h.label} · projeto`, title: sk.path, params: { name: sk.name, harness: h.id, ws: d.dir }, project: true }],
              onCopy: (src) => copyToGestor({ name: src.params.name, harness: src.params.harness, ws: src.params.ws }),
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
  async function openSkillViewer({ title, managed, diverged, badge, onEdit, onCopy, sources }) {
    let index = Math.max(0, sources.findIndex((s) => s.preferred));

    const headRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' });
    const srcRow = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' });
    const treePane = el('div', { class: 'stack', style: 'gap:4px' });
    const viewPane = el('div', { class: 'stack' });
    let activeFile = 'SKILL.md';

    // ações do rodapé dependem da fonte ativa: editar só na coleção, copiar
    // para o gestor só em cópia de projeto
    const editBtn = typeof onEdit === 'function'
      ? el('button', { class: 'btn btn-secondary', text: 'Editar arquivo atual…', onclick: () => onEdit(sources[index], activeFile) })
      : null;
    const copyBtn = typeof onCopy === 'function'
      ? el('button', { class: 'btn btn-secondary', text: 'Copiar para o Gestor…', title: 'copia esta skill de projeto para a coleção do gestor', onclick: () => onCopy(sources[index]) })
      : null;

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
      actions: [...(editBtn ? [editBtn] : []), ...(copyBtn ? [copyBtn] : []), { label: 'Fechar' }],
    });

    headRow.replaceChildren(...[
      badge ? el('span', { class: 'chip chip-info', text: badge }) : null,
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
      if (editBtn) editBtn.style.display = sources[index].collection ? '' : 'none';
      if (copyBtn) copyBtn.style.display = sources[index].project ? '' : 'none';
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
        const src = sources[index];
        const base = src.collection ? '/api/collection/skills/file' : '/api/skills/file';
        const q = new URLSearchParams({ ...src.params, rel });
        const file = await api(`${base}?${q}`);
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
        const base = src.collection ? '/api/collection/skills/files' : '/api/skills/files';
        const { files, dir } = await api(`${base}?${new URLSearchParams(src.params)}`);
        renderTree(files);
        // depois de renderTree, que faz replaceChildren e apagaria a linha
        if (dir) treePane.append(el('div', { class: 'small muted mono', style: 'word-break:break-all', text: dir }));
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

// No boot, o diagnóstico roda antes de tudo: se não há nada configurado
// (máquina nova, CLI ausente, sem servidor), o wizard de preparação se abre
// sozinho — é o que guia a instalação e o cadastro do servidor.
refreshServerChip().then(() => {
  if (SETUP?.firstRun) openSetupWizard();
});
route();
