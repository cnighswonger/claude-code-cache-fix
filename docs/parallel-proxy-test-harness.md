# Parallel proxy test harness

For end-to-end testing of cache-fix-proxy extensions against real `claude -p` traffic without disturbing the production proxy or any active CC sessions on the box.

## When to use this

- Verifying a new extension actually changes API request/response behavior the way unit tests claim
- Reproducing an upstream CC bug by capturing real request bodies the live binary sends
- Side-by-side baseline vs injected comparisons (same prompt, different proxy config)
- Investigating cache-prefix impact of a request-body mutation

If you only need to verify extension logic against synthetic inputs, unit tests are enough. Use this harness when "does the live CC binary actually trigger this code path?" is the open question.

## What it gives you

- A second proxy on a non-conflicting port (default 9802) running from the feature branch's source — so the running `cache-fix-proxy.service` on `:9801` is untouched.
- An isolated extensions directory so the test proxy loads only what you want, regardless of what's enabled in the deployed `extensions.json`.
- A diagnostic extension that dumps every request body's relevant shape to a file you grep, so you don't have to instrument the proxy itself.
- Direct invocation of the CC binary, bypassing the local `claude` wrapper that hardcodes `ANTHROPIC_BASE_URL=http://127.0.0.1:9801`.

## Quick start

```bash
# 1. Create an isolated extensions dir with the extension you're testing + a
#    diagnostic that dumps request bodies.
mkdir -p /tmp/test-extensions-dir
# Copy the minimum extensions needed for the path to work end-to-end. The
# example below uses ttl-tier-detect + fingerprint-strip + cache-telemetry
# as the "always include" set; add your extension under test alongside.
cp proxy/extensions/{ttl-tier-detect,fingerprint-strip,cache-telemetry}.mjs /tmp/test-extensions-dir/
cp proxy/extensions/MY-EXTENSION.mjs /tmp/test-extensions-dir/

cat > /tmp/test-extensions-dir/test-debug.mjs <<'JS'
import { appendFile } from "node:fs/promises";
const LOG = "/tmp/test-debug.jsonl";
export default {
  name: "test-debug",
  description: "Dump request body shape + injection state to a file",
  enabled: true,
  order: 999, // run AFTER your extension so you see post-injection state
  async onRequest(ctx) {
    const entry = {
      ts: new Date().toISOString(),
      model: ctx.body?.model || null,
      // Add fields relevant to your extension here
      thinking: ctx.body?.thinking || null,
      meta: ctx.meta || {},
    };
    try { await appendFile(LOG, JSON.stringify(entry) + "\n"); } catch {}
  },
};
JS

# 2. Stage an extensions config that enables exactly your test set.
cat > /tmp/test-extensions.json <<'JSON'
{
  "ttl-tier-detect": { "enabled": true, "order": 75 },
  "fingerprint-strip": { "enabled": true, "order": 100 },
  "MY-EXTENSION":     { "enabled": true, "order": 360 },
  "cache-telemetry":  { "enabled": true, "order": 600 },
  "test-debug":       { "enabled": true, "order": 999 }
}
JSON

# 3. Start the test proxy on 9802 with whatever env vars your extension
#    reads. Production proxy on :9801 stays running, undisturbed.
cd ~/git_repos/claude-code-cache-fix
> /tmp/test-debug.jsonl
> /tmp/test-proxy.log
CACHE_FIX_PROXY_PORT=9802 \
  CACHE_FIX_MY_EXTENSION_FLAG=on \
  CACHE_FIX_EXTENSIONS_DIR=/tmp/test-extensions-dir \
  CACHE_FIX_EXTENSIONS_CONFIG=/tmp/test-extensions.json \
  nohup node proxy/server.mjs > /tmp/test-proxy.log 2>&1 &
disown
sleep 1.5
curl -fs http://127.0.0.1:9802/health  # should return {"status":"ok"}

# 4. Run claude -p against the test proxy. CRITICAL: invoke the binary
#    directly, NOT the ~/bin/claude wrapper — that wrapper hardcodes
#    ANTHROPIC_BASE_URL=:9801 and will override your env var.
CLAUDE_BIN="$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 \
  "$CLAUDE_BIN" -p "YOUR PROMPT" \
  --model claude-opus-4-7 \
  --output-format stream-json --include-partial-messages --verbose \
  > /tmp/test-output.jsonl 2>&1

# 5. Inspect: what reached the proxy? (jq handles multi-line JSONL natively.)
jq . /tmp/test-debug.jsonl
# Or, if you only care about the last request:
tail -1 /tmp/test-debug.jsonl | python3 -m json.tool

# 6. Inspect: what came back from Anthropic? Walk the stream-json events.
python3 - <<'PY'
import json
with open('/tmp/test-output.jsonl') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            d = json.loads(line)
            ev = d.get('event', d)
            t = ev.get('type', d.get('type'))
            if t in ('content_block_start', 'content_block_delta', 'message_delta'):
                print(json.dumps(ev, indent=2)[:200])
        except: pass
PY

# 7. Tear down.
kill $(ss -tlnp 2>/dev/null | awk '/:9802/' | grep -oP 'pid=\K[0-9]+' | head -1)
ss -tln | grep :9802 || echo "9802 free"
# Production proxy on :9801 should be untouched throughout.
curl -fs http://127.0.0.1:9801/health
```

## Gotchas

### 1. `~/bin/claude` wrapper hardcodes `ANTHROPIC_BASE_URL=:9801`

The wrapper at `~/bin/claude` runs `export ANTHROPIC_BASE_URL="http://127.0.0.1:9801"` unconditionally. Any value you set in your shell gets clobbered.

**Always invoke the CC binary directly for harness testing**: `$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (Bun binary) or via `node $HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js` (legacy Node path).

### 2. `claude -p` requires `--verbose` for `--output-format stream-json`

Without `--verbose`, the binary errors out before sending any request. You'll see a confusing empty `/tmp/test-debug.jsonl` because the request never happened.

### 3. Env-var changes need a proxy restart

Most proxy extensions read `process.env.*` at startup (or per-request via `process.env[...]`). Changing the env var in your shell does NOT change the running proxy's `process.env`. To toggle, kill the proxy and restart with the new value:

```bash
kill $(ss -tlnp 2>/dev/null | awk '/:9802/' | grep -oP 'pid=\K[0-9]+' | head -1)
sleep 1
# new env vars
CACHE_FIX_PROXY_PORT=9802 ... nohup node proxy/server.mjs > ...
```

### 4. PID discovery via `ss` requires the listener to be up

If the test proxy crashed at startup, `ss -tlnp ... awk` returns empty and the kill silently no-ops. Check `cat /tmp/test-proxy.log` for startup errors before assuming the proxy is running.

### 5. Don't `pkill -f "proxy/server.mjs"` — it matches your own shell

The pattern `proxy/server.mjs` can match the parent shell process if you typed those characters in your command line, leading to the shell being killed mid-script. Always target by exact PID (via `ss -tlnp` → port → pid lookup), never by `pkill -f`.

### 6. Adaptive thinking is model-decided

If you're testing thinking-related extensions, note that `thinking.type: "adaptive"` (the CC v2.1.131 default) lets the model decide whether to think per-prompt. Casual prompts ("what's 2+2") won't trigger thinking; constraint-optimization or multi-step reasoning prompts reliably will. If your test response has zero thinking content but you expected it, try a harder prompt before concluding the extension is broken.

## Patterns

### Side-by-side baseline vs injected comparison

The canonical "did my extension actually change behavior?" test.

```bash
# Run A: extension DISABLED (baseline — should reproduce the bug)
kill $(ss -tlnp 2>/dev/null | awk '/:9802/' | grep -oP 'pid=\K[0-9]+' | head -1); sleep 1
> /tmp/test-debug.jsonl
CACHE_FIX_PROXY_PORT=9802 CACHE_FIX_MY_FLAG=disabled \
  CACHE_FIX_EXTENSIONS_DIR=/tmp/test-extensions-dir \
  CACHE_FIX_EXTENSIONS_CONFIG=/tmp/test-extensions.json \
  nohup node proxy/server.mjs > /tmp/test-proxy.log 2>&1 &
disown; sleep 1.5
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 \
  "$CLAUDE_BIN" -p "SAME PROMPT" --verbose --output-format stream-json --include-partial-messages \
  > /tmp/baseline.jsonl 2>&1

# Run B: extension ENABLED (injected — should produce the fix)
kill $(ss -tlnp 2>/dev/null | awk '/:9802/' | grep -oP 'pid=\K[0-9]+' | head -1); sleep 1
> /tmp/test-debug.jsonl
CACHE_FIX_PROXY_PORT=9802 CACHE_FIX_MY_FLAG=on \
  CACHE_FIX_EXTENSIONS_DIR=/tmp/test-extensions-dir \
  CACHE_FIX_EXTENSIONS_CONFIG=/tmp/test-extensions.json \
  nohup node proxy/server.mjs > /tmp/test-proxy.log 2>&1 &
disown; sleep 1.5
ANTHROPIC_BASE_URL=http://127.0.0.1:9802 \
  "$CLAUDE_BIN" -p "SAME PROMPT" --verbose --output-format stream-json --include-partial-messages \
  > /tmp/injected.jsonl 2>&1

# Diff the two outputs. Anything that differs is your extension's effect.
python3 - <<'PY'
import json
# Walk both JSONL files; compare content_block_start types, content_block_delta types,
# usage counts, and any field your extension is supposed to affect.
PY
```

### Cache impact measurement

For extensions that mutate request bodies (and might break Anthropic's prefix cache), establish a baseline of `cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)` across a series of requests in two windows — extension off, then extension on — over at least one cache TTL cycle (1h on the 1h tier). Compare the steady-state ratio between windows. Pre-commit thresholds before running so the result isn't rationalized post-hoc:

| Drop | Verdict |
|---|---|
| ≤ 5% absolute | Preserved — extension is cache-safe |
| 5–10% | Investigate — probably broken, check confounders |
| > 10% | Broken — document tradeoff, keep off by default |

## Limitations

- **One test proxy at a time.** Port 9802 is the convention; if you need to compare two extension configs simultaneously, use 9802 + 9803.
- **No multi-turn session state.** Each `claude -p` invocation is a fresh CC subprocess with no resume context. To test extensions that mutate multi-turn behavior, you need a real CC session — and at that point, you're back to deploying to the live proxy (operator-coordinated).
- **Cache state is shared at the account level.** Even on a separate proxy, requests still hit Anthropic with your account's auth. Cache prefixes are account-scoped, so warming via the test proxy affects production-proxy traffic and vice versa. Use disposable / synthetic prompts when this matters.
- **Production proxy is untouched but production cache isn't.** A test prompt sent through 9802 still creates cache entries Anthropic indexes; subsequent production-proxy traffic may hit those entries. For most tests this is harmless; for cache-impact measurements it's a confounder.

## File conventions used by this doc

| Path | Purpose |
|---|---|
| `/tmp/test-extensions-dir/` | Isolated extensions directory for the test proxy |
| `/tmp/test-extensions.json` | Extensions config the test proxy loads |
| `/tmp/test-proxy.log` | Test proxy stdout/stderr |
| `/tmp/test-debug.jsonl` | Diagnostic extension's request-body dump |
| `/tmp/baseline.jsonl` | `claude -p` output without injection (the bug, if any) |
| `/tmp/injected.jsonl` | `claude -p` output with injection (the fix verification) |

These are convention, not contract — rename freely.

---

This harness was extracted from the work on `thinking-display` extension (PR #131), where the live test surfaced a spec/reality mismatch (CC v2.1.131 ships `thinking.type: "adaptive"`, the upstream issue described `"enabled"`) that no unit test could have caught.
