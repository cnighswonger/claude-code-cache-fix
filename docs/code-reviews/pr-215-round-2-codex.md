Verdict: REQUEST_CHANGES

## Round-1 -> round-2 status table

| Item | Status | Note |
| --- | --- | --- |
| B1 | ADDRESSED | The directive now defines a single normalized request-side stash `ctx.meta._workflowAgentId = { id, parentId, source }`, stashes the canonical header path explicitly, makes `usage-log` read only that stash, and adds the Task-subagent canonical-priority test path (`docs/directives/proxy-workflow-agent-id-synthesis.md:12-20`, `:171-210`, `:253-260`; `proxy/stream.mjs:63`; `proxy/extensions/cache-telemetry.mjs:170-179`). |
| B2 | PARTIALLY ADDRESSED | The round-3 rewrite is more honest about sequencing and removes the fake `#TBD`, but it still does not point to a concrete meter issue, PR, branch, or commit: it names a future directive `meter-agent-id-schema-addition` while also stating the meter PR is not yet open, and I could not find a matching tracker or branch in `cnighswonger/claude-code-meter` (`docs/directives/proxy-workflow-agent-id-synthesis.md:135-143`). |
| A1 | ADDRESSED | Drift canary and event logging moved out of disabled `request-log.mjs` and into the always-loaded synthesis extension, with the old `request-log` assignment explicitly removed (`docs/directives/proxy-workflow-agent-id-synthesis.md:212-238`, `:277-283`; `proxy/extensions/request-log.mjs:3-21`; `proxy/extensions.json:19`). |
| A2 | ADDRESSED | The directive now uses order `365`, and committed `main` still has `thinking-display` at `360` and `cache-control-normalize` at `400`, so the tie is gone (`docs/directives/proxy-workflow-agent-id-synthesis.md:165-169`; `proxy/extensions.json:13-14`). |
| A3 | ADDRESSED | The catalog example now includes the required `marker_id` field and explains that it, not raw marker text, is the hash input (`docs/directives/proxy-workflow-agent-id-synthesis.md:69-88`). |
| A4 | ADDRESSED | `first-user-message` markers are no longer accepted on trust: the directive now requires `first_message_authorship: "tool"` plus binary-inspection proof before such entries may enter the catalog (`docs/directives/proxy-workflow-agent-id-synthesis.md:78-81`, `:240-249`, `:255`). |
| P1 | PARTIALLY ADDRESSED | The new operator-attestation paragraph is correct, but the release-ordering bullet just above it still says older meter installs see no row changes "regardless of the env-var," which implies a runtime floor check the directive itself says cannot exist (`docs/directives/proxy-workflow-agent-id-synthesis.md:136-141`). |
| P2 | ADDRESSED | The `usage-log.mjs` wording now matches the committed tree: `usage-log` is an operator-added extension entry, not something already present in `main` (`docs/directives/proxy-workflow-agent-id-synthesis.md:167-169`; `proxy/extensions.json:1-20`; `proxy/extensions/usage-log.mjs:34-44`, `:267-271`). |
| P3 | ADDRESSED | The front matter now distinguishes the actual directive branch from the planned implementation branch (`docs/directives/proxy-workflow-agent-id-synthesis.md:6`). |
| P4 | ADDRESSED | The `test/extensions/` subdirectory is now called out as a deliberate convention shift rather than an incidental path choice (`docs/directives/proxy-workflow-agent-id-synthesis.md:151-159`). |

## New issues

- The meter-rollout section now contradicts itself on the load-bearing safety contract. Line 136 says older meter installs see no row changes "regardless of the env-var," but lines 141-143 correctly say there is no runtime version probe and the env var is only operator attestation. Those cannot both be true; the directive should keep the operator-attestation model and delete the impossible invariant claim.

## Bottom Line

The round-3 rewrite closes the original canonical-source blocker cleanly and resolves the event-log, ordering, catalog-shape, first-user-message, branch, and test-layout concerns. I am still at `REQUEST_CHANGES` because the meter dependency remains untracked in any concrete external artifact: the directive now names a future meter directive, but it still provides no issue, PR, branch, or commit that reviewers or implementers can anchor to before this directive advances. Tighten the meter prerequisite into a real tracker and remove the contradictory "older meter sees no row changes regardless of env-var" sentence, then this should be ready for approval.

— Codex review
