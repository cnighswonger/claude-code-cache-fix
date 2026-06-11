# PR #220 image-retry-circuit-breaker sim validation — 2026-06-11

**Branch:** `feature/image-retry-circuit-breaker`
**Commit at run time:** `7ce182c` (Codex round-2 APPROVE)
**Verdict:** **GREEN** — sections A–E pass
**Run host:** Docker Engine 29.5.2 (Linux/amd64), Node 22 Alpine container image
**Per:** directive § Sim validation requirement (`docs/directives/proxy-image-retry-circuit-breaker.md:182-190`); merge gate via `needs-sim-validation` label
**Sim script:** `/tmp/cf-sim-pr220/sim.sh` (out-of-tree; reproducible from this report)

## Scope

Validates the image-retry circuit breaker in a container-runtime environment matching the production deployment shape. The unit + integration suite (1078/1078) covers correctness in-process; this sim catches Node/filesystem/container-isolation assumptions that only surface under `node:22-alpine` and confirms the wire format the proxy emits matches the directive's contract.

**The CC binary harness is not exercised in this sim.** The fake upstream stubs the canonical Anthropic image-processing-error envelope; the synthesized SSE / JSON responses are captured for byte-mimicry comparison against a real-upstream stream tail. The CC-side consumption of the synth (directive sim #1, #2, #4 in part) requires a separate operator-driven traffic capture against the live CC binary, deferred per the explicit out-of-scope section at bottom.

## Test rig

- **Fake upstream** at host `0.0.0.0:9802` (`/tmp/cf-sim-pr220/fake-upstream.mjs`): tiny Node HTTP server, returns canonical Anthropic image-processing-error envelope (HTTP 400 + `{"type":"error","error":{"type":"invalid_request_error","message":"image could not be processed: ..."}}`) for every POST `/v1/messages`. Exposes `GET /__ctl__/state` for the counter assertion.
- **Cache-fix container** built from `feature/image-retry-circuit-breaker` HEAD using the in-tree `Dockerfile`:
  - Image tag `cache-fix-pr220-sim:local`, container name `cf-sim-pr220`
  - `--add-host=host.docker.internal:host-gateway` so the container reaches the host fake upstream
  - `CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:9802`
  - `CACHE_FIX_IMAGE_RETRY_BREAKER=on` (default off in v4.2.0; sim explicitly enables)
  - `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS=300000` (5 min — sim doesn't need to exercise expiry)
  - `-v /tmp/cf-sim-pr220-logs:/home/node/.claude` to capture the JSONL event log on host for assertion
  - `-p 127.0.0.1:9881:9801` to publish without colliding with prod 9801

## Section A — Container boot, `/health`, extension load

- Image built from feature-branch HEAD `7ce182c`
- Container started detached, `/health` returned `{"status":"ok"}` on first poll
- No `[CRITICAL] extension load failed` lines for `image-retry-circuit-breaker` in container logs → extension loaded cleanly via `proxy/pipeline.mjs:loadExtensions()`

**Result: PASS**

## Section B — First image-bearing request → upstream forwarded → JSONL `failure_recorded`

Request: `POST /v1/messages` with `stream:true`, `x-claude-code-session-id: sim-session-pr220-<pid>`, single user message carrying one base64 image (synthetic PNG-headed payload).

- HTTP status: `400` — upstream's image-processing-error envelope passes through to the client unchanged (proxy is read-only on the failure path; the harness still sees the failure).
- Body: `{"type":"error","error":{"type":"invalid_request_error","message":"image could not be processed: the image you submitted is invalid"}}`
- Fake upstream `__ctl__/state` call count: **1**
- JSONL event log after R1:

```json
{"timestamp":"2026-06-11T22:02:54.991Z","event":"failure_recorded","session_id":"sim-session-pr220-1798159","request_signature":"14475836115af4fa","image_hashes":["f9d887b3105da740c7fef12205c97cfba6665671453d88aed7c28c4ca5895215"],"last_failure_at":1781215374991,"request_id":"req_fake_1781215374986"}
```

PII discipline confirmed: hash + session id + signature + timestamp + request id only. No image bytes, no body content, no auth headers in the record (verified by structural assertion in the unit suite + visual confirmation here).

**Result: PASS**

## Section C — Same-image retry (`stream:true`) → SSE short-circuit

Identical request body, same session, same image hash.

- HTTP status: `200`
- `content-type: text/event-stream`
- Body length: 1081 bytes
- All six events present in order: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- `data: [DONE]` sentinel **absent** (matches directive § Synthesized response — wire format default; deferred to byte-mimicry comparison vs real upstream)
- Synthesized `content_block_delta` text:

  ```
  [cache-fix-proxy] Image with content hash f9d887b3 failed processing on the previous attempt. To avoid burning cache_creation tokens on the same failure, this attempt was short-circuited locally. Please drop or replace the image. (See CC#66815. Cooldown: 299999ms.)
  ```

- Fake upstream `__ctl__/state` call count: **still 1** — short-circuit fired locally, no upstream call. This is the directive's load-bearing acceptance assertion ("total upstream calls = 1, not 19").

JSONL event log after R2:

```json
{"timestamp":"2026-06-11T22:02:55.372Z","event":"breaker_fire","mode":"on","session_id":"sim-session-pr220-1798159","request_signature":"14475836115af4fa","image_hashes":["f9d887b3105da740c7fef12205c97cfba6665671453d88aed7c28c4ca5895215"],"retry_count":1,"last_failure_at":1781215375372,"remaining_ms":299999,"request_id":null}
```

**Result: PASS**

## Section D — Same-image retry (`stream:false`) → JSON envelope short-circuit

Identical body except `stream: false`.

- HTTP status: `200`
- `content-type: application/json`
- Body shape (validated by structural assertion):
  - `type: "message"`, `role: "assistant"`, `model: "claude-opus-4-7"`
  - `content[0]`: `{ "type": "text", "text": "[cache-fix-proxy] Image with content hash f9d887b3 ..." }`
  - `stop_reason: "end_turn"`
  - `usage.input_tokens = 0`, `output_tokens = 0`, `cache_creation_input_tokens = 0`, `cache_read_input_tokens = 0`
- Fake upstream call count: **still 1** — short-circuit fired locally on the non-streaming path too.

JSONL `breaker_fire` event written (retry_count = 2).

**Result: PASS**

## Section E — Synthesized SSE byte artifact for byte-mimicry

The synthesized SSE byte tail from Section C is captured at `/tmp/cf-sim-pr220-artifacts/synthesized-sse-tail.txt` for the directive's sim-validation #2: "Compare the synthesized SSE byte tail against a captured real-upstream stream tail" (presence/absence of `data: [DONE]` sentinel).

First 200 bytes (verifies `message_start` shape, model echo, zero usage):

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_synth_3f23e6b480f4623276ab57","type":"message","role":"assistant","model":"claude-opus-4-7","content":[],"stop_reason":null,"sto
```

Last 200 bytes (verifies terminator at `message_stop`, no `[DONE]` trailer):

```
"index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}
```

**Result: ARTIFACT CAPTURED.** Byte-mimicry comparison against a captured real-upstream stream tail is the operator's task (deferred — requires production traffic capture).

## Verdict

**GREEN.** All five sections pass. The image-retry circuit breaker behaves correctly in container-runtime under the canonical Anthropic image-processing-error envelope:

- Container builds and boots cleanly from feature-branch HEAD
- First image-bearing request forwards upstream once and records the failure
- Subsequent retries with the same image short-circuit locally with correct SSE / JSON wire formats
- Upstream call count is invariant at 1 across all retries — the directive's load-bearing replay assertion ("total upstream calls = 1, not 19") is confirmed in the deployment shape
- JSONL event log is PII-clean, written via the host-mounted volume as expected

## Artifacts

Out-of-tree (not committed to the release artifact):

- Sim script: `/tmp/cf-sim-pr220/sim.sh`
- Fake upstream: `/tmp/cf-sim-pr220/fake-upstream.mjs`
- Container build log: `/tmp/cf-sim-pr220-artifacts/docker-build.log`
- Response captures: `/tmp/cf-sim-pr220-artifacts/response-{1,2,3}*`
- Synthesized SSE byte tail: `/tmp/cf-sim-pr220-artifacts/synthesized-sse-tail.txt`
- Host-side JSONL event log: `/tmp/cf-sim-pr220-logs/image-retry-events.jsonl`
- Image built and removed locally — not pushed to a registry; this was a local-validation smoke, not a release-candidate build.

## Deferred to operator's traffic capture

These pieces of the directive's sim-validation requirement cannot be exercised inside this sim because they require either a live CC binary harness or production traffic samples. They are deferred to the operator-side docker capture:

1. **Real CC binary consumption of the synthesized SSE.** This sim validates the wire format the proxy emits; the CC-side consumption check (does the harness's SDK render the synth as a normal completed assistant turn? does the transcript record a single text content block? no transport-error retry?) requires the operator to invoke the real CC binary with `ANTHROPIC_BASE_URL` pointed at this proxy and observe the harness's behavior. Per the parallel-proxy-test-harness doc (`docs/parallel-proxy-test-harness.md`), the `claude.exe` binary is the right vehicle and the test proxy on a non-conflicting port is the standard setup.
2. **Byte-mimicry comparison of the synthesized SSE tail against a captured real-upstream stream tail** (directive § Sim validation #2). The synthesized tail captured in Section E is the artifact; the comparison needs a real-traffic capture of an upstream Anthropic SSE stream tail to determine whether `data: [DONE]` is emitted on the message surface. Per directive N1: if the captured upstream tail emits `[DONE]`, the synth must add it; if absent, the synth's current omission is correct.
3. **Error-class predicate regex breadth against actual production traffic** (directive § Sim validation #4). The `isImageProcessingError` regex `/image (could not be processed|format|content)/i` covers the documented Anthropic family; confirmation that it matches actual production traffic for the "image could not be processed" surface needs a sample of real upstream error envelopes. The fake upstream in this sim emits the documented canonical message verbatim — that proves the predicate handles the documented case, not the breadth of variants.

These three items remain the operator's gate before merge. The sim's GREEN verdict covers everything the sim can cover; (1)–(3) are explicitly out of scope for this sim and called out so the merge gate is judged accurately.

## Notes on what this sim does NOT cover

- Long-running cool-off behavior (entries expiring past TTL). The sim sets `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS=300000` to avoid expiry mid-test; expiry behavior is exercised by unit tests `retry past cool-off window → forwards` and `sliding window: each fire extends cool-off from latest suppressed attempt`.
- LRU eviction under load. Exercised by unit test `LRU eviction drops oldest entry at MAX_ENTRIES cap`.
- Dry-run mode. Exercised by unit test `mode=dry-run → logs breaker_fire but does NOT short-circuit`.
- Multi-image / replaced-bad-image false-positive trade-off. Exercised by unit test `replaced-bad-image+shared-good-image within cool-off → short-circuits (acknowledged trade-off)`.
- Sessionless `"unknown"` bucket cross-contamination per directive § Detection #4. Exercised by unit test `sessionless 'unknown' bucket: cross-signature contamination per directive § Detection #4` (the bug-fix coverage from Codex round-1) + named-session control test.
- Hot-reload behavior (off by default in v4.0+).

If `npm test` (1078/1078) and this sim (GREEN A–E) both green, the operational risk of the image-retry breaker in production is bounded by:

- The three deferred operator-side checks above (CC-binary consumption, SSE byte-mimicry, regex breadth);
- The default-off env-var gate (`CACHE_FIX_IMAGE_RETRY_BREAKER=on` is required to activate);
- The dry-run mode safety net for production debugging without short-circuiting.
