# Review: PR 94 Session Serializer Directive Rereview

Date: 2026-04-30
Reviewed: `docs/directives/proxy-session-serializer.md` at `22609cc`
Label applied: `changes-requested`

## What Is Correct

- The directive now scopes the missing terminal-response seam into Phase 0 instead of hand-waving it away. [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:52) adds `onResponseEnd(ctx)` with the right four termination paths called out, and the file map at [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:191) now includes `proxy/pipeline.mjs`, `proxy/server.mjs`, and `proxy/stream.mjs`.
- The decision rule is now materially more defensible. The success-criteria table and the new decision-rigor section require at least 50 samples in both populations, use Wilson 95% confidence intervals, and distinguish `OBSERVABLE`, `NOT_OBSERVABLE`, and `INSUFFICIENT_DATA` rather than treating a bare 2x ratio as enough. See [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:161) and [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:166).
- The privacy contract is substantially better. The directive no longer derives `session_key` from prompt text; it now limits inputs to structural fields plus a process-side ephemeral salt, documents the false-merge tradeoff honestly, and adds the right load-bearing tests for prompt independence, restart rotation, and prompt-string absence in JSONL output. See [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:109), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:149), and [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:242).
- The previously-correct top-level choices remain intact: the two-phase split is still the right shape, the deferred draft stays preserved rather than overwritten, and Phase 0 remains observational rather than mutating request bodies.

## Blockers

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:86), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:151), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:238): the directive still contradicts itself on the same core seam it just fixed. The scope, success criteria, file map, and tests now say Phase 0 adds a new `onResponseEnd` pipeline hook and that upstream-error is one of the terminal outcomes. But the out-of-scope section still says the response-complete hook is out of scope and that Phase 0 can rely on callbacks "already available to extensions"; the telemetry section still omits `error` from the documented `outcome` enum; and the pipeline sketch still says "either approach is acceptable" if the unified callback does not exist. Those stale sections re-open the exact ambiguity the blocker fix was meant to close. The directive needs one consistent source-of-truth position: Phase 0 adds `onResponseEnd`, and `error` is a first-class outcome everywhere the contract is documented.

## What Needs Attention

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:166), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:283), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:299): the Codex blocker references are misnumbered as "review #1" in both the hook and decision-rigor sections even though they address different prior findings. Not blocking, but worth cleaning up so future readers do not have to reverse-map which fix is being discussed.
- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:301), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:302): the reviewer-checklist test references were not renumbered after the new tests were inserted. The checklist still points to tests 5-9 and 10-14 even though collision and outcome checks now live at 8-12 and 18-23.

## Recommendations

- Remove the stale "out of scope" and "either approach is acceptable" language, and make every section reflect the same Phase 0 contract: `onResponseEnd` is added in `proxy/pipeline.mjs` and wired through `proxy/server.mjs`.
- Update the telemetry contract so `outcome` includes `error` anywhere the enum is listed, not just in tests and scope text.
- Clean up the review-fix numbering and stale checklist test references while touching the directive so the document remains internally navigable.

## Bottom Line

Two of the three original blockers are fixed cleanly, and the third is mostly fixed in the right places. I cannot approve the directive yet because the document still contains contradictory instructions about whether the new response-end seam is in scope at all and whether `error` is part of the outcome contract. Resolve those stale sections and this should be approvable for directive stage.
