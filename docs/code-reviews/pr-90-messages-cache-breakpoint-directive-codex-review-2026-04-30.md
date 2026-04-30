# Review: messages[0] cache breakpoint #3 injection directive

Date: 2026-04-30
Reviewed: `docs/directives/proxy-messages-cache-breakpoint.md`
Label applied: `changes-requested`

## What Is Correct

- The activation model is specified in the repo's working shape: `enabled: true` in `proxy/extensions.json` plus a runtime env gate. That matches the established `prefix-diff` pattern used by `overage-warning`, `upstream-change-detection`, and the current `image-strip` extension.
- Order `410` is the right slot. Running immediately after `cache-control-normalize` at `400` gives this extension a normalized user-marker baseline before it decides whether breakpoint #3 can be added, and it still runs before `ttl-management` at `500` fills in missing TTLs.
- The hard cap at 4 total `cache_control` markers is the correct safety invariant. Skipping when the pre-injection count is already `4` prevents the extension from turning a valid request into a guaranteed `400`.
- Keeping the `messages[0] -> system[]` migration and VS Code breakpoint #2 recovery out of scope is the right cut for this directive. Both are materially different changes with larger blast radius than the narrow breakpoint-#3 injection proposed here.
- The general "fail open by under-detecting rather than over-detecting" posture is the correct safety principle for a classifier that may touch user-visible prompt structure.

## Blockers

- The detection taxonomy is incomplete for the repo's own observed attachment bundle, so the boundary algorithm can land too early and leave part of the auto-injected prefix uncached. The directive treats the auto-injected set as `skills`, `CLAUDE.md`, `deferred-tools`, and `MCP`, but the existing preload code and docs consistently describe the `messages[0]` attachment bundle as `hooks, skills, deferred-tools, MCP` as well ([preload.mjs](/home/manager/git_repos/claude-code-cache-fix/preload.mjs:6), [preload.mjs](/home/manager/git_repos/claude-code-cache-fix/preload.mjs:1020), [docs/extension-impact-guide.md](/home/manager/git_repos/claude-code-cache-fix/docs/extension-impact-guide.md:173)). A request shaped as `[skills, hooks, user-text]` would be classified today as boundary `0` instead of `1`, which is the wrong breakpoint position. The spec needs to enumerate every observed CC-injected block kind it intends to treat as prefix content, and the signature table needs tightening where it is currently vague or incorrect (`Contents of [^/]+/CLAUDE\.md` does not match normal absolute paths, and "an MCP server enumeration" is too underspecified for a safe classifier).
- The required fixture source is impossible as written. The directive says classification tests should use real block text "dumped via `CACHE_FIX_DUMP_BREAKPOINTS`", but that diagnostic only records blocks that already have `cache_control` markers ([preload.mjs](/home/manager/git_repos/claude-code-cache-fix/preload.mjs:2505)). The whole point of this directive is that the `messages[0]` skills / CLAUDE.md / deferred-tools / MCP span is missing breakpoint #3, so those blocks will not appear in that dump. As written, the implementation reviewer cannot satisfy the "at least 5 fixture blocks from real `CACHE_FIX_DUMP_BREAKPOINTS` output" requirement. The directive needs to name a source that actually captures the unmarked blocks, such as raw OTEL body logs or a dedicated full-body dump.

## What Needs Attention

- The `0 markers -> skip` decision is defensible, but the rationale should be stated more narrowly: it is safe because this extension is intentionally CC-specific and opt-in, not because a lone marker is inherently useless. A single marker could still create a cache boundary on some shapes; the real reason to skip is "unexpected/non-CC request baseline, avoid guessing."
- The skip-reason contract is not fully aligned across sections. The prose says `unexpected_role`, the pseudocode uses `unexpected_role_or_shape`, and the test plan never exercises that branch. The directive should settle on one literal value and add a test for it.
- Test coverage is close but not complete. The current plan omits an explicit role/shape guard test, a hook-classification test if hooks remain in scope, and a case proving the classifier does not over-match ordinary user text that mentions MCP, skills, or `CLAUDE.md`.
- The reviewer checklist is mostly actionable, but the fixture requirement needs the same source correction as the implementation section or it will force the reviewer to check an unfulfillable condition.

## Recommendations

- Revise the detection section to define the complete observed auto-injected block set first, then provide concrete, dump-backed signatures for each kind. If hooks are intentionally excluded, say why that is safe and cite evidence that they are absent from the current breakpoint-#3 problem shape.
- Replace the CLAUDE.md and MCP signatures with concrete patterns that are specific enough to avoid over-detection and broad enough to match real request paths.
- Replace the `CACHE_FIX_DUMP_BREAKPOINTS` fixture requirement with a source that actually exposes unmarked `messages[0]` blocks, or add a new diagnostic that dumps full `messages[0].content` safely for fixture capture.
- Add explicit tests for `unexpected_role_or_shape`, unknown-text fail-open behavior, and any newly added block kinds.

## Bottom Line

Revise before implementation. The activation model, ordering, and marker-cap safety are in good shape, but the current detection spec does not yet cover the full observed attachment bundle, and the test-fixture requirement depends on a diagnostic that cannot capture the unmarked blocks this directive is about. Those two gaps are directive blockers because they directly affect correctness and reviewability of the eventual implementation.
