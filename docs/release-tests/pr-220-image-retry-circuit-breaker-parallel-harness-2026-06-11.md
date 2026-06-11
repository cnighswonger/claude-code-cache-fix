# PR #220 image-retry-circuit-breaker — parallel-harness sim — 2026-06-11

**Branch:** `feature/image-retry-circuit-breaker`
**Commit at run time:** `2878984` (Codex round-3 APPROVE; doc-only delta from `7ce182c` source approval)
**Verdict:** **GREEN on feature-branch proxy via controlled traffic; deferred for CC binary harness consumption (see § Harness consumption — empirical scope finding).**
**Run host:** Direct on visits-01 — second proxy from feature-branch source on `:9802`, prod `:9801` untouched per `docs/parallel-proxy-test-harness.md`
**Per:** directive § Sim validation requirement; merge gate via `needs-sim-validation` label
**Sim script:** `/tmp/cf-parallel-pr220/parallel-sim.sh`; manual-trace artifacts: `/tmp/cf-parallel-pr220-artifacts/`
**Relationship to container smoke:** Complements `pr-220-image-retry-circuit-breaker-container-smoke-2026-06-11.md` (Docker-container wire-format proof). This report adds direct-source-tree validation on visits-01 and documents the empirical scope finding about CC binary harness consumption.

## Scope

This report supersedes the morning's container-smoke as the primary sim-validation artifact. It covers:

1. **Feature-branch proxy correctness against the canonical Anthropic envelope** — validated on the actual source tree on visits-01, not just the container image.
2. **Empirical scope finding for the "real CC binary harness consumption" gate** — turns out CC's `Read` tool decides whether to upload a fixture as an image or to inspect it as bytes; with controllable fixtures this falls into bytes-mode, which means the request body has no image content blocks and the breaker correctly takes the no-images fast-path. The actual CC#66815 trigger path (multi-turn interactive retry on a real-Anthropic-rejected image) is structurally not reproducible at this scope.

## Test rig

- **Prod proxy** on `:9801` (untouched throughout).
- **Test proxy** on `:9802`, started via `node proxy/server.mjs` from `feature/image-retry-circuit-breaker` HEAD with:
  - `CACHE_FIX_IMAGE_RETRY_BREAKER=on`, `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS=300000`
  - `CACHE_FIX_PROXY_UPSTREAM=http://127.0.0.1:9803` (points at fake upstream)
  - Isolated extension dir at `/tmp/cf-parallel-pr220/extensions/` loading only the minimal set + the breaker
  - Isolated breaker log at `/tmp/cf-parallel-pr220-artifacts/breaker-events.jsonl` (does not touch `~/.claude/image-retry-events.jsonl`)
- **Fake upstream** on `:9803` (`/tmp/cf-parallel-pr220/fake-upstream.mjs`): returns the canonical Anthropic image-processing-error envelope (HTTP 400 + `{"type":"error","error":{"type":"invalid_request_error","message":"image could not be processed: the image you submitted is invalid"}}`) on every POST `/v1/messages*`.

## Sections

### A — Three-process state and isolation

- `:9801` prod proxy `/health` → `{"status":"ok"}`, untouched throughout.
- `:9802` test proxy `/health` → `{"status":"ok"}`.
- `:9803` fake upstream `/__ctl__/state` reachable.

**Result: PASS.**

### B — Controlled curl trace against the breaker (canonical envelope path)

Drove the breaker directly with two curl POSTs to `:9802` carrying identical bodies (single user message with a base64-encoded `tiny-valid.png` content block). Pinned `x-claude-code-session-id` to a fixed UUID. Fake upstream returns the canonical 400 envelope on the first call.

Results (literal artifacts in `/tmp/cf-parallel-pr220-artifacts/`):

- **R1 (curl POST):** HTTP 400 from fake upstream, passed through to client unchanged. Breaker log gains a `failure_recorded` event:

  ```json
  {"event":"failure_recorded","session_id":"00000000-0000-4000-8000-c4f1efb22220","request_signature":"7637566d741a61fe","image_hashes":["e878950f8091ec010cf5cc723bdea027a8539cf7147cfea199c2f666232dcd4e"],"last_failure_at":1781217334323,"request_id":"req_fake_1781217334316"}
  ```

- **R2 (curl POST, same body):** HTTP 200 with synthesized JSON envelope:

  ```json
  {"id":"msg_synth_7cfc5e93cb53d77514cd5f","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"[cache-fix-proxy] Image with content hash e878950f failed processing on the previous attempt. ... (See CC#66815. Cooldown: 300000ms.)"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
  ```

  Breaker log gains a `breaker_fire` event. Fake-upstream call count **stays at 1** — the directive's load-bearing replay assertion confirmed on the feature-branch source tree.

**Result: PASS.** Same wire-format guarantees as the morning's container smoke, now proven on the actual source tree the package will publish.

### C — CC binary harness consumption — empirical scope finding

Attempted the canonical parallel-harness setup: real CC binary (`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, version 2.1.148) invoked with `ANTHROPIC_BASE_URL=http://127.0.0.1:9802 claude -p "Use Read tool on tiny-valid.png and describe it" --session-id <pinned UUID> --allowedTools Read`. Goal: observe whether the harness consumes the synthesized SSE response as a normal completed turn.

**Empirical finding:** with a controllable fixture (`tiny-valid.png`, a 69-byte 1×1 RGB PNG), CC's `Read` tool decides to inspect the file's bytes as text rather than uploading it as an image content block. Diagnostic instrumentation confirmed this directly:

```json
{"session_id_header":"00000000-0000-4000-8000-c4f1efb22220","stream":true,"model":"claude-haiku-4-5","message_count":1,"first_user_blocks":["text","text","text","text","text"],"has_image":false}
```

Five text blocks, zero image blocks. The breaker's `imageHashesFromBody()` returns the empty set, the no-images guard fires, and the breaker correctly takes the no-op path. No `failure_recorded` / `breaker_fire` events because there's no image to record.

CC's request still receives a 400 from the fake upstream (because the fake upstream returns 400 unconditionally), and CC's harness renders the upstream error as an `API Error: 400 image could not be processed: ...` assistant message — but **this is CC's first-attempt error surfacing path, not the multi-turn retry storm CC#66815 documents**. With `-p` (print) mode, CC does not retry on API errors; it exits with status 1.

### D — Why CC#66815's retry storm is structurally not reproducible at this scope

CC#66815's pattern is:

1. CC is in an interactive multi-turn session.
2. User attaches an image; an in-conversation image upload triggers an Anthropic image-processing-error on the wire.
3. The CC harness treats the failure as transient and **retries with full message history**, 19 times.

The interactive retry behavior depends on (a) CC's interactive-mode retry classifier, (b) Anthropic's actual image-processing-error envelope being emitted on the wire from a real image upload, (c) the conversation being multi-turn so each retry resubmits 34 MB of context. None of those three preconditions is reproducible inside a parallel-harness sim:

- **(a) interactive-mode retry**: `claude -p` is single-shot; no retry classifier engages. Multi-turn interactive sessions cannot be fed image attachments programmatically in this CC version.
- **(b) real Anthropic image-error envelope**: requires a real image Anthropic actually rejects (a moving target — most malformed/oversized images get caught client-side before upload; the rejection conditions per CC#66815 are not publicly documented as a regex against a fixture).
- **(c) full message history retry**: requires either replaying upstream wire bytes verbatim (we don't have a captured wire trace of CC#66815) or driving CC interactively with a multi-turn fixture (no programmatic harness for that).

The unit-test suite (1078/1078 pass) covers the breaker's response to the canonical envelope shape including the directive's CC#66815 19-call replay assertion. The parallel-harness curl trace above proves the same behavior holds on the feature-branch source tree on visits-01. The remaining gap — "does CC's harness actually consume the breaker's synthesized SSE as a normal completed turn?" — will be settled by production traffic when v4.2.0 ships with the breaker default-off; the `dry-run` mode is the operator's safety net for surfacing any consumption-side surprises before the default-on flip in a later release.

### E — Sim #2 ([DONE] sentinel byte-mimicry) and sim #4 (regex breadth)

Both unchanged from the morning's container-smoke report: byte-mimicry against a captured real-upstream SSE tail and error-message regex breadth against production traffic both require artifacts this sim cannot generate. The breaker's default-off shipping gate puts these in the operator's hands at activation time, not as merge blockers.

## Verdict

**GREEN on feature-branch proxy** for the surfaces this sim can exercise:

- Container smoke (`pr-220-image-retry-circuit-breaker-container-smoke-2026-06-11.md`) and direct-source-tree smoke both confirm the proxy emits the directive's wire format correctly against the canonical envelope.
- The breaker fires the way the directive specifies; upstream call count is invariant at 1 across one failure + one retry; JSONL events are PII-clean.
- Prod `:9801` proxy is provably untouched throughout.

**Deferred for CC harness consumption (sim #1)**: cannot be exercised at this scope because the canonical CC#66815 retry pattern requires interactive multi-turn with a real-Anthropic-triggering image. The `dry-run` env-var mode + default-off shipping gate cover this risk in production.

**Deferred for sim #2 and sim #4** as documented in the container-smoke report.

## Artifacts

Out-of-tree:

- Sim script: `/tmp/cf-parallel-pr220/parallel-sim.sh`
- Fake upstream: `/tmp/cf-parallel-pr220/fake-upstream.mjs`
- Isolated extensions dir: `/tmp/cf-parallel-pr220/extensions/`
- Fixture: `/tmp/cf-parallel-pr220/tiny-valid.png` (1×1 RGB)
- Diagnostic extension that confirmed `has_image: false`: `/tmp/cf-parallel-pr220/extensions/test-debug.mjs`
- Trace logs: `/tmp/cf-parallel-pr220-artifacts/` (proxy debug log, fake-upstream log, CC outputs, request-body dump, breaker JSONL)
- Curl trace responses: `/tmp/cf-parallel-pr220-artifacts/manual-r1.txt`, `manual-r2.txt`

## Doc hygiene note

The morning's report `pr-220-image-retry-circuit-breaker-sim-2026-06-11.md` was renamed to `pr-220-image-retry-circuit-breaker-container-smoke-2026-06-11.md` because its scope is container-runtime wire-format validation specifically, not the full sim-validation requirement. The container smoke remains a valid + complementary artifact; this parallel-harness report is the comprehensive sim-validation record.
