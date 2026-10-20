# Montagem de skills de sessão por symlink no root de usuário

Status: accepted

## Decisão

A visibilidade de skills da Coleção durante uma Sessão do painel é controlada por
**symlinks temporários no root de usuário do harness** (`~/.<harness>/skills/<nome>`
→ pasta da Coleção), criados no início da sessão e removidos quando a última sessão
viva que os quer encerra. O root de um harness exibe sempre a **união das seleções
das sessões vivas** daquele harness. A Desinstalação permanente permanece uma
operação explícita e separada.

## Contexto

O painel hoje só instala cópias permanentes (`installSkill`). A spike "skills por
sessão" precisa de visibilidade temporária sem sujar os harnesses. Symlink foi
escolhido porque já é padrão em uso na máquina (ex.: `~/.zcode/skills` apontando
para `~/.claude/skills`) e funciona em todos os harnesses suportados sem depender
de env/flag nativo, cuja existência por harness é desconhecida.

## Opções consideradas

- **Root de sessão via env/flag nativo** (isolamento perfeito por sessão) — rejeitado
  para a primeira versão: viabilidade desconhecida e heterogênea por harness; a spike
  mapeia o suporte e o relatório pode promover este mecanismo depois.
- **Instalar no project root do repo** (`.harness/skills` no cwd) — rejeitado: muta o
  working tree (git sujo), conflita com sessões concorrentes no mesmo repo.
- **Instalação automática persistente ao iniciar** — rejeitada: duplica o botão
  "Instalar…" e não dá a semântica temporária pedida.

## Consequências

- A seleção é **por máquina, não por processo**: duas sessões do mesmo harness veem a
  união; nenhuma perde skill no meio do run.
- **Leak de symlink** se o painel morrer entre montar e desmontar: o painel deve
  recomputar a união a partir das sessões vivas no boot e varrer symlinks órfãos
  (mesmo padrão do lease de workstream).
- Symlink de sessão **nunca** substitui nem apaga uma Cópia real instalada no mesmo
  nome: colisão de nome é pulada com aviso.
- Skills já instaladas permanentemente continuam visíveis em qualquer sessão; a
  montagem só adiciona, nunca esconde.
