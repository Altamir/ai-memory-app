# Painel ai-memory (gestão de host)

Painel web que gerencia o ai-memory e artefatos da máquina do usuário: coleção de skills, harnesses de agentes CLI e sessões interativas de run. Os termos abaixo vêm do código (`server/`, `public/app.js`).

## Linguagem

### Skills e coleção

**Skill**:
Pasta com `SKILL.md` (e recursos) que dá uma capacidade a um harness.
_Evitar_: plugin, comando

**Coleção**:
Acervo de skills mantido pelo painel em `~/.ai-memory-app/skills`, com versionamento próprio.
_Evitar_: repositório de skills, catálogo do painel

**Catálogo gerenciado**:
Catálogo de skills distribuído pelo ai-memory (`fetchManagedCatalog`), fonte de instalação quando a skill não está na coleção nem em root de usuário.
_Evitar_: marketplace

**Harness**:
CLI de agente na máquina que consome skills; ids canônicos: `claude`, `agents`, `opencode`, `zcode`, `grok`, `kiro`, `devin`.
_Evitar_: agente, cliente, ferramenta

**Root de harness**:
Diretório onde um harness procura skills; tipos (`kind`): `user` (instalável), `project` (`.harness/skills` no repo), `plugin`, `bundled` (somente leitura).
_Evitar_: pasta de skills, diretório alvo

**Cópia**:
Instância de uma skill de um root de harness (`copies` em `listCollectionSkills`). Uma skill pode ter várias cópias em harnesses diferentes.
_Evitar_: instalação (reservado ao ato), espelho

**Instalação**:
Ato de copiar uma skill (da coleção, do catálogo gerenciado ou de outro root de usuário) para um root de harness, com marker gerenciado e backup do estado anterior.
_Evitar_: sync, deploy

**Marker gerenciado**:
Marca no `SKILL.md` que identifica a cópia como gerenciada pelo painel e autoriza sobrescrita sem `force`.
_Evitar_: header, assinatura

**Versão**:
Snapshot point-in-time de uma skill da coleção, guardado em `.versions/` com índice próprio.
_Evitar_: commit (reservado ao git), release

**Importação**:
Ato de trazer uma skill de um harness, de uma cópia de projeto ou do catálogo gerenciado para a coleção; importar por cima de skill divergente cria snapshot do estado anterior.
_Evitar_: download, cópia (reservado à Cópia)

**Montagem**:
Ato de tornar skills da Coleção visíveis a um harness por symlink temporário no root de usuário, amarrado a sessões vivas do painel; não copia nada e não sobrevive às sessões. Ver [ADR-0001](docs/adr/0001-montagem-de-skills-por-symlink-no-root-de-usuario.md).
_Evitar_: instalação temporária, mount, ativação

**Seleção de sessão**:
Conjunto de skills da Coleção escolhido ao criar uma Sessão; o root de um harness exibe a união das seleções das Sessões vivas dele.
_Evitar_: whitelist, permissões da sessão

**Desinstalação**:
Remoção permanente de uma Cópia do root de usuário de um harness; cópia com marker gerenciado é removida direto, cópia sem marker exige confirmação e backup. Não se aplica a cópias de projeto.
_Evitar_: remover skill, delete, limpar

### Sessões

**Sessão**:
Run interativo `ai-memory run <harness>` num diretório, gerenciado pelo painel via node-pty (aparece como card); criada por `POST /api/sessions` com `harness`, `cwd`, `workstream`, `yolo`, `fresh`.
_Evitar_: aba, terminal, job

**Sessão de host**:
Run vivo na máquina iniciado fora do painel, detectado via `ps` (+ `lsof` para cwd); o painel só lista, protege e pode retomar.
_Evitar_: sessão órfã

**Run**:
Comando do ai-memory (`run`, `show`, `continue`, `resume`) que abre um harness interativo num repositório.
_Evitar_: processo

**Workstream**:
Worktree/projeto do ai-memory ao qual uma sessão se liga (`--workstream` / `--new`).
_Evitar_: branch, tarefa

### Servidores

**Perfil de servidor**:
Destino cadastrado no painel (URL, data-dir do cliente, binário da CLI, token opcional) ao qual o painel inteiro passa a falar; ativá-lo reescreve `config` sem reiniciar o processo.
_Evitar_: servidor, conexão

**Servidor do ambiente**:
Perfil derivado do ambiente em que o painel subiu (env do processo), sem entrada gravada; é sempre o destino implícito quando não há outro ativo.
_Evitar_: local, padrão

**Espelhamento**:
Ato de levar o Perfil de servidor ativo para fora do painel — `applyShell`: registra o perfil na CLI (para os hooks capturarem nele) e grava um Bloco gerenciado no shell (para o `run` da CLI na linha de comando). Revertido ao voltar ao Servidor do ambiente ou remover o perfil ativo.
_Evitar_: sincronizar, exportar

**Bloco gerenciado**:
Trecho delimitado (`# >>> ai-memory-app >>>`) nos rc's do usuário com `AI_MEMORY_SERVER_URL`/`AI_MEMORY_AUTH_TOKEN`; reescrito sem duplicar, com backup e comentando linhas soltas antigas.
_Evitar_: snippet, config do shell

**Perfil da CLI**:
Registro `ai-memory server add` em `<data-dir>/servers.toml`, com token em `<data-dir>/auth-tokens/<nome>`; roteia apenas a captura por hooks, nunca o `run`.
_Evitar_: perfil de servidor (o do painel é outro), token
