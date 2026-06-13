Verdict: REQUEST_CHANGES

# Review: PR #226

Date: 2026-06-13
Reviewed: `main...feature/workflow-agent-id-synthesis` at `b8e78c3`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- `proxy/extensions/workflow-agent-id-synthesis.mjs:95-168` implements the three-state request flow the directive wanted: session id required, canonical `x-claude-code-agent-id` checked before marker matching, canonical Task-subagent traffic stashed as `ctx.meta._workflowAgentId = { id, parentId, source: "cc_header" }`, and no `ctx.headers` or `ctx.body` mutation.
- `proxy/workflow-agent-derivation.mjs:23-33` matches the requested hash shape once a discriminator is in hand: `deriveAgentId()` hashes `sessionId + markerId + perLegDiscriminator`, `deriveParentAgentId()` hashes `sessionId + "workflow-root"`, both truncate to 16 hex, and the tests pin `marker_id` rather than raw marker text as the hash input (`test/workflow-agent-derivation.test.mjs:12-49`).
- `proxy/workflow-markers.mjs:30-60` contains the required catalog fields on all three seed entries, with the PR body citing the matching CC `2.1.177` sha256. All seeded entries are `position: "system-prompt"`, so the branch does not introduce an unproven first-user-message marker. `matchWorkflowMarker()` is position-anchored and body-shape aware, and the negative tests cover user-quoted marker text (`proxy/workflow-markers.mjs:63-120`, `test/workflow-markers.test.mjs:39-107`).
- Event-log ownership and rollout wiring match the directive: the writer lives in the synthesis extension, defaults to `~/.claude/workflow-derivation-events.jsonl`, rotates at 5 MB, logs `marker_id` rather than raw marker text on derived records, emits `drift_canary` when conditions 1+2 hold but no marker matches, and keeps `usage-log` emission default-off behind `CACHE_FIX_USAGE_LOG_AGENT_ID` with no runtime meter-version probe (`proxy/extensions/workflow-agent-id-synthesis.mjs:57-78`, `proxy/extensions/workflow-agent-id-synthesis.mjs:115-168`, `proxy/extensions/usage-log.mjs:240-261`).
- The remaining checklist items also line up: helpers stay flat at `proxy/` with no `proxy/lib/`, the deliberate `test/extensions/` convention is already documented in the directive (`docs/directives/proxy-workflow-agent-id-synthesis.md:150-165`), the extension is registered at order `365` (`proxy/extensions.json:13-15`), and the CHANGELOG calls out CC#66761, the meter `v0.8.0` floor, the env-var rollout, and the attestation-breach symptom (`CHANGELOG.md:7`).

## Blockers

### 1. The per-leg discriminator does not satisfy the directive's load-bearing source requirement

The approved directive made the discriminator source a gating condition: it had to come from a **binary-verified field inside the matched Workflow context block**, and if no such field existed the design was supposed to be rescoped or withdrawn (`docs/directives/proxy-workflow-agent-id-synthesis.md:116-123`, `docs/directives/proxy-workflow-agent-id-synthesis.md:306`). The implementation instead hashes the first user-message text (`proxy/workflow-agent-derivation.mjs:35-57`).

That fallback is reasonable for the narrow, hand-synthesized `parallel()` fixture where each leg carries a different prompt (`test/fixtures/workflow-parallel-fanout-replay.json:2-40`), and the current tests correctly show distinct ids for that shape. But it is not the contract that was approved. It provides no binary-inspection proof that the discriminator source is Workflow-authored context rather than plain prompt text, and it collapses identical-prompt fan-out legs onto one derived id. The code comments acknowledge that collision mode (`proxy/workflow-agent-derivation.mjs:48-51`), but the PR description does not surface it to reviewers or operators; it only says the function hashes first-user-message text and that the tests cover a “distinct/identical input matrix.”

This is blocking because checklist item 306 is still unmet. Either the implementation needs to switch to a discriminator extracted from an actually verified Workflow context field and document that field in the PR body, or the team needs to take the design back to directive stage and explicitly approve the first-user-message fallback and its identical-prompt collision tradeoff before merging code.

## What Needs Attention

- If the first-user-message fallback ends up being the intended product decision, pin the identical-prompt collision behavior with an explicit test and say it plainly in the PR body and CHANGELOG. Right now that tradeoff is only implicit in the code comments.

## Bloat / Non-Functional

None.

## Recommendations

- Re-run the binary-inspection/discovery step specifically for a leg-distinguishing Workflow context field, not just sentinel markers.
- If that field exists, wire `extractPerLegDiscriminator()` to it and update the PR body with the exact field choice and why it survives tools-list churn.
- If that field does not exist, reopen the directive and bless the first-user-message fallback explicitly before this implementation merges, including the identical-prompt collision limitation.

## Bottom Line

Most of the branch is disciplined and matches the directive well: the three-state stash, marker catalog, position anchoring, event-log placement, extension order, and meter rollout contract all check out. But the discriminator source is the one load-bearing place where the implementation does not match the approved design, and the PR description does not disclose the resulting identical-prompt collision behavior. That needs to be resolved before this should merge.

— Codex review
