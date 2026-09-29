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
| **Manutenção** | Executa a CLI com flags opcionais: `doctor`, `curator`, `auto-improve-report`, `audit-contamination`, `lint`, `forget-sweep`, `finalize-session`, `embed`, `backfill`, `bootstrap`, `backup`. Zona de perigo com confirmação digitada: `compact`, `reindex`, `purge-project`, `purge-session`. Log ao vivo via SSE e histórico das execuções. |
| **Pendências** | Revisa propostas do auto-improve (`pending-writes`): ver diff, aprovar, rejeitar com motivo. |
| **Handoffs** | Handoffs abertos entre sessões (aceitar consome, são single-use) e mailbox entre projetos (`message list/pop/cancel/send`). Envio via composer com **seletor de workspace/projeto** (escolha dos existentes ou digitação livre). |
| **Sessões** | Inicia `ai-memory run {opencode,grok,claude}` num diretório de projeto, com workstream nova/existente (sugestões da CLI), `--yolo` e `--fresh`. **Diretório escolhível**: datalist com os projetos conhecidos + navegador de pastas (marca repositórios git, restrito ao home). Cada sessão é um **card**; clicar abre o terminal numa **janela flutuante** grande (82% da tela), arrastável pela barra de título e redimensionável pelo grip do canto — **várias janelas ao mesmo tempo**, em cascata; fechar a janela não encerra a sessão. Cards de sessões encerradas podem ser **excluídos** da lista (individualmente ou com "limpar encerradas", com confirmação). A lista **sobrevive a reinicializações do painel** (`.sessions.json`): os cards voltam marcados como "I/O perdido", já que o PTY não é restaurável — excluir quando não interessar mais. A seção **"Rodando fora do painel"** lista (via tabela de processos) os `ai-memory run` vivos iniciados no seu terminal, com pid/tty/harness e botões para **Encerrar** ou **Retomar no painel** — cria uma sessão do painel no mesmo diretório, sem `--fresh` (o harness restaura a conversa mais recente), e encerra o processo externo. Como o ai-memory segura um **lease do workstream por ~90s** mesmo após o processo morrer (409 Conflict), o endpoint orquestra: mata todo o run (launcher + harness), espera morrer, detecta o conflito pelo buffer, espera a expiração exata do lease e recria a sessão (pode levar alguns minutos). Diretórios sem `.git` não oferecem Retomar (o run falharia). Pids intocáveis podem ser listados em `.protected-pids.json` (array) — aparecem com 🔒 e o backend recusa encerrá-los. |
| **Memórias** | Busca global (todos os projetos) ou por escopo, lista de páginas recentes por projeto e leitor de página renderizado em markdown com frontmatter/tags. |

## Como se integra

- **Leituras** (recent/search/read-page): via **MCP HTTP** do servidor (`AI_MEMORY_SERVER_URL`, default `http://127.0.0.1:49374/mcp`) com Bearer do arquivo `auth-token`; cai para a CLI se o MCP falhar.
- **Manutenção e run**: subprocessos da CLI em `AI_MEMORY_BIN` (default `~/.local/bin/ai-memory`), sempre com `--data-dir` explícito e `AI_MEMORY_AUTH_TOKEN` injetado via env (lido de `<data-dir>/auth-token`).

### Variáveis de ambiente

| Var | Default | Para quê |
| --- | --- | --- |
| `AIM_APP_PORT` | `4790` | Porta do painel |
| `AIM_APP_HOST` | `127.0.0.1` | Bind do painel (mantenha local) |
| `AI_MEMORY_BIN` | `~/.local/bin/ai-memory` | Binário da CLI |
| `AI_MEMORY_DATA_DIR` | `~/Library/Application Support/ai-memory` | Data-dir da CLI (token, config) |
| `AI_MEMORY_SERVER_URL` | `http://127.0.0.1:49374` | Servidor MCP/HTTP do ai-memory |

## Testes

```bash
npm test
```

20 testes (`node --test`): whitelist e construção de argumentos de manutenção (inclui confirmação obrigatória dos destrutivos), normalização das respostas do MCP e integração do servidor HTTP (health, estáticos com bloqueio de path traversal, rejeição de comandos fora da whitelist, ciclo de vida de job e SSE) — a integração roda com `AI_MEMORY_BIN=/bin/echo`, sem tocar no ai-memory real.

## Segurança

- Bind apenas em `127.0.0.1`; nenhuma rota de shell arbitrário — os comandos vêm de uma whitelist (`server/spec.mjs`) que constrói o argv.
- Comandos destrutivos mantêm `--confirm` na linha e exigem que o usuário digite o nome do comando no modal.
- O token de auth nunca é logado nem enviado ao frontend.
- `node-pty` fixado em `1.0.0` (a 1.1.0 está falhando com `posix_spawnp failed` neste ambiente).
