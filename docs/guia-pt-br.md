# Cache do Claude Code: o problema e a solução

> **Nota:** Esta tradução foi gerada com auxílio de máquina e pode estar defasada em relação ao README em inglês. Para qualquer informação autoritativa, consulte [README.md](../README.md). Correções são muito bem-vindas — por favor, abra um PR.
>
> **Note:** This translation is machine-assisted and may lag the English README. For anything authoritative, see [README.md](../README.md). Corrections are very welcome — please open a PR.

**TL;DR:** O Claude Code tem bugs que fazem o cache de prompt quebrar silenciosamente, especialmente quando você retoma sessões (`--resume` / `--continue`). Isso faz você gastar bem mais tokens do que deveria — e queima sua cota do plano Max muito mais rápido. Este projeto é um proxy local que fica entre o Claude Code e a API da Anthropic, normaliza a requisição, e devolve a maior parte dessa cota. Baseline A/B na v4.0.0 (em CC v2.1.117): **95.5% de cache hit passando pelo proxy vs 82.3% direto** no primeiro turno quente.

## O problema

Toda vez que você manda uma mensagem no Claude Code, ele envia todo o contexto da conversa pra API. A API da Anthropic tem um sistema de cache: se o início da mensagem for idêntico byte a byte ao da chamada anterior, ela reutiliza o cache em vez de processar tudo de novo.

O problema é que o Claude Code tem bugs que quebram essa correspondência — ordem de blocos instável, fingerprint que muda entre turnos, ordenação de ferramentas não determinística, downgrades de TTL, e outras regressões documentadas no histórico de issues do repositório principal.

Resultado: o cache quebra, a API reprocessa o contexto do zero, e sua cota derrete.

## A ferramenta: claude-code-cache-fix

Repositório: https://github.com/cnighswonger/claude-code-cache-fix

A partir da v3.0.0, o projeto é um **proxy HTTP local** que fica entre o Claude Code e `api.anthropic.com`, aplica uma pipeline de extensões que corrige os bugs, e devolve a resposta. Funciona com **qualquer versão do CC** — Node.js ou o binário Bun a partir de v2.1.113. Sem wrapper de script, sem `NODE_OPTIONS`, sem preload.

## Como instalar (modo proxy, recomendado)

```bash
# Instalar
npm install -g claude-code-cache-fix

# Iniciar o proxy (escuta em localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Rodar o Claude Code passando pelo proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

É isso. O proxy aplica sua pipeline de extensões default automaticamente.

### Alternativa: modo forward-proxy (mantém Remote Control funcionando)

Se você usa Remote Control (`/remote-control`), `/schedule`, ou conectores MCP do claude.ai, o modo forward-proxy é o certo — no CC ≥ 2.1.196 um `ANTHROPIC_BASE_URL` não-Anthropic desativa esses recursos. O comando abaixo cuida de tudo automaticamente:

```bash
cache-fix-proxy --remote-control
```

Isso inicia o proxy em modo forward-proxy, aguarda o CA local, e lança o `claude` com `HTTPS_PROXY` e `NODE_EXTRA_CA_CERTS` configurados. Detalhes completos no [README em inglês](../README.md#forward-proxy-mode-keeps-remote-control-working).

### Rodar como serviço (systemd / launchd)

Para manter o proxy rodando sempre (auto-restart, iniciar no login):

```bash
cache-fix-proxy install-service
```

O comando detecta sua plataforma (Linux → systemd user unit; macOS → launchd agent) e imprime os próximos passos. Detalhes no [README em inglês](../README.md#running-as-a-service).

## Comandos úteis depois de instalar

```bash
# Verificar se o proxy está saudável
curl http://127.0.0.1:9801/health
# {"status":"ok"}

# Ver cota atual (5h e 7d) — arquivo escrito pela extensão cache-telemetry
cat ~/.claude/quota-status/account.json

# Ver estado por sessão
ls ~/.claude/quota-status/sessions/
```

> **Migrando scripts de v3.4.x para v3.5.0+:** se você escreveu um statusline ou script de monitoramento que lia `~/.claude/quota-status.json` diretamente, consulte a seção ["Migration: v3.4.x → v3.5.0+" no README em inglês](../README.md#migration-v34x--v350) para o padrão de migração (tente o novo caminho, recue para o legado). Tradução em português é bem-vinda via PR.

## Variáveis de ambiente principais

| Variável | Default | O que faz |
|----------|---------|-----------|
| `CACHE_FIX_PROXY_PORT` | `9801` | Porta do proxy |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | Endereço de bind |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | URL de upstream. Mude para encadear outro proxy |
| `CACHE_FIX_FORWARD_PROXY` | (não definido) | `on` para modo forward-proxy (CONNECT + MITM seletivo do upstream); mantém Remote Control ativo |
| `CACHE_FIX_DEBUG` | `0` | Ativa log de debug |
| `CACHE_FIX_HOT_RELOAD` | (não definido) | `on` para reativar hot-reload de extensões (desligado por default a partir da v4.0.0) |
| `CACHE_FIX_THINKING_SANITIZE` | (não definido, = v1) | Mitigação de desync de thinking blocks. Ligada por default na v4.0.0. `off` para desativar; `v2` para o drop adicional de tools-hash-mismatch |
| `CACHE_FIX_SESSION_BUDGET` | (não definido) | Circuit breaker de gasto por sessão. `on` + um teto (`_TOKENS`, `_COST_USD`, ou `_RATE_*`) para curto-circuitar sessões desgovernadas localmente |

Lista completa e semântica de cada extensão no [README em inglês](../README.md#proxy-configuration).

## Modelo de contêiner (Docker)

Imagem multi-arch (amd64, arm64) publicada no GitHub Container Registry a cada release:

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# Depois, na sua shell:
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

Use `--restart=always` para auto-recuperação (Docker cuida disso nativamente). Tags: `latest`, `4`, `4.0`, `4.0.0` (semver-ladder — `4` sempre aponta pro 4.x mais novo).

## Desinstalar

```bash
# Se estiver rodando via install-service:
cache-fix-proxy uninstall-service

# Remover o pacote npm
npm uninstall -g claude-code-cache-fix
```

O comando `claude` normal (binário standalone ou instalação via npm) não é afetado.

## Links

- Projeto: https://github.com/cnighswonger/claude-code-cache-fix
- README completo (autoritativo, sempre atualizado): [README.md](../README.md)
- CHANGELOG: [CHANGELOG.md](../CHANGELOG.md)
- Contribuidor original desta tradução: [@thepiper18](https://github.com/thepiper18) (v1.8.0-era, atualizada para v4.x por regeneração assistida por máquina — veja o cabeçalho de aviso acima)
