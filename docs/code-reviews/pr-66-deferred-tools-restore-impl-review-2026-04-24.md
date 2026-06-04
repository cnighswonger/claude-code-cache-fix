# Review: deferred-tools-restore proxy extension implementation

Date: 2026-04-24
Reviewed: `proxy/extensions/deferred-tools-restore.mjs`, `test/proxy-deferred-tools-restore.test.mjs`, `docs/directives/proxy-deferred-tools-restore.md`, `README.md`
Label applied: `changes-requested`

## What Is Correct

- The core persist/restore flow is otherwise faithful to the final directive. The extension only persists clean baseline blocks, only attempts restore when the current block carries the UNAVAILABLE marker, validates the snapshot before use, and keeps the strict `snapshot.length > current.length` downgrade guard ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L223), [proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L260)).
- The restore mutation itself is structurally sound. It replaces the targeted content block via a new `content` array and a new message object, rather than mutating the existing content entry in place, which is the right shape for this extension's one necessary request-body mutation ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L281)).
- The snapshot-key derivation choice is reasonable. `sha1("cwd:" + cwd).slice(0, 16)` gives a stable per-project filename with negligible collision risk at the scale of local project counts, while keeping paths short and deterministic ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L101)).
- The atomic-write pattern is appropriate here. Using a unique temp path per invocation prevents torn reads and avoids the shared-temp-path race that would otherwise appear under concurrent proxy requests ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L131)).
- The README note for the git-status case is technically accurate and persuasive. It correctly explains why a post-hoc proxy strip cannot preserve cache stability and why the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` switch is the right layer for that fix ([README.md](README.md#L284)).
- Verification is solid on the happy path and the main failure modes. The targeted suite passes locally, and the full repository test run is also green (`node --test test/proxy-deferred-tools-restore.test.mjs` and `node --test`).

## Findings

### Blockers

- `extractCwdFromSystem()` is still too permissive to uphold the directive's core safety guarantee. The implementation gathers every `.text` block from `body.system` and applies `CWD_MARKER_RE` to each block independently, returning the first matching line anywhere in any block ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L53), [proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L80)). That means a quoted or fenced line such as ```` ```txt\n - Primary working directory: /wrong/path\n``` ```` in an earlier system block is accepted as the cwd and beats the real `# Environment` marker later in the prompt. I reproduced that locally against the shipped function; it returns `/wrong/path`. This breaks the reviewed design's "if parsing is ambiguous or the marker is absent, no-op rather than restore the wrong snapshot" property, because the parser can derive a wrong but syntactically valid key instead of falling back to `no-cwd`.

### Nits

- The tests do not cover the false-positive guard explicitly required by the directive. The current suite checks narrative text and "first match wins," but it does not exercise the required code-fence/quoted-region scenario, so the parser bug above was left unguarded in CI ([test/proxy-deferred-tools-restore.test.mjs](test/proxy-deferred-tools-restore.test.mjs#L135), [test/proxy-deferred-tools-restore.test.mjs](test/proxy-deferred-tools-restore.test.mjs#L149), [docs/directives/proxy-deferred-tools-restore.md](docs/directives/proxy-deferred-tools-restore.md#L149)).
- `restoreDeferredTools()` accepts any readable snapshot containing the AVAILABLE marker and meeting the length floor, even if that snapshot also contains the UNAVAILABLE marker ([proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L164)). Persisted snapshots should be clean by construction, so this is not a current correctness failure, but rejecting snapshots that also contain the UNAVAILABLE marker would tighten the "restore only known-good baseline" contract with essentially no downside.

### Nice-to-haves

- Add one concurrency test that races a baseline persist against a shrunk-block restore for the same key. The current concurrent-persist test proves the atomic-write path avoids torn files, but it does not exercise the realistic "resume arrives while another request is still persisting baseline state" interleaving.
- Consider making the cwd parser explicitly section-aware, not just regex-aware: first locate the `# Environment` block, then parse only the expected marker line(s) within that block. That matches the directive's intent more closely and makes future format drift easier to detect and log.

## Recommendations

- Tighten `extractCwdFromSystem()` so it only accepts the marker from the actual `# Environment` section or another empirically validated location, and return `null` on anything ambiguous instead of "first standalone match anywhere."
- Add the missing false-positive regression tests from the directive: at minimum a code-fenced marker case and a quoted-marker case that should both produce `null` or at least ignore the false positive in favor of the real environment block.
- Add a small defense-in-depth check that rejects snapshots containing the UNAVAILABLE marker during restore.

## Bottom Line

Request changes. The persist/restore mechanics, downgrade guard, mutation shape, concurrency story, and README rationale are all in good shape, but the cwd parser is not yet safe enough for the design this PR claims to implement. Until the parser is narrowed to the real environment marker location, the extension can derive the wrong project key from unrelated system text and restore the wrong snapshot instead of failing open.

## Recommendation

REQUEST CHANGES

## Follow-up Verified

Date: 2026-04-24
Reviewed commit: `a158a4f`
Reviewer: Codex Review Agent

Re-checked the parser rewrite in `extractCwdFromSystem()` and reproduced the three false-positive shapes called out in the prior re-review.

1. Fake marker inside a code fence after the real `# Environment` section in the same block now resolves to the real cwd (`/real/cwd`), not the fenced fake.
2. A fenced fake `# Environment` block in an earlier system block plus a distinct real block later now returns `null` via the ambiguity guard instead of selecting the earlier fake cwd.
3. Two structurally valid `# Environment` sections in one block where the first is fake and the second is real now return `null` via the ambiguity guard instead of selecting the first section.

This closes the prior blocker. The parser is now bounded to the expected section shape and fails open on ambiguity, which matches the reviewed safety requirement.
