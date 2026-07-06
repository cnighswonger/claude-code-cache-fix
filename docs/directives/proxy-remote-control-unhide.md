# Directive: remote-control-unhide — proxy extension to restore /rc palette visibility on non-first-party sessions

**Status:** directive draft. No upstream tracking issue (this is our own discovery — Claude Code v2.1.201 hides `/remote-control` and its `/rc` alias from the slash palette entirely when `ANTHROPIC_BASE_URL` points at anything other than `api.anthropic.com`). Precedent: changelog line 34 of the public CHANGELOG says Remote Control is *disabled* on non-first-party base URLs; v2.1.201 escalates that from disabled-with-visible-reason to hidden-from-palette-entirely.
**Author:** cc-watch Agent. Chris directed the intervention: "we'll paint their little red wagon green for them."
**Surface:** proxy extension. Outbound request modification (`onRequest`) + response body rewrite (`onResponse`).

## Pre-work — binary-walk of CC's Remote Control gate

Verified against Claude Code v2.1.201 (the installed version at time of directive; `strings -a` on the native binary at `$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude`). Identifier names are minified per release; when re-verifying against a later CC version, look up the same code bodies rather than the same short names.

### The slash-command registration

The `/remote-control` slash command is registered as a local-jsx command (v2.1.201 short name `ASm`):

```js
ASm = {
  type: "local-jsx",
  name: "remote-control",
  aliases: ["rc"],
  get description() { return NI() ? "Disconnect Remote Control" : "Control this session from your phone or claude.ai/code" },
  get argumentHint() { return NI() ? void 0 : "[name]" },
  isEnabled: yI,
  get isHidden() { return !yI() }
  // ... rest of the definition
}
```

Both `isEnabled` and `isHidden` key off the same predicate `yI()`. When `yI()` returns `false`, the command is *both disabled and hidden* — it does not appear in slash-autocomplete, does not appear in `/help`, and issuing `claude remote-control` from the CLI returns the human-readable disable reason from `fgr()`.

### The `yI()` gate chain

```js
function yI() {
  if (Qhr()) return true;              // Qhr() = () => false; dead in v2.1.201
  if (Zon()) return false;             // managed-setting disableRemoteControl
  return !ZU() && U9e();
}

function ZU() {
  return it(process.env.CLAUDE_CODE_REMOTE) || na();  // na() = jt.caps.workspace === "remote"
}

function U9e() {
  return Qon() && EIt() && nt("tengu_ccr_bridge", !1);
}

function Qon() {
  if (!ic()) return false;                    // ic() = fr() === "firstParty"
  return !!process.env.ANTHROPIC_UNIX_SOCKET || wwn();
}

function wwn() {
  let e = process.env.ANTHROPIC_BASE_URL;
  if (!e) return true;
  return qce(e);
}

function qce(e) {
  try {
    let t = new URL(e).host;
    return ["api.anthropic.com"].includes(t);
  } catch { return false; }
}
```

And `fgr()` — the disable-reason chain for CLI invocations of the command — spells out the same gate in human-readable form:

```js
function fgr() {
  if (Qhr()) return null;
  if (!Qon()) return "Remote Control is only available when using Claude via api.anthropic.com.";
  if (ZU()) return "Remote Control is not available inside a cloud session.";
  if (Zon()) return "Remote Control is disabled by your organization's policy (managed setting `disableRemoteControl`).";
  if (!Zhr()) return "Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in with your claude.ai account.";
  if (!EIt()) return rGn({ prefix: "Remote Control requires claude.ai subscription auth.", ... });
  // ... plus the GrowthBook-fetch fall-through path
}
```

### What the binary actually gates on

The two conjuncts that a proxy-side intervention can plausibly influence:

1. **`qce(ANTHROPIC_BASE_URL)`**: a pure string equality check. If `new URL(process.env.ANTHROPIC_BASE_URL).host === "api.anthropic.com"`, the gate opens. **Nothing in the binary verifies that the base URL actually reaches the real Anthropic API** — only that the string parses to a URL whose host is `api.anthropic.com`. If the env var is set to `https://api.anthropic.com/` and network-layer routing (transparent-mode DNS rewrite, host-file entry, iptables NAT, or user's own `/etc/hosts`) sends the actual traffic to cache-fix's proxy port, the gate treats the client as first-party.

2. **`nt("tengu_ccr_bridge", !1)`**: a GrowthBook feature-flag lookup. Its default is `false`. `nt(e, t)` checks two local override maps (`sjt()` returning `Rqi`, and `ijt()` returning undefined in v2.1.201) *before* falling back to the cached GrowthBook features fetched from Anthropic. The GrowthBook fetch surface is `/api/features/`. If cache-fix intercepts that response and rewrites `tengu_ccr_bridge: true` into the features object, `nt()` reads the rewritten value and the third conjunct of `U9e()` passes.

The other conjuncts (`ic()` requiring first-party enum — which is set by `CLAUDE_CODE_USE_*` env vars, not the base URL; `EIt()` requiring OAuth with Claude Code scopes; `Qhr()` dead; `Zon()` requiring managed-setting) are either already true for the target user population (Claude Code users on subscription auth) or outside the proxy's reach.

### What this means for the intervention

Two-lever design. Both levers are strictly on the client side; neither modifies the actual `/v1/messages` traffic path:

| Lever | Mechanism | Effect on gate |
|---|---|---|
| Base URL alias | User sets `ANTHROPIC_BASE_URL=https://api.anthropic.com/` and configures network-layer routing (transparent mode, hosts file, iptables) to redirect the actual traffic to cache-fix's proxy port. | `qce()` returns true → `wwn()` returns true → `Qon()` reaches its second predicate |
| GrowthBook rewrite | Proxy extension `onResponse` handler intercepts `/api/features/` response bodies, sets `tengu_ccr_bridge` to `true` in the features object before returning. | `nt("tengu_ccr_bridge", !1)` returns `true` → third conjunct of `U9e()` passes |

Both levers together restore `/rc` to the slash palette on non-first-party proxy sessions. The base-URL lever is the more load-bearing one — the GrowthBook rewrite alone doesn't unblock `Qon()`.

## Scope

A new proxy extension `remote-control-unhide` with two modes controlled by env var `CACHE_FIX_REMOTE_CONTROL_UNHIDE`:

| Mode | env var value | Behavior |
|---|---|---|
| `off` | unset, `0`, `false`, empty | No intervention. Extension is a no-op. Default. |
| `on` | `1`, `true`, `yes`, `on` | Two interventions active: (a) if the proxy sees an inbound `/api/features/` response, rewrite it to force `tengu_ccr_bridge: true`; (b) emit an annotation into `ctx.meta._remoteControlUnhide` with the intervention status, propagated to session state via `cache-telemetry` the same way `_auto1mGuard` is. |

Note the deliberate absence of a "warn" mode. `auto-1m-guard` had warn/strip because the intervention modifies outbound-request billing behavior — warning was useful because the user might genuinely want 1M context. This extension modifies the response body of a metadata endpoint to unblock a UI element. There is no user benefit to the "warn" mode; either you want `/rc` visible or you don't.

The extension does **not** modify `ANTHROPIC_BASE_URL`. That's a user-environment configuration change and belongs in the extension's README/documentation, not in the runtime. The extension trusts the user to set the env var correctly if they want the base-URL lever.

## Detection and rewrite mechanics

### Detection

The extension registers an `onResponse` handler that fires for every proxied response. It matches when:

1. `req.method === "GET"` (GrowthBook fetches are GETs)
2. `req.url.pathname === "/api/features/"` **exactly** (with trailing slash — that's the actual endpoint per binary strings). Also match `/api/features` without the trailing slash as a defensive alternative in case Anthropic normalizes.
3. `res.statusCode >= 200 && res.statusCode < 300`
4. Response `content-type` starts with `application/json`

If any check fails, the extension is a pass-through — the response is returned unmodified. Missing content-type is treated as a miss (do not force JSON parsing).

### Rewrite

If the detection checks all pass:

1. Buffer the full response body (respect the same body-size cap the rest of the proxy uses; document the cap in the README).
2. Attempt `JSON.parse` on the buffered body. On parse failure, restore the original bytes and log a warning at `debug` level — do not fail the request.
3. Locate the features object. GrowthBook's standard response shape is `{"status": 200, "features": {"<flag_name>": {"defaultValue": <bool>, ...}, ...}, "dateUpdated": "..."}`. If `body.features` is not an object, restore the original bytes and log a warning.
4. Set `body.features.tengu_ccr_bridge = {"defaultValue": true}` (or overwrite an existing entry with the same key).
5. Re-serialize the body with `JSON.stringify`. Adjust `content-length` header. Return the modified response.
6. Record the intervention in `ctx.meta._remoteControlUnhide = { fired: true, timestamp: ... }`.

If detection matches but the body is empty (204 No Content, or an actual empty 200), record `ctx.meta._remoteControlUnhide = { fired: false, reason: "empty_body" }` and pass through.

### GrowthBook local overrides (alternative approach)

The binary shows `nt(e, t)` checks two local override maps (`sjt()` → `Rqi`, `ijt()` → undefined) *before* the cached GrowthBook fetch. These maps are populated from local sources — likely settings files or env vars. A future refinement could investigate how to populate `Rqi` from the proxy side and set overrides that way, but this directive picks the response-rewrite path because:

- The response-rewrite path is a single well-defined intervention point (`/api/features/`), independent of CC internal state.
- The local-override maps are read once at startup by the binary; the proxy can't reach into a running CC process's memory.
- A settings-file intervention (writing to whatever populates `Rqi`) would live in cache-fix-vscode's launcher-wrapper surface, not the proxy — different repo, different review path.

## Order key

The extension operates on the response body of the `/api/features/` endpoint. It has no interaction with the model-completion pipeline. Assign order **730** (in the trailing 700-range slot alongside `read-dedupe` at 700 and `jsonl-session-mirror` at 720). This keeps it well after cache-management and rate-limit extensions and prevents interference with model-request annotation extensions in the 500-600 range.

## Non-goals

- **Not modifying `ANTHROPIC_BASE_URL`.** The env var is user-controlled; the extension does not overwrite it.
- **Not intercepting `/v1/messages` requests or `anthropic-beta` headers.** No model-pipeline touch.
- **Not restoring Remote Control functionality.** The extension unblocks the *palette visibility gate*. Whether Remote Control actually connects (OAuth flow, WebSocket to bridge, mobile app pairing) is unaffected — those subsystems make their own network calls against `api.anthropic.com` endpoints, and if they hit gates the extension is silent on them.
- **Not defeating managed-setting `disableRemoteControl`.** `Zon()` fires before `U9e()` in `yI()`. If the user's organization has set `disableRemoteControl: true` in managed settings, this extension does nothing — the gate remains closed. That's the right behavior; org policy stands.
- **Not classifying subscription tier.** Unlike the auto-1m-guard discussion, this extension is safe on any tier — a rewrite of a metadata endpoint response has no billing implication.
- **Not a `/rc` shim.** The extension does not implement Remote Control server-side. It restores the client-side ability to *see* the command in the palette. Everything downstream is stock Anthropic client behavior.

## Test plan

1. **Unit: detection.** Feed the extension a GET `/api/features/` response with status 200 and a GrowthBook-shaped JSON body. Verify the rewritten body has `features.tengu_ccr_bridge.defaultValue === true`.
2. **Unit: detection miss on wrong path.** GET `/api/oauth/usage` with same body shape. Verify passthrough — no rewrite, no annotation.
3. **Unit: detection miss on wrong method.** POST `/api/features/`. Passthrough.
4. **Unit: detection miss on non-JSON content-type.** GET `/api/features/` with `text/html`. Passthrough.
5. **Unit: detection miss on JSON parse failure.** GET `/api/features/` with malformed JSON. Passthrough, debug-level warning logged.
6. **Unit: detection miss on non-object `features`.** GET `/api/features/` with `{"features": "not an object"}`. Passthrough, debug-level warning logged.
7. **Unit: existing `tengu_ccr_bridge` overwritten.** GET `/api/features/` with `{"features": {"tengu_ccr_bridge": {"defaultValue": false, "rules": [...]}}}`. Verify the rewrite sets `defaultValue: true` and preserves or overwrites `rules` per the design decision documented in the extension header.
8. **Unit: annotation flow.** Verify `ctx.meta._remoteControlUnhide.fired === true` after a successful rewrite, and that the annotation is propagated to session state via `cache-telemetry`.
9. **Integration: mode off.** Set `CACHE_FIX_REMOTE_CONTROL_UNHIDE=0`. Verify no rewrite, no annotation.
10. **Integration: end-to-end** (requires network). With `CACHE_FIX_REMOTE_CONTROL_UNHIDE=1` and `ANTHROPIC_BASE_URL=https://api.anthropic.com/` set (assuming network-layer routing is configured), start a CC session and confirm `/rc` appears in the slash palette. This test is not part of the automated suite; it's documented as a manual verification step in the extension README.
11. **Regression: cache-fix-warmer session state.** Verify `_remoteControlUnhide` appears in the session-state JSON at `~/.claude/quota-status/sessions/<sid>.json` after a rewrite, alongside `_auto1mGuard` and `_sessionHealth`.

## Non-functional

- **~150 LOC net code** per typical proxy-extension shape. Response-body-rewrite pattern is already established in the codebase (`overage-warning`, `thinking-block-sanitize`).
- **Load-bearing** per CLAUDE.md — the extension modifies bytes returned to CC. Chris human review on the implementation PR.
- **No impact on cache-fix's core `/v1/messages` handling.** The extension is purely on a metadata endpoint.
- **Body-size cap.** Reuse the existing convention; document in extension README.
- **`onResponse` hook overhead.** Every response through the proxy triggers the check. The check is `method === "GET" && pathname matches`; O(1). No measurable overhead on non-matching responses.

## What this is NOT

- **Not a jailbreak.** Remote Control's actual connectivity to claude.ai/code is unaffected; the extension only restores the palette visibility gate. If Anthropic decides to add additional server-side checks that block non-first-party clients from establishing a bridge, this extension does nothing to circumvent them.
- **Not permanent.** Anthropic can — and probably will — add stricter server-side attestation to the bridge handshake in a future release, at which point this extension may become a no-op or need to be retired. The extension's README should say so plainly.
- **Not a claim about Anthropic's policy.** cc-watch has published on the disclosure delta around Remote Control (`training-carveout-vs-firstparty-fetch`, `fingerprint-apostrophe-claude-code-v2-1-91`, `changelog-every`) — that's a separate concern, expressed in blog form. The extension is a tool.

## Open questions for implementation review

- **Should the extension also handle `/api/features` without the trailing slash?** The binary literal is `/api/features/`, but reverse proxies commonly normalize away trailing slashes. The extension should match both defensively unless verification against actual Anthropic responses shows only one form is served.
- **How does the extension coexist with GrowthBook's caching?** CC's binary shows `Pt().cachedGrowthBookFeatures` — an on-disk cache. If a prior response is already cached with `tengu_ccr_bridge: false`, the first rewrite has no immediate effect until the cache TTL expires. The extension should annotate this in its debug output.
- **Should the extension log a one-shot informational message on first successful rewrite?** Similar to the `auto_1m_advice` string that goes into session state. Suggested wording documented in the extension README, gated on log-verbosity.
- **Should the extension check whether Remote Control is actually reachable before rewriting?** No. That would require a probe against Anthropic's bridge endpoint, adding latency and coupling. The extension trusts the user to know whether they want the palette entry.

## What this does NOT scope

- Implementing the extension (that's Proxy Builder's PR).
- The base-URL lever documentation on cache-fix-vscode's launcher-wrapper side.
- Any interaction with the `sjt()`/`ijt()` local-override maps (deferred to a future workstream).
- Detection of when the extension is a no-op because Anthropic has escalated to server-side attestation (future workstream if that happens).
- Any modification to the OAuth handshake or bridge WebSocket layer.

## Rationale

The v2.1.91 → v2.1.201 trajectory on Remote Control shows a specific escalation:
- v2.1.91-era: `OM()` gate exists for other capabilities (fingerprint chain), not for Remote Control.
- v2.1.196-era: line 34 of the CHANGELOG names Remote Control being disabled on non-first-party base URLs. Command is still visible in palette with a `fgr()`-supplied disable reason.
- v2.1.201: `isHidden: !yI()` added to the slash-command definition. Command is no longer discoverable at all.

The escalation is from "documented + disabled" to "silent + hidden." That's a user-experience regression for the population that legitimately routes traffic through a proxy (compliance, corporate MITM, quota management, debugging). Cache-fix has always operated in exactly that population. Restoring palette visibility for our users is well within the scope of what the proxy is for.

Chris directed the work with: "We'll pain their little red wagon green for them."

— cc-watch Agent
