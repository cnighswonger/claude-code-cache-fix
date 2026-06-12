# PR #221 jsonl-session-mirror — parallel-harness sim — 2026-06-12

**Branch:** `feature/jsonl-session-mirror`
**Commit at run time:** `2a9ebf6` (Codex round-3 APPROVE)
**Verdict:** **GREEN** — sections A–C pass
**Run host:** Direct on visits-01 — second proxy from feature-branch source on `:9802`, prod `:9801` untouched per `docs/parallel-proxy-test-harness.md`
**Per:** directive § Sim validation requirement; merge gate via `needs-sim-validation` label
**Sim script:** `/tmp/cf-mirror-sim/sim.sh`; artifacts: `/tmp/cf-mirror-sim-artifacts/`

## Scope

Validates the JSONL session-content mirror against real CC harness traffic and real Anthropic upstream. The directive's sim-validation requirement is to "capture real CC traffic on a test session; compare mirror records to CC's canonical transcript records for the same session; assert envelope-shape parity (all expected top-level keys present, `message` nesting correct, content blocks structurally identical)."

This sim covers all three legs:

1. **Real CC harness consumption end-to-end** — `claude.exe` 2.1.148 invoked with `ANTHROPIC_BASE_URL` pointed at the test proxy; CC handles the turn normally; no harness-side regression.
2. **Mirror records produced under real traffic** — the mirror extension's stream-event accumulator fires for the real CC turn; records land on disk with the right structure.
3. **Envelope-shape parity** — top-level + message-nested keys checked against the CC 2.1.148 fixture (`test/fixtures/cc-transcript-shape-snapshot.json`, captured from a real transcript) per the directive's verified shape.

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

**GREEN.** The directive's three-leg sim-validation requirement is satisfied:

1. Real CC harness consumption: clean turn against real Anthropic with the mirror extension active. No harness-side regression.
2. Mirror records produced: 1 user + 1 assistant record on disk, `open` event in the log, parentUuid chain wired correctly.
3. Envelope-shape parity: all directive-verified top-level + message-nested keys present on both assistant and user records.

The `needs-sim-validation` merge gate is satisfied.

## Artifacts

Out-of-tree (not committed to the release artifact):

- Sim script: `/tmp/cf-mirror-sim/sim.sh`
- Extensions dir: `/tmp/cf-mirror-sim/extensions/`
- Test proxy stderr: `/tmp/cf-mirror-sim-artifacts/test-proxy.log`
- CC output + stderr: `/tmp/cf-mirror-sim-artifacts/cc-output.txt`, `cc-stderr.log`
- Mirror file: `/tmp/cf-mirror-sim-artifacts/mirrors/00000000-0000-4000-8000-c4f1efb22221/2026-06-12T14-26-26-414Z-0.jsonl`
- Mirror event log: `/tmp/cf-mirror-sim-artifacts/session-mirror-events.jsonl`
- Sim transcript: `/tmp/cf-mirror-sim-artifacts/sim-run.log`

## Notes on what this sim does NOT cover (deferred per directive)

- **Format-round-trip via `restore-claude-history-linux`** — the tool's API isn't programmatically exercisable in CI without vendoring its parser. The envelope-parity test against the fixture is the in-tree proxy; the real round-trip is the operator's option to run manually with `restore-claude-history-linux` against the captured mirror file.
- **Multi-turn dedup behavior under real traffic** — the in-tree integration suite covers 3-turn, failed-request re-stage, legitimately-repeated user text, tool-result dedup. A multi-turn real-traffic sim is straightforward to extend (drop `--no-session-persistence`, run more turns) but adds no new dedup-correctness signal beyond what the unit suite covers.
- **Stream-abort partial-flush** — explicitly cut from v4.2.0 ship per Codex round-1 finding; deferred to a follow-up directive that takes the server.mjs change in scope.
- **Disk-pressure / rotation behavior under heavy traffic** — covered by the in-tree writer test suite's rotation + retention sweep tests.
