# Cache do Claude Code: o problema e a solução

**TL;DR:** O Claude Code tem bugs que fazem o cache de prompt quebrar silenciosamente, especialmente quando você retoma sessões (`--resume` / `--continue`). Isso faz você gastar até 20x mais tokens do que deveria — e queima sua cota do plano Max muito mais rápido. Existe uma ferramenta da comunidade que corrige isso, e nós fizemos um fork com melhorias de segurança.

## O problema

Toda vez que você manda uma mensagem no Claude Code, ele envia todo o contexto da conversa pra API. A API da Anthropic tem um sistema de cache: se o início da mensagem for idêntico byte a byte ao da chamada anterior, ela reutiliza o cache em vez de processar tudo de novo.

O problema é que o Claude Code tem 3 bugs que quebram essa correspondência:

1. **Blocos de sistema se espalham** — Quando você retoma uma sessão, blocos de skills, MCP e ferramentas vão parar no lugar errado (no meio da conversa em vez do início)
2. **Ordem das ferramentas muda** — As ferramentas chegam em ordem diferente entre chamadas
3. **Fingerprint instável** — Um identificador de versão muda entre turnos

Resultado: o cache quebra, a API reprocessa tudo do zero, e sua cota derrete.

## A ferramenta: claude-code-cache-fix

Repositório original: https://github.com/cnighswonger/claude-code-cache-fix

É um módulo Node.js que intercepta as chamadas HTTP do Claude Code antes de saírem da sua máquina, corrige os bugs, e manda a versão corrigida pra API.

## Melhorias de segurança (v1.8.0+)

As melhorias de segurança do [@thepiper18](https://github.com/thepiper18) foram integradas ao repositório principal a partir da v1.8.0:

https://github.com/cnighswonger/claude-code-cache-fix

O que foi adicionado:

- **Verificação de segurança do fingerprint** — O fix original pode piorar as coisas se a Anthropic mudar o algoritmo interno. Nosso fork verifica antes de reescrever, e se não bater, não mexe (em vez de corromper)
- **Kill switch** (`CACHE_FIX_DISABLED=1`) — Desliga todos os fixes mas mantém o monitoramento
- **Toggles por fix** (`CACHE_FIX_SKIP_RELOCATE=1`, etc.) — Desliga fixes individuais conforme a Anthropic for corrigindo
- **Detecção de dormência** — O sistema te avisa quando um fix não é mais necessário
- **Detector de regressão** — Se o cache piorar depois de desligar os fixes, ele avisa

## Como instalar

**Requisito:** Precisa do Claude Code instalado via npm (não funciona com o binário standalone):

```bash
# 1. Instalar Claude Code via npm (pode ter os dois instalados)
npm install -g @anthropic-ai/claude-code

# 2. Instalar o cache-fix (inclui as melhorias de segurança a partir da v1.8.0)
npm install -g claude-code-cache-fix

# 3. Criar um script de lançamento
cat > ~/.local/bin/claude-fixed << 'EOF'
#!/bin/bash
export NODE_OPTIONS="--import $(npm prefix -g)/lib/node_modules/claude-code-cache-fix/preload.mjs"
export CACHE_FIX_DEBUG=1
exec $(npm prefix -g)/bin/claude "$@"
EOF
chmod +x ~/.local/bin/claude-fixed
```

Depois é só usar `claude-fixed` em vez de `claude`.

## Resultados reais (testado em 12/04/2026)

| Métrica | Com fix | Sem fix |
|---------|---------|---------|
| Taxa de cache (turn 2+) | **99.5%** | **74.3%** |
| Pior turn individual | 99.2% | **32.4%** |
| Cache busts completos (0%) | 0 | 1 |
| Tokens desperdiçados em re-cache | ~4K | **~79K** |

Sem o fix, uma sessão resumida desperdiça ~19x mais tokens reconstruindo o cache.

## Comandos úteis depois de instalar

```bash
# Ver o log de debug (o que o interceptor fez)
cat ~/.claude/cache-fix-debug.log

# Ver estatísticas por fix
cat ~/.claude/cache-fix-stats.json

# Ver cota atual (5h e 7d) — modo proxy (v3.5.0+)
cat ~/.claude/quota-status/account.json
# Modo preload (legado, sessão única)
cat ~/.claude/quota-status.json 2>/dev/null
```

> **Migrando scripts de v3.4.x para v3.5.0+:** se você escreveu um statusline ou script de monitoramento que lia `~/.claude/quota-status.json` diretamente, consulte a seção ["Migration: v3.4.x → v3.5.0+" no README em inglês](../README.md#migration-v34x--v350) para o padrão de migração (tente o novo caminho, recue para o legado). Tradução em português é bem-vinda via PR.

## Variáveis de ambiente

| Variável | Default | O que faz |
|----------|---------|-----------|
| `CACHE_FIX_DEBUG` | 0 | Ativa log de debug |
| `CACHE_FIX_DISABLED` | 0 | Desliga todos os fixes, mantém monitoramento |
| `CACHE_FIX_SKIP_RELOCATE` | 0 | Desliga fix de relocação de blocos |
| `CACHE_FIX_SKIP_FINGERPRINT` | 0 | Desliga fix de fingerprint |
| `CACHE_FIX_SKIP_TOOL_SORT` | 0 | Desliga fix de ordenação de ferramentas |
| `CACHE_FIX_SKIP_TTL` | 0 | Desliga injeção de TTL de 1h |
| `CACHE_FIX_SKIP_IDENTITY` | 0 | Desliga normalização de identidade |
| `CACHE_FIX_IMAGE_KEEP_LAST` | 0 | Mantém imagens nos últimos N turnos (0=desligado) |

## Desinstalar

```bash
rm ~/.local/bin/claude-fixed
npm uninstall -g claude-code-cache-fix @anthropic-ai/claude-code
```

O comando `claude` normal (binário standalone) não é afetado em nenhum momento.

## Links

- Projeto: https://github.com/cnighswonger/claude-code-cache-fix
- PR de segurança por @thepiper18: https://github.com/cnighswonger/claude-code-cache-fix/pull/8 (integrado na v1.8.0)
- Issues relacionadas no Claude Code: [#34629](https://github.com/anthropics/claude-code/issues/34629), [#40524](https://github.com/anthropics/claude-code/issues/40524), [#42052](https://github.com/anthropics/claude-code/issues/42052)
