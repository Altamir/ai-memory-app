import { expandTilde } from './config.mjs';

// Whitelist de comandos de manutenção executáveis pelo painel — e a ÚNICA
// fonte da verdade da tela de manutenção: escopo, efeitos, flags, confirmação
// e textos saem daqui via `commandCatalog()`. O frontend não repete nada.
//
// Cada entrada constrói os args a partir de opções validadas; nada de shell.
//
// Escopo (`scope`):
//   global  → age na store inteira (todos os workspaces/projetos)
//   project → age em UM projeto por execução. O projeto vem do seletor de
//             escopo do painel; sem seleção, a CLI resolve do cwd do processo
//             do painel (não do projeto que a tela está mostrando).
// `acceptsScope` diz se o builder aceita --workspace/--project injetados.

// `label` nomeia o campo na mensagem: é o texto que o painel mostra no toast
const str = (v, label) => {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(label ? `campo "${label}" é obrigatório` : 'valor de texto inválido');
  }
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

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ---------- helpers de metadata ----------

const fBool = (key, flag, def, label, extra = {}) => ({ key, flag, type: 'bool', def, label, ...extra });
const fNum = (key, flag, def, label, extra = {}) => ({ key, flag, type: 'number', def, label, ...extra });
const fText = (key, flag, label, extra = {}) => ({ key, flag, type: 'text', label, ...extra });
const fSelect = (key, flag, label, options, extra = {}) => ({ key, flag, type: 'select', label, options, ...extra });

/** Efeitos colaterais declarados — o frontend mostra em chips e no modal de ajuda. */
const effects = (o = {}) => ({
  readOnly: o.readOnly === true,
  writesStore: o.writesStore === true,
  deletesData: o.deletesData === true,
  costsTokens: o.costsTokens === true,
  blocksWrites: o.blocksWrites === true,
  touchesGit: o.touchesGit === true,
  writesFile: o.writesFile === true,
});

export const GROUPS = [
  {
    id: 'fast',
    label: 'Diagnóstico e leitura',
    hint: 'Relatórios. Nada aqui altera o store — exceto quando o próprio item avisar.',
  },
  {
    id: 'actions',
    label: 'Ações',
    hint: 'Escrevem no store. Confira as flags: quase todas têm dry-run (padrão ligado).',
  },
  {
    id: 'heavy',
    label: 'Pesados (podem levar minutos)',
    hint: 'Importação/pré-carga de histórico. Rodam por projeto e falam com LLM quando indicado.',
  },
  {
    id: 'recovery',
    label: 'Backup e recuperação',
    hint: 'Snapshot do store e volta de páginas a partir dos checkpoints git do wiki.',
  },
  {
    id: 'publish',
    label: 'Git e portabilidade',
    hint: 'Commit do wiki e exportação do wiki de um projeto como bundle OKF.',
  },
  {
    id: 'danger',
    label: 'Zona de perigo',
    hint: 'Destrutivo ou bloqueante. Exigem digitar o nome do comando antes de executar.',
  },
];

export const SCOPES = {
  global: {
    label: 'Global — toda a store',
    hint: 'Age na store inteira do servidor: todos os workspaces e todos os projetos.',
  },
  project: {
    label: 'Um projeto',
    hint: 'Age em UM projeto por execução. Não existe modo "todos os projetos": para varrer tudo, rode uma vez por projeto.',
  },
};

const DATA_DIR_NOTE = 'Age no data-dir passado ao comando (no painel, AI_MEMORY_DATA_DIR). Se o servidor roda em Docker, o store real está no volume do container — confira o caminho mostrado no topo da tela.';

export const SPEC = {
  // --- diagnóstico e leitura ---
  doctor: {
    group: 'fast',
    scope: 'project',
    acceptsScope: true,
    label: 'Doctor',
    summary: 'Cobertura de captura por harness nos últimos N dias.',
    details:
      'Compara as sessões locais dos harnesses com o que o servidor capturou para UM projeto e avisa quando um harness rodou nesse projeto recentemente sem nenhuma sessão capturada (sinal de hook faltando).',
    sideEffects: ['Não escreve no store.', 'Lê os diretórios de sessão locais dos harnesses.'],
    effects: effects({ readOnly: true }),
    timeoutMs: 120_000,
    flags: [
      fNum('sinceDays', '--since-days', 30, 'dias', { min: 1, max: 365, help: 'Sessão local conta como "recente" se foi atualizada nos últimos N dias.' }),
    ],
    args: (o) => ['doctor', ...optNum(o.sinceDays, '--since-days', { min: 1, max: 365 })],
  },
  curator: {
    group: 'fast',
    scope: 'project',
    acceptsScope: true,
    label: 'Curator',
    summary: 'Relatório rule-based sobre as páginas do wiki.',
    details:
      'Passa as regras do curator nas páginas de UM projeto e devolve o relatório. Por padrão não escreve nada; com "stage", registra UMA página de proposta em pending-writes, que você revisa na aba Pendências.',
    sideEffects: [
      'dry-run (padrão): nenhuma escrita.',
      'Com "stage" ligado: cria uma proposta pendente de aprovação (aba Pendências) — não altera páginas existentes.',
    ],
    effects: effects({ readOnly: true }),
    timeoutMs: 120_000,
    flags: [
      fBool('dryRun', '--dry-run', true, 'dry-run', { help: 'Devolve o relatório sem gravar nada.' }),
      fBool('stage', '--stage', false, 'stage (criar proposta pendente)', { advanced: true, help: 'Registra uma página de proposta em pending-writes para aprovação posterior.' }),
    ],
    args: (o) => ['curator', ...optBool(o.dryRun, '--dry-run', true), ...optBool(o.stage, '--stage', false)],
  },
  'auto-improve-report': {
    group: 'fast',
    scope: 'project',
    acceptsScope: true,
    label: 'Auto-improve report',
    summary: 'Telemetria read-only das revisões automáticas de sessão.',
    details:
      'Relatório de telemetria das revisões do auto-improve em UM projeto: quantas rodaram, o que propuseram, o que foi aprovado ou rejeitado.',
    sideEffects: ['Somente leitura.', 'Com "stage" ligado: cria uma proposta de telemetria em pending-writes.'],
    effects: effects({ readOnly: true }),
    timeoutMs: 120_000,
    flags: [
      fNum('days', '--days', 30, 'dias', { min: 1, max: 365, help: 'Janela de lookback.' }),
      fNum('limit', '--limit', 10, 'limite', { min: 1, max: 100, help: 'Máximo de linhas em cada tabela top-N.' }),
      fBool('stage', '--stage', false, 'stage (criar proposta pendente)', { advanced: true, help: 'Registra o relatório como proposta em pending-writes.' }),
    ],
    args: (o) => [
      'auto-improve-report',
      ...optNum(o.days, '--days', { min: 1, max: 365 }),
      ...optNum(o.limit, '--limit', { min: 1, max: 100 }),
      ...optBool(o.stage, '--stage', false),
    ],
  },
  'audit-contamination': {
    group: 'fast',
    scope: 'global',
    acceptsScope: false,
    label: 'Auditoria de contaminação',
    summary: 'Auditoria SQL read-only de conteúdo cross-project.',
    details:
      'Procura contaminação entre projetos na store inteira: sessões cujo cwd resolve para outro projeto e observações cujo projeto diverge do projeto da sessão. Opcionalmente restrita a um projeto (as duas flags andam juntas).',
    sideEffects: ['Somente leitura (SQL).', 'Não corrige nada: só aponta os suspeitos.'],
    effects: effects({ readOnly: true }),
    timeoutMs: 120_000,
    flags: [
      fText('workspace', '--workspace', 'workspace (opcional)', { advanced: true, help: 'Restringe a auditoria a um workspace. Exige o campo "projeto" junto.' }),
      fText('project', '--project', 'projeto (opcional)', { advanced: true, help: 'Restringe a auditoria a um projeto. Exige o campo "workspace" junto.' }),
    ],
    args: (o) => {
      const ws = typeof o.workspace === 'string' && o.workspace.trim() ? o.workspace.trim() : null;
      const proj = typeof o.project === 'string' && o.project.trim() ? o.project.trim() : null;
      if (ws && !proj) throw new Error('informe workspace E projeto (ou deixe os dois vazios para auditar a store inteira)');
      if (proj && !ws) throw new Error('informe workspace E projeto (ou deixe os dois vazios para auditar a store inteira)');
      return ['audit-contamination', ...(ws ? ['--workspace', ws] : []), ...(proj ? ['--project', proj] : [])];
    },
  },
  lint: {
    group: 'fast',
    scope: 'project',
    acceptsScope: true,
    label: 'Lint',
    summary: 'Detecta páginas stale, duplicatas e contradições.',
    details:
      'Passa o lint (M8) nas páginas de UM projeto e devolve os achados: páginas stale, títulos duplicados, referências quebradas e — com LLM ligado — contradições entre páginas semânticas.',
    sideEffects: [
      'dry-run (padrão): não escreve o relatório.',
      'Sem dry-run: grava/atualiza wiki/_lint/report.md (o relatório, não as páginas).',
      'Com LLM ligado: consome tokens e pode levar minutos.',
    ],
    effects: effects({ costsTokens: true }),
    timeoutMs: 600_000,
    flags: [
      fBool('noLlm', '--no-llm', true, 'sem LLM (rápido)', { help: 'Só checagens rule-based; evita gastar tokens na passada de contradições.' }),
      fBool('dryRun', '--dry-run', true, 'dry-run', { help: 'Calcula os achados sem gravar wiki/_lint/report.md.' }),
    ],
    args: (o) => ['lint', ...optBool(o.noLlm, '--no-llm', true), ...optBool(o.dryRun, '--dry-run', true)],
  },
  'llm-test': {
    group: 'fast',
    scope: 'global',
    acceptsScope: false,
    label: 'Testar LLM',
    summary: 'Smoke-test de um provider de LLM com um prompt.',
    details:
      'Manda UM prompt ao provider/modelo indicado e mostra a resposta. Serve para checar credencial, modelo e conectividade quando o auto-improve ou o bootstrap falham.',
    sideEffects: [
      'Envia um prompt de verdade ao provider: consome tokens.',
      'Não escreve nada no store.',
      'A chave de API vem do ambiente do servidor (AI_MEMORY_LLM_*), não do painel.',
    ],
    effects: effects({ costsTokens: true }),
    timeoutMs: 120_000,
    flags: [
      fSelect('provider', '--provider', 'Provider', ['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth', 'gemini', 'openai-compat', 'codex', 'copilot', 'opencode'], { required: true, def: 'openai-compat' }),
      fText('model', '--model', 'modelo', { required: true, placeholder: 'ex.: claude-haiku-4-5, gpt-5.4-mini, llama3.1:8b' }),
      fText('prompt', '--prompt', 'prompt', { required: true, def: 'Responda apenas: ok' }),
      fBool('structured', '--structured', false, 'resposta em JSON (structured)', { advanced: true }),
      fText('baseUrl', '--base-url', 'base URL', { advanced: true, placeholder: 'obrigatório para openai-compat' }),
    ],
    args: (o) => [
      'llm-test',
      '--provider', str(o.provider, 'provider'),
      '--model', str(o.model, 'modelo'),
      '--prompt', str(o.prompt, 'prompt'),
      ...optBool(o.structured, '--structured', false),
      ...optStr(o.baseUrl, '--base-url'),
    ],
  },

  // --- ações ---
  'forget-sweep': {
    group: 'actions',
    scope: 'project',
    acceptsScope: true,
    label: 'Forget sweep',
    summary: 'Sweep de retenção: expira TTLs, evicta páginas episódicas frias.',
    details:
      'Roda o sweep de retenção (M8) nas páginas de UM projeto, em quatro passadas: (1) TTL vencido é apagado, (2) páginas episódicas frias são evictadas para tombstone, (3) tombstones antigos são apagados de vez, (4) observações antigas de sessões já consolidadas são podadas (desligado por padrão).',
    sideEffects: [
      'dry-run (padrão): só relata o que faria.',
      'Sem dry-run: DELETA — TTL vencido vence até pin, e páginas episódicas frias viram tombstone.',
      'Poda de observações só toca sessões já consolidadas e está desligada por padrão.',
      'Só UM projeto por execução (veja o escopo no card).',
    ],
    effects: effects({ deletesData: true, writesStore: true }),
    timeoutMs: 600_000,
    flags: [fBool('dryRun', '--dry-run', true, 'dry-run', { help: 'Relata o que seria evictado sem mutar nada.' })],
    args: (o) => ['forget-sweep', ...optBool(o.dryRun, '--dry-run', true)],
  },
  'finalize-session': {
    group: 'actions',
    scope: 'project',
    acceptsScope: true,
    label: 'Finalizar sessões',
    summary: 'Fecha sessões abertas de agentes que não emitiram SessionEnd.',
    details:
      'Emite um SessionEnd sintético e resume a sessão aberta de UM projeto — para harnesses que morrem sem fechar (ex.: ZCode). Sem "todas", fecha só a mais recente; dá para mirar uma sessão exata pelo id.',
    sideEffects: [
      'Fecha a sessão no servidor e dispara o resumo/consolidação dela.',
      'Sem "todas": apenas a sessão mais recente.',
      'Com "outros operadores" ligado: pode fechar a sessão aberta de outra pessoa/terminal.',
    ],
    effects: effects({ writesStore: true, costsTokens: true }),
    timeoutMs: 300_000,
    flags: [
      fText('agent', '--agent', 'agente', { placeholder: 'vazio = codex', help: 'Qual harness finalizar. Aceita qualquer agente que a store reconheça.' }),
      fBool('all', '--all', true, 'todas as sessões abertas', { help: 'Sem isto, finaliza apenas a mais recente.' }),
      fText('sessionId', '--session-id', 'session id (UUID)', { advanced: true, help: 'Finaliza exatamente esta sessão, em vez de "a mais recente".' }),
      fBool('allOwners', '--all-owners', false, 'incluir sessões de outros operadores', { advanced: true, help: 'Por padrão só as suas (e as sem dono).' }),
    ],
    args: (o) => [
      'finalize-session',
      ...optStr(o.agent, '--agent'),
      ...optStr(o.sessionId, '--session-id'),
      ...optBool(o.allOwners, '--all-owners', false),
      ...optBool(o.all, '--all', true),
    ],
  },
  embed: {
    group: 'actions',
    scope: 'project',
    acceptsScope: true,
    label: 'Embeddings',
    summary: 'Gera embeddings das latest pages para busca semântica.',
    details:
      'Calcula e grava embeddings das latest pages de UM projeto, usando o provider de embeddings configurado no servidor. "Forçar" re-embeda páginas que já têm linha.',
    sideEffects: [
      'dry-run (padrão): relata sem gerar.',
      'Sem dry-run: chama o provider de embeddings e grava linhas novas.',
      'Sem "forçar", pula páginas que já têm embedding do provider/modelo/dimensão atuais.',
    ],
    effects: effects({ writesStore: true, costsTokens: true }),
    timeoutMs: 1_800_000,
    flags: [
      fBool('dryRun', '--dry-run', true, 'dry-run'),
      fBool('force', '--force', false, 'forçar re-embed'),
    ],
    args: (o) => ['embed', ...optBool(o.dryRun, '--dry-run', true), ...optBool(o.force, '--force', false)],
  },
  reorg: {
    group: 'actions',
    scope: 'global',
    acceptsScope: false,
    label: 'Reorg por cwd',
    summary: 'Retro-ajusta sessões antigas para projetos por cwd.',
    details:
      'Re-arruma sessões e observações antigas de UM store que era multi-projeto: cada sessão passa para o projeto derivado do cwd capturado no session-start. As páginas que eram mistura multi-projeto são marcadas como is_latest=false para a próxima consolidação regerar por projeto.',
    sideEffects: [
      'dry-run (padrão): mostra o que mudaria.',
      'Sem dry-run: re-stampa sessões/observações e APOSENTA as páginas antigas (is_latest=false) — elas saem da busca até serem regeradas.',
      'Idempotente: rodar de novo não muda nada.',
      DATA_DIR_NOTE,
    ],
    effects: effects({ writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [fBool('dryRun', '--dry-run', true, 'dry-run')],
    confirm: { word: 'reorg', when: { flag: 'dryRun', value: false }, hint: 'A rodada real aposenta as páginas antigas (is_latest=false) até a próxima consolidação.' },
    args: (o) => ['reorg', ...optBool(o.dryRun, '--dry-run', true)],
  },

  // --- pesados ---
  backfill: {
    group: 'heavy',
    scope: 'project',
    acceptsScope: true,
    label: 'Backfill',
    summary: 'Importa histórico local de harness para o store.',
    details:
      'Importa, uma vez, o histórico de sessões locais de UM projeto para o store — para o projeto não começar amnésico quando os hooks são instalados no meio do caminho. É no-op se o store já tem sessões daquele projeto, a menos que "forçar".',
    sideEffects: [
      'dry-run (padrão): relata o que seria importado.',
      'Sem dry-run: cria sessões e observações no store (uma vez, com deduplicação por id nativo).',
      'Só roda em projeto sem sessões capturadas, a menos que "forçar".',
      'Lê os arquivos de sessão locais do harness — nada sai da máquina.',
    ],
    effects: effects({ writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [
      fBool('dryRun', '--dry-run', true, 'dry-run'),
      fNum('maxSessions', '--max-sessions', 25, 'máx sessões', { min: 1, max: 200, help: 'Importa no máximo as N sessões locais mais novas.' }),
      fBool('force', '--force', false, 'forçar (store não vazio)', { advanced: true, help: 'Importa mesmo quando o store já tem sessões.' }),
      fText('session', '--session', 'session id nativo', { advanced: true, help: 'Importa só esta sessão do harness, em vez de todas.' }),
    ],
    args: (o) => [
      'backfill',
      ...optBool(o.dryRun, '--dry-run', true),
      ...optBool(o.force, '--force', false),
      ...optNum(o.maxSessions, '--max-sessions', { min: 1, max: 200 }),
      ...optStr(o.session, '--session'),
    ],
  },
  bootstrap: {
    group: 'heavy',
    scope: 'project',
    acceptsScope: true,
    label: 'Bootstrap',
    summary: 'Pré-carga de histórico via LLM (git log, README, docs).',
    details:
      'Pré-carrega UM projeto que já existia antes do ai-memory: resume git log, README, docs/ e cabeçalhos de módulo em páginas-semente do wiki. Roda uma vez; depois disso o histórico normal de sessões toma conta.',
    sideEffects: [
      'dry-run (padrão): coleta as fontes e mostra o que SERIA enviado — não chama o provider nem escreve no wiki.',
      'Sem dry-run: chama o LLM (pode custar bastante em repo grande) e ESCREVE páginas-semente no wiki do projeto.',
      'Recusa rodar duas vezes no mesmo projeto sem "forçar".',
      'Lê o repositório local (git log, README, docs, cabeçalhos) — o servidor nunca vê esses caminhos.',
    ],
    effects: effects({ costsTokens: true, writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [
      fBool('dryRun', '--dry-run', true, 'dry-run', { help: 'Coleta e monta o prompt sem chamar o provider.' }),
      fBool('force', '--force', false, 'forçar re-bootstrap', { advanced: true, help: 'Re-roda em projeto que já tem wiki/bootstrap.md.' }),
      fBool('resume', '--resume', false, 'retomar bootstrap interrompido', { advanced: true }),
      fText('repoPath', '--repo-path', 'caminho do repositório', { advanced: true, placeholder: 'vazio = git root do cwd do painel' }),
      fText('since', '--since', 'git log --since', { advanced: true, placeholder: 'ex.: 180 days ago' }),
      fNum('maxInputTokens', '--max-input-tokens', 150000, 'máx tokens de entrada', { min: 1000, max: 500000, advanced: true }),
      fBool('excludeGit', '--exclude-git', false, 'pular git log', { advanced: true }),
      fBool('excludeReadme', '--exclude-readme', false, 'pular README', { advanced: true }),
      fBool('excludeDocs', '--exclude-docs', false, 'pular docs/', { advanced: true }),
      fBool('excludeCode', '--exclude-code', false, 'pular cabeçalhos de código', { advanced: true }),
    ],
    args: (o) => [
      'bootstrap',
      ...optBool(o.dryRun, '--dry-run', true),
      ...optBool(o.force, '--force', false),
      ...optBool(o.resume, '--resume', false),
      ...optStr(o.repoPath, '--repo-path'),
      ...optStr(o.since, '--since'),
      ...optNum(o.maxInputTokens, '--max-input-tokens', { min: 1000, max: 500000 }),
      ...optBool(o.excludeGit, '--exclude-git', false),
      ...optBool(o.excludeReadme, '--exclude-readme', false),
      ...optBool(o.excludeDocs, '--exclude-docs', false),
      ...optBool(o.excludeCode, '--exclude-code', false),
    ],
  },

  // --- backup e recuperação ---
  backup: {
    group: 'recovery',
    scope: 'global',
    acceptsScope: false,
    label: 'Backup',
    summary: 'Exporta o store inteiro (wiki/, db/, config) como tar.gz.',
    details:
      'Gera um snapshot do store inteiro — todos os workspaces e projetos — num .tar.gz. É a rede de segurança antes de purge/reset/reindex.',
    sideEffects: ['Escreve um .tar.gz no caminho indicado.', 'Não altera o store.', 'Demora conforme o tamanho do store (aqui, centenas de MiB).'],
    effects: effects({ readOnly: true, writesFile: true }),
    timeoutMs: 3_600_000,
    flags: [fText('out', '-o', 'arquivo de saída', { placeholder: 'vazio = ~/ai-memory-backup-<data>.tar.gz' })],
    args: (o, ctx) => {
      const out = o.out ? expandTilde(str(o.out)) : `${ctx.home}/ai-memory-backup-${stamp()}.tar.gz`;
      return ['backup', '-o', out];
    },
  },
  checkpoints: {
    group: 'recovery',
    scope: 'global',
    acceptsScope: false,
    label: 'Checkpoints do wiki',
    summary: 'Lista os checkpoints git do wiki (de onde restaurar).',
    details:
      'Lista os commits recentes do repo git interno do wiki. Use um deles como "checkpoint" para restaurar uma página específica no Restore page.',
    sideEffects: ['Somente leitura.'],
    effects: effects({ readOnly: true }),
    timeoutMs: 120_000,
    flags: [fNum('limit', '-n', 20, 'quantidade', { min: 1, max: 200 })],
    args: (o) => ['checkpoints', ...optNum(o.limit, '-n', { min: 1, max: 200 })],
  },
  'restore-page': {
    group: 'recovery',
    scope: 'project',
    acceptsScope: true,
    label: 'Restore page',
    summary: 'Volta UMA página do wiki a partir de um checkpoint git.',
    details:
      'Pega o conteúdo de um caminho de página num checkpoint (commit) do wiki, sobrescreve o arquivo e reindexa a página no store. Use os Checkpoints do wiki para descobrir o id/commit.',
    sideEffects: [
      'Sobrescreve o arquivo da página no wiki com a versão do checkpoint.',
      'Reindexa a página no store.',
      'A versão atual da página é perdida — mas o wiki é git, então há histórico.',
    ],
    effects: effects({ writesStore: true, touchesGit: true }),
    timeoutMs: 300_000,
    flags: [
      fText('path', '--path', 'caminho da página', { required: true, placeholder: 'ex.: notes/foo.md' }),
      fText('from', '--from', 'checkpoint (commit)', { required: true, placeholder: 'ex.: HEAD~1 ou um sha de checkpoint' }),
    ],
    confirm: { word: 'restore-page', hint: 'Sobrescreve a página atual no wiki com a versão do checkpoint.' },
    args: (o) => ['restore-page', '--path', str(o.path, 'caminho da página'), '--from', str(o.from, 'checkpoint')],
  },
  restore: {
    group: 'recovery',
    scope: 'global',
    acceptsScope: false,
    label: 'Restore (store inteiro)',
    summary: 'Restaura um backup .tar.gz por cima do data-dir.',
    details:
      'Pega um .tar.gz gerado pelo Backup e restaura wiki/, db/ e config.toml no data-dir. É a volta do store inteiro — não é seletivo por projeto.',
    sideEffects: [
      'Substitui wiki/, db/ e config.toml pelo conteúdo do tarball.',
      'Recusa data-dir não vazio, a menos que "forçar" — com "forçar", sobrescreve o store atual.',
      'Deve rodar com o servidor ai-memory PARADO; com o servidor vivo, ele pode reescrever o DB por cima.',
      'Irreversível sem outro backup anterior.',
      DATA_DIR_NOTE,
    ],
    effects: effects({ writesStore: true, deletesData: true }),
    timeoutMs: 3_600_000,
    flags: [
      fText('from', '-i', 'tarball de origem', { required: true, placeholder: 'ex.: ~/ai-memory-backup-2026-09-30.tar.gz' }),
      fBool('force', '--force', false, 'forçar sobre data-dir não vazio'),
    ],
    confirm: { word: 'restore', hint: 'Sobrescreve o store atual com o conteúdo do backup.' },
    args: (o) => ['restore', '-i', expandTilde(str(o.from, 'tarball de origem')), ...optBool(o.force, '--force', false)],
  },

  // --- git e portabilidade ---
  commit: {
    group: 'publish',
    scope: 'global',
    acceptsScope: false,
    label: 'Commit do wiki',
    summary: 'Faz git add + commit do wiki/ no repo interno.',
    details:
      'Estagia e commita a árvore do wiki no repo git interno (o mesmo que gera os checkpoints). Útil para marcar um ponto antes de operações grandes.',
    sideEffects: ['Faz commit no repo git do wiki (todos os projetos).', 'Não altera páginas nem o índice do SQLite.'],
    effects: effects({ touchesGit: true, writesFile: true }),
    timeoutMs: 300_000,
    flags: [fText('message', '-m', 'mensagem do commit', { placeholder: 'vazio = "manual commit"' })],
    args: (o) => ['commit', ...optStr(o.message, '-m')],
  },
  'export-okf': {
    group: 'publish',
    scope: 'project',
    acceptsScope: true,
    label: 'Exportar OKF',
    summary: 'Exporta o wiki de UM projeto como bundle OKF v0.2.',
    details:
      'Monta um .tar.gz com o wiki de UM projeto (o do seletor de escopo) no formato OKF v0.2 — para levar o conhecimento do projeto para outro lugar.',
    sideEffects: ['Escreve um .tar.gz no caminho indicado.', 'Somente leitura no store.'],
    effects: effects({ readOnly: true, writesFile: true }),
    timeoutMs: 3_600_000,
    flags: [fText('out', '-o', 'arquivo de saída', { placeholder: 'vazio = ~/ai-memory-<projeto>-okf-<data>.tar.gz' })],
    args: (o, ctx) => {
      const proj = ctx?.scope?.project ? str(ctx.scope.project) : null;
      if (!proj) throw new Error('escolha um projeto no seletor de escopo (o export é sempre de um projeto)');
      const out = o.out ? expandTilde(str(o.out)) : `${ctx.home}/ai-memory-${proj.replace(/[^\w.-]+/g, '_')}-okf-${stamp()}.tar.gz`;
      return ['export-okf', '--to', out];
    },
  },

  // --- zona de perigo (confirmação digitada) ---
  compact: {
    group: 'danger',
    scope: 'global',
    acceptsScope: false,
    label: 'Compact',
    summary: 'VACUUM + rebuild do FTS para devolver páginas livres ao disco.',
    details:
      'Roda VACUUM e reconstrói os índices FTS, devolvendo ao sistema as páginas livres do SQLite. Não apaga nada — mas pega lock exclusivo e reescreve o banco inteiro.',
    sideEffects: [
      'Não deleta nada.',
      'BLOQUEIA todas as escritas enquanto roda (minutos, num store grande).',
      'Precisa de espaço livre ≈ tamanho do banco.',
      'Age na store inteira.',
    ],
    effects: effects({ blocksWrites: true }),
    timeoutMs: 3_600_000,
    flags: [],
    confirm: { word: 'compact', hint: 'Bloqueia escritas no store inteiro enquanto roda.' },
    args: () => ['compact', '--confirm'],
  },
  reindex: {
    group: 'danger',
    scope: 'global',
    acceptsScope: false,
    label: 'Reindex',
    summary: 'Rebuild do SQLite a partir do wiki/ (a garantia "DB é reconstruível").',
    details:
      'Reconstrói o SQLite a partir dos markdown do wiki/: recria workspaces/projetos a partir dos manifestos _meta.md de cada escopo e reindexa todas as páginas.',
    sideEffects: [
      'Reconstrói o índice do zero a partir do wiki/ (não apaga o wiki/).',
      'Deve rodar com o SERVIDOR ai-memory PARADO e contra um data-dir limpo/recém-migrado — com o servidor vivo, o índice pode duplicar ou corromper.',
      'Age na store inteira.',
      DATA_DIR_NOTE,
    ],
    effects: effects({ writesStore: true, blocksWrites: true }),
    timeoutMs: 3_600_000,
    flags: [],
    confirm: { word: 'reindex', hint: 'Reconstrói o índice inteiro; exige o servidor parado.' },
    args: () => ['reindex'],
  },
  'purge-project': {
    group: 'danger',
    scope: 'project',
    acceptsScope: true,
    ownsProjectFlag: true,
    label: 'Purge projeto',
    summary: 'Remove um projeto inteiro do store (irreversível).',
    details:
      'Apaga um projeto: páginas (todas as versões), sessões, observações, handoffs, embeddings, workstreams gerenciadas e os arquivos do wiki em disco. Se o campo de projeto ficar vazio, usa o projeto do seletor de escopo.',
    sideEffects: [
      'APAGA dados de forma irreversível (sem "forçar", recusa se houver workstream com lease vivo).',
      'Por padrão é delete lógico: os bytes ficam em páginas livres do SQLite até um compact (use "reclamar bytes").',
      'O histórico git do wiki e qualquer backup anterior ainda contêm o conteúdo — não é apagamento forense.',
    ],
    effects: effects({ deletesData: true, writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [
      fText('project', '--project', 'projeto', { placeholder: 'vazio = o projeto do seletor de escopo' }),
      fBool('compact', '--compact', false, 'reclamar bytes (VACUUM)', { advanced: true, help: 'Roda VACUUM depois: reescreve o banco inteiro e demora minutos.' }),
      fBool('force', '--force', false, 'forçar com workstream vivo', { advanced: true, help: 'Sem isto, recusa quando um run gerenciado ainda segura o projeto.' }),
    ],
    confirm: { word: 'purge-project', hint: 'Irreversível: apaga o projeto e tudo que pende dele.' },
    args: (o, ctx) => {
      const proj = typeof o.project === 'string' && o.project.trim() ? o.project.trim() : ctx?.scope?.project ? str(ctx.scope.project) : null;
      if (!proj) throw new Error('informe o projeto (ou escolha um no seletor de escopo)');
      return ['purge-project', '--project', proj, ...optBool(o.compact, '--compact', false), ...optBool(o.force, '--force', false), '--confirm'];
    },
  },
  'purge-session': {
    group: 'danger',
    scope: 'project',
    acceptsScope: true,
    label: 'Purge sessão',
    summary: 'Remove UMA sessão e tudo derivado dela (irreversível).',
    details:
      'Apaga uma sessão: a linha da sessão, as observações, os handoffs que ela escreveu, a página sessions/<id>.md (todas as versões) e os embeddings — estritamente dentro do escopo escolhido. Handoffs que ela apenas aceitou ficam (o texto é de quem escreveu).',
    sideEffects: [
      'APAGA a sessão e tudo derivado dela, de forma irreversível.',
      'Age só no workspace/projeto do escopo escolhido.',
      'Por padrão é delete lógico: os bytes ficam até um compact (use "reclamar bytes").',
    ],
    effects: effects({ deletesData: true, writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [
      fText('sessionId', '--session-id', 'session id (UUID)', { required: true, placeholder: 'UUID completo da sessão' }),
      fBool('compact', '--compact', false, 'reclamar bytes (VACUUM)', { advanced: true, help: 'Roda VACUUM depois: reescreve o banco inteiro e demora minutos.' }),
    ],
    confirm: { word: 'purge-session', hint: 'Irreversível: apaga a sessão e as observações dela.' },
    args: (o) => ['purge-session', '--session-id', str(o.sessionId, 'session id'), ...optBool(o.compact, '--compact', false), '--confirm'],
  },
  reset: {
    group: 'danger',
    scope: 'global',
    acceptsScope: false,
    label: 'Reset (apagar a store)',
    summary: 'Esvazia wiki/, db/ e raw/ do data-dir — todos os projetos.',
    details:
      'Apaga o conteúdo de wiki/, db/ e raw/ do data-dir: o store inteiro, todos os workspaces e projetos. Hooks, config.toml e o token permanecem. É o botão de "começar do zero" — só faça isso com um backup em mãos.',
    sideEffects: [
      'APAGA a store inteira (wiki/, db/, raw/) — irreversível sem backup.',
      'Não remove hooks, config.toml nem o token.',
      'Com o servidor ai-memory vivo, o processo pode recriar arquivos enquanto o wipe roda: pare o servidor antes.',
      DATA_DIR_NOTE,
    ],
    effects: effects({ deletesData: true, writesStore: true }),
    timeoutMs: 3_600_000,
    flags: [],
    confirm: { word: 'reset', hint: 'Apaga TODOS os projetos do store. Faça backup antes.' },
    args: () => ['reset', '--confirm'],
  },
};

// ---------- construção de args ----------

function flagValue(entry, options, key) {
  if (options && options[key] !== undefined) return options[key];
  const f = (entry.flags || []).find((x) => x.key === key);
  return f ? f.def : undefined;
}

/** Confirmação exigida para esta execução (considerando as opções), ou null. */
export function confirmationFor(command, options = {}) {
  const entry = SPEC[command];
  const confirm = entry?.confirm;
  if (!confirm) return null;
  if (confirm.when && flagValue(entry, options ?? {}, confirm.when.flag) !== confirm.when.value) return null;
  return confirm;
}

export function requiresConfirmation(command, options = {}) {
  return Boolean(confirmationFor(command, options));
}

export function checkConfirmation(command, confirm, options = {}) {
  const wanted = confirmationFor(command, options ?? {});
  if (!wanted) return;
  if (confirm !== wanted.word) throw new Error(`confirmação necessária: digite "${wanted.word}" para executar`);
}

/** --workspace/--project injetados do seletor de escopo do painel. */
function scopeArgs(entry, ctx) {
  if (!entry.acceptsScope) return [];
  const workspace = ctx?.scope?.workspace ? str(ctx.scope.workspace) : null;
  const project = ctx?.scope?.project ? str(ctx.scope.project) : null;
  const out = [];
  if (workspace) out.push('--workspace', workspace);
  // comandos que já montam o próprio --project não recebem o do escopo
  if (project && !entry.ownsProjectFlag) out.push('--project', project);
  return out;
}

export function buildMaintenanceArgs(command, options = {}, ctx = { home: '' }) {
  const entry = SPEC[command];
  if (!entry) throw new Error(`comando não permitido: ${command}`);
  if (typeof entry.args !== 'function') throw new Error(`comando sem builder: ${command}`);
  const opts = options ?? {};
  const [name, ...rest] = entry.args(opts, ctx);
  // o escopo entra logo depois do nome do comando: fica legível no log
  const args = [name, ...scopeArgs(entry, ctx), ...rest];
  const confirm = confirmationFor(command, opts);
  return {
    args,
    timeoutMs: entry.timeoutMs,
    group: entry.group,
    scope: entry.scope,
    confirmWord: confirm?.word || null,
    confirmHint: confirm?.hint || null,
  };
}

/**
 * Args para exibição (o que vai rodar) — espelha os defaults que a tela envia.
 * `ctx.fill` preenche obrigatórios faltantes com `<label>`: é o modo do modal
 * de ajuda, que precisa mostrar uma linha mesmo antes de tudo estar preenchido.
 * Sem `fill` a validação é a mesma da execução (e é o que o botão Executar usa).
 */
export function previewArgs(command, options = {}, ctx = { home: '' }) {
  const entry = SPEC[command];
  if (!entry) throw new Error(`comando não permitido: ${command}`);
  const opts = {};
  for (const f of entry.flags || []) {
    if (options && options[f.key] !== undefined) opts[f.key] = options[f.key];
    else if (f.def !== undefined) opts[f.key] = f.def;
    else if (ctx.fill && f.required) opts[f.key] = f.type === 'select' ? (f.options?.[0] ?? '') : `<${f.label}>`;
  }
  return buildMaintenanceArgs(command, opts, ctx).args;
}

/** Payload da tela de manutenção: grupos + comandos + escopos. */
export function commandCatalog() {
  return {
    groups: GROUPS,
    scopes: SCOPES,
    commands: Object.entries(SPEC).map(([id, entry]) => ({
      id,
      label: entry.label || id,
      group: entry.group,
      scope: entry.scope,
      summary: entry.summary || '',
      details: entry.details || '',
      sideEffects: entry.sideEffects || [],
      effects: entry.effects || effects(),
      flags: entry.flags || [],
      // como o escopo chega no comando: pelo seletor da tela, por um campo
      // próprio (que cai no seletor se ficar vazio) ou não se aplica
      scopeInput: entry.scope !== 'project' ? 'none' : entry.ownsProjectFlag ? 'own-flag' : 'selector',
      timeoutMs: entry.timeoutMs,
      confirm: entry.confirm ? { word: entry.confirm.word, when: entry.confirm.when || null, hint: entry.confirm.hint || null } : null,
    })),
  };
}
