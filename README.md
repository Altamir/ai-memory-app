# ai-memory-app

Painel web local para gerenciar o [ai-memory](https://github.com/akitaonrails/ai-memory): status, comandos de manutenção, sessões `ai-memory run` com terminal embutido e navegação/busca nas memórias.

Node puro, sem framework e sem build. Frontend vanilla com os tokens visuais do **zzportal** (coezzion).

## Rodar

```bash
npm install
npm start
# abre http://127.0.0.1:4790
```

## O que tem

| Aba | O que faz |
| --- | --- |
| **Painel** | Métricas do servidor (`ai-memory status --json`): páginas, sessões, observações, spool, providers de LLM/embeddings, armazenamento. |
| **Manutenção** | Executa a CLI do ai-memory. A tela é **gerada do catálogo do servidor** (`server/spec.mjs` é a única fonte): grupos Diagnóstico, Ações, Pesados, Backup e recuperação, Git e portabilidade e Zona de perigo, com 23 comandos — `doctor`, `curator`, `auto-improve-report`, `audit-contamination`, `lint`, `llm-test`, `forget-sweep`, `finalize-session`, `embed`, `reorg`, `backfill`, `bootstrap`, `backup`, `checkpoints`, `restore-page`, `restore`, `commit`, `export-okf`, `compact`, `reindex`, `purge-project`, `purge-session`, `reset`. Cada card mostra **escopo** (`global` ou um projeto), **efeitos** em chips (`somente leitura`, `escreve no store`, `apaga dados`, `consome tokens`, `bloqueia escritas`) e um botão **?** que abre o que o comando faz, os efeitos colaterais por extenso, onde ele age e a **linha de comando exata** (com `--data-dir`). Antes de executar, a tela valida as opções e, nos destrutivos, pede para **digitar o nome do comando** mostrando a linha e os efeitos. Log ao vivo via SSE e histórico das execuções. |
| **Pendências** | Revisa propostas do auto-improve (`pending-writes`): ver diff, aprovar, rejeitar com motivo. |
| **Handoffs** | Handoffs abertos entre sessões (aceitar consome, são single-use) e mailbox entre projetos (`message list/pop/cancel/send`). Envio via composer com **seletor de workspace/projeto** (escolha dos existentes ou digitação livre). |
| **Sessões** | Inicia `ai-memory run {opencode,grok,claude}` num diretório de projeto, com workstream nova/existente (sugestões da CLI), `--yolo` e `--fresh`. **Diretório escolhível**: datalist com os projetos conhecidos + navegador de pastas (marca repositórios git, restrito ao home). Cada sessão é um **card**; clicar abre o terminal numa **janela flutuante** grande (82% da tela), arrastável pela barra de título e redimensionável pelo grip do canto — **várias janelas ao mesmo tempo**, em cascata; fechar a janela não encerra a sessão. Cards de sessões encerradas podem ser **excluídos** da lista (individualmente ou com "limpar encerradas", com confirmação). A lista **sobrevive a reinicializações do painel** (`.sessions.json`): os cards voltam marcados como "I/O perdido", já que o PTY não é restaurável — excluir quando não interessar mais. A seção **"Rodando fora do painel"** lista (via tabela de processos) os `ai-memory run` vivos iniciados no seu terminal, com pid/tty/harness e botões para **Encerrar** ou **Retomar no painel** — cria uma sessão do painel no mesmo diretório, sem `--fresh` (o harness restaura a conversa mais recente), e encerra o processo externo. Como o ai-memory segura um **lease do workstream por ~90s** mesmo após o processo morrer (409 Conflict), o endpoint orquestra: mata todo o run (launcher + harness), espera morrer, detecta o conflito pelo buffer, espera a expiração exata do lease e recria a sessão (pode levar alguns minutos). Diretórios sem `.git` não oferecem Retomar (o run falharia). Pids intocáveis podem ser listados em `.protected-pids.json` (array) — aparecem com 🔒 e o backend recusa encerrá-los. |
| **Memórias** | Busca global (todos os projetos) ou por escopo, lista de páginas recentes por projeto e leitor de página renderizado em markdown com frontmatter/tags. |
| **Importar** | Traz as memórias de **outras ferramentas** e de **bundles do próprio ai-memory** para o ai-memory: Grok v1, Grok v2, Kiro e bundle `.tar.gz` (com destino remoto opcional). Scan somente leitura, revisão item a item (com o markdown renderizado), ajuste de destino/opções e gravação página a página com log ao vivo — ver abaixo. |
| **Exportar** | Empacota as páginas de um ou mais escopos num **bundle `.tar.gz`** (manifesto + `.md` como estão no wiki) na pasta de exports, pronto para importar em outro servidor do ai-memory — ver abaixo. |
| **Skills dos harnesses** | Catálogo dos roots de Agent Skills (Claude Code, Agents, OpenCode, ZCode, Grok, Kiro, Devin): globais por harness e skills de projeto por workspace. Mostra cópias por root, cópia **desatualizada** (difere do catálogo gerenciado do ai-memory), instalação num harness (global ou projeto) com backup `.bak-*` e viewer de SKILL.md com a árvore de arquivos. Quando o mesmo nome existe em mais de um root, o botão **Cópias…** (e o chip **cópias diferentes**) abre o painel de conciliação — ver abaixo. |

### Importar memórias (Grok, Kiro e bundle)

O painel lê as memórias que **outras ferramentas** guardam no seu home (e bundles do próprio ai-memory) e as grava no ai-memory. Tudo roda no host (o servidor Docker não vê `~/.grok` nem `~/.kiro`), e nada é gravado antes da sua revisão: o scan é somente leitura e cada item pode ser aberto, redirecionado ou descartado.

| Fonte | O que entra |
| --- | --- |
| **Grok v1** (`~/.grok/memory`) | `MEMORY.md` global e de cada projeto, **divididos por seção** (`## …`); o `MEMORY.md` de projeto informa o caminho do repo no cabeçalho (`# Project Memory — <path>`). Sessões (`sessions/*.md`) entram como itens crus, desmarcados. |
| **Grok v2** (`~/.grok/memory-v2`) | Um item por tópico (`topics/*.md`) do `global/` e de cada `workspaces/<slug>/`; observações da `_inbox` entram como crus. O projeto do workspace é resolvido pelos caminhos indexados no `index.sqlite` e, na falta, pelo nome do slug contra os vínculos. |
| **Kiro** (`~/.kiro`) | Steering global e por projeto (`inclusion: always` vira regra em `_rules/`), `semantic_memory` do crew agrupada por projeto, `episodic_memories` agrupada por dia e os diários do `crew/workspace/memory/history`. A leitura do `memory.db` usa o `sqlite3` do sistema, sempre read-only; sem ele a fonte degrada para os markdown com aviso na tela. |
| **Bundle do ai-memory** (`.tar.gz`) | As páginas de um bundle exportado pela aba Exportar (ou por `ai-memory export-okf`) — ver a seção seguinte. O destino padrão de cada página é o mesmo escopo de origem do bundle; um bundle de outra máquina pode ser apontado por caminho e gravado em outro servidor. |

Como cada item vira página:

- **Destino**: tópicos globais (estilo, fluxo, VPS) e itens sem projeto identificado vão para o escopo reservado **`_global`**; memórias de projeto aterrissam no projeto vinculado no `client-projects.json` (mesmo mapa da aba Memórias), resolvido pelo caminho do projeto. Sem vínculo, o item cai no grupo "sem destino" e a tela pede a escolha — nada é importado sem destino.
- **Path/tier** (heurística por título e corpo, ajustável por item): regra ("nunca", "sempre", "preferência", "estilo"…) → `_rules/<slug>.md`, `kind rule`, tier `procedural`, `pinned`; problema ("erro", "não funciona", "Is a directory"…) → `gotchas/<slug>.md`; o resto → `notes/imported/<fonte>/<slug>.md`, tier `semantic`. Itens crus (sessão/observação/diário/episódico) entram com tier `episodic` e **desmarcados**.
- **Status**: `novo`, `alterado` (o mesmo item mudou desde o último import), `já importado` (idêntico), `duplicado` (o mesmo conteúdo já foi importado por outra fonte) e `mesma página` (dois itens do scan querem o mesmo path). O estado fica em `.import-state.json` na raiz do painel.
- **Gravação**: item a item, via tool MCP `memory_write_page` (com `scope: global` quando for o caso) e, se o MCP falhar, pela CLI `write-page --body -` (stdin), registrando no log qual caminho foi usado por item. Reimportar atualiza a página — o ai-memory versiona por path, não duplica arquivo. Há um botão de **dry-run** que só lista o que cada item faria.
- **Ficam de fora** (de propósito): `knowledge.db` do Kiro e `implement-memory/` do Grok — são biblioteca de documentos, não memória curada.

### Exportar bundle (levar as memórias para outro servidor)

A aba **Exportar** empacota as páginas dos escopos escolhidos num `.tar.gz` na pasta de exports do painel (`AIM_APP_EXPORT_DIR`, padrão `<repo>/exports/`, arquivos com permissão 600):

```
manifest.json                          formato ai-memory-bundle v1: escopo, path, kind,
                                       tier, tags, pinned, sha256 e tamanho de cada página
README.md                              o que é e os dois caminhos de importação
scopes/<workspace>/<projeto>/_meta.md  manifesto do escopo (workspace + projeto)
scopes/<workspace>/<projeto>/<path>.md as páginas, byte a byte como estão no wiki
```

- **De onde vem**: a lista de páginas vem do `memory.sqlite` do servidor (`is_latest = 1` — o wiki em disco tem arquivos que não são páginas, como `log-*.md` e `_pending/`) e o conteúdo do arquivo correspondente; se o arquivo sumiu, o corpo vem do banco. O store é `AIM_STORE_DIR` (padrão `~/.ai-memory-data/ai-memory`, o volume montado no Docker). Sem `sqlite3` no PATH a exportação fica indisponível — é ele que lista as páginas.
- **Escopo da escolha**: checkboxes por projeto (com páginas, cruas, pinned e bytes), botões todos/nenhum e a opção **incluir páginas cruas** (tier episodic, `sessions/`, `log-*.md`) — sem ela o histórico fica de fora e o dry-run mostra quantas entrariam. `_global` vai como escopo próprio.
- **Dry-run e job**: `simular` mostra o plano (páginas, bytes, por escopo, primeiras páginas) sem ler arquivos nem gravar; `Exportar bundle` roda um job com log ao vivo e, ao final, **relê o bundle e confere o sha256 de cada página** antes de declarar pronto.
- **Como importar**: aba Importar → fonte *Bundle do ai-memory* (o botão `importar` da lista leva o arquivo já escolhido e escaneia) → revisar item a item → importar. Reimportar o mesmo bundle atualiza as páginas (o ai-memory versiona por path). Na mão: extrair em `<store>/wiki/` do destino e rodar `ai-memory reindex` com o servidor parado.
- **Outro servidor**: no importador, o painel **servidor de destino** troca a gravação para "outro servidor do ai-memory" (URL + token Bearer digitados na hora). O token não é salvo em disco, o token local do painel nunca é enviado para o servidor remoto, e o fallback da CLI herda a URL/token por env. O projeto de destino é criado no servidor remoto se ainda não existir.

### Conciliar cópias diferentes da mesma skill

O mesmo nome em roots diferentes costuma ser a mesma skill em versões distintas (`~/.claude/skills/x` × `~/.agents/skills/x` × `~/.zcode/skills/x`). O painel **Cópias de "x"** mostra:

- cada cópia com root, data, nº de arquivos, hash do SKILL.md e status contra a referência escolhida: `idêntica`, `mesma pasta (symlink)` (roots ligados por symlink são uma pasta só), `recursos diferem` ou `SKILL.md difere` — mais `desatualizada` quando difere do catálogo gerenciado;
- **diff** linha a linha do SKILL.md contra a referência e a lista de arquivos por status (`≠` difere, `+` só na referência, `-` só nesta cópia);
- escolha da **referência** (a cópia que vale, ou o próprio catálogo do binário) e das cópias a alinhar com ela, incluindo harnesses que ainda não têm a skill;
- opções de copiar os **arquivos de recursos** (scripts, references, assets) e de **remover** o que só existe no destino (backup preserva `.bak-*`).

Nada é gravado sem plano: `Conciliar…` faz um **dry-run** que lista, por destino, o que é criado/sobrescrito/removido e onde ficará o backup; destinos sem o marker gerenciado ou com remoção exigem **digitar `conciliar`** para confirmar. O estado anterior de cada destino é copiado inteiro para `.skill-backups/<timestamp>-<skill>-<harness>-<kind>/` (fora da árvore da skill, para não virar cópia no scan) e o resultado é mostrado por destino, com erros isolados por alvo. Roots `bundled`/`plugin`/catálogo são **somente leitura**: servem como origem, nunca como destino.

### Escopo na Manutenção: global ou um projeto

Os comandos **não** agem "no workspace que o painel abriu" — a divisão real é:

| Escopo | Comandos | O que significa |
| --- | --- | --- |
| **Global** | `compact`, `reindex`, `backup`, `restore`, `checkpoints`, `commit`, `reset`, `reorg`, `llm-test`, `audit-contamination` | Age na store inteira do servidor: todos os workspaces e projetos. O seletor de escopo não se aplica (o card avisa). |
| **Um projeto** | `doctor`, `curator`, `auto-improve-report`, `lint`, `forget-sweep`, `finalize-session`, `embed`, `backfill`, `bootstrap`, `restore-page`, `purge-project`, `purge-session`, `export-okf` | Age em **um** projeto por execução (`--workspace`/`--project`). Não existe modo "todos os projetos": para varrer tudo, rode uma vez por projeto. |

O **seletor de escopo** do topo da tela manda esses `--workspace/--project`. Em `automático` (padrão) nada é injetado e a CLI resolve o projeto pela **pasta onde o painel foi iniciado** (não pelo que você está navegando em Memórias) — o chip mostra qual é (`comandos por projeto: automático → default/ai-memory-app`). Escolher um projeto da lista, ou digitar um, passa o escopo explícito na linha de comando.

Duas ressalvas que a tela também mostra:

- Comandos que recebem escopo continuam agindo em **um projeto só** — `forget-sweep` no projeto A não olha o projeto B.
- `restore`, `reset` e `reindex` agem no **data-dir** passado ao comando (`AI_MEMORY_DATA_DIR`). A store real vive no servidor (`AI_MEMORY_SERVER_URL`); se o servidor roda em Docker, o data-dir local tem só o lado cliente (token, config) e o store está no volume do container — confira o caminho mostrado no topo da tela antes de usar esses três.

## Como se integra

- **Leituras** (recent/search/read-page): via **MCP HTTP** do servidor (`AI_MEMORY_SERVER_URL`, default `http://127.0.0.1:49374/mcp`) com Bearer do arquivo `auth-token`; cai para a CLI se o MCP falhar. Escritas do importador usam o mesmo cliente, e um import de bundle pode apontar o cliente para **outro servidor** (URL + token da tela — o token local fica de fora).
- **Manutenção e run**: subprocessos da CLI em `AI_MEMORY_BIN` (default `~/.local/bin/ai-memory`), sempre com `--data-dir` explícito e `AI_MEMORY_AUTH_TOKEN` injetado via env (lido de `<data-dir>/auth-token`).
- **Catálogo de manutenção**: `GET /api/maintenance` devolve comandos, grupos, escopos, flag metadata (defaults, obrigatórios, avançadas), efeitos colaterais e textos; `GET /api/maintenance/scope` devolve o projeto que a CLI resolveria pelo cwd do painel; `POST /api/jobs` com `preview: true` monta o argv sem executar (o `fill: true` tolera campos vazios e é o que o modal de ajuda usa).
- **Exportação**: `GET /api/export/sources` (store + escopos com contagens + bundles), `POST /api/export/plan` (dry-run sem ler o wiki), `POST /api/export/run` (job que monta e verifica o bundle), `GET /api/export/download?file=` (attachment) e `POST /api/export/delete` (exige o nome digitado). Bundles só são lidos da pasta de exports ou de caminhos sob o home.

### Variáveis de ambiente

| Var | Default | Para quê |
| --- | --- | --- |
| `AIM_APP_PORT` | `4790` | Porta do painel |
| `AIM_APP_HOST` | `127.0.0.1` | Bind do painel (mantenha local) |
| `AI_MEMORY_BIN` | `~/.local/bin/ai-memory` | Binário da CLI |
| `AI_MEMORY_DATA_DIR` | `~/Library/Application Support/ai-memory` | Data-dir da CLI (token, config) |
| `AI_MEMORY_SERVER_URL` | `http://127.0.0.1:49374` | Servidor MCP/HTTP do ai-memory |
| `AI_MEMORY_SKILLS_HOME` | `os.homedir()` | Home usado no scan dos roots de skills (isolamento em testes) |
| `AI_MEMORY_SKILLS_BACKUP_DIR` | `<repo>/.skill-backups` | Onde a conciliação de cópias guarda o estado anterior dos destinos |
| `AIM_IMPORT_GROK_DIR` | `~/.grok` | Raiz das memórias do Grok (v1 em `memory/`, v2 em `memory-v2/`) |
| `AIM_IMPORT_KIRO_DIR` | `~/.kiro` | Raiz das memórias do Kiro (steering, crew, diários) |
| `AIM_APP_IMPORT_FILE` | `<repo>/.import-state.json` | Estado do importador (fingerprints, destinos, histórico) |
| `AIM_STORE_DIR` | `~/.ai-memory-data/ai-memory` | Volume do servidor ai-memory (wiki + db) que o exportador lê |
| `AIM_APP_EXPORT_DIR` | `<repo>/exports` | Onde os bundles exportados ficam (e de onde o importador lista) |

## Testes

```bash
npm test
```

157 testes (`node --test`): o SPEC e a tela de manutenção (metadata completa de todo comando, escopo global vs projeto, injeção de `--workspace/--project`, confirmação digitada — inclusive a condicional do `reorg` —, preview de argv, catálogo), normalização das respostas do MCP, diretórios, **skills** (scan dos roots com symlink quebrado/root inexistente, instalação com backup, compare/diff/conciliação de cópias incluindo confirmação obrigatória, remoção de extras e containment no home), **diff de linhas** (Myers, hunks com contexto, CRLF, arquivo grande e limite de hunks), sessões, **importação** (parsing do Grok v1/v2 e do Kiro em fixtures, classificação em `_rules`/`gotchas`/`notes`, resolução de destino por path/slug, ciclo de status `novo → já importado → duplicado`, colisão de path, write via MCP com fake server e fallback da CLI com o corpo no stdin, rotas de scan/item/apply/dry-run/state e o runner job com log por linha), **tar próprio** (round-trip com nome longo/GNU longname, descarte de diretórios e links, recusa de nomes com `..`, checksum e truncamento), **exportação de bundle** (escopos e contagens do SQLite, dry-run sem escrita, manifesto/README/_meta.md, exclusão de `log-*.md`/`_pending`/versões antigas, fallback do corpo pelo banco, scan com destino de origem e `_global`, sha256 adulterado, bundle do `export-okf`, containment de caminho e exclusão com confirmação, gravação no MCP local e em **outro servidor** com token da tela — provando que o token local não vaza) e a integração do servidor HTTP (health, estáticos com bloqueio de path traversal, rejeição de comandos fora da whitelist, escopo na linha de comando, preview, ciclo de vida de job, SSE, rotas de skills, rotas de export/bundle com download e delete confirmado) — a integração roda com `AI_MEMORY_BIN=/bin/echo` e `AI_MEMORY_SKILLS_HOME` temporário, sem tocar no ai-memory nem nos roots reais; os testes de importação/exportação usam fixtures próprias (store com SQLite criado no teste) e fakes de MCP.

## Segurança

- Bind apenas em `127.0.0.1`; nenhuma rota de shell arbitrário — os comandos vêm de uma whitelist (`server/spec.mjs`) que constrói o argv. `--workspace`/`--project` passam por validação (texto não vazio, truncado) e nunca entram por shell.
- Os destrutivos (`compact`, `reindex`, `purge-project`, `purge-session`, `restore`, `restore-page`, `reset`) mantêm `--confirm` na linha e exigem digitar o nome do comando; a exigência vem do SPEC (o frontend não mantém lista própria), e o modal mostra a linha exata e os efeitos colaterais antes.
- **Escrita de skills**: instalação e conciliação só gravam em roots `user` (global do harness) ou `project` (dentro de um workspace) sob o home — paths passam por `realpath` e containment, nomes por regex, nada de shell. `bundled`, `plugin` e catálogo são somente leitura. Toda sobrescrita de SKILL.md sem o marker gerenciado e toda remoção de arquivo exigem a confirmação digitada (`conciliar`/`instalar`) no servidor, não só na tela.
- **Bundles**: nada do bundle é extraído para o disco — o tar é lido em memória, entradas com `..`/absolutas são descartadas na leitura e o path de cada página passa pelas mesmas validações do importador. `download`/`delete` só alcançam a pasta de exports (delete exige digitar o nome do arquivo) e ler um bundle de fora exige caminho sob o home. Arquivos de bundle nascem com permissão `600` (memória privada). Servidor de destino remoto: o token digitado não é persistido nem logado, e o token local do painel nunca é enviado para o servidor remoto (o env do fallback da CLI sobrescreve com o token do destino).
- O token de auth nunca é logado nem enviado ao frontend.
- `node-pty` fixado em `1.0.0` (a 1.1.0 está falhando com `posix_spawnp failed` neste ambiente).
