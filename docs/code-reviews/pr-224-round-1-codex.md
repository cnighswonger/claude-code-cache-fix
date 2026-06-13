Verdict: REQUEST_CHANGES

# Review: PR #224 directive

Date: 2026-06-13
Reviewed: `docs/directives/proxy-statusline-served-model-divergence.md` at `b14d90f`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- The cited base-file anchors check out against `origin/main` `f697def`: `proxy/server.mjs:127`, `proxy/server.mjs:193`, `proxy/extensions/usage-log.mjs:295`, `proxy/extensions/cache-telemetry.mjs:191-270`, `proxy/pipeline.mjs:115-127`, `tools/quota-statusline.sh:37-42`, and `tools/quota-statusline.sh:188-196` all match the directive's claims.
- Fable r1 A1 and A2 are substantively fixed in the directive text. The design now reads `requestedModel` from `ctx.telemetry?.requestedModel` rather than inventing new plumbing, and it places the divergence detector at `message_delta` inside the existing writer-side try/catch boundary.
- Fable r1 B2's in-process fix is directionally right: the counter is no longer session-only, the entry stores `servedTarget`, and the reset semantics are explicit enough for interleaved background-model traffic.
- The load-bearing classification is correct under `CLAUDE.md:86-94`: this is an additive persisted-schema change plus a new statusline contract. The heredoc-confined Python boundary in `tools/quota-statusline.sh` is also preserved as written.

## Blockers

### 1. Pair-keyed rehydration is still incorrect across `/model` changes plus proxy restart

The round-2 text now says pair state is retained per `(sessionFilename, requestedModel)` so a later return to the original requested model resumes from where it left off (`docs/directives/proxy-statusline-served-model-divergence.md:59`, `docs/directives/proxy-statusline-served-model-divergence.md:173`). But the only persisted rehydration source is still a single top-level session JSON record, and the rehydration rule seeds a map entry from whatever `served_model` / sticky fields happen to be on disk (`docs/directives/proxy-statusline-served-model-divergence.md:108`, `docs/directives/proxy-statusline-served-model-divergence.md:121-130`).

That leaves two correctness holes:

- After a `/model` change, a proxy restart cannot reconstruct dormant state for the earlier requested model, because the file carries only one `requested_model` tuple, not a per-model map.
- Worse, the rehydration rule does not require the persisted `requested_model` to match the current `requestedModel`, so the last-written pair can be rehydrated into the wrong map key after restart.

Concrete failure mode: requested model `A` accumulates state, the session switches to requested model `B`, the proxy restarts, then the session returns to `A`. As specified, the "resume from where it left off" promise no longer holds, and if `B` was the last divergent pair written, `A` can inherit `B`'s sticky/served state.

Fix suggestion: either persist pair-keyed divergence state on disk, or narrow the contract so restart rehydration only applies when the persisted `requested_model` matches the current `requestedModel` and explicitly state that dormant pair counters/sticky do not survive restart. Add a test that covers restart after `/model` change plus return to the original requested model.

### 2. The directive still contains contradictory user-facing contracts, so Fable r1 nit 1 and B1 are not actually closed

Two round-2 fixes were applied in some sections but left contradictory text elsewhere:

- Requested-side-only `[1m]` is the stated rule in Functional Requirement 3, the short-label section, the test plan, and the reviewer checklist (`docs/directives/proxy-statusline-served-model-divergence.md:41-45`, `docs/directives/proxy-statusline-served-model-divergence.md:94`, `docs/directives/proxy-statusline-served-model-divergence.md:175`, `docs/directives/proxy-statusline-served-model-divergence.md:220`), but the reader implementation surface still says to apply the suffix on **both** sides of the arrow (`docs/directives/proxy-statusline-served-model-divergence.md:138-145`). An implementer following the implementation section would reintroduce the exact behavior Fable rejected.
- The sticky-clear semantics are corrected in the heuristic section and checklist (`docs/directives/proxy-statusline-served-model-divergence.md:60`, `docs/directives/proxy-statusline-served-model-divergence.md:226`), but the out-of-scope section still says "Operator removes the per-session JSON file or starts a new session" (`docs/directives/proxy-statusline-served-model-divergence.md:235`). That reintroduces the false recovery path Fable called out.

This is blocking for a directive PR: the document no longer presents one unambiguous contract for implementation or operator expectations.

Fix suggestion: align every section to the same requested-side-only `[1m]` rule, and remove the file-deletion-alone sticky-clear claim everywhere it still appears.

## What Needs Attention

- `docs/directives/proxy-statusline-served-model-divergence.md:110` calls the eviction behavior "LRU-bounded," but the cited base implementation in `proxy/extensions/cache-telemetry.mjs:132-156` is a time-based sweep, not an access-order LRU. That is mostly terminology, but the directive should either describe it as TTL/sweep-based eviction or specify the actual LRU behavior if that is intended.
- The statusline test plan should name the existing harness directly. `origin/main` already has `test/quota-statusline-smoke.test.mjs`, so "or extend the existing statusline test if one is present" can be tightened to that concrete file.

## Bloat / Non-Functional

None.

## Recommendations

- Make restart durability semantics precise: either persist per-requested-model divergence state, or explicitly scope restart rehydration to the last-written pair only and guard it on persisted/current `requested_model` equality.
- Remove the contradictory reader-side `[1m]` sentence and the contradictory sticky-clear sentence so the directive has one authoritative contract.
- Add one restart-plus-`/model` regression test, because that is the gap the current plan misses and it is the exact place the new pair-keyed design can still go wrong.

## Bottom Line

The round-2 draft fixed the major anchor and plumbing problems Fable identified, and the overall design remains viable. But the pair-keyed restart story is still semantically wrong once `/model` transitions enter the picture, and the document still contains contradictory instructions for both `[1m]` rendering and sticky clearing. Those are directive-stage issues, not implementation nits, so this should not advance to the impl PR until they are corrected.

— Codex review
