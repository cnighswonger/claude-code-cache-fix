# Directive: bootstrap-defense v3.7.1 — prompt-injection coverage

**Status:** plan-approved on issue #153 (2026-05-27). Implementation in progress on `feature/bootstrap-defense-v3.7.1`.
**Author:** AI Team Lead (directive), Proxy Builder (review + plan refinement)
**References:**
- Issue #153 — directive thread with Q&A
- cc-watch v2.1.152 report — `critical — remote-control-surface` finding
- `docs/disclosure/heron-brook-2026-05.md` — original heron_brook disclosure for the v3.7.0 surface
- v3.7.0 release notes for the existing `bootstrap-defense` shape

## Problem statement

CC v2.1.152 (shipped 2026-05-27) adds a new consumer pattern over the existing bootstrap-response delivery channel. The new pattern reads the bootstrap-delivered GrowthBook flag map and uses an env-var-selected flag value as the agent system prompt body:

```
uH(process.env.CLAUDE_CODE_REMOTE)
  ? process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE
  : void 0
  ... V$(<gb_key>, "") ... : j.systemPrompt
```

When `CLAUDE_CODE_REMOTE` is set (remote-control mode), `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` selects a GrowthBook feature flag key, and the cached flag value becomes the system prompt body via the `V$` reader. Both the original `tengu_heron_brook` reader and this new env-var-selected reader pull from the same on-disk flag cache, which is populated and refreshed (60s) from `/api/claude_cli/bootstrap` responses.

**Same delivery channel, new consumer pattern.** This is not a new endpoint surface — it's a new key-selection layer over the same bootstrap response payload that `bootstrap-defense` already audits.

The expanded indirection has a sharp edge: any future CC build can set `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE=<any-key>`, so per-key static expectations do not constrain the attack surface. The actionable signal is at the bootstrap response: did the response carry the key named by the env var, and what was its value.

Mitigation Anthropic provides today is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — a binary kill-switch for all bootstrap-class traffic. v3.7.0 users running `bootstrap-defense` in audit mode currently get observability for the original heron_brook surface; they do not get observability for the new env-var-selected surface. v3.7.1 closes that gap.

## Scope

Extend `bootstrap-defense` in-place. Single extension covers both consumer patterns over the same bootstrap response body. Update name/description to reflect both surfaces.

## Mode design

v3.7.1 ships three modes (configurable via `CACHE_FIX_BOOTSTRAP_MODE`):

| Mode | Default? | Source | Behavior |
|---|---|---|---|
| `audit` | yes | v3.7.0 (extended) | Call passes upstream; response parsed; audit record emitted with surface + key + value-hash + remote-mode flag. Body returned to CC unchanged. |
| `block` | opt-in | v3.7.0 (unchanged) | `onRequest` short-circuits with empty 200. No flag map ever reaches the on-disk cache. Defeats both surfaces. |
| `allowlist` | opt-in (new) | v3.7.1 | Call passes upstream; response parsed; any prompt-source-eligible key NOT in the allowlist is stripped from the response body before returning to CC. Audit record emitted with `stripped_keys` populated. |

`allowlist` mode env vars:

- `CACHE_FIX_BOOTSTRAP_MODE=allowlist` — enable allowlist mode
- `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=key1,key2,...` — comma-separated list of allowed prompt-source key names. Default: `tengu_heron_brook`. Explicit empty string (`CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=`) means deny-all (strip even `tengu_heron_brook`).

Prompt-source-eligible keys (the set the allowlist applies to):
- `tengu_heron_brook` (the historical hardcoded key)
- The value of `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` if set in the proxy's environment

Other GrowthBook flag keys in the response are not touched by allowlist mode — only prompt-source-eligible keys are filtered.

**Default-mode rationale:** v3.7.0 → v3.7.1 is a patch release. Default behavior unchanged from v3.7.0 (audit). Users opting into stronger defense get a clear, documented upgrade path. cc-watch's recommended allowlist posture is reachable via opt-in for security-forward users without forcing surprise behavior on the upgrade path.

## Detection mechanism

Response-time over env-var-presence. Env-var presence tells you what the launcher disclosed; the parsed bootstrap response is where injection actually lands and where defense actually applies. The env-var signal for `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` is implicit in the audit record: when `surface: "prompt_injection_gb"`, `prompt_key` carries the value of that env var. The orthogonal `CLAUDE_CODE_REMOTE` signal (which gates the entire new consumer pattern on the CC side) is captured as the `remote_mode` boolean.

**Stale-cache blind spot (out of scope for v3.7.1).** If CC reads a previously-written on-disk GrowthBook cache without making a fresh `/api/claude_cli/bootstrap` fetch through this proxy run, the audit log will not emit a fresh record for that session. v3.7.1 protects against new bootstrap fetches; it does not retroactively audit cache contents written by prior runs. Users who want belt-and-suspenders on this should clear the on-disk cache on proxy start, or use `block`/`allowlist` mode (which prevents new cache writes from injection-class keys going forward).

## Audit log schema

Same file (`~/.claude/cache-fix-bootstrap-log.jsonl`). Schema bumps from v1 to v2. New fields:

| Field | Type | Description |
|---|---|---|
| `surface` | `"bootstrap"` \| `"prompt_injection_gb"` | Which consumer pattern the record covers. `"bootstrap"` for legacy heron_brook surface; `"prompt_injection_gb"` for env-var-selected GB key surface. |
| `prompt_key` | string \| null | The key name that would be read as the prompt source. `"tengu_heron_brook"` for the legacy surface, the value of `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` for the new surface, null when no prompt source applies. |
| `prompt_value_hash` | string \| null | SHA-256 of the flag value if present in the response, truncated to first 16 hex chars. Null when the key is absent from the response. PII discipline: never log the value itself, only the hash. |
| `remote_mode` | boolean | Whether `CLAUDE_CODE_REMOTE` is set in the proxy's environment at audit time. Captures the launcher's mode signal. |
| `stripped_keys` | string[] | Keys removed from the response body by allowlist mode. Empty array when no stripping occurred. Always-present field so consumers can distinguish "no strip needed" from "strip happened but was empty." |

`SCHEMA_VERSION` constant bumps from `1` to `2`. `EXTENSION_VERSION` bumps to `"v3.7.1"`. Existing v1 records remain readable — consumers should treat absent v1 fields as null/empty array.

### Multi-surface records

A single bootstrap response can carry both `tengu_heron_brook` AND the key named by `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE`. `surface` / `prompt_key` / `prompt_value_hash` are scalar fields — they cannot represent both surfaces in one record.

**Resolution: one audit record per detected prompt-source surface.** When `onResponse` finds N prompt-source-eligible keys present in the response body, it emits N records, one per surface (`"bootstrap"` and/or `"prompt_injection_gb"`). Each record carries the scalar fields for its own surface only. `stripped_keys` on each record reflects only the strip outcome for that surface's key. Other scalar fields (`status`, `body_bytes`, `request_id`, `remote_mode`, etc.) are duplicated across the records emitted from a single response — consumers correlate by matching `request_id` + timestamp window.

This keeps each record's `surface` field meaningful, avoids array-typed fields that complicate downstream consumers, and lets future surfaces extend the same one-record-per-surface convention.

When neither surface is detected in the response (no `tengu_heron_brook` and no env-var-selected key present), the existing single `response_audited` record is emitted with `surface: "bootstrap"`, `prompt_key: null`, `prompt_value_hash: null`. This preserves the existing record shape for the no-injection-detected case.

When the bootstrap response would normally carry prompt-source keys but the body is JSON-unparseable, the single existing anomaly audit (`upstream_error_audited` / `response_audited` with null body) records the unparseable case; new fields default to null / empty array. No multi-surface emission for unparseable bodies.

## Implementation surface

`proxy/extensions/bootstrap-defense.mjs`:
- Bump `SCHEMA_VERSION` to `2`, `EXTENSION_VERSION` to `"v3.7.1"`
- Update extension `name`/`description` to reflect both surfaces
- Extend `recordShape` with `surface`, `prompt_key`, `prompt_value_hash`, `remote_mode`, `stripped_keys` fields
- Extend `onResponse` to inspect parsed body for prompt-source-eligible keys, compute SHA-256 hash of values when present, emit one audit record per detected surface (see "Multi-surface records"), and in `allowlist` mode mutate `ctx.body` to strip non-allowlisted prompt-source keys before the existing serialization path returns the response to CC
- Add `modeFromEnv` support for `"allowlist"` value
- Add `allowedKeysFromEnv` helper that parses `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS` (default `["tengu_heron_brook"]`, explicit empty string → empty array)
- Add `promptSourceKeysFromEnv` helper that returns the set of prompt-source-eligible keys based on `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` + the hardcoded `tengu_heron_brook` baseline

Hot-path note: the bootstrap path is a single non-SSE JSON response, not a hot path. The added parse + hash + optional mutate + re-serialize is fine.

## Test coverage

### Unit tests — `test/proxy-bootstrap-defense.test.mjs`

1. Audit mode, response carries `tengu_heron_brook` only → one record with `surface: "bootstrap"`, `prompt_key: "tengu_heron_brook"`, `prompt_value_hash` populated, `stripped_keys: []`
2. Audit mode, `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE=foo_bar`, response carries `foo_bar` key only → one record with `surface: "prompt_injection_gb"`, `prompt_key: "foo_bar"`, `prompt_value_hash` populated, `stripped_keys: []`
3. **Multi-surface case:** Audit mode, env var set to `foo_bar`, response carries BOTH `tengu_heron_brook` AND `foo_bar` → two records emitted from the single response, one per surface, each with its own `prompt_key` / `prompt_value_hash`, shared `request_id` + timestamp window for correlation
4. Audit mode, env var set but response does not carry the named key → one `prompt_injection_gb` record with `prompt_value_hash: null`, `stripped_keys: []`
5. Audit mode, neither prompt-source key in response → single record with `surface: "bootstrap"`, `prompt_key: null`, `prompt_value_hash: null` (preserves no-injection-detected baseline)
6. Audit mode, JSON-unparseable response body → single anomaly audit record with new fields defaulted to null/empty array, no multi-surface emission
7. Block mode unchanged → still empty 200 from `onRequest`, no body inspection, single `request_blocked` record
8. Allowlist mode, env-var-selected key NOT in allowlist → key stripped from response body, record has `stripped_keys: ["<key>"]`, returned body lacks the key
9. Allowlist mode, env-var-selected key IS in allowlist → key passes through, `stripped_keys: []`
10. Allowlist mode with `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=` (explicit empty) → even `tengu_heron_brook` stripped (deny-all semantics)
11. Allowlist mode preserves non-prompt-source keys → only prompt-source-eligible keys are subject to stripping; other GB flag keys in the response pass through untouched
12. Allowlist mode, multi-surface case (both prompt-source keys in response, only one allowlisted) → two records emitted, only the non-allowlisted key appears in its record's `stripped_keys`, returned body lacks only the stripped key
13. `remote_mode` field correctly reflects `CLAUDE_CODE_REMOTE` presence/absence across audit/block/allowlist modes

### Integration test — `test/proxy-server-bootstrap.test.mjs`

14. **End-to-end allowlist mutation:** `allowlist` mode, env-var-selected key NOT in allowlist, full request through `handleBootstrap` — assert the response Claude Code actually receives on the wire lacks the stripped key (proves `ctx.body` mutation flows through the existing `JSON.stringify(resCtx.body)` serialization path in `proxy/server.mjs`)

## Documentation

- `CHANGELOG.md`: v3.7.1 entry summarizing new surface coverage, schema v2 additions, new `allowlist` mode
- README: bootstrap-defense section gains the three-mode table + allowlist documentation. Note that default allowlist includes `tengu_heron_brook` and that explicit deny-all requires `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=`
- Allowlist documented as experimental — may need updates if Anthropic adds legitimate prompt-source keys in future CC releases

## Version target

v3.7.1 patch. Securing a feature v3.7.0 already shipped; threat class unchanged from v3.7.0; new opt-in `allowlist` mode does not alter the default upgrade path. Within spirit of maintenance-mode patch policy.

If scope grows during implementation (e.g. additional injection paths discovered, granular block needs to land, or the extension significantly restructures), promote to v3.8.0 minor.

## Out of scope for v3.7.1

- **Granular block** (let the call upstream, parse, strip-specific-keys, re-serialize) — `allowlist` mode is the granular-strip path; this directive does not redesign the `block` mode mechanic. v3.7.0's empty-200 contract holds.
- **Allowlist with content-pattern matching** — current design is key-name allowlisting only. Content-based filtering (e.g. "strip any flag value over N bytes") is a separate design.
- **Cross-host bootstrap state** — extension assumes single-host single-process proxy; if multi-host deployment becomes a goal, allowlist state will need to coordinate.
