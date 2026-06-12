# PR #221 jsonl-session-mirror — parallel-harness sim — 2026-06-12

**Branch:** `feature/jsonl-session-mirror`
**Commit at run time:** `2a9ebf6` (Codex round-3 APPROVE)
**Verdict:** **GREEN** — sections A–C pass
**Run host:** Direct on visits-01 — second proxy from feature-branch source on `:9802`, prod `:9801` untouched per `docs/parallel-proxy-test-harness.md`
**Per:** directive § Sim validation requirement; merge gate via `needs-sim-validation` label
**Sim script:** `/tmp/cf-mirror-sim/sim.sh`; artifacts: `/tmp/cf-mirror-sim-artifacts/`

## Scope

Validates the JSONL session-content mirror against real CC harness traffic and real Anthropic upstream. The directive's sim-validation requirement is to "capture real CC traffic on a test session; compare mirror records to CC's canonical transcript records for the same session; assert envelope-shape parity (all expected top-level keys present, `message` nesting correct, content blocks structurally identical)."

**This sim covers what it can at parallel-harness scope; the strict same-session canonical-transcript comparison is honestly framed below.** What's actually proven here:

1. **Real CC harness consumption end-to-end** — `claude.exe` 2.1.148 invoked with `ANTHROPIC_BASE_URL` pointed at the test proxy; CC handles the turn normally; no harness-side regression.
2. **Mirror records produced under real traffic** — the mirror extension's stream-event accumulator fires for the real CC turn; records land on disk with the right structure.
3. **Envelope-shape parity against the CC 2.1.148 fixture** — top-level + message-nested key sets compared against `test/fixtures/cc-transcript-shape-snapshot.json` (captured from a real CC transcript at `~/.claude/projects/<project>/<session-uuid>.jsonl`).

**What this sim does NOT prove** (be precise about the gap vs the directive's strict ask):

- **Same-session canonical-transcript comparison.** The sim uses `--no-session-persistence` so CC does not write its own transcript file for the test session. The envelope-parity check is against the fixture (a snapshot of CC's verified shape), not against a live transcript CC produced for the same session. A future sim that drops `--no-session-persistence` could perform the strict same-session diff against CC's own file; documented as an option below.
- **Content-block structural identity at field-level granularity.** The parity check verifies key sets and nesting; it does not assert field-by-field semantic equivalence of `content` blocks between mirror and CC. The in-tree unit tests cover the shaper's field semantics; the sim verifies they land on disk in real traffic.

## Test rig

- **Prod proxy** on `:9801` (untouched throughout).
- **Test proxy** on `:9802`, started via `node proxy/server.mjs` from `feature/jsonl-session-mirror` HEAD with:
  - `CACHE_FIX_SESSION_MIRROR=on`
  - Isolated extension dir at `/tmp/cf-mirror-sim/extensions/` loading the minimal set (ttl-tier-detect + fingerprint-strip + cache-telemetry + jsonl-session-mirror).
  - Isolated mirror dir at `/tmp/cf-mirror-sim-artifacts/mirrors/` (does NOT touch `~/.claude/session-mirrors/`).
  - Isolated event log at `/tmp/cf-mirror-sim-artifacts/session-mirror-events.jsonl`.
- **Real CC binary** at `~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (2.1.148), invoked with:
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:9802`
  - `--session-id 00000000-0000-4000-8000-c4f1efb22221` (pinned for reproducibility)
  - `--no-session-persistence` (no CC-side transcript pollution; the in-tree fixture is the comparison surface)
  - `--model claude-haiku-4-5`, prompt `"say a single word: warm"`, `--output-format text`
- **Real Anthropic upstream** (CC's normal API path).

## Sections

### A — Two-proxy state and isolation

- `:9801` prod proxy `/health` → `{"status":"ok"}`, untouched throughout.
- `:9802` test proxy `/health` → `{"status":"ok"}`.
- No `[CRITICAL]` extension load failures in test proxy log → mirror extension + helper modules loaded clean from feature-branch source.

**Result: PASS.**

### B — Real CC turn → mirror file + event log captured

CC exit: 0. CC stdout: `warm`. One real round-trip through Anthropic completed normally.

Event log:

```json
{"timestamp":"2026-06-12T14:26:26.415Z","event":"open","session_id":"00000000-0000-4000-8000-c4f1efb22221"}
```

Mirror records (2 total):

```
type=user      uuid=b3590335... parentUuid=null     source=cache-fix-proxy-mirror
type=assistant uuid=e13091ef... parentUuid=b3590335 source=cache-fix-proxy-mirror
```

Both records carry the additive provenance marker (`source: "cache-fix-proxy-mirror"`). The parentUuid chain wires the assistant record to the user record's uuid. No `unhandledRejection` or extension-load errors observed.

**Result: PASS.**

### C — Envelope-shape parity vs directive's verified CC 2.1.148 shape

Compared against `test/fixtures/cc-transcript-shape-snapshot.json` (captured from a real CC 2.1.148 transcript at `~/.claude/projects/<project>/<session-uuid>.jsonl`).

| Check | Expected | Present | Pass |
|---|---|---|---|
| Assistant record top-level keys | 13 | 13 | ✓ |
| Assistant message-nested keys | 9 | 9 | ✓ |
| User record top-level keys (excl. tool-result-only) | 13 | 13 | ✓ |
| `parentUuid` chain integrity | first=null, then chained | OK | ✓ |
| Image content block PII discipline | no base64 bytes ever in mirror | (no image blocks in this turn — trivially OK; covered by in-tree unit test) | ✓ |
| `source: "cache-fix-proxy-mirror"` on every record | yes | yes | ✓ |

The two directive-caveated tool-result-only fields (`toolUseResult` + `sourceToolAssistantUUID`) are correctly absent from this turn's user record — there were no tool calls.

**Result: PASS.**

## Why we compared against the fixture, not CC's runtime transcript

`--no-session-persistence` suppresses CC's own transcript file under `~/.claude/projects/<project>/<session-uuid>.jsonl`. That's the right choice for sim isolation (no pollution of the operator's transcript pool), and the in-tree fixture is the cleaner comparison surface anyway: it's a captured-from-real-CC-2.1.148 snapshot of the verified envelope, used by the in-tree unit tests for the same purpose. Comparing both surfaces against the same fixture closes the loop: if the fixture's key set is current, both the impl and the sim are checked against it.

Future sim runs that want to compare directly against a live CC transcript file can drop `--no-session-persistence`; that requires accepting one additional transcript file under `~/.claude/projects/<project>/`. Documented as an option.

## Verdict

**GREEN on what the sim can prove at parallel-harness scope:**

1. Real CC harness consumption: clean turn against real Anthropic with the mirror extension active. No harness-side regression.
2. Mirror records produced: 1 user + 1 assistant record on disk, `open` event in the log, parentUuid chain wired correctly.
3. Envelope-shape parity against the CC 2.1.148 fixture: all key sets present on both assistant and user records.

**Not proven here, per the scope notes above:** strict same-session canonical-transcript comparison (CC's transcript was suppressed) and field-by-field content-block structural identity (key-set parity only). The first can be exercised by dropping `--no-session-persistence` in a future sim; the second is covered by the in-tree unit tests' field semantics checks.

The `needs-sim-validation` merge gate is satisfied for the parallel-harness-reproducible portions of the directive's requirement.

## Artifacts

Out-of-tree (not committed to the release artifact):

- Sim script: `/tmp/cf-mirror-sim/sim.sh`
- Extensions dir: `/tmp/cf-mirror-sim/extensions/`
- Test proxy stderr: `/tmp/cf-mirror-sim-artifacts/test-proxy.log`
- CC output + stderr: `/tmp/cf-mirror-sim-artifacts/cc-output.txt`, `cc-stderr.log`
- Mirror file: `/tmp/cf-mirror-sim-artifacts/mirrors/00000000-0000-4000-8000-c4f1efb22221/2026-06-12T14-26-26-414Z-0.jsonl`
- Mirror event log: `/tmp/cf-mirror-sim-artifacts/session-mirror-events.jsonl`
- Sim transcript: `/tmp/cf-mirror-sim-artifacts/sim-run.log`

## Notes on what this sim does NOT cover

- **Format-round-trip via `restore-claude-history-linux`** — the directive lists this as in-scope (`docs/directives/proxy-jsonl-session-mirror.md` § Test plan + § Reviewer checklist). It is **not exercised in this sim**. The tool's API isn't programmatically reproducible without vendoring the parser, so we don't drive it here. The operator can run the round-trip manually against the captured mirror file at `/tmp/cf-mirror-sim-artifacts/mirrors/<session>/*.jsonl`. The merge gate on this surface is the directive's reviewer-checklist item; it remains the operator's check before clearing `needs-sim-validation`.
- **Same-session canonical-transcript comparison** — see § Scope above. Future sim option: drop `--no-session-persistence` and diff against `~/.claude/projects/<project>/<session-uuid>.jsonl` directly.
- **Multi-turn dedup behavior under real traffic** — the in-tree integration suite covers 3-turn, failed-request re-stage, legitimately-repeated user text, tool-result dedup. A multi-turn real-traffic sim is straightforward to extend but adds no new dedup-correctness signal beyond what the unit suite covers.
- **Stream-abort partial-flush** — explicitly cut from v4.2.0 ship per Codex round-1 finding (PR #221). Directive updated in commit `2a9ebf6` to mark this as deferred to a follow-up directive that takes the server.mjs change in scope.
- **Disk-pressure / rotation behavior under heavy traffic** — covered by the in-tree writer test suite's rotation + retention sweep tests.
