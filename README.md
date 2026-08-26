# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

English | [中文](./README.zh.md) | [한국어](./README.ko.md) | [Français](./README.fr.md) | [Português](./docs/guia-pt-br.md)

Cache optimization proxy for [Claude Code](https://github.com/anthropics/claude-code). Fixes prompt cache bugs that cause excessive quota burn, stabilizes the request prefix, and monitors for silent regressions. Works with all CC versions including the v2.1.113+ Bun binary.

*This README documents current `main`; release availability is noted per feature.*

## What it does to your traffic

A local proxy sits between Claude Code and Anthropic. Before you read further,
here is exactly what that means — the full treatment is in
[Security model](#security-model).

- **Binds to `127.0.0.1`** by default.
- **Forwards Claude Code traffic to Anthropic. On the default path it makes no
  other outbound calls** — telemetry is written to local files under
  `~/.claude/`, never sent anywhere. Two opt-in features do perform their own
  egress, both off unless you enable them: OAuth refresh
  (`CACHE_FIX_OAUTH_REFRESH=on`) posts to Anthropic's token endpoint, and
  forward-proxy download acceleration re-issues release downloads to
  `downloads.claude.ai` / `storage.googleapis.com`.
- **Can read and rewrite `POST /v1/messages`.** That capability *is* the cache
  repair — there is no version of this that works without it.
- **It is idempotent: if nothing needs fixing, the request passes through
  unmodified.** It normalizes request structure (block order, fingerprint, TTL);
  it does not modify your conversation.
- **Each transform is one file** in `proxy/extensions/`, readable in isolation.
- [Independently assessed as a legitimate tool](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605)
  by @TheAuditorTool (2026-04-14).

Forward-proxy mode (`--remote-control`) additionally terminates TLS for
`api.anthropic.com` using a locally-generated CA, which your client must trust.
Everything else is blind-tunnelled. That mode is opt-in and off by default.

## Do you need this?

**Install or test it if:** resumed or long-running sessions show repeated
`cache_creation_input_tokens` spikes; your cache-read ratio is low or unstable;
you see unexpected TTL 5m downgrades, thinking-desync `400`s, or image-retry
storms; or one of the non-cache surfaces documented below applies.

**You can skip it if:** your sessions already hold a stable high cache-read
ratio; you rarely resume long sessions; you are not under quota pressure; or you
would rather not place a local proxy in the API path. **All four are good
reasons not to install this.**

If you are not sure which applies, measure it — you do not need this project
installed to find out.

## Check whether you have this problem

Claude Code already records per-request cache accounting in its own session
transcripts, so you can measure your cache health right now, before installing
anything.

```bash
# Replace <session-uuid>, or use a glob to pick your most recent session.
jq -r 'select(.message.usage.cache_read_input_tokens != null) |
  "\(.requestId)\t\(.message.usage.cache_read_input_tokens) \(.message.usage.cache_creation_input_tokens)"' \
  ~/.claude/projects/*/<session-uuid>.jsonl |
  sort -u -k1,1 | cut -f2 |
  awk '{n++; r+=$1; c+=$2}
       END {if (n==0) print "no usage rows found — check the session path";
            else printf "requests=%d cache_read=%d creation=%d read-ratio=%.0f%%\n", n, r, c, 100*r/(r+c)}'
```

`sort -u -k1,1` counts each API call once — Claude Code writes multiple
transcript rows per request, and **not always the same number of times per
request** ([ArkNill's analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)).
Summing raw rows weights each call by its own duplicate count. Two independent
sweeps of the local transcripts on one machine (2026-08-02) agreed on the shape:
**short sessions are where this bites** — over half of sessions under 20 requests
shifted by a point or more without the dedup, worst case **41 points**, while
long sessions were almost all sub-point (3 of ~37). Short sessions are exactly
what a first-time reader will run this against.

Reading the result:

- **Fewer than ~20 requests: the number is meaningless.** A cold start has
  nothing to read yet, so creation dominates and every healthy session looks
  broken. Use a long or resumed session.
- **Sustained low ratio on a long session, or `creation` spiking on every
  `--resume`** — that is the problem this project exists to fix.
- **High ratio on a long session** — you do not need this. See *Do you need
  this?* above.

## Current advisories

> **v4.0.0** — Local HTTP proxy with a pipeline of cost-impact and observability extensions. Two long-standing defaults flipped: `thinking-block-sanitize` v1 is on by default (mitigates the thinking-desync `400` wedge — [#63147](https://github.com/anthropics/claude-code/issues/63147)) and in-process extension hot-reload is opt-in (`CACHE_FIX_HOT_RELOAD=on`). A/B baseline (v3.0.0 on v2.1.117): **95.5% cache hit rate through proxy vs 82.3% direct** on first warm turn. [Full release notes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Opus 4.7 advisory:** Metered data shows 4.7 burns Q5h quota at **~2.4x the rate of 4.6** for equivalent visible token counts ([independently confirmed by @ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). Two factors: a new tokenizer (up to 35% more tokens, [documented](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) and adaptive thinking overhead (~105%, not documented in usage response). The Q5h impact compounds into **Q7d** — the weekly quota ceiling that most heavy users will hit first. Workaround: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` reduces burn by ~3.3x but may reduce quality on complex tasks. See [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (initial observation) and [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (controlled A/B data + Q7d analysis).

## Quick Start: Proxy (recommended)

The proxy works with any CC version — Node.js or Bun binary. It sits between Claude Code and the Anthropic API, applying cache fixes as composable extensions.

```bash
# Install
npm install -g claude-code-cache-fix

# Start the proxy (runs on localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Launch Claude Code through it
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

That's it. The proxy applies its default extension pipeline automatically. No wrapper scripts, no `NODE_OPTIONS`, no preload.

### Forward-proxy mode (keeps Remote Control working)

The quick-start above is **reverse-proxy mode**: you point `ANTHROPIC_BASE_URL` at the proxy. That is simple, but on Claude Code **>= 2.1.196** a non-Anthropic `ANTHROPIC_BASE_URL` **disables Remote Control** (`/remote-control`), `/schedule`, and claude.ai MCP connectors (CC treats any custom base URL like a Bedrock/Vertex gateway). If you rely on those features, use forward-proxy mode instead.

In **forward-proxy mode** the proxy sits in front of the *real* `api.anthropic.com` as an `HTTPS_PROXY`. Claude Code's base URL stays `api.anthropic.com`, so Remote Control keeps working, while the proxy still sees and transforms `/v1/messages`.

```bash
# Start the proxy in forward-proxy mode
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# It prints the two env vars to wire the client, e.g.:
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# Launch Claude Code through it (leave ANTHROPIC_BASE_URL UNSET)
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

Or let the launcher do both steps for you with `--remote-control`:

```bash
# Spawns the proxy with CACHE_FIX_FORWARD_PROXY=on and wires the client
# (HTTPS_PROXY + the MITM CA, ANTHROPIC_BASE_URL left unset) automatically.
cache-fix-proxy --remote-control
```

The `--remote-control` flag is the one-command equivalent of the manual wiring above: it starts the proxy in forward-proxy mode, waits for the CA, and launches `claude` pointed at `HTTPS_PROXY` with `NODE_EXTRA_CA_CERTS` set (and adds `127.0.0.1,localhost,::1` to `NO_PROXY` so local services — e.g. HTTP/SSE-transport MCP servers on localhost — bypass the proxy rather than being routed at it; any existing `NO_PROXY` is preserved). Without the flag the launcher stays in reverse-proxy mode (sets `ANTHROPIC_BASE_URL`), unchanged. Two things worth knowing: Remote Control does a trusted-device enrollment on first connect that can need a few `/remote-control` retries (a Claude Code step that runs upstream, not a proxy failure); and enabling RC on an already-warm session costs a **single** prompt-cache rebuild (RC adds an `anthropic-beta` the cache keys on), so if you want RC, launching with `--remote-control` from the start avoids that one-time flip. `cache-fix-proxy --help` documents both.

> If you wire forward-proxy mode manually (setting `HTTPS_PROXY` yourself instead of using `--remote-control`), set `NO_PROXY=127.0.0.1,localhost,::1` as well, or local HTTP-transport MCP servers and other localhost services will be routed at the cache-fix proxy and fail. stdio-transport MCP servers are unaffected (they use pipes, not the network).

How it works: the proxy also handles HTTP `CONNECT`. It MITMs **only** the upstream host (`api.anthropic.com`), terminating TLS with a locally-generated CA so it can run the same extension pipeline, and **blind-tunnels every other CONNECT** (mcp-proxy, telemetry, npm, ...) untouched. On first start it generates a CA under `$CLAUDE_CONFIG_DIR/cache-fix-ca/` (default `~/.claude/cache-fix-ca/`; override with `CACHE_FIX_CA_DIR`); the client must trust it via `NODE_EXTRA_CA_CERTS`. A WebSocket/Upgrade to the upstream host (e.g. `/voice`) is relayed to upstream as-is. Because base URL stays `api.anthropic.com`, all of `/api/oauth/*`, `/v1/agents`, Remote Control credential fetches, etc. pass through untouched and RC stays enabled.

Corporate proxy chaining works the same as reverse mode: set `HTTPS_PROXY`/`HTTP_PROXY` for the proxy's **own** upstream egress (the proxy dials `api.anthropic.com` through it). The client's `HTTPS_PROXY` points at the cache-fix proxy; the cache-fix proxy's `HTTPS_PROXY` (in its own env) points at the corporate proxy.

**Crash semantics on a shared proxy.** In forward-proxy mode the proxy MITMs the whole upstream host, so an in-flight Claude Code session is wired to *this* port and cannot fail over. To keep one bad request from taking the process down, a successful forward-proxy attach installs process-wide `uncaughtException`/`unhandledRejection` handlers that log and keep serving instead of crashing. These are scoped to forward mode (a reverse-only proxy keeps Node's default crash-on-uncaught semantics, letting its supervisor restart it) and are removed when the last forward instance closes. The tradeoff: on a **shared / multi-tenant** proxy, enabling forward mode changes crash behavior for every client on that instance while the mode is on — a fatal bug is swallowed rather than surfaced to a supervisor. If you run one proxy for many sessions, weigh that against a supervised per-session model.

**Running it persistently.** The `... node .../proxy/server.mjs &` above is fine for a quick try, but a backgrounded process is not supervised: it does not restart if it crashes or if the machine reboots. To run forward-proxy mode as a managed service (auto-restart, start-on-login), use the same `install-service` path described under [Running as a service](#running-as-a-service) — just set the flag at install time so it is baked into the unit:

```bash
CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service
```

The generated systemd unit / launchd agent carries `CACHE_FIX_FORWARD_PROXY=on`, so the service starts the proxy in forward-proxy mode and keeps it up (systemd `Restart=on-failure` plus the healthcheck timer; launchd `KeepAlive`).

**The service only manages the proxy end.** It does **not** — and cannot — set anything on your `claude` client, which is a separate process. You still wire the client yourself in whatever shell launches `claude`, using the two values from the forward-proxy quick-start above:

- `HTTPS_PROXY` — where the proxy listens: `http://127.0.0.1:<port>` (default port `9801`, or your `CACHE_FIX_PROXY_PORT`).
- `NODE_EXTRA_CA_CERTS` — the CA the proxy generated on first start: `~/.claude/cache-fix-ca/ca.pem` (or `$CACHE_FIX_CA_DIR/ca.pem`).

Three ways to wire it, depending on how broadly you want the vars to apply.

> **If anything else on this host also MITMs `api.anthropic.com`** — a corporate
> TLS-inspecting agent, an account-switching pin proxy — do not use these
> recipes. `NODE_EXTRA_CA_CERTS` takes one file, so pinning it to our CA alone
> silently untrusts every other component. Use `--remote-control`, which
> publishes into `ca-trust.d/` and consumes the merged bundle instead. See
> [Coexisting with another MITM](#coexisting-with-another-mitm-on-the-same-machine-ca-trustd).

```bash
# a) per-invocation — scoped to just this claude run
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude

# b) whole shell — add to ~/.zshrc / ~/.bashrc (every HTTPS in that shell goes
#    through the proxy; harmless since non-anthropic hosts are blind-tunneled,
#    but that shell's HTTPS breaks if the proxy is ever down)
export HTTPS_PROXY=http://127.0.0.1:9801
export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# c) scoped to claude only — a shell function (recommended; avoids b's blast radius)
claude() {
  HTTPS_PROXY=http://127.0.0.1:9801 \
  NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
    command claude "$@"
}
```

#### Coexisting with another MITM on the same machine (`ca-trust.d`)

`NODE_EXTRA_CA_CERTS` takes exactly **one** file. If anything else on the host
also MITMs `api.anthropic.com` and also sets that variable — a corporate agent,
an account-switching pin proxy — the last writer wins and every other CA is
silently untrusted. Measured 2026-07-30: two such components on one machine took
turns breaking each other's TLS, with no error attributable to either.

So `--remote-control` does not simply assign the variable. It:

1. **Publishes** our CA to `<config>/ca-trust.d/ccf.pem` — our own filename only,
   never a sibling's, rewritten every launch (the proxy regenerates its CA
   whenever the CA dir is wiped, and a stale pem advertises a key nothing signs
   with), skipped when the bytes already match, and written via temp + `rename`
   so a reader never sees a half-written file.
2. **Reads** `<config>/ca-trust.pem` — a merged bundle built by exactly one
   external writer from the ambient/corporate roots plus every published
   `ca-trust.d/*.pem` — and points `NODE_EXTRA_CA_CERTS` at it.

`<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. **We never write the merged
bundle**: merging requires finding the ambient corporate roots, which is
environment-specific (a Linux host may keep them outside the bundle a shell
points at; a Mac keeps them in the keychain), and two components both rebuilding
it would race one output.

The bundle is used only if node, handed that file, will actually verify our
proxy's leaf. The launcher does not predict that — it asks: a child process with
`NODE_EXTRA_CA_CERTS` set from birth stands up a TLS server holding our leaf and
connects to it. Only a bundle from which the loader really loaded our CA can
complete that handshake.

A bundle failing that is worse than no bundle — it would make the client
distrust the very proxy it is being routed through, so every request fails TLS
rather than merely losing some other component's CA.

**Why ask rather than parse.** The previous version modelled node's loader in a
regex: base64 quanta, padding position, dash runs in markers, which of ten
whitespace characters openssl tolerates. It took five review rounds and was
still wrong in *both* directions on a real bundle — accepting one node loads
nothing from, and refusing one node loads fine. The rule it was reaching for
turns out not to be expressible from outside: an identical tear is recovered or
fatal depending only on whether its truncated body happens to be complete DER,
which is a question about bytes the parser cannot answer. The loader can, in one
spawn (~25 ms over a bare `node -e ''` — measured, 40 interleaved pairs: 17.3 ms
bare, 42.4 ms probed). What that is 25 ms *of*: a `--remote-control` launch is
~520 ms end to end, of which ~493 ms is forking the proxy and waiting for it to
listen. So the probe is ~8% of a launch and very nearly all of the CA work.

**Three outcomes, never two.** `ok`, `not ok`, and `unknown` — the last meaning
the probe could not be run at all. A guard that answers "unusable" when it could
not ask drops every corporate root on a machine whose bundle was fine.

**A damaged merge does not cost the other publishers their CAs.** The damage
lives in the merge, not in the files that fed it, so the launcher rebuilds from
the `ca-trust.d/` publishers that still work rather than falling back to its own
CA alone. The saving is one certificate per surviving publisher: measured on
this box (ours plus one peer), one certificate under the old fallback against
two under the rebuild; on a three-publisher host, one against three.

Both paths are fixed names under `<config>`, deliberately with no env override
of their own. They are two halves of one rendezvous: a knob on either half alone
lets a participant publish where no builder looks, or read a file no builder
writes, while still appearing to implement the contract. `CLAUDE_CONFIG_DIR`
already relocates the pair, and it moves both halves together.

Note the limit of what a consumer checks: intact, and carries my CA. Whether the
bundle is *complete* — that no corporate root went missing — is the builder's
guarantee, and a consumer must not act on it even where it could.

That is a design choice, not a missing capability, and the distinction matters
because the other reading is an invitation: someone adds the previous bundle as
state, believes the limitation is lifted, and adds a floor. It would still be
wrong. A shrink is *legitimate* whenever a root is retired or a component is
uninstalled, and only the builder knows which happened — so a reader holding
both bundles still cannot tell a regression from a fact. Measured: a legitimate
bundle is 5 certs on one machine here and 168 on another, so any floor that
catches narrowing on one host rejects a healthy bundle on the next.

**This is a cooperative convention among same-user processes, not a trust
boundary.** The check proves *parses, and carries us* — never *contains only
approved writers*. Anyone who can write `<config>` can hand us a well-formed
bundle holding our CA plus their own and it will be accepted, exactly as they
could already have replaced `ca-trust.d/ccf.pem`, the CA dir, or this file. The
contract defends against components accidentally untrusting each other, which is
the failure that actually happens; it does not defend against a local attacker,
who has simpler routes.

#### `CACHE_FIX_DOWNLOAD_REWRITE` breaks `claude update` — leave it off

`CACHE_FIX_DOWNLOAD_REWRITE=on` reads like a pure performance knob. It is not:
turning it on **disables `claude update` entirely** on that host. Rewriting a
download URL means reading it, which means MITM-ing `downloads.claude.ai` — and
the release-channel client pins **public roots only** and rejects any private
CA, so the version check dies before a byte is downloaded:

```
Failed to fetch version from .../claude-code-releases/latest after 3 attempt(s):
  unable to verify the first certificate
```

Measured with `openssl s_client -proxy 127.0.0.1:9901 -connect downloads.claude.ai:443
-servername downloads.claude.ai`:

| `CACHE_FIX_DOWNLOAD_REWRITE` | leaf CN | verify |
|---|---|---|
| `on` | `api.anthropic.com` | code 21 |
| `off` | `downloads.claude.ai` (WR3 / GTS Root R1) | code 0 |

Two things make this worse than it first looks:

- **It cannot be narrowed to the binary download.** MITM is decided per host at
  `CONNECT` time, and the version check shares `downloads.claude.ai` with the
  download itself. It is all-or-nothing per host.
- **No client-side override reaches that client.** `HTTPS_PROXY` / `ALL_PROXY`,
  `/etc/hosts`, `/etc/resolv.conf`, and `NODE_EXTRA_CA_CERTS` were each
  disproved against a control on the identical path — a local resolver logged 0
  queries and a TCP forwarder logged 0 connects across a full `claude update`,
  while a plain `node https.get` through that same forwarder returned 200. So no
  amount of CA injection can make the rewrite work. Only not intercepting works.

Other hosts are unaffected: `github.com` through the same proxy returns its real
certificate and verifies. The flag is off by default; keep it that way unless you
are prepared to update Claude Code some other way.

### What the proxy does

On every `/v1/messages` request, the pipeline runs an ordered chain of extensions covering cache stability, observability, thinking-desync mitigation, image, microcompact, breakpoint, bootstrap-channel, and other surfaces. Several are gated behind env vars documented in their own sections below; bootstrap-channel handling defaults to `audit` mode. The headliners:

| Extension | What it fixes |
|-----------|--------------|
| `fingerprint-strip` | Removes unstable cc_version fingerprint from system prompt |
| `sort-stabilization` | Deterministic ordering of tool and MCP definitions |
| `ttl-management` | Detects server TTL tier, injects correct cache_control markers |
| `identity-normalization` | Normalizes message identity fields for prefix stability |
| `fresh-session-sort` | Fixes non-deterministic ordering on first turn |
| `cache-control-normalize` | Normalizes cache_control markers across messages |
| `cache-telemetry` | Extracts cache stats from response headers → `~/.claude/quota-status/{account.json,sessions/<id>.json}` |
| `session-health` | Observes per-session thinking-desync risk (context size + thinking-block count) and warns before a session reaches the danger zone. Read-only |
| `thinking-block-sanitize` | Drops omitted (empty-text) thinking blocks to head off the CC thinking-desync `400` (#63147). **On by default as of v4.0.0** (v1 mode). Set `CACHE_FIX_THINKING_SANITIZE=off` to disable, `=v2` for additional tools-hash-mismatch drop (opt-in). |
| `workflow-agent-id-synthesis` | Derives a stable per-leg agent id for Workflow-tool subagents whose canonical `x-claude-code-agent-id` header CC does not set ([CC#66761](https://github.com/anthropics/claude-code/issues/66761)). On by default; stash lives on `ctx.meta._workflowAgentId` and never leaves the proxy. `usage-log` emits the `agent_id` + `agent_id_source` fields when `CACHE_FIX_USAGE_LOG_AGENT_ID=on` AND meter v0.8.0+ is installed. Master switch: `CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off`. |
| `session-budget-breaker` | Opt-in hard **per-session spend ceiling** — short-circuits a session's requests locally once its cumulative tokens / estimated cost / consumption rate cross a limit you set, so a runaway fan-out can't drive credits or auto-purchase ([CC#68285](https://github.com/anthropics/claude-code/issues/68285)). Default-off; fail-open. Gate `CACHE_FIX_SESSION_BUDGET=on` + a ceiling. See [Session budget circuit breaker](#session-budget-circuit-breaker-proxy-mode-opt-in). |

Extensions live as `.mjs` files in `proxy/extensions/` with configuration in `proxy/extensions.json`. As of v4.0.0 the proxy loads them once at startup; adding, removing, or modifying an extension requires a supervisor-level proxy restart (see [Upgrading from v3.x](#upgrading-from-v3x)). Hot-reload is available as opt-in via `CACHE_FIX_HOT_RELOAD=on` for users who want the v3.x behavior back; that path is subject to the Node ESM stale-import race documented in [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196).

**Developing a new extension?** See [docs/parallel-proxy-test-harness.md](docs/parallel-proxy-test-harness.md) for the pattern we use to test extensions end-to-end against real `claude -p` traffic without disturbing the production proxy.

### Running as a service

**Recommended (Linux/macOS) — `install-service` subcommand:**

```bash
cache-fix-proxy install-service
```

Detects your platform and writes the appropriate config:

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service` (systemd user unit)
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist` (launchd agent)

The output prints the next-step commands to enable and start the service. On Linux:

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # auto-recovery — see below
sudo loginctl enable-linger $USER   # optional: start on boot, not just on login
```

**Auto-recovery (Linux):** `install-service` also drops a healthcheck companion (`cache-fix-proxy-healthcheck.service` + `.timer`). The timer fires every 2 minutes; the oneshot service runs `curl -fs http://127.0.0.1:<port>/health` and `systemctl --user start cache-fix-proxy.service` if the probe fails. This recovers the proxy from any stop — clean or unclean, expected or unexpected — within 2 minutes. Background: `Restart=on-failure` doesn't fire on clean stops, so before this companion existed, a `systemctl stop` from any source (including unidentified ones during an Anthropic outage on 2026-04-25) would leave the proxy down indefinitely. macOS doesn't need the companion — launchd's `KeepAlive` already auto-restarts on any exit.

On macOS:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

The installed config picks up `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_UPSTREAM`, and `CACHE_FIX_DEBUG` from the env at install time. Re-run `install-service --force` to regenerate after env changes, or edit the service file directly. Pair with `cache-fix-proxy uninstall-service` to remove cleanly (stops, disables, deletes).

The service runs `cache-fix-proxy server` in the foreground, which is just the proxy without the wrapper-mode claude launcher.

**Manual (any platform):**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

A multi-arch (amd64, arm64) container image is published to GitHub Container Registry on every release tag.

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# Then in your shell:
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

Use `--restart=always` instead of the systemd healthcheck companion — Docker handles auto-recovery natively. Mount nothing; the container is stateless. Override the default port with `-e CACHE_FIX_PROXY_PORT=...`. Override the upstream (e.g. to chain through llm-relay) with `-e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080`. The image runs as the unprivileged `node` user (uid 1000) and exposes a `HEALTHCHECK` Docker can use for liveness.

For corporate environments behind an SSL-inspecting proxy, mount your CA bundle and set the env vars:

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e HTTPS_PROXY=http://proxy.corp.example:8080 \
  -e CACHE_FIX_PROXY_CA_FILE=/etc/ssl/corp-ca.pem \
  -v /path/to/zscaler-root.pem:/etc/ssl/corp-ca.pem:ro \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

Image tags: `latest`, `4`, `4.0`, `4.0.0` (semver-ladder, so `4` always points to the newest 4.x). `latest` always tracks the newest tagged release.

**Linux note:** the chained-upstream `host.docker.internal` example below is automatic on Docker Desktop (macOS / Windows). On plain Linux Docker Engine you usually need `--add-host=host.docker.internal:host-gateway` so the name resolves to the host bridge. Without it, the container's name lookup fails and the proxy can't reach the upstream service running on the host. Example chaining cache-fix proxy through `llm-relay` running on the host:

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

**Forward-proxy mode in Docker** (keeps Remote Control; see [Forward-proxy mode](#forward-proxy-mode-keeps-remote-control-working)). Add `-e CACHE_FIX_FORWARD_PROXY=on` and point `CACHE_FIX_CA_DIR` at a writable path. The image runs as the unprivileged `node` user (uid 1000), and a fresh Docker named volume mounts **root-owned**, so use a bind mount you `chown` to uid 1000 (this also persists the CA across restarts and lets the host read it):

```bash
mkdir -p ./cache-fix-ca && sudo chown 1000:1000 ./cache-fix-ca
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e CACHE_FIX_FORWARD_PROXY=on \
  -e CACHE_FIX_CA_DIR=/ca -v "$PWD/cache-fix-ca:/ca" \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# The CA is now at ./cache-fix-ca/ca.pem on the host. Point the client at the
# proxy (leave ANTHROPIC_BASE_URL unset so Remote Control stays enabled):
HTTPS_PROXY=http://127.0.0.1:9801 NODE_EXTRA_CA_CERTS=$PWD/cache-fix-ca/ca.pem claude
```

If you don't need the CA to persist on the host, drop the volume and let it live in the container's writable layer: `-e CACHE_FIX_CA_DIR=/tmp/cache-fix-ca` (then `docker cp cache-fix-proxy:/tmp/cache-fix-ca/ca.pem ./ca.pem` to fetch it). Check it worked: `curl -s localhost:9801/health` must report `"forward_proxy":true`; a `false` there means the proxy fell back to reverse-proxy (e.g. an unwritable CA dir).

### Health check

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### Proxy configuration

All proxy settings are controlled via environment variables. Set them before starting the proxy server.

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_FIX_PROXY_PORT` | `9801` | Listen port |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | Bind address |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | Upstream URL. Change to chain another proxy (e.g. `http://localhost:8080`) |
| `CACHE_FIX_FORWARD_PROXY` | unset | Set to `on` for forward-proxy mode (HTTP CONNECT + selective MITM of the upstream host) so the client points `HTTPS_PROXY` at the proxy instead of `ANTHROPIC_BASE_URL`, keeping Remote Control enabled. See [Forward-proxy mode](#forward-proxy-mode-keeps-remote-control-working). |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | Directory for the forward-proxy CA/leaf cert (generated once on first start). The client trusts `ca.pem` via `NODE_EXTRA_CA_CERTS`. |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | Request timeout in milliseconds |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | Directory for extension `.mjs` files |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | Extension configuration file |
| `CACHE_FIX_DEBUG` | `0` | Enable debug logging |
| `CACHE_FIX_HOT_RELOAD` | unset | Set to `on` to enable in-process extension hot-reload. Off by default as of v4.0.0 — see [Upgrading from v3.x](#upgrading-from-v3x) for details and the supervisor restart flow. |
| `CACHE_FIX_READ_DEDUPE` | unset | Set to `1` to dedupe repeat `Read` tool results that re-appear unchanged across turns. Keeps the first occurrence intact; replaces later byte-identical ones (keyed on `file_path` + content + `offset` + `limit`) with a stable pointer line. Default-off; opt in per session to validate before broader rollout. See [extension impact guide](docs/extension-impact-guide.md). |
| `CACHE_FIX_ADVISOR_PLAN` | unset | Plan override for `tools/tier-advisor.mjs` — one of `max-5x`, `max-20x`, `pro`. Bypasses heuristic plan detection. See [Tier advisor](docs/tier-advisor.md). |
| `CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD` | `80` | Projected-Q7d percent that triggers an `UPGRADE` recommendation from tier-advisor. |
| `CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD` | `20` | Projected-Q7d percent that triggers a `DOWNGRADE` recommendation from tier-advisor (paired with the `DOWNGRADE_WEEKS` consecutive-weeks gate). |
| `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS` | `2` | Consecutive completed weeks under the downgrade threshold required before tier-advisor recommends downgrade. Single-week dips never trigger; single-week spikes DO trigger upgrade (cost-of-being-throttled asymmetry). |

### Corporate environments (proxies, custom CAs)

The proxy honors the following environment variables when forwarding to `api.anthropic.com`. Behind Zscaler / Netskope / Forcepoint / Bluecoat / corporate squid, set these in the proxy's environment.

| Variable | Effect |
|----------|--------|
| `HTTPS_PROXY` / `HTTP_PROXY` (and lowercase variants) | Routes upstream requests through the corporate HTTP CONNECT proxy. |
| `NO_PROXY` | Comma-separated host list to bypass the proxy. Supports `*` and `.suffix.example.com`. |
| `CACHE_FIX_PROXY_CA_FILE` | Path to a PEM file with one or more extra CA certificates (for SSL-inspecting proxies). |
| `NODE_EXTRA_CA_CERTS` | Standard Node mechanism — also honored. |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Insecure escape hatch.** Disables TLS verification. Use only as a last resort while you wait for IT to provide the corp CA bundle. |

Example (Windows PowerShell):

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

Stderr will print `[upstream] using proxy http://proxy.corp.example:8080 ...` on first request when the agent is wired correctly. With no proxy/CA env vars set, behavior is unchanged from earlier versions (Node default agent, system trust store).

### Embedding the proxy in your own process

If you ship a Node or Bun binary that wants the cache-fix proxy in-process (e.g. a Bun-compiled agent that avoids forking a Node child), import the factory from `claude-code-cache-fix/proxy/server`:

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0,        // OS-assigned ephemeral port; pass a number to pin
  bind: "127.0.0.1",
  watch: false,   // skip fs.watch — recommended for compiled binaries
});

console.log(`proxy listening on ${handle.address}:${handle.port}`);

// ...later...
await handle.close();
```

**`createProxyServer()` → `http.Server`** builds the request handler wired into an `http.Server`. The returned server is *not* listening and the extension pipeline has not been loaded — use this when you want to manage the lifecycle yourself.

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`** loads the extension pipeline, optionally starts the file watcher, and starts listening. Returns a handle with the bound port (resolved when `port: 0` is requested) and a `close()` that releases the server and the watcher.

Options (all optional; all fall back to the same env vars used by the CLI):

| Option | Default | Effect |
|--------|---------|--------|
| `port` | `CACHE_FIX_PROXY_PORT` env, else `9801` | Listen port. Pass `0` for an OS-assigned ephemeral port. |
| `bind` | `CACHE_FIX_PROXY_BIND` env, else `127.0.0.1` | Bind address. |
| `extensionsDir` | package `proxy/extensions/` | Directory to load `.mjs` extensions from. |
| `extensionsConfig` | package `proxy/extensions.json` | Path to extension config. |
| `watch` | `true` | Whether to start `fs.watch` on the extensions config. Set `false` for embedded / compiled-binary use. |

**One extension registry per process.** The pipeline maintains a single shared extension registry at module scope. Hosting two `startProxy()` instances in the same process is supported (different ports, different bind addresses), but they share that registry — a subsequent `loadExtensions` call replaces it for both. If you need divergent extension configs per instance, run them in separate processes.

**CLI invocation is unchanged.** `node proxy/server.mjs`, `cache-fix-proxy server`, and the wrapper's child-fork path all auto-listen and install SIGTERM/SIGINT handlers as before. Library imports never trigger that behavior — the auto-listen is gated behind a main-module check.

*The embeddable factory was contributed by [@bilby91](https://github.com/bilby91) at [Crunchloop DAP](https://dap.crunchloop.ai) — see [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123).*

## Upgrading from v3.x

**Behavior changes in v4.0.0:**

- **`thinking-block-sanitize` v1 is now on by default.** Was opt-in via `CACHE_FIX_THINKING_SANITIZE=on` in v3.8.0–v3.9.x. After seven days of prod dogfood across 37 sessions (zero `cannot be modified` 400s, cache hit-rate aggregate 94.66% vs. 92.44% baseline, sanitize firing on ~35% of sessions with ~800 blocks dropped per day) the v1 mitigation is the new default. Set `CACHE_FIX_THINKING_SANITIZE=off` to explicitly disable. v2 (additional tools-hash-mismatch drop) stays opt-in via `=v2`. See [#63147](https://github.com/anthropics/claude-code/issues/63147) and [#162](https://github.com/cnighswonger/claude-code-cache-fix/issues/162).
- **In-process extension hot-reload is now off by default.** Was on in v3.x. Set `CACHE_FIX_HOT_RELOAD=on` to restore the prior behavior. Off-by-default eliminates the Node ESM stale-import race documented in [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196), where the watcher silently failed to load a newly-merged extension for 17 hours after a hot-reload trigger. The race fires when the file watcher re-imports an extension whose transitive dependencies are already cached by Node's loader; cold starts are unaffected.

### Embedder note (Bun hosts, DAP-style integrations using `createProxyServer()` / `startProxy()`)

v4.0.0 flips `CACHE_FIX_THINKING_SANITIZE` from default-off to default-on. The v1 omitted-text drop will run on every request body passing through the embedded proxy. If your host depends on the prior no-sanitization behavior (e.g., your downstream code expects empty `thinking` blocks to survive the proxy round-trip), preserve it by either:

- Setting `CACHE_FIX_THINKING_SANITIZE=off` in your host's environment, OR
- Setting `process.env.CACHE_FIX_THINKING_SANITIZE = "off"` in your code at any point before request handling — the mode is read per-request via `modeFromEnv()`, not cached at module load.

The flip is backed by 7 days of prod dogfood (37 sessions, zero `cannot be modified` 400s, cache hit-rate aggregate 94.66% vs 92.44% baseline). See [PR #201](https://github.com/cnighswonger/claude-code-cache-fix/pull/201) for the validation data and [#63147](https://github.com/anthropics/claude-code/issues/63147) for upstream context.

Picking up a new extension or a code change to an existing one in v4.0.0 requires a supervisor-level proxy restart. There are two upgrade flows depending on whether you also want to opt back into hot-reload.

### Flow 1 — code-only npm upgrade (recommended default)

Your existing systemd unit / launchd plist is unchanged; only the proxy code on disk is updated by npm. Restart the running process to pick up the new code.

**Linux (systemd user unit):**

```
npm install -g claude-code-cache-fix@4
systemctl --user restart cache-fix-proxy
```

No `daemon-reload` required — the unit file content is unchanged.

**macOS (launchd user agent):**

```
npm install -g claude-code-cache-fix@4
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

`kickstart` re-execs the agent under the existing plist.

### Flow 2 — opt back into hot-reload at the supervisor layer

Run if you actively use hot-reload (e.g., you drop custom extensions into the extensions dir on a live proxy and want them picked up without restart). This rewrites the unit / plist so `CACHE_FIX_HOT_RELOAD=on` is set every time the supervisor starts the proxy.

**Linux (systemd user unit):**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
systemctl --user daemon-reload
systemctl --user restart cache-fix-proxy
```

`daemon-reload` is required because the unit file content changed.

**macOS (launchd user agent):**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
launchctl bootout gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

`bootout` + `bootstrap` is required because the plist contents changed — `kickstart` alone does not pick up plist changes.

**Note on the hot-reload tradeoff:** even on the opt-in path, the ESM stale-import race remains possible on long-running processes. If you hit a degraded `/health` (returns 503 + `{status:"degraded",...}`), a process restart is the only recovery; the proxy logs a `[CRITICAL]` hint when this happens. See [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197) for the observability layer.

## What this proxy defends against

**Cache-economics regressions.** The original purpose of cache-fix is to absorb the cache-handling behaviors in Claude Code that cost users real money and quota — TTL downgrades, cache-breaking header churn, identity-latching issues, and the rest of the regression catalog documented across our issue history. The proxy sits between CC and the Anthropic API, normalizes the request and response stream, and emits enough observability (via statusline integration and the quota-status files) that users can see what their session is actually doing. This is the load-bearing feature for almost every user today.

**Bootstrap-channel observability.** Claude Code v2.1.150 introduced a prompt-section consumer that fetches a server-supplied string from `/api/claude_cli/bootstrap` and merges it into the agent's behavioral-instructions prompt path. We filed this behavior with Anthropic's security team in May 2026; Anthropic closed the report as *Informative*, treating TLS as the transport-integrity boundary and declining to add application-layer authenticity checks. Cache-fix shipped explicit handling for this path in v3.7.0 and extended it in v3.7.1 to also cover the env-var-selected GrowthBook prompt-injection surface that landed in CC v2.1.152 (remote-control mode: `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` names a flag key whose cached value is used as the system prompt body). Stable in the current v4.x line.

Cache-fix's `bootstrap-defense` extension ships three modes, selected via `CACHE_FIX_BOOTSTRAP_MODE`:

| Mode | Default? | Behavior |
|---|---|---|
| `audit` | yes | Bootstrap responses proxy through to CC. Each response is logged to `~/.claude/cache-fix-bootstrap-log.jsonl` with surface metadata: which prompt-source surfaces fired (`tengu_heron_brook` legacy and/or env-var-selected), the SHA-256 hash of the value (first 16 hex chars — never the value itself), and the `CLAUDE_CODE_REMOTE` flag. Multi-surface responses emit one record per surface, correlated by `request_id` + timestamp window. |
| `block` | opt-in | `onRequest` returns a 200 with an empty JSON body. Upstream is never called, no flag map ever reaches the on-disk GrowthBook cache. Defeats both legacy and env-var-selected injection surfaces. |
| `allowlist` | opt-in (experimental) | Bootstrap response proxies through, but prompt-source-eligible keys (legacy `tengu_heron_brook` + env-var-selected key) not in the allowlist are stripped from the response body before it reaches CC. Default allowlist is `tengu_heron_brook` (the only known-legitimate historical key); configure via `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=comma,separated,list`. Pass `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=` (explicit empty) for full deny-all. Other GrowthBook flag keys pass through untouched. May need updates if Anthropic adds legitimate prompt-source keys in future CC releases. |

Note: cache-fix v3.6.2 and earlier returned 404 for the bootstrap path because the proxy router did not include it — the practical effect was that bootstrap content was not reaching CC for cache-fix users. v3.7.0's default `audit` changes that behavior; explicit `CACHE_FIX_BOOTSTRAP_MODE=block` preserves it. The full disclosure record, including Anthropic's verbatim close text, is in [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md).

**Reference material:**
- [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) — full disclosure record
- [`CHANGELOG.md`](CHANGELOG.md#371---2026-05-27) — v3.7.1 release entry (extended surface coverage + allowlist mode); [v3.7.0 entry](CHANGELOG.md#370---2026-05-26) covers the prior behavior-change note
- [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) — reproducer for the bootstrap-channel behavior

**Auto-1M-context overage protection.** CC v2.1.161 onward (notably the VS Code Extension surface) can auto-select 1M context on Pro Plan without user request, immediately consuming overage credits. The proxy's `auto-1m-guard` extension detects the `context-1m-2025-08-07` token on the outbound `anthropic-beta` header and either warns or strips it, depending on the mode you opt into via `CACHE_FIX_AUTO_1M_GUARD`:

| Mode | Default? | Behavior |
|---|---|---|
| `off` | no | Extension no-op. |
| `warn` | yes | Detect the token. Stash an annotation into the per-session JSON (`auto_1m_detected`, `auto_1m_action: "warn"`, `auto_1m_advice`) and emit a stderr log line, latched to the first detection for the life of the process (the advice never changes; an extension reload does not re-arm it). Does not modify the request. |
| `strip` | opt-in | Detect AND remove the token from the `anthropic-beta` header before forwarding. Annotation: `auto_1m_action: "stripped"`. |

The CC-side kill switch is `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (env var), which is the right fix when it actually reaches the CC process. On the VS Code extension surface that env var is reportedly unreliable; the proxy intercept bypasses that gap because it acts on the wire regardless of which CC launcher produced the request. Tracks [CC#64919](https://github.com/anthropics/claude-code/issues/64919); see [`docs/directives/proxy-auto-1m-guard.md`](docs/directives/proxy-auto-1m-guard.md) for the binary-walk that confirms the proxy-visible signal is the beta header (CC strips the `[1m]` suffix from `req.body.model` client-side before sending).

## Client-side hooks

Some Claude Code behaviors live below the request layer — they happen client-side, in the tool-dispatch path, before the proxy ever sees traffic. cache-fix ships standalone hook scripts under [`hooks/examples/`](hooks/README.md) for those cases. They're independent of the proxy and you install them by pointing at them from your own `~/.claude/settings.json`.

| Script | What it does |
|---|---|
| [`worktree-edit-guard.py`](docs/hooks/worktree-edit-guard.md) | Block `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool calls whose target path escapes the active git worktree, preventing parent-checkout corruption from worktree sessions. Addresses [CC#59628](https://github.com/anthropics/claude-code/issues/59628). |

## Contributed tools

Standalone scripts that aren't proxy extensions or CC hooks — installable separately, addressing specific upstream issues.

| Tool | What it does |
|---|---|
| [`tools/gh-auth-status-shim/`](tools/gh-auth-status-shim/README.md) | PATH-resolved `gh` wrapper that suppresses CC Desktop's false "GitHub CLI authentication expired" toast. Addresses [CC#67055](https://github.com/anthropics/claude-code/issues/67055): CC Desktop's PR poller maps any non-zero return from `gh auth status` (including its 5s spawn timeout) to the `"auth"` toast category. The shim intercepts `gh auth status` calls with a 4s internal timeout, classifies the outcome, and returns exit 0 to suppress the false toast on transient/timeout signals while letting genuine expiry (`not logged in`, `HTTP 401`) propagate normally. Workaround until Anthropic's classifier fix lands. **Known limitations:** rewrites `gh auth status` exit-code semantics for every caller in the PATH scope (not just CC); macOS coverage unverified due to launchd PATH inheritance; native Windows CC Desktop not supported. |

## Recommended CC operational config

The proxy fixes what it can fix at the request layer. A handful of CC client-side env vars and `~/.claude/settings.json` knobs solve adjacent problems the proxy can't reach — silent model swaps on CC update, ambiguous model fallback, schema-strip side effects. Surfacing these here as a recommendation; users decide their own config.

These findings come from [@fgrosswig](https://github.com/fgrosswig)'s binary analysis of CC v2.1.91. Methodology is public PowerShell + ASCII string extraction; he shared the resulting punch list privately as a courtesy.

### Suggested `~/.claude/settings.json` env block

The model IDs below are illustrative — replace with your preferred main and small-fast models. The point is that pinning *something* explicit beats relying on CC's defaults.

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
    "ANTHROPIC_MODEL": "claude-opus-4-7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — single most impactful flag. CC has a legacy code path that silently remaps your pinned model to a different one after certain version updates. Setting this to `1` disables the remap; the model you pin is the model you get. (If you don't pin, CC's defaults apply as usual.)

**`ANTHROPIC_MODEL`** — pins the primary model. Keeping this explicit means the cache prefix hash stays stable across CC version bumps that would otherwise swap your default. Adjust to whichever model you actually want.

**`ANTHROPIC_SMALL_FAST_MODEL`** — pins the side-channel "fast" model CC uses for short auxiliary calls (e.g., title generation, classification). Without an explicit pin, this can silently fall back to a different family on update.

### `autoCompactWindow=1000000` caveat

If you've seen the `autoCompactWindow: 1000000` setting recommended elsewhere: it only takes effect when the active model qualifies for 1M-context (currently `claude-sonnet-4-6` or `claude-opus-4-6` with the appropriate beta header). Without those preconditions it caps at the hardcoded 200K regardless of what you set.

### `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` schema-strip side effect

If you set this flag, CC strips any tool field outside `["name", "description", "input_schema", "cache_control"]` from outgoing requests. Custom tools relying on `defer_loading` or `eager_input_streaming` will silently lose those fields and behave differently. Worth knowing before turning the flag on.

## Known CC behaviors that affect cache cost

These aren't bugs cache-fix patches — they're upstream CC behaviors users should be aware of when sizing their session cost.

### Diagnostic slash commands inflate conversation history ([#49335](https://github.com/anthropics/claude-code/issues/49335))

Running `/context`, `/release-notes` (and likely other state-inspection commands) appends the diagnostic output to conversation history rather than rendering terminal-only. Subsequent turns replay the inflated payload via prompt cache, compounding token cost on a state-inspection action that should be free. Empirically measured at +3,480 `cache_creation_input_tokens` for a single `/context` invocation on v2.1.148; another user reports ~5K on a separate session. `/release-notes` is worse — defaults to dumping the full changelog.

Worse for diagnosis: the inflated payload that bills against your cache isn't written to the local JSONL transcript, so you can't audit the cost source locally — you can only infer it from `cache_creation_input_tokens` jumps in response usage metadata. (Proxy-mode users can inspect the deltas in `~/.claude/quota-status/` files, which the proxy writes directly from response headers.)

**Workaround until upstream fix:** use these commands sparingly in long sessions. If you need them frequently in a session, consider `/compact` after a diagnostic run to reset the bleed.

## Quick Start: Preload (CC v2.1.112 and earlier)

If you're on a Node.js-based CC version (v2.1.112 or earlier), the preload interceptor works without a proxy:

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note:** The preload does NOT work on CC v2.1.113+ (Bun binary). Use the proxy above.

See [docs/preload-setup.md](docs/preload-setup.md) for wrapper scripts, shell aliases, Windows instructions, and VS Code preload-mode integration.

## VS Code Extension

The [VS Code extension](https://github.com/cnighswonger/claude-code-cache-fix-vscode) (v0.5.0) supports both proxy and preload modes:

**Proxy mode (recommended):**
1. Start the proxy (see above)
2. In VS Code command palette: **Claude Code Cache Fix: Enable Proxy Mode**
3. Restart any active Claude Code session

**Preload mode (CC ≤v2.1.112):**
1. `npm install -g claude-code-cache-fix`
2. Download the VSIX from [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)
3. Install: `code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. Command palette: **Claude Code Cache Fix: Enable**

For manual VS Code wrapper setup (without the VSIX), see [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode).

## Security model

> **The proxy and interceptor have full read/write access to API requests and responses.** This is inherent to the approach — any fetch interceptor, proxy, or gateway has this position.

**What it does:** Modifies outgoing request structure (block order, fingerprint, TTL, git-status) to fix cache bugs. Reads response headers and SSE usage data for monitoring.

**What it does NOT do:** No network calls from the proxy or interceptor. All telemetry is written to local files under `~/.claude/`. No data leaves your machine.

**Supply chain:** Proxy mode: small focused extension modules in `proxy/extensions/` (most under a few hundred lines; the pipeline is composable, you can read any single one in isolation). Preload mode: single unminified file (`preload.mjs`). One dev dependency (`zod` for schema validation in tests only). Review before installing. Published builds carry npm's default registry signatures; sigstore provenance attestation is not currently published — tracked as a follow-up.

**Independent audit:** [Assessed as "LEGITIMATE TOOL"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) by @TheAuditorTool (2026-04-14).

## The problem

When you use `--resume` or `/resume` in Claude Code, the prompt cache breaks silently. Instead of reading cached tokens (cheap), the API rebuilds them from scratch on every turn (expensive). A session that should cost ~$0.50/hour can burn through $5–10/hour with no visible indication anything is wrong.

Three bugs cause this:

1. **Partial block scatter** — Attachment blocks (skills listing, MCP servers, deferred tools, hooks) are supposed to live in `messages[0]`. On resume, some or all drift to later messages, changing the cache prefix.

2. **Fingerprint instability** — The `cc_version` fingerprint (e.g. `2.1.92.a3f`) is computed from `messages[0]` content including meta/attachment blocks. When those blocks shift, the fingerprint changes, the system prompt changes, and cache busts.

3. **Non-deterministic tool ordering** — Tool definitions can arrive in different orders between turns, changing request bytes and invalidating the cache key.

Additionally, images read via the Read tool persist as base64 in conversation history and are sent on every subsequent API call, compounding token costs silently.

## How it works

**Proxy mode** (v3.0.0+): An HTTP server on `localhost:9801` intercepts `POST /v1/messages` requests. A pipeline of extension modules processes each request — normalizing block order, stripping fingerprints, stabilizing tool sort, managing TTL markers, sanitizing thinking blocks, recording telemetry, and more. Extensions live as `.mjs` files configured in `proxy/extensions.json` and load once at proxy startup (hot-reload is opt-in as of v4.0.0 — see [Upgrading from v3.x](#upgrading-from-v3x)). All other traffic passes through untouched.

**Preload mode** (v2.x): A Node.js `--import` module that patches `globalThis.fetch` before Claude Code makes API calls. Applies the same fixes inline — scans user messages for relocated blocks, sorts tools, recomputes fingerprints, injects TTL markers.

Both modes are idempotent — if nothing needs fixing, the request passes through unmodified. Neither mode modifies your conversation; they only normalize the request structure before it hits the API.

## Graduating from fixes

The package serves three purposes with different lifecycles:

| Purpose | Examples | When to disable |
|---------|----------|-----------------|
| **Bug fixes** | Block relocation, fingerprint, tool sort, TTL | When CC fixes the underlying bug — check the health line |
| **Monitoring** | Quota tracking, microcompact detection, GrowthBook flags | Keep permanently — these detect future regressions |
| **Optimizations** | Image stripping, output efficiency rewrite | Keep as long as they help your workflow |

### Health status (preload mode)

On first API call, the interceptor logs a health status line (requires `CACHE_FIX_DEBUG=1`):

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — fix was applied recently
- **dormant(N clean sessions)** — bug not detected in N sessions; CC may have fixed it
- **safety-blocked(Nx)** — round-trip verification failed; fix auto-disabled
- **waiting** — fix hasn't been triggered yet

### Regression detection

If cache_read ratio drops below 50% across 5+ calls after disabling fixes:
```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## Safety

### Fingerprint round-trip verification

Before rewriting the `cc_version` fingerprint, the interceptor verifies that its hardcoded salt and character indices reproduce the fingerprint Claude Code sent. If verification fails (CC changed its algorithm), the rewrite is skipped automatically. This ensures the interceptor can never make cache performance *worse* than stock CC.

### Fail-safe design

Every fix is designed to fail to a no-op:
- If block detection regexes don't match → blocks aren't relocated (CC behavior)
- If fingerprint format changes → fingerprint isn't rewritten (CC behavior)
- If tool sort produces no changes → payload passes through untouched
- If TTL injection target structure changes → TTL isn't injected (CC behavior)

The interceptor can only *help* or *do nothing*. It cannot make things worse.

## Status line — quota warnings in real time

Both modes write quota state on every API call. Proxy mode (v3.5.0+) splits into `~/.claude/quota-status/account.json` (account-global fields: Q5h/Q7d, status, overage) plus `~/.claude/quota-status/sessions/<id>.json` (per-session cache fields: TTL tier, hit rate). Preload mode keeps the legacy `~/.claude/quota-status.json` (single-session by construction). The included `tools/quota-statusline.sh` script displays a live status line showing:

- **Q5h** quota bar `[███░┃░░░░░]` + percent + `(exhaust X, reset Y)`. Filled cells are consumed quota; the heavy-vertical tick is wall-clock elapsed position in the window. Tick to the right of the fill = under pace; tick inside the fill = burning faster than time (over pace). `exhaust` is the projected time-to-100% at the current burn rate; `reset` is the wall-clock time until the window rolls over. When `exhaust < reset`, you will hit 100% before the window resets — back off.
- **Q7d** same shape with day-scale durations (e.g. `(exhaust 3d13h, reset 3d0h)`). Below a day, the suffix auto-switches to `h/m` format (e.g. `(exhaust 1h41m, reset 0h30m)`).
- **TTL tier** — `TTL:1h` when healthy, **`TTL:5m` in red when the server has downgraded you** (typically at Q5h ≥ 100%)
- **PEAK** in yellow during weekday peak hours (13:00–19:00 UTC)
- **Cache hit rate %**
- **OVERAGE** flag when active
- **Served-model divergence indicator** — when the served model differs from the requested model (the classifier-driven swap pattern in [CC#66728](https://github.com/anthropics/claude-code/issues/66728)), the bar gains a red `requested → served` segment, or a black-on-yellow `requested → served` for sticky state once the family-aware heuristic latches. No segment appears on the default no-divergence path. `[1m]` suffix appears on the requested side only when `auto_1m_detected` is set.

Example line (mid-window, healthy state):

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

The `(exhaust …, reset …)` suffix is dropped piecewise when projection isn't meaningful: at 0% (fresh window) and 100% (already exhausted) only `reset` is shown; in the first 5 minutes after window start the burn rate isn't stable enough to project (a single early call dominates the rate), so `exhaust` is held back until then on both Q5h and Q7d; a stale `resets_at` (the server-reported value sits in the past, before the next API call refreshes it) drops both.

The bar uses Unicode block characters (`█┃░`) — most modern terminals render these correctly. If your terminal substitutes boxes or replacement glyphs, configure a Unicode-capable font (any DejaVu, Fira, Iosevka, JetBrains Mono, etc.).

### Setup

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### Why the status line matters

When the server downgrades your TTL to 5m (quota-aware downgrade at Q5h ≥ 100%), **every idle longer than 5 minutes causes a full context rebuild**. Without the status line, this is invisible. With it, the red `TTL:5m` warning tells you: **stop working, wait for the Q5h window to reset, then resume**. Powering through overage compounds the drain; pausing breaks the cycle.

### Recommended: disable git-status injection

Claude Code injects live `git status` into the system prompt on every call. Any file edit changes the git status, which busts the entire prefix cache. Disabling this saves ~1,800 tokens per call:

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

Or add `"includeGitInstructions": false` to `~/.claude/settings.json`. Claude Code can still run `git status` via the Bash tool when it needs context. Community-validated by [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11): 18-token cache creation across git state changes (vs thousands without the flag).

**Why we don't ship a proxy extension for this:** the proxy intercepts requests after Claude Code has already composed the system prompt — by then the volatile `git status` text is already part of the prefix that the model conditioned on in the previous turn, and stripping it post-hoc would itself bust the cache. The fix has to happen at the source. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` prevents the injection before the prompt is composed, which is why the native flag is the right tool. Stripping post-hoc would also remove model-visible context that an explicit Bash call can recover, and would risk false-positive matches against assistant-written text.

## Migration: v3.4.x → v3.5.0+

If you wrote a custom statusline, monitoring script, or anything else that reads `~/.claude/quota-status.json` directly, this section is for you. v3.5.0 split that file in proxy mode; preload mode is unchanged.

### What changed

| | v3.4.x and earlier (proxy + preload) | v3.5.0+ proxy mode | v3.5.0+ preload mode |
|---|---|---|---|
| Quota fields (Q5h, Q7d, status, overage) | `~/.claude/quota-status.json` | `~/.claude/quota-status/account.json` | `~/.claude/quota-status.json` (legacy path) |
| Cache fields (TTL tier, hit rate, cache_creation/read) | same file as above | `~/.claude/quota-status/sessions/<filename>.json` | same file as above |
| Multi-session attribution | none — last writer wins | per-session files | preload is single-session by construction |

`<filename>` is derived from the request's `x-claude-code-session-id` header via a deterministic safe-name rule: UUIDs and other ids matching `[A-Za-z0-9_-]{1,128}` pass through; null/empty/whitespace become `unknown`; anything else is mapped to `inv-<sha256-prefix>`. Full rule is documented at [`docs/directives/proxy-quota-status-per-session.md`](docs/directives/proxy-quota-status-per-session.md).

The legacy `~/.claude/quota-status.json` is auto-deleted on the first proxy-mode write after upgrade. Per-session files older than `CACHE_FIX_QUOTA_STATUS_TTL_DAYS` (default `7`) are swept on write.

### Consumer-side migration pattern

Your script should try the v3.5.0+ proxy paths first and fall back to the legacy path if not present. That way it works in both modes (and on hosts mid-upgrade). The session id usually comes from Claude Code's stdin when it invokes a statusline hook; for other consumers, capture it from the most-recently-modified `~/.claude/projects/*/*.jsonl` filename.

**Bash (statusline-style):**
```bash
QS_DIR="$HOME/.claude/quota-status"
ACCOUNT="$QS_DIR/account.json"
LEGACY="$HOME/.claude/quota-status.json"

# Canonical filename rule — must mirror proxy/extensions/cache-telemetry.mjs
# sessionFilename(): trim, then "" → unknown, safe regex passthrough, else
# inv-<sha256-prefix>. Without this, malformed or whitespace ids miss the
# per-session file even though the writer created one under the canonical name.
session_filename() {
  local trimmed
  trimmed="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$trimmed" ]; then echo unknown; return; fi
  if printf '%s' "$trimmed" | grep -qE '^[A-Za-z0-9_-]{1,128}$'; then
    printf '%s' "$trimmed"
  else
    # sha256sum on Linux; shasum -a 256 on macOS. Both emit "<hex>  -".
    local hash
    if command -v sha256sum >/dev/null 2>&1; then
      hash="$(printf '%s' "$trimmed" | sha256sum)"
    else
      hash="$(printf '%s' "$trimmed" | shasum -a 256)"
    fi
    printf 'inv-%s' "$(printf '%s' "$hash" | cut -c1-16)"
  fi
}

# session id: prefer CC stdin, fall back to most-recent jsonl
sid="$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)"
if [ -z "$sid" ]; then
  sid="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)"
fi
filename="$(session_filename "$sid")"

# quota: account.json (v3.5.0+) → fall back to legacy
if [ -f "$ACCOUNT" ]; then
  quota_json="$(cat "$ACCOUNT")"
elif [ -f "$LEGACY" ]; then
  quota_json="$(cat "$LEGACY")"
fi

# cache: sessions/<filename>.json (v3.5.0+) → fall back to legacy
if [ -f "$QS_DIR/sessions/$filename.json" ]; then
  cache_json="$(cat "$QS_DIR/sessions/$filename.json")"
elif [ -f "$LEGACY" ]; then
  cache_json="$(cat "$LEGACY")"
fi
```

**Node:**
```js
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const home = homedir();
const accountPath = join(home, ".claude", "quota-status", "account.json");
const legacyPath = join(home, ".claude", "quota-status.json");

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Mirror of cache-telemetry.mjs sessionFilename(). Reader-side rule must match
// writer-side rule; otherwise malformed/whitespace ids miss their per-session file.
function sessionFilename(rawId) {
  if (rawId === null || rawId === undefined) return "unknown";
  const s = String(rawId).trim();
  if (s.length === 0) return "unknown";
  if (SAFE_NAME_RE.test(s)) return s;
  return "inv-" + createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function readQuotaJson() {
  if (existsSync(accountPath)) return JSON.parse(readFileSync(accountPath, "utf8"));
  if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}

function readCacheJson(sessionId) {
  const filename = sessionFilename(sessionId);
  const p = join(home, ".claude", "quota-status", "sessions", `${filename}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}
```

The shipped [`tools/quota-statusline.sh`](tools/quota-statusline.sh) is the reference implementation for the bash version. The [`/coffee` skill](https://github.com/cnighswonger/claude-code-coffee) v1.4.0 is the reference for the per-session warmth gate.

### Why per-session

On multi-agent hosts (multiple Claude Code sessions sharing one proxy), the pre-v3.5.0 single global file caused every session to overwrite the others' cache stats with each response. A statusline reading from session A would show session B's TTL tier whenever B sent a request more recently. Per-session files plus an account-global quota file resolve this without losing the easy account-wide view. See [#104](https://github.com/cnighswonger/claude-code-cache-fix/issues/104) for the original report.

### `CLAUDE_CONFIG_DIR`

Claude Code reads `CLAUDE_CONFIG_DIR` to relocate its config root away from the default `~/.claude` (used to keep multiple independent config roots in separate directories). The proxy now honors the same variable for **all** of its on-disk state: `quota-status/`, `usage.jsonl`, `cache-fix-state/`, session mirrors, snapshots, and OAuth events all land under `$CLAUDE_CONFIG_DIR` instead of a hardcoded `~/.claude`. When it's unset the proxy uses `~/.claude` exactly as before (no change for the common single-config case).

This matters when you run **one proxy per config dir**: without it, every proxy writes to `~/.claude/quota-status/account.json` and they clobber each other's quota state. Give each proxy the same `CLAUDE_CONFIG_DIR` its Claude Code client uses, and their state stays cleanly separated.

## Image stripping (preload mode)

Images read via the Read tool persist as base64 in conversation history, riding along on every subsequent API call. A single 500KB image costs ~62,500 tokens per turn on Opus 4.6, and **~85,000+ on Opus 4.7** due to the new tokenizer. Image stripping is strongly recommended on 4.7.

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

Keeps images in the last 3 user messages, replaces older ones with a text placeholder. Only targets `tool_result` blocks — user-pasted images are never touched.

### Oversized-image guard (legacy, v3.2.1)

```bash
export CACHE_FIX_IMAGE_MAX_DIM=2000
```

The Anthropic API enforces TWO image-related limits on multi-image requests, and the same error message can fire for either:

> `"An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."`

Two pressure axes to address them:

| Pressure | Variable | What it does |
|---|---|---|
| **Too many images in conversation** | `CACHE_FIX_IMAGE_KEEP_LAST=N` | Strips images from old user messages, keeps only the last N. |
| **Any single image too large** | `CACHE_FIX_IMAGE_MAX_DIM=2000` | Replaces images exceeding the dimension limit with a forensic placeholder noting the original dimensions. Covers both user-message direct images and tool_result-nested images. |

The two compose: with both set, `KEEP_LAST` runs first (drops the count), then `MAX_DIM` runs on what remains (caps the size of the kept ones). Common triggers for the dimension axis: hi-res manuscript scans, retina screenshots, photos at full resolution.

Pure-JS PNG and JPEG header parsing — no native deps. Other formats (GIF, WebP, AVIF, BMP) pass through unchanged regardless of dimension. Fail-open: images whose dimensions can't be parsed (truncated header, unsupported format) are kept rather than stripped — better to send a request that might error than to strip a valid image we just couldn't measure.

### Image-guard pipeline (v3.3.0)

A conditional pipeline that mirrors Anthropic's actual rules. Strictly opt-in via a single env var:

```bash
export CACHE_FIX_IMAGE_GUARD=1
```

When enabled, the proxy runs:

| Pass | Trigger | Action |
|------|---------|--------|
| **Pass 0** (legacy) | `CACHE_FIX_IMAGE_KEEP_LAST=N` set | Strip tool_result images from user messages older than N most recent |
| **Pass 3** | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` AND image long edge > model native cap | Lanczos resize via `sharp` to native cap (2576 px for Opus 4.7, 1568 px otherwise), preserve aspect ratio and media type |
| **Pass 1** | image long edge > active rejection cap | Strip and replace with forensic placeholder. Active cap = `MAX_DIM` if set, else 2000 px (when count > 20) or 8000 px (count ≤ 20) |
| **Pass 2** | request body exceeds `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` (default 30 MB) | Drop oldest images until under budget |
| **Count cap** | surviving image count > `CACHE_FIX_IMAGE_COUNT_MAX` (default 100) | Drop oldest images down to the cap |

Execution order: **Pass 0 → Pass 3 → Pass 1 → Pass 2 → count cap**. Each pass is independent — Pass 1 never resizes; Pass 3 never strips.

#### Optional `sharp` dependency

Pass 3 requires [sharp](https://www.npmjs.com/package/sharp) for Lanczos resize. It's declared as an **optional peer dependency** — install separately if you want Pass 3:

```bash
npm install sharp
```

If `sharp` is missing, Pass 3 skips cleanly (telemetry records `library_missing: true`); Pass 1 + Pass 2 + the count cap still run.

#### Precedence matrix

| Env var combination | Behavior |
|---|---|
| Nothing set | No image processing (back-compat default; the extension short-circuits). |
| `KEEP_LAST=N` only | Existing v3.2.1: count cap on tool_result images in user messages, runs first. No pipeline. |
| `MAX_DIM=N` only | Existing v3.2.1: hard size cap, strip-only. No pipeline. |
| `KEEP_LAST=N` + `MAX_DIM=N` | Existing v3.2.1 composition: `KEEP_LAST` runs first (drops count), then `MAX_DIM` runs on survivors (caps size). No pipeline, no Pass 2, no Pass 3. |
| `IMAGE_GUARD=1` | New pipeline: Pass 1 (conditional cap) + Pass 2 (request-size guard) + image-count cap. |
| `IMAGE_GUARD=1` + `MAX_DIM=N` | `MAX_DIM` overrides Pass 1's conditional cap (acts as the cap value); Pass 2 still runs. |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` | Adds Pass 3 (Lanczos resize via `sharp`). When `sharp` unavailable, falls back to strip behavior. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` | `KEEP_LAST` runs first as count cap (Pass 0); pipeline runs on remainder. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` + `MAX_DIM=N` | Three-way: `KEEP_LAST` runs first; pipeline runs on remainder, but `MAX_DIM` overrides Pass 1's conditional cap; Pass 2 still runs. |
| `PRESERVE_DETAIL=1` without `IMAGE_GUARD=1` | Logs warning, treats as no-op. `PRESERVE_DETAIL` is meaningless without the pipeline running. |

#### Tunables

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_IMAGE_GUARD` | unset | Top-level pipeline gate (`=1` enables). |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL` | unset | Enable Pass 3 Lanczos resize via `sharp`. |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | 31457280 (30 MB) | Pass 2 byte budget. 2 MB headroom from Anthropic's 32 MB ceiling. |
| `CACHE_FIX_IMAGE_COUNT_MAX` | 100 | Hard image-count cap. Set to 600 for legacy Claude 1/2.x/Instant if needed. |

## Image-retry circuit breaker (proxy mode, opt-in)

When CC encounters a permanent "image could not be processed" error, the harness currently treats it as transient and retries — with full conversation context and the same 34 MB image payload — up to ~19 times per [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815). One bad image can consume ~60% of a Max-plan user's 5-hour quota envelope before the storm naturally stops.

The breaker watches every messages-route response. When upstream returns a permanent image-processing error, it records the failure keyed by `(sessionId, requestSignature)` with the request's image SHA-256 hashes. When the next request on the same session carries an image whose hash matches a recorded failure within the 30-second sliding cool-off, the breaker short-circuits the retry locally — emitting a wire-format-correct synthesized response (SSE event sequence for `stream:true`, JSON envelope otherwise) that the harness consumes as a normal completed assistant turn. The synthesized text names the failure and asks the user to drop or replace the image. Bounds the retry storm from "many upstream calls" to one.

Opt-in via env var; default-off in v4.2.0 first ship pending sim-validation:

```bash
export CACHE_FIX_IMAGE_RETRY_BREAKER=on
```

| Mode | Behavior |
|------|----------|
| `on` | Detect + record + short-circuit retries |
| `off` (default) | Pass-through, no detection, no logging |
| `dry-run` | Detect + record + log JSONL events, but **do not** short-circuit (useful for production debugging) |

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_IMAGE_RETRY_BREAKER` | `off` | Mode gate — `on` / `off` / `dry-run` |
| `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` | 30000 | Sliding cool-off window per recorded failure |
| `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` | 4096 | LRU cap on the in-memory failure map |
| `CACHE_FIX_IMAGE_RETRY_LOG_PATH` | `~/.claude/image-retry-events.jsonl` | Structured event log path (5 MB single-tier rotation) |

**Observability surface:** the JSONL event log is the only signal. Short-circuited requests do not produce `usage.jsonl` rows — they bypass `usage-log` and `cache-telemetry` entirely (no upstream call → no SSE stream → no row). Each fire writes `{ event: "breaker_fire", mode, session_id, image_hashes, retry_count, remaining_ms, request_id, ... }`; each first-time failure writes `{ event: "failure_recorded", ... }`. The log carries hashes and metadata only — no image bytes, no request bodies, no auth headers.

**Detection conditions** (all four must hold):

1. Previous response on the same session matched the image-processing-error predicate (HTTP 400 + canonical `invalid_request_error` envelope + image-class message).
2. Current request carries an image content block whose SHA-256 matches a recorded failure's image hashes.
3. Current request arrives within the sliding cool-off window.
4. Current request is on the same session (resolved via `x-claude-code-session-id` / `x-session-id` / `x-anthropic-session-id`).

Sessionless requests bucket to `"unknown"` — they're not isolated from each other by request signature, an acknowledged limitation mitigated by the 30s sliding window.

## Session budget circuit breaker (proxy mode, opt-in)

An opt-in **hard per-session spend ceiling.** Once a CC session's cumulative token consumption (or its estimated cost, or its consumption *rate*) crosses a limit you set, further `/v1/messages` for that session are short-circuited locally — they never reach Anthropic, so they cannot consume credits, trigger auto-purchase, or (for direct API-key users) keep billing the card. Motivated by [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285): a Workflow fan-out of 700+ subagents inherited a premium-tier default with no per-agent model ceiling and no spend gate, burning ~$350 of credits and triggering ~$800 of auto-purchased overage before the user could intervene. All 700 subagents were children of a single session, so a per-session ceiling caps that runaway at the source.

**This is a circuit breaker, not a meter.** It stops the bleeding; it does not price each request to the cent. The tally is body-sourced (`msg.usage` token counts, which every Messages response carries) and auth-independent, so it works identically for subscription/OAuth and direct API-key clients.

Opt-in via the gate; **default-off**, and inert until you set at least one ceiling:

```bash
export CACHE_FIX_SESSION_BUDGET=on
export CACHE_FIX_SESSION_BUDGET_COST_USD=25      # e.g. stop this session at ~$25
```

| Mode | Behavior |
|------|----------|
| `on` | Tally per session; short-circuit the next request once confidently over a ceiling |
| `off` (default) | Pass-through, no tally, no logging |
| `dry-run` | Tally + log `would_block` events at the block point, but **forward every request** (measure before you enforce) |

### The three blocking levers (set at least one)

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_SESSION_BUDGET` | `off` | Gate — `on` / `off` / `dry-run` |
| `CACHE_FIX_SESSION_BUDGET_TOKENS` | unset | Hard-stop when cumulative `input + cache_creation` tokens for the session cross this integer. Plan-agnostic and **exact** — the backstop lever. |
| `CACHE_FIX_SESSION_BUDGET_COST_USD` | unset | Hard-stop when estimated cost (tokens × `tools/rates.json`) crosses this float. |
| `CACHE_FIX_SESSION_BUDGET_RATE_TPM` | unset | Hard-stop when the session's tokens/min over the sliding window cross this integer — the **early fan-out catch** (fires on the slope, before a big in-flight batch lands). |
| `CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS` | 60000 | Sliding window for the rate lever. |
| `CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES` | 4096 | LRU cap on the in-memory per-session tally map. |
| `CACHE_FIX_SESSION_BUDGET_EVENT_LOG` | `~/.claude/session-budget-events.jsonl` | Structured fire-event log path (5 MB single-tier rotation). |

### Which lever for which billing model

The breaker serves **both** billing models, but the danger — and so the primary lever — differs:

- **Subscription (OAuth, e.g. Max) — the #68285 case.** Tokens are quota-until-overage; the hazard is the account-global auto-purchase wall. Use `_TOKENS` (or `_RATE_TPM`) to cap the runaway *session* before it drives the account into auto-purchase. Cost is informational here.
- **Direct API key (pay-as-you-go) — the more severe case.** There is **no quota buffer**: every token is billed immediately at API list price, and the same fan-out has *no* spend circuit at all — it charges the card until the key's tier limit or the bank intervenes. Here `_COST_USD` is a **literal dollar ceiling**: `tools/rates.json` is Anthropic's API list pricing, so `tokens × rates.json` is real money out of pocket.

**Cost is an estimate — pair it with a token cap for a guaranteed dollar bound.** `rates.json` may lag a newly-released model. An unknown model contributes **0** to the cost tally (fail-open by design), so a stale rate silently *under*-counts and can let cost run past your intended dollar figure. The token and rate levers are always exact. If you want a hard dollar cap on an API key, **also set `_TOKENS`** so a stale/unknown rate can't let spend run unbounded — the token bound then backstops the estimate. (`tools/rates.json` is refreshed weekly from Anthropic's pricing page via a fetch-and-open-PR cron; a human reviews every pricing diff.)

Both request modes are covered: streaming responses accrue from the `message_start` event, non-streaming (`stream:false`) responses from the returned JSON body. The tally, the ceilings, and the block behaviour are identical either way — there is no mode that bypasses the budget.

### Fail-open, always

If accounting is uncertain — gate off, no ceiling set, `usage` missing or unparseable, no session key, the model unknown to `rates.json` (cost lever only), first request after a restart, or anything throws — the request **forwards.** A block requires the gate `on` **and** at least one lever numerically, confidently at/over its ceiling. A budget breaker that failed *closed* would wedge a whole session on a proxy bug, which is worse than the overage. One env flip (`CACHE_FIX_SESSION_BUDGET=off`) fully disables it.

### Observability surface (meter bypass)

A short-circuited request returns before any upstream call, so it produces **no `usage.jsonl` row** — correct (no cost was incurred), but note it is **not** in the meter. The only fire signal is the JSONL event log: each block writes `{ event: "session_budget_block", would_block, sid, lever, limit, observed, cumulative_tokens, cumulative_cost_usd, request_id, ts }`. `dry-run` writes the same records with `would_block: true` and forwards. The log carries the tally and the crossed limit only — **no request/response bodies, no model-input content, no auth headers.** `request_id` is nullable (a locally-blocked request has no upstream request-id; it's populated from the client request header if present, else `null` — never fabricated).

Each fire event also carries an **observational** `account_q5h_contribution` — an estimate of how much of the account's rolling-5h quota burn this session drove, attributed by the session's token share of the window (`{ window_ms, account_q5h_delta, session_token_share, attributed_q5h_delta }`). This is derived from Anthropic's **account-global** `anthropic-ratelimit-unified-5h-utilization` header, so it is **never** a blocking lever — it would trip an innocent session for another session's burn. It exists only to show operators *which* session is driving the account quota. API-key traffic lacks the header, so the field is simply omitted.

The attribution denominator is the proxy's **process-global** token pool, so the estimate is only sound when a proxy instance serves **one** Anthropic account (the normal single-operator deployment). If one instance fronts several accounts, independent accounts share the same denominator and a session's contribution can be over- or under-stated. Being observational, this never affects gating.

### Known limitations

- **Concurrency overshoot.** A large fan-out fires near-simultaneously, so a pure cumulative (`_TOKENS`/`_COST_USD`) ceiling trips only after the in-flight batch's tokens land — it overshoots by ~that batch. **`_RATE_TPM` mitigates this** by firing on the slope before the batch completes.
- **Output cost is post-hoc** — the tally gates the *next* request, not the current one.
- **Restart resets the tally** — it's in-memory; a mid-session proxy restart zeroes it. Acceptable for a safety backstop.
- **Per-session, not per-account** — it caps the offending *session*; it cannot lower Anthropic's account-global quota or stop auto-purchase directly. For a single-session runaway (#68285), capping that session is the right and sufficient action.

## `cc_version` normalize (proxy mode, opt-in)

Some Claude Code distribution channels — notably the VS Code extension under auto-update — emit a `cc_version` value in the system prompt's `x-anthropic-billing-header` that includes a per-build hash on top of `MAJOR.MINOR.PATCH` (e.g. `2.1.185.<buildhash>`). When the build hash mutates mid-session (the binary auto-updates between turns), that value lives inside the cacheable prefix, so every subsequent turn pays full `cache_creation` cost until the suffix stabilizes — Anthropic's prefix cache is byte-exact and the field is in scope.

The existing `fingerprint-strip` does NOT cover this case: it only rewrites suffixes whose value matches a CC-generated fingerprint of the user message text. A binary build-hash fails that verification and `fingerprint-strip` returns null without rewriting.

Opt-in via env var; default-off:

```bash
export CACHE_FIX_NORMALIZE_CC_VERSION=strip          # collapses X.Y.Z.<suffix> → X.Y.Z
# or
export CACHE_FIX_NORMALIZE_CC_VERSION=pin:2.1.185    # operator-supplied literal
```

| Mode | Behavior |
|------|----------|
| `off` (default) | No mutation |
| `strip` | Collapses `cc_version=X.Y.Z(.suffix)+` to `cc_version=X.Y.Z` |
| `pin:<value>` | Replaces `cc_version=<anything>` with the operator literal. Validation: `^[A-Za-z0-9.\-]+$`, max 64 chars (anything that would break the surrounding header grammar fails-open to `off` with a one-shot stderr warning). |

The extension runs at order 90, before `fingerprint-strip` at order 100. After normalization the `cc_version` has at most 3 segments, so `fingerprint-strip`'s `dotParts.length < 4` guard makes it a no-op — the two cooperate cleanly with no other ordering hazards. Field-boundary anchored regex `(^|[;\s:])cc_version=([^;\s]+)` so a `cc_version=` substring embedded in another field's value cannot be accidentally rewritten. Atomic fail-open: planned rewrites stage in a local array and apply only after the scan completes; any error during the scan leaves the body byte-intact.

## Session backup (proxy mode, opt-in)

A belt-and-suspenders backup against CC's transcript regressions per [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) (in-place transcript rewrite to a metadata-only stub) and [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486) (missing transcript on interactive sessions). When the proxy is in the path, every assistant message + observed tool result / user input is mirrored into a per-session JSONL file under user control, independent of CC's own transcript writer. CC's transcript remains canonical when it survives; the mirror is the recovery path when it doesn't.

Opt-in via env var; default-off in v4.2.0 and v4.3.0 pending a privacy-posture cycle:

```bash
export CACHE_FIX_SESSION_MIRROR=on
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_SESSION_MIRROR` | `off` | Master gate — `on` activates mirroring |
| `CACHE_FIX_SESSION_MIRROR_DIR` | `~/.claude/session-mirrors/` | Storage root |
| `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` | 100 MB | Per-session active-file rotation threshold |
| `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` | 30 | Retention sweep horizon (files past this are unlinked) |
| `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` | 1024 | LRU cap on the in-memory dedup state map |
| `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING` | `true` | Set `false` to exclude `thinking` content blocks from mirror records |

**Format-parity:** mirror records use CC 2.1.148's verified transcript envelope shape exactly — existing transcript readers (including `restore-claude-history-linux`) parse mirror files unchanged. The single distinguishing field is `source: "cache-fix-proxy-mirror"`. Three known limitations called out at write time:

1. `cwd` is always `null` (proxy does not know caller working directory).
2. `uuid` is dash-formatted (`8-4-4-4-12`) but the version/variant bits aren't RFC-valid. It's a deterministic hash of `(sessionId, timestamp, messageId)` so the chain is reconstructable; shape-validating parsers accept it.
3. Tool-result user records omit `toolUseResult` and `sourceToolAssistantUUID` (CC-internal enriched objects the proxy cannot reconstruct).

Storage layout: `<DIR>/<sessionFilename(sessionId)>/<timestamp>.jsonl`. Session ids that don't match `[A-Za-z0-9_-]{1,128}` bucket to `inv-<sha256[:16]>` (path-traversal safe). Sessionless requests share an `unknown/` directory.

**Operational events** (open / rotate / sweep / error) are logged to `~/.claude/session-mirrors/session-mirror-events.jsonl` (5 MB single-tier rotation). The mirror is read-only with respect to upstream traffic; no requests or responses are modified, and writer errors are isolated from the response stream by the pipeline's per-hook try/catch.

See [docs/disk-usage.md](docs/disk-usage.md) for the worst-case disk-footprint accounting.

## Cache breakpoints (proxy mode, opt-in)

Anthropic's prompt cache supports up to **four** `cache_control` markers per request. Claude Code currently uses three of the four; the third (between auto-injected `messages[0]` content — hooks, skills, project CLAUDE.md, deferred tools, MCP server descriptions — and the first real user content) is missing entirely. Without that marker, every change inside the auto-injected span busts the cache for everything that follows. wadabum projected ~6,500 token savings per fresh-session first turn from adding it ([anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098)).

The proxy can inject the missing marker on opt-in. Default off until validated against community data.

```sh
export CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1
```

The injection is conservative: it only fires when the request already carries 1–3 markers (typical CC shape) and refuses if the request is at the 4-marker limit (would 400) or has zero markers (Agent SDK / API-direct shape this extension isn't built for). Boundary detection covers all five observed auto-injected block kinds — hooks, skills, CLAUDE.md, deferred-tools, MCP — and lands the marker on the LAST auto-injected block.

A diagnostic-only env var dumps the structural shape of `messages[0]` for fixture sourcing without mutating the request:

```sh
export CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/messages-head.jsonl
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT` | unset | Enable breakpoint #3 injection (`=1` opt-in). |
| `CACHE_FIX_DUMP_MESSAGES_HEAD` | unset | Diagnostic JSONL dump of `messages[0].content` shape — read-only, no mutation. |

## Microcompact stability (proxy mode, opt-in)

After ~90 minutes idle, Claude Code's `time_based_microcompact` (and the cold-compact path triggered by `FDY()`) replaces old `tool_result` content with a sentinel string. The original content is gone for cache purposes; that part is unrecoverable from the proxy. But the sentinel itself can carry an embedded timestamp (`[Old tool result content cleared at 2026-04-30T13:42:11Z]`), which means a *second* microcompact pass against the same already-cleared position writes different bytes — busting the cache for everything after that position even though no new content was added.

This extension addresses the recoverable half: normalize the sentinel to a byte-stable canonical form so repeat microcompacts don't churn the cache. **Phase 1 only** — diagnostic + opt-in normalization. Phase 2 (snapshot-and-restore of original tool_result content) is deferred to v3.5.0+ pending Phase 1 production data.

```sh
# Step 1 (diagnostic): characterize what CC's sentinel actually looks like.
export CACHE_FIX_DUMP_MICROCOMPACT=/tmp/microcompact-dump.jsonl

# Step 2 (normalize): once the sentinel format is confirmed, opt-in.
export CACHE_FIX_NORMALIZE_MICROCOMPACT=1
```

Detection has two modes:
- **Mode A** — exact match against confirmed CC sentinel patterns (the bare form and the ISO-8601 timestamp variant). Mode A matches are eligible for normalization.
- **Mode B** — prefix-only match (text begins with `[Old tool result content cleared` but does not exactly match a Mode A pattern). Mode B is **diagnostic-only**: never normalized, dump records redact to a 64-char prefix only.

The Mode A/B separation protects against cases where the sentinel might be followed by user-derived content (e.g., a tool that echoed user input back into its result) — the redaction guarantee on Mode B keeps that content out of the diagnostic dump.

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_DUMP_MICROCOMPACT` | unset | Path for diagnostic JSONL dump of detected sentinels. Read-only — no mutation. |
| `CACHE_FIX_NORMALIZE_MICROCOMPACT` | unset | Enable normalization (`=1` opts in). Mutates Mode A matches to canonical form. |
| `CACHE_FIX_MICROCOMPACT_NORMALIZED` | `[Old tool result content cleared]` | Override the canonical replacement string. |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>` | unset | Add custom Mode A regex pattern(s). Numbered (1-indexed, sparse OK). |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>` | unset | Custom Mode B literal prefix(es). Pair with a custom Mode A pattern from a non-default sentinel family so prefix-only variants of that family also get redacted Mode B capture. |
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN` | `64` | Mode B prefix length in dump records. Set to `0` to suppress the prefix entirely. |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | unset | Add post-normalization text alongside (not replacing) raw `sentinel_text` in dump records. |

## Thinking summaries (proxy mode, opt-in, Opus 4.7+)

On Opus 4.7, Anthropic flipped the API default for `thinking.display` from `"summarized"` to `"omitted"`. In parallel, Claude Code's CLI has a `!getIsNonInteractiveSession()` gate that propagates `display: "summarized"` only when the session is interactive. The combination means every CC subprocess spawned with `--input-format stream-json` — the VS Code chat panel, the Antigravity panel, the SDK, `claude --print` — sends a thinking-enabled request (`thinking.type` is either `"enabled"` or `"adaptive"` depending on CC version) without `display`, and the API responds with thinking blocks whose `thinking` field is empty (plus a multi-KB signature). The UI shows a static "Thinking" stub while the agent runs but never any reasoning content.

Upstream root cause and patch proposed in [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) (credit: [@ojura](https://github.com/ojura)). This extension is the proxy-side complement: when a request to an Opus 4.7 endpoint has thinking enabled but `display` unset, inject the configured mode at the API boundary. Works on any CC version routed through cache-fix-proxy, no waiting on Anthropic to ship the CLI fix.

```sh
# Restore summaries (the built-in default — non-interactive surfaces get reasoning content)
export CACHE_FIX_THINKING_DISPLAY=summarized

# Force-suppress override (agent runtimes that don't want thinking blocks at all)
export CACHE_FIX_THINKING_DISPLAY=omitted

# Explicit no-op (extension passes through unchanged)
export CACHE_FIX_THINKING_DISPLAY=disabled
```

The extension is **default-on** as of v3.6.1. The cache-prefix test measured 0% absolute drop in steady-state `cache_read` ratio when injection is active on Opus 4.7 (5 sequential `claude -p` calls per window, baseline vs injected — both windows held 1.000 cache_read ratio from call 2 onward). Adding `thinking.display` to the request body changes the bytes Anthropic hashes, but Anthropic's cache layer accepts and indexes the injected-prefix the same way it does any other prefix. Users who want the older "no injection" behavior (e.g. to avoid any request-body mutation at all) explicitly set `CACHE_FIX_THINKING_DISPLAY=disabled`.

Scoping rules baked into the extension:

- **Model-gated.** Only fires on requests whose `model` matches `/^claude-opus-4-7/` — covers `claude-opus-4-7` and `claude-opus-4-7-1m`. Sonnet 4.7 needs separate verification (the API default-flip may differ); future versions (4.8+) require an explicit cache-fix bump rather than auto-applying unverified behavior.
- **User opt-out preserved.** If the request already has `thinking.display` set (either `"summarized"` or `"omitted"`), the extension never overwrites. Explicit user choice always wins.
- **Thinking-active types only.** The extension fires on `thinking.type` ∈ `{ "enabled", "adaptive" }` — the two active modes that produce thinking blocks on Opus 4.7. Other values (`"disabled"`, future modes) are skipped. Conservative: if Anthropic ships a new thinking type with different display semantics, we'd rather miss the fix than auto-apply incorrect behavior.

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_THINKING_DISPLAY` | `summarized` (built-in) | One of `summarized` / `omitted` / `disabled`. `summarized` restores thinking summaries (default). `omitted` force-suppresses thinking blocks. `disabled` opts the extension out entirely. |

## Session-health early-warning (proxy mode, thinking-desync risk)

Long-running Opus 4.7 `[1m]` sessions accumulate interleaved thinking blocks and grow their live context until Claude Code's own history reconstruction desyncs a thinking-block signature, producing a permanent `400 … thinking blocks … cannot be modified` on every subsequent turn (upstream root cause: [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)). The session dies abruptly with no prior signal.

The `session-health` extension watches the conditions that correlate with the trip and warns **before** a session reaches the danger zone, so the operator can retire it deliberately (write a session-state handoff, `/clear`) instead of being surprised by a dead session. It is **read-only** — it never mutates the request/response body and never attempts to repair the desync (that is CC-side, #63147). It records numeric telemetry into the per-session file (`~/.claude/quota-status/sessions/<id>.json`) on each request and, when a session first crosses into `high` risk, emits a one-time stderr line. Counts only — no thinking text or signatures are ever logged.

Fields added to the per-session JSON:

- `context_tokens` — latest request's live context (`input + cache_read + cache_creation`)
- `thinking_block_count` — `thinking`/`redacted_thinking` blocks in the latest request
- `thinking_block_max` — session high-water mark (carried across proxy restarts)
- `first_seen`, `request_count` — session age + request tally
- `thinking_desync_risk` — `ok` / `warn` / `high` (omitted when the signal is disabled)

Token thresholds are anchored to the observed ~382K-token trip with margin; the warning is conservative by design — a premature "retire soon" is far cheaper than a dead session. Block-count is recorded but does not yet gate the warning (it activates in a calibrated fast-follow once the failure distribution is known).

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_THINKING_RISK_WARN_TOKENS` | `250000` | Context-token level at which `thinking_desync_risk` becomes `warn`. |
| `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` | `340000` | Context-token level at which risk becomes `high` and the one-time stderr warn fires. |
| `CACHE_FIX_THINKING_RISK` | unset (on) | Set to `off` to suppress the warning signal (stderr line + `thinking_desync_risk` field). Raw count telemetry keeps recording. |

## Thinking-block sanitize (proxy mode, on by default, thinking-desync mitigation)

The *mitigate* half of the thinking-desync response (the *warn-before* half is session-health above). On history-replay paths (resume / `--continue` / auto-compaction / parallel-tool-cancel), Claude Code re-sends prior assistant turns' extended thinking in the **omitted** shape `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`. The API rejects modified thinking in the **latest** assistant message with a permanent `400 … thinking … blocks cannot be modified`, which wedges the session on every subsequent turn (upstream root cause: [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)).

The `thinking-block-sanitize` extension drops those omitted blocks — which the API treats as optional history — from the request before it is forwarded. Empirically-resolved turn-selection rule: drop omitted thinking from **all prior assistant turns and the latest assistant turn, unless the latest turn is an active tool-continuation** (its last block is a `tool_use` answered by a following `tool_result`). In that one case the API requires the signed thinking intact and the proxy cannot restore the emptied text, so it leaves the turn untouched. **No env var both preserves thinking and avoids the wedge for that case:** `CLAUDE_CODE_DISABLE_THINKING=1` / `MAX_THINKING_TOKENS=0` stop the wedge only by disabling thinking entirely (lossy — no reasoning), and `DISABLE_INTERLEAVED_THINKING=1` does *not* stop the `400` — so there the answer is don't-resume + heal/retire the session. That is exactly why the proxy mitigation matters: **it is the only path that preserves reasoning while avoiding the wedge** for the history-replay paths it covers. Non-empty thinking is never touched; `redacted_thinking` is out of scope for v1.

**On by default as of v4.0.0.** v1 was opt-in via `CACHE_FIX_THINKING_SANITIZE=on` in v3.8.0–v3.9.x. After seven days of prod dogfood across 37 sessions (zero `cannot be modified` 400s, cache hit-rate aggregate 94.66% vs. 92.44% baseline, sanitize firing on ~35% of sessions with ~800 blocks dropped per day, max 938K context healthy) the v1 mitigation is the new default. The transform is deterministic and cache-prefix-stable, and emits a per-request `thinking_blocks_dropped` count into the per-session JSON (counts only — never content) that complements the session-health signal. v2 stays opt-in pending its own prod-dogfood window after [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) closes the silent-load failure mode that prevented v2 from running in prior testing.

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_THINKING_SANITIZE` | unset (= v1) | v4.0.0+: v1 omitted-block drop is the default. Set to `off` to explicitly disable (returns to v3.x default-off behavior). Set to `v2` to additionally enable the v2 tools-hash-mismatch drop. Set to `on` for v1 (back-compat — same as unset). |

## System prompt rewrite (preload mode, optional)

The interceptor can rewrite Claude Code's `# Output efficiency` system-prompt section. Disabled by default. Enable with `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`. See [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md) for the three known prompt variants and usage instructions.

## Monitoring & diagnostics

The preload interceptor includes monitoring for microcompact degradation, false rate limiters, GrowthBook flag state, usage telemetry, and cost reporting. Quota tracking works in both proxy and preload modes via `~/.claude/quota-status/` (proxy: per-session split) or `~/.claude/quota-status.json` (preload: single-session legacy path).

See [docs/monitoring.md](docs/monitoring.md) for full details, debug mode, prefix diffing, environment variables, and the bundled quota analysis tool.

### `usage-log` extension and the `MeterRowSchema v:1` wire format

The `usage-log` extension (opt-in via `proxy/extensions.json`) appends one JSON line per API response to `~/.claude/usage.jsonl`. The row shape is `MeterRowSchema v:1` — the cross-repo contract validated by [`claude-code-meter`](https://github.com/cnighswonger/claude-code-meter)'s strict schema. Every field below is captured per call:

| Field | Type | Source |
|---|---|---|
| `v` | literal `1` | constant |
| `ts` | ISO-8601 datetime | server time at row emission |
| `sid` | 8-char lowercase hex | proxy session id, sticky for the proxy's lifetime |
| `model` | string ≤64 | `message_start.message.model` from the response stream |
| `requested_model` | string ≤64 (optional) | request body `model` field |
| `model_mismatch` | bool (optional) | true when `requested_model && model && requested_model !== model` |
| `speed` | `"standard"` / `"fast"` / `""` | response `usage.speed` |
| `service_tier` | string ≤32 | response `usage.service_tier` |
| `input_tokens` | int ≥0 | response usage |
| `output_tokens` | int ≥0 | response usage |
| `cache_creation_input_tokens` | int ≥0 | response usage |
| `cache_read_input_tokens` | int ≥0 | response usage |
| `ephemeral_1h_input_tokens` | int ≥0 | response usage |
| `ephemeral_5m_input_tokens` | int ≥0 | response usage |
| `web_search_requests` | int ≥0 | response usage |
| `q5h` / `q7d` | float 0–2 | `anthropic-ratelimit-unified-{5h,7d}-utilization` headers |
| `q5h_reset` / `q7d_reset` | int (unix sec) | corresponding reset headers |
| `qstatus`, `qoverage`, `qclaim` | lowercase enums | unified status / overage / claim headers |
| `qfallback_pct` | float 0–1 | unified fallback percentage |
| `qoverage_util` | float ≥0 (optional) | overage utilization header |
| `qrepresentative_claim` | string ≤16 (optional) | representative-claim header |
| `org_id` | 16-char hex (optional) | `sha256(anthropic-organization-id).slice(0, 16)` — never raw |
| `overage_disabled_reason` | string ≤64 (optional) | overage-disabled-reason header |
| `cache_hit_rate` | float 0–1 | `cache_read_input_tokens / (input + cache_creation + cache_read)` |
| `q5h_delta`, `q7d_delta` | float | per-call delta from the previous row's q5h/q7d; 0 on first call after restart |
| `request_id` | string ≤64 (optional) | upstream `request-id` response header. **Default-on as of v4.2.0.** `CACHE_FIX_USAGE_LOG_REQID=off` is a kill-switch (omits the field) for operators stuck on a pre-meter-v0.7.0 install. **Cross-repo gate:** `claude-code-meter >= v0.7.0` accepts the optional field; older meter installs reject unknown keys via the strict-object schema. |

**Why `request_id` matters operationally.** The `sid` field is generated once at proxy boot and shared across every CC session that proxy serves. On hosts running multiple concurrent CC sessions through one proxy (common in agent fleets), every session's rows collapse into the same `sid` — there's no way to ask "which session burned 80% of today's Opus tokens?" from `usage.jsonl` alone. CC's per-session JSONL transcripts at `~/.claude/projects/<project>/<session-uuid>.jsonl` already carry `requestId` for every API call. Capturing the same value in the meter row makes the post-hoc join trivial:

```bash
# Find which CC session each usage.jsonl row belongs to:
for row in $(jq -c . < ~/.claude/usage.jsonl); do
  req=$(jq -r '.request_id // empty' <<< "$row")
  [ -z "$req" ] && continue
  grep -l "\"requestId\":\"$req\"" ~/.claude/projects/*/*.jsonl
done
```

The filename of the matching transcript is the CC session UUID, recovering per-session attribution for every meter row that was emitted with the field on.

### `upstream-error-log` extension (non-200 response capture)

The `usage-log` extension above only records successful (200) responses. Non-200s (429 capacity throttling, 5xx errors) leave only an unstructured line in the debug log, so server-side throttling has been effectively invisible to any analysis built on `usage.jsonl`.

`upstream-error-log` (opt-in, new in v4.2.0) emits a structured record for every `status >= 400` to `~/.claude/usage-log/upstream-errors.jsonl`. Two distinct 429 classes look identical to a user — **account/usage-limit** carries `anthropic-ratelimit-unified-*` headers + `retry-after`; **infrastructure/capacity** is Cloudflare-fronted, carries `x-should-retry: true` only, NO ratelimit headers (the "Server is temporarily limiting requests, not your usage limit" case). The discriminator is `has_ratelimit_headers` (bool): with headers → usage limit; without → capacity event.

Opt-in via env var; default-off:

```bash
export CACHE_FIX_UPSTREAM_ERROR_LOG=on
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_UPSTREAM_ERROR_LOG` | `off` | Master gate — `on` activates capture |
| `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH` | `~/.claude/usage-log/upstream-errors.jsonl` | Log path override |

Record fields per row: `schema_version`, `ts`, `type`, `session_id`, `requested_model`, `request_path`, `response_status`, `upstream_message`, `has_ratelimit_headers`, `ratelimit_status`, `ratelimit_overage_status`, `x_should_retry` (normalized to bool from string), `retry_after`, `upstream_request_id`, `upstream_connection_id`.

This is a SUPERSET of the existing `rate-limit-log` extension — `rate-limit-log` only triggers on the canonical `rate_limit_error` body envelope and misses capacity-class 429s whose body shape differs; `upstream-error-log` triggers on every `status >= 400` regardless of body shape. Independent JSONL streams; analysts join on `session_id + ts`. Both can be enabled simultaneously without interference.

### Proxy-owned OAuth refresh (opt-in)

Default-off subsystem that makes the cache-fix proxy the single, proactive, lock-cooperative refresher of the OAuth credential at `~/.claude/.credentials.json`. Closes the refresh-token rotation race that can revoke the whole token family and 401 every concurrent Claude Code client running as the same OS user — a failure that no client-side restart recovers (only an interactive `/login` does).

The race: Anthropic's refresh tokens rotate on every use. Each successful refresh returns a new access token AND a new refresh token, invalidating the prior one; reusing a consumed refresh token is treated as theft and revokes the whole family. When N clients share one `~/.claude/.credentials.json` and the access token expires (~8h cadence), two clients can race to POST the same refresh token — the server sees the reuse and revokes both. After that, the file's refresh token is dead; only interactive `/login` recovers.

Recent Claude Code binaries (2.1.148+) ship a cross-process `~/.claude/.oauth_refresh.lock` via `proper-lockfile`, but with a 10-second stale-break window. A refresh POST that runs longer than 10s lets a waking client proceed lock-less and POST the same token — the race fires anyway.

This extension makes the proxy the proactive single-refresher: it keeps the shared token fresh AND holds the client's own `.oauth_refresh.lock` during its refresh, so a waking client finds a fresh token and short-circuits without POSTing. Exactly one party reaches the token endpoint → no double-spend → no family revocation.

Opt-in via env var; default-off:

```bash
export CACHE_FIX_OAUTH_REFRESH=on
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `CACHE_FIX_OAUTH_REFRESH` | `off` | Master gate — `on` activates the refresher |
| `CACHE_FIX_OAUTH_CRED_PATH` | `~/.claude/.credentials.json` | Credential file path |
| `CACHE_FIX_OAUTH_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token endpoint (test override) |
| `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS` | 7200000 (2h) | Refresh when expiry is within this window |
| `CACHE_FIX_OAUTH_TICK_MS` | 300000 (5min) | Check interval |
| `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` | 8000 | Hard refresh-POST deadline; **must stay below the client's 10000 ms stale-break** |

The `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` ceiling is load-bearing. The refresh POST has an `AbortController` timer covering both headers AND the response body read. On timeout the outcome is UNKNOWN — the server may or may not have rotated the token — so the proxy does NOT write, does NOT retry, emits a distinct `oauth_refresh_timeout` event, and backs off for at least one full stale window before any next attempt. The ordering guarantees that if the proxy ever loses the timing race, it loses by *not POSTing again*, never by POSTing concurrently.

Adds `proper-lockfile` as a runtime dependency (the only other runtime dep is `hpagent`).

Operational events go to `~/.claude/cache-fix-oauth-events.jsonl`. Seven event classes: `oauth_refreshed` (routine), `oauth_family_revoked` (loud — requires human `/login`; also writes a stderr banner), `oauth_refresh_timeout` (UNKNOWN outcome — no write, no retry), `oauth_refresh_error` (clean failure — leave file, try next tick), `oauth_refresh_skipped` (already-rotated or no-longer-due), `oauth_lock_contended` (another writer holds the lock), `oauth_cred_*` (validation failures: symlink rejected, mode warning, unreadable). Records carry only `{event, outcome, status_code, expires_at, err_class, elapsed_ms}` — never token strings, never raw POST bodies, never raw response bodies.

Validation gates on every credential read: not a symlink, mode `0600`, owner-matches-uid, JSON-shape valid. Atomic persist: temp-write (mode 0600) + fsync FD + rename + fsync parent dir, preserving every other credential field across the rotation.

Backout: gate off + proxy restart → clients self-manage exactly as today (they always read the file, so the fallback is automatic).

## Limitations

### When NOT to run this

Cases where the honest answer is "this proxy isn't the right tool for your setup." These are the questions to answer before you decide to adopt, not after.

- **You already operate a caching gateway or proxy in the request path.** Composition here is *chaining*, not layering — you'd point your existing gateway's upstream at `cache-fix-proxy` (or vice versa via `CACHE_FIX_PROXY_UPSTREAM`), which adds a hop, a second failure mode, and a decision about which layer terminates TLS and which owns the cache-control markers. For many setups this is a net negative compared to a single well-instrumented gateway you already run. If you're evaluating whether to add this on top of an existing layer, weigh the marginal signal it gives you against the operational cost of one more process in the path.
- **You need crash-to-supervisor semantics.** In forward-proxy mode (`--remote-control` / `CACHE_FIX_FORWARD_PROXY=on`), the proxy installs process-wide `uncaughtException` / `unhandledRejection` handlers that log and keep serving instead of crashing. On a shared / multi-tenant proxy this is a feature (one bad request doesn't take the whole process down); on a setup where you rely on a supervisor to restart on fatal errors, it means a fatal bug is swallowed rather than surfaced to the supervisor. See [Crash semantics on a shared proxy](#forward-proxy-mode-keeps-remote-control-working) for the full discussion — the constraint predates this section and applies regardless of when you find it.
- **Your sessions are short and cold.** The proxy's value concentrates on resumed and long-running sessions where a stable prefix would otherwise be re-billed. On a pattern of many short fresh sessions, there is little cached prefix to protect, and the proxy carries overhead against a small ceiling of improvement. See [`docs/benchmarking.md`](docs/benchmarking.md) for the full "what this doesn't improve" discussion; this is the same argument stated at the adoption decision instead of the measurement one.

### After adoption

Constraints that assume you've already decided to run this:

- **Proxy requires a running process** — The proxy must be started before Claude Code. If it's not running and `ANTHROPIC_BASE_URL` points to it, CC will fail to connect. We recommend running it as a systemd service or with a health-checking wrapper script.
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is server-side and cannot be fixed client-side. The proxy/interceptor prevents the cache instability that can push you into overage in the first place.
- **Microcompact is not preventable** — The monitoring features detect context degradation but cannot prevent it. Microcompact and budget enforcement are server-controlled via GrowthBook flags with no client-side disable option.
- **System prompt rewrite is experimental** — Preload-only, opt-in. Not proven to be the cause of behavior differences discussed in community reports. Use at your own risk.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Related research

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 38,996-request proxy-based analysis: 7 bugs (microcompact, budget caps, false rate limiter, JSONL duplication, extended thinking), GrowthBook feature flag causal testing, Opus 4.7 burn rate advisory. The monitoring features in v1.1.0 are informed by this research.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Diagnostic HTTPS proxy with real-time dashboard, system prompt section diffing, per-tool stripping thresholds. Works with any Claude client that supports `ANTHROPIC_BASE_URL`.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — Self-hosted forensic dashboard with SSE live monitoring, multi-host aggregation, cache-health scoring. Complementary to our proxy's vantage point. See [docs/dashboard-integration.md](docs/dashboard-integration.md) for the interop setup.

## Used in production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP development environment. First production team to merge the interceptor to trunk for team-wide deployment (2026-04-10). Identified two distinct cache regression patterns through real-world testing — tool ordering jitter and the fresh-session sort gap — and contributed debug traces that drove the v1.5.1 and v1.6.2 fixes. Contributed the embeddable proxy factory (v3.6.0) that lets the proxy run in-process inside Bun-compiled and DAP-style agent binaries without forking a Node child.
- **[VM Farms](https://vmfarms.com)** ([@vmfarms](https://github.com/vmfarms)) — Agent development environment running concurrent multi-runner workloads with `--resume --fork-session`. Surfaced three cache-fix proxy-mode bugs: the resume-marker regex no-op (#96), TTL tier detection gap vs preload mode (#97), and image-strip stderr leak past `CACHE_FIX_DEBUG` (#98) — all addressed in the v3.4.0 release.

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, tighter block matchers, and the optional output-efficiency rewrite hook
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP production environment validation, 1h cache TTL confirmation, tool ordering jitter discovery via debug trace (fixed in v1.5.1), fresh-session sort bug discovery via SKILLS SORT diagnostic (fixed in v1.6.2). First production team to roll the interceptor to trunk. Designed and contributed the embeddable proxy factory (`startProxy()` / `createProxyServer()`) shipped in v3.6.0 (PR #123).
- **[@jmarianski](https://github.com/jmarianski)** — Root cause analysis via MITM proxy capture and Ghidra reverse engineering, multi-mode cache test script
- **[@cnighswonger](https://github.com/cnighswonger)** — Fingerprint stabilization, tool ordering fix, image stripping, monitoring features, overage TTL downgrade discovery, proxy architecture, package maintainer
- **[@ArkNill](https://github.com/ArkNill)** — Microcompact mechanism analysis, GrowthBook flag documentation, false rate limiter identification, fingerprint verification fix for CC v2.1.108+ (PR #21), Korean README (PR #22), [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) research
- **[@Renvect](https://github.com/Renvect)** — Image duplication discovery, cross-project directory contamination analysis
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) forensic methodology: cost-factor overhead ratio metric, `anthropic-*` header capture pattern, proxy NDJSON schema that informed our dashboard interop layer
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` wrapper, first Windows platform validation (7.5h/536-call Opus 4.6 session, 98.4% cache hit rate)
- **[@arjansingh](https://github.com/arjansingh)** — nvm-compatible wrapper script with dynamic `npm root -g` path resolution (PR #15)
- **[@beekamai](https://github.com/beekamai)** — Windows URL-encoding fix for `claude-fixed.bat` when npm root contains spaces (PR #17)
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code extension investigation: discovered `claudeCode.claudeProcessWrapper` as the working integration path, wrote the C wrapper for Windows (#16)
- **[@X-15](https://github.com/X-15)** — VS Code extension validation, per-fix health status analysis confirming safety check behavior on v2.1.105 (#16); surfaced the per-build `cc_version` cache-bust pattern from VS Code extension auto-update (#238), which became the `cc-version-normalize` extension in v4.2.0
- **[@deafsquad](https://github.com/deafsquad)** — Universal smoosh_split un-smoosh fix (PR #26), source-level function attribution of resume scatter bug (anthropics/claude-code#43657), OTEL telemetry discovery, proposed and built proxy architecture for v3.0.0
- **[@vmfarms](https://github.com/vmfarms)** — Concurrent multi-runner production validation, surfaced proxy-mode resume-marker regex no-op (#96), TTL tier detection gap (#97), and image-strip stderr leak (#98)
- **[@ojura](https://github.com/ojura)** — Opus 4.7 thinking-summaries root-cause analysis: filed [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) with the CLI-binary decode (`!getIsNonInteractiveSession()` gate at offset 230510599 in v2.1.142) and the two-stacked-special-cases framing, which made the `thinking-display` extension (v3.6.1) a clean proxy-side complement to the proposed upstream fix
- **[@yurukusa](https://github.com/yurukusa)** — [Cluster taxonomy](https://yurukusa.github.io/cc-safe-setup/cluster-tracker.html#cluster-extended-thinking-wedge) for [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147) thinking-desync wedge; the 13E (ToolSearch) sub-pattern synthesis that made the `thinking-block-sanitize` v2 directive predicate tractable (cache-fix #171, shipped behind `=v2` opt-in in v4.0.0)
- **[@schuay](https://github.com/schuay)** — `quota-statusline.sh` enhancements: 10-cell quota bar with elapsed-time tick and exhaust-vs-reset projection replacing the prior `%/min` burn-rate display (PR #140, v3.6.2), and d/h vs h/m time-format autoselect plus named time-unit and burn-warmup constants (PR #143, v3.7.0)
- **[@codeslake](https://github.com/codeslake)** — Opt-in forward-proxy mode (HTTP `CONNECT` + selective MITM of the upstream host) that keeps Remote Control / mobile session visibility working through the proxy, resolving the `ANTHROPIC_BASE_URL`-disables-RC breakage on CC >= 2.1.196 (PR #251, implements #248); and honoring `CLAUDE_CONFIG_DIR` for all on-disk proxy state so multiple config roots don't clobber each other's credentials/state (PR #246); RFC 7230 absolute-form request-target handling in forward-proxy mode (PR #261); and the `ca-trust.d` rendezvous that lets the launcher coexist with another MITM on the same host instead of clobbering its `NODE_EXTRA_CA_CERTS` (PR #283), with the follow-up that replaced a regex model of node's CA loader with an actual probe — spawn a child, stand up a TLS server, connect to it — after the regex proved wrong in both directions on real bundles (PR #296)
- **[@Gunther-Schulz](https://github.com/Gunther-Schulz)** — The attribution series: `capture` (PR #275), the pre-pipeline record of what Claude Code actually sent, which is what makes "is this bust ours or upstream's" answerable at all; `prefix-diff` (PR #280) reworked from head-only preview into full cache-key attribution — marker/tail windows, every cache-keyed param and beta header, per-tenant baselines; `insertion-normalization` (PR #272) pinning volatile reminder blocks so mid-history rewrites land behind the cache boundary; `deferred-tool-rewrite` (PR #273) holding `tools[]` byte-stable and announcing mid-session tool additions through Anthropic's `mid-conversation-tool-changes` beta rather than mutating the array; and `output-guard` (PR #278), the last-line response invariant that restores rather than corrupts. Plus the forwarding fix for extension-mutated headers (PR #274), continuation protection by shape rather than tail distance (PR #279), a growing conversation no longer read as an upstream change (PR #282), a supervised stop exiting 0 (PR #277), and the transcript-shape fixture rebuild (PR #307)
- **[@anupamme](https://github.com/anupamme)** — Bounded `strlcpy`/`snprintf` in `claude-vscode-wrapper.c` (PR #294), a memory-safety hardening in the C wrapper we had not caught ourselves
- **[@thepiper18](https://github.com/thepiper18)** — Original Brazilian Portuguese translation (`docs/guia-pt-br.md`, #109 era); regenerated against v4.x reality in PR #315, which updates their work rather than replacing it

If you contributed to the community effort on these issues and aren't listed here, please open an issue or PR — we want to credit everyone properly.

## Support

If this tool saved you money, consider buying me a coffee:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

[MIT](LICENSE)
