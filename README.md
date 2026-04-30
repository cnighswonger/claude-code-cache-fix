# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

English | [中文](./README.zh.md) | [한국어](./README.ko.md) | [Português](./docs/guia-pt-br.md)

Cache optimization proxy for [Claude Code](https://github.com/anthropics/claude-code). Fixes prompt cache bugs that cause excessive quota burn, stabilizes the request prefix, and monitors for silent regressions. Works with all CC versions including the v2.1.113+ Bun binary.

> **v3.0.3** — Local HTTP proxy with 7 hot-reloadable extensions. A/B tested on v2.1.117: **95.5% cache hit rate through proxy vs 82.3% direct** on first warm turn. [Full release notes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0)

> **Opus 4.7 advisory:** Metered data shows 4.7 burns Q5h quota at **~2.4x the rate of 4.6** for equivalent visible token counts ([independently confirmed by @ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). Two factors: a new tokenizer (up to 35% more tokens, [documented](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) and adaptive thinking overhead (~105%, not documented in usage response). The Q5h impact compounds into **Q7d** — the weekly quota ceiling that most heavy users will hit first. Workaround: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` reduces burn by ~3.3x but may reduce quality on complex tasks. See [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (initial observation) and [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (controlled A/B data + Q7d analysis).

## Quick Start: Proxy (recommended)

The proxy works with any CC version — Node.js or Bun binary. It sits between Claude Code and the Anthropic API, applying cache fixes as hot-reloadable extensions.

```bash
# Install
npm install -g claude-code-cache-fix

# Start the proxy (runs on localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Launch Claude Code through it
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

That's it. The proxy applies all 7 cache-fix extensions automatically. No wrapper scripts, no `NODE_OPTIONS`, no preload.

### What the proxy does

On every `/v1/messages` request, 7 extensions run in order:

| Extension | What it fixes |
|-----------|--------------|
| `fingerprint-strip` | Removes unstable cc_version fingerprint from system prompt |
| `sort-stabilization` | Deterministic ordering of tool and MCP definitions |
| `ttl-management` | Detects server TTL tier, injects correct cache_control markers |
| `identity-normalization` | Normalizes message identity fields for prefix stability |
| `fresh-session-sort` | Fixes non-deterministic ordering on first turn |
| `cache-control-normalize` | Normalizes cache_control markers across messages |
| `cache-telemetry` | Extracts cache stats from response headers → `~/.claude/quota-status.json` |

Extensions are hot-reloadable — add, remove, or modify `.mjs` files in `proxy/extensions/` and changes apply to the next request without restarting. Configuration in `proxy/extensions.json`.

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

Image tags: `latest`, `3`, `3.2`, `3.2.1` (semver-ladder, so `3` always points to the newest 3.x). `latest` always tracks the newest tagged release.

**Linux note:** the chained-upstream `host.docker.internal` example below is automatic on Docker Desktop (macOS / Windows). On plain Linux Docker Engine you usually need `--add-host=host.docker.internal:host-gateway` so the name resolves to the host bridge. Without it, the container's name lookup fails and the proxy can't reach the upstream service running on the host. Example chaining cache-fix proxy through `llm-relay` running on the host:

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

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
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | Request timeout in milliseconds |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | Directory for extension `.mjs` files |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | Extension configuration file |
| `CACHE_FIX_DEBUG` | `0` | Enable debug logging |

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

**Supply chain:** Proxy mode: 7 small extension modules in `proxy/extensions/` (each under 200 lines). Preload mode: single unminified file (`preload.mjs`, ~1,700 lines). One dev dependency (`zod` for schema validation in tests only). Review before installing. npm provenance links each published version to its source commit.

**Independent audit:** [Assessed as "LEGITIMATE TOOL"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) by @TheAuditorTool (2026-04-14).

## The problem

When you use `--resume` or `/resume` in Claude Code, the prompt cache breaks silently. Instead of reading cached tokens (cheap), the API rebuilds them from scratch on every turn (expensive). A session that should cost ~$0.50/hour can burn through $5–10/hour with no visible indication anything is wrong.

Three bugs cause this:

1. **Partial block scatter** — Attachment blocks (skills listing, MCP servers, deferred tools, hooks) are supposed to live in `messages[0]`. On resume, some or all drift to later messages, changing the cache prefix.

2. **Fingerprint instability** — The `cc_version` fingerprint (e.g. `2.1.92.a3f`) is computed from `messages[0]` content including meta/attachment blocks. When those blocks shift, the fingerprint changes, the system prompt changes, and cache busts.

3. **Non-deterministic tool ordering** — Tool definitions can arrive in different orders between turns, changing request bytes and invalidating the cache key.

Additionally, images read via the Read tool persist as base64 in conversation history and are sent on every subsequent API call, compounding token costs silently.

## How it works

**Proxy mode** (v3.0.0+): An HTTP server on `localhost:9801` intercepts `POST /v1/messages` requests. Seven extension modules process each request through a pipeline — normalizing block order, stripping fingerprints, stabilizing tool sort, managing TTL markers. Extensions are hot-reloadable `.mjs` files configured in `proxy/extensions.json`. All other traffic passes through untouched.

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

Both proxy and preload modes write quota state to `~/.claude/quota-status.json` on every API call. The included `tools/quota-statusline.sh` script displays a live status line showing:

- **Q5h %** with burn rate (%/min)
- **Q7d %** with burn rate (%/hr)
- **TTL tier** — `TTL:1h` when healthy, **`TTL:5m` in red when the server has downgraded you** (typically at Q5h ≥ 100%)
- **PEAK** in yellow during weekday peak hours (13:00–19:00 UTC)
- **Cache hit rate %**
- **OVERAGE** flag when active

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
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN` | `64` | Mode B prefix length in dump records. Set to `0` to suppress the prefix entirely. |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | unset | Add post-normalization text alongside (not replacing) raw `sentinel_text` in dump records. |

## System prompt rewrite (preload mode, optional)

The interceptor can rewrite Claude Code's `# Output efficiency` system-prompt section. Disabled by default. Enable with `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`. See [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md) for the three known prompt variants and usage instructions.

## Monitoring & diagnostics

The preload interceptor includes monitoring for microcompact degradation, false rate limiters, GrowthBook flag state, usage telemetry, and cost reporting. Quota tracking works in both proxy and preload modes via `~/.claude/quota-status.json`.

See [docs/monitoring.md](docs/monitoring.md) for full details, debug mode, prefix diffing, environment variables, and the bundled quota analysis tool.

## Limitations

- **Proxy requires a running process** — The proxy must be started before Claude Code. If it's not running and `ANTHROPIC_BASE_URL` points to it, CC will fail to connect. We recommend running it as a systemd service or with a health-checking wrapper script.
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is server-side and cannot be fixed client-side. The proxy/interceptor prevents the cache instability that can push you into overage in the first place.
- **Microcompact is not preventable** — The monitoring features detect context degradation but cannot prevent it. Microcompact and budget enforcement are server-controlled via GrowthBook flags with no client-side disable option.
- **System prompt rewrite is experimental** — Preload-only, opt-in. Not proven to be the cause of behavior differences discussed in community reports. Use at your own risk.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Tracked issues

We monitor 30+ upstream Claude Code issues related to cache, quota, and context bugs. See [TRACKED_ISSUES.md](TRACKED_ISSUES.md) for the full list with our involvement, community research, and key contributors.

## Related research

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 38,996-request proxy-based analysis: 7 bugs (microcompact, budget caps, false rate limiter, JSONL duplication, extended thinking), GrowthBook feature flag causal testing, Opus 4.7 burn rate advisory. The monitoring features in v1.1.0 are informed by this research.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Diagnostic HTTPS proxy with real-time dashboard, system prompt section diffing, per-tool stripping thresholds. Works with any Claude client that supports `ANTHROPIC_BASE_URL`.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — Self-hosted forensic dashboard with SSE live monitoring, multi-host aggregation, cache-health scoring. Complementary to our proxy's vantage point. See [docs/dashboard-integration.md](docs/dashboard-integration.md) for the interop setup.

## Used in production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP development environment. First production team to merge the interceptor to trunk for team-wide deployment (2026-04-10). Identified two distinct cache regression patterns through real-world testing — tool ordering jitter and the fresh-session sort gap — and contributed debug traces that drove the v1.5.1 and v1.6.2 fixes.

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, tighter block matchers, and the optional output-efficiency rewrite hook
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP production environment validation, 1h cache TTL confirmation, tool ordering jitter discovery via debug trace (fixed in v1.5.1), fresh-session sort bug discovery via SKILLS SORT diagnostic (fixed in v1.6.2). First production team to roll the interceptor to trunk.
- **[@jmarianski](https://github.com/jmarianski)** — Root cause analysis via MITM proxy capture and Ghidra reverse engineering, multi-mode cache test script
- **[@cnighswonger](https://github.com/cnighswonger)** — Fingerprint stabilization, tool ordering fix, image stripping, monitoring features, overage TTL downgrade discovery, proxy architecture, package maintainer
- **[@ArkNill](https://github.com/ArkNill)** — Microcompact mechanism analysis, GrowthBook flag documentation, false rate limiter identification, fingerprint verification fix for CC v2.1.108+ (PR #21), Korean README (PR #22), [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) research
- **[@Renvect](https://github.com/Renvect)** — Image duplication discovery, cross-project directory contamination analysis
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) forensic methodology: cost-factor overhead ratio metric, `anthropic-*` header capture pattern, proxy NDJSON schema that informed our dashboard interop layer
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` wrapper, first Windows platform validation (7.5h/536-call Opus 4.6 session, 98.4% cache hit rate)
- **[@arjansingh](https://github.com/arjansingh)** — nvm-compatible wrapper script with dynamic `npm root -g` path resolution (PR #15)
- **[@beekamai](https://github.com/beekamai)** — Windows URL-encoding fix for `claude-fixed.bat` when npm root contains spaces (PR #17)
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code extension investigation: discovered `claudeCode.claudeProcessWrapper` as the working integration path, wrote the C wrapper for Windows (#16)
- **[@X-15](https://github.com/X-15)** — VS Code extension validation, per-fix health status analysis confirming safety check behavior on v2.1.105 (#16)
- **[@deafsquad](https://github.com/deafsquad)** — Universal smoosh_split un-smoosh fix (PR #26), source-level function attribution of resume scatter bug (anthropics/claude-code#43657), OTEL telemetry discovery, proposed and built proxy architecture for v3.0.0

If you contributed to the community effort on these issues and aren't listed here, please open an issue or PR — we want to credit everyone properly.

## Support

If this tool saved you money, consider buying me a coffee:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

[MIT](LICENSE)
