# Review: upstream change detection directive (re-review)

Date: 2026-04-25
Reviewed: `docs/directives/proxy-upstream-change-detection.md`
Label applied: `changes-requested`

## What Is Correct

- The activation-model blocker is fixed. The directive now uses the `prefix-diff` pattern: `enabled: true` in config plus an early `CACHE_FIX_UPSTREAM_DETECTION=1` gate inside `onRequest()`, which is compatible with the current loader behavior in [proxy/pipeline.mjs](proxy/pipeline.mjs#L24) ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L50)).
- The fingerprint design is now materially content-free. Parsed marker names and extracted reminder tags were replaced with allowlist-index hashes, counts, and boolean unknown-presence detectors, and the directive explicitly states that the unknown detectors record only existence, never matched text ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L76), [docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L153)).
- The timestamp/equality contradiction is fixed. Timestamps now live only in event records, while fingerprint equality is defined over the structural payload itself ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L173)).
- The hook lifecycle is now explicit enough for implementation handoff: module-load state, `onRequest()` behavior, hot-reload behavior, and persisted-vs-memory state are each called out directly ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L59)).
- The throttle nit is addressed appropriately by removing it from v3.2.0 scope and documenting the rationale, and the test path is corrected to `test/` ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L273), [docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L302)).
- The directive now includes the requested unit-level privacy guardrail: test item 18 explicitly asserts that a planted secret string never appears in the serialized fingerprint ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L250)).

## Blockers

- The JSONL atomicity contract is still not defensible as written. The directive now names a mechanism, but it cites the wrong kernel guarantee: `PIPE_BUF` atomicity applies to pipes/FIFOs, not regular-file appends, so "`appendFile` + `O_APPEND` + `PIPE_BUF`" does not prove "no interleaving, no truncation" for `~/.claude/upstream-changes.jsonl` ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L222)). `O_APPEND` does give atomic end-of-file positioning for each write, but this section currently overstates what POSIX guarantees for regular files, and the 4 KB bound is tied to the wrong concept. Since my prior blocker asked for a concrete, defensible write contract, this revision is closer but still not there.

## What Needs Attention

- The baseline-file contract is now concrete and stronger than the current `prefix-diff` helper because it adds `fsync` and tmp cleanup in `finally`; that is fine, but the reference to "same pattern as `prefix-diff.atomicWriteJson`" should be read as conceptual rather than literal, because the current helper does not yet implement those extra steps ([docs/directives/proxy-upstream-change-detection.md](docs/directives/proxy-upstream-change-detection.md#L218), [proxy/extensions/prefix-diff.mjs](proxy/extensions/prefix-diff.mjs#L144)).

## Recommendations

- Revise the JSONL section so it relies on a regular-file guarantee that is actually true for the intended platforms, or change the persistence design. Two valid paths are:
  - keep JSONL, but justify it in terms of a single `write()` to a regular file opened with `O_APPEND`, without invoking `PIPE_BUF`, and scope the claim to the local filesystems/platforms the project supports;
  - or switch the event log to a publication model with stronger atomicity semantics, such as segmented files written via tmp+rename.
- If the design keeps JSONL append, tighten the record-size claim as well. Right now a `structural_change` record includes `diff`, `previous`, and `current`; the directive should justify why that payload stays within whatever bound the chosen contract relies on, instead of assuming it.

## Bottom Line

Most of the previous review is now resolved. The revised directive fixes the activation model, removes content-bearing fields from the fingerprint, separates timestamps from fingerprint equality, adds an explicit hook lifecycle table, removes throttle scope, corrects the test path, and adds the requested secret-string privacy test. I am still requesting changes because the JSONL atomicity section now cites `PIPE_BUF` as if it governs regular-file appends, which it does not. Tighten that contract and this directive should be ready to approve.

## Verdict

REQUEST CHANGES
