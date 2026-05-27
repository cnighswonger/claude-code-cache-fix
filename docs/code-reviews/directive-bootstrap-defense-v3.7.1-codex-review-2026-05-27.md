# Review: bootstrap-defense v3.7.1 directive

Date: 2026-05-27
Reviewed: `docs/directives/proxy-bootstrap-defense-v3.7.1.md`
Label applied: `changes-requested`

## What Is Correct

- The threat framing is accurate. This is the same bootstrap-response delivery channel with a new env-var-selected consumer pattern layered over the same GrowthBook flag cache.
- Extending `bootstrap-defense` in place is the right scope cut. Both surfaces are visible in the same parsed `/api/claude_cli/bootstrap` response body, so a sibling extension would add coordination cost without buying clearer boundaries.
- The three-mode split is sensible for a patch release. Keeping `audit` as the default and preserving `block` semantics avoids surprising v3.7.0 users, while `allowlist` gives security-forward users an opt-in stronger posture.
- `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=` as an explicit deny-all override is a sound contract in Node: unset and empty string are distinguishable, so the parser can cleanly separate "use default `tengu_heron_brook`" from "strip everything."
- Logging only a hash of the prompt value is the right PII boundary, and truncating SHA-256 to 16 hex chars is adequate for local delta detection and correlation without storing the prompt body itself.
- The proposed `allowlist` mutation point matches the current proxy pipeline. `handleBootstrap` parses the upstream JSON, passes `resCtx.body` through `runOnResponse`, then serializes `resCtx.body` back to the wire, so stripping keys in `onResponse` will flow to Claude Code without extra server changes.

## Blockers

- The schema does not define what happens when both prompt-source keys are present in the same bootstrap response. The directive adds scalar `surface`, `prompt_key`, and `prompt_value_hash` fields, but a single response can carry both `tengu_heron_brook` and the env-selected key. The test plan covers "heron only" and "env-selected only" but omits the simultaneous case. As written, the implementer has to guess whether to drop one surface, emit multiple records, or change the schema. That needs a directive-level decision before implementation.
- The detection prose still names a field that the schema no longer defines. The detection section says env-var presence is captured as `setup_detected`, while the schema section defines `remote_mode` instead. That leaves the implementation contract ambiguous: one field, the other, or both. The directive needs one final name and consistent wording before implementation starts.

## What Needs Attention

- Response-time inspection is the correct in-band detector, but the directive should explicitly call out the stale-cache blind spot. If Claude Code reuses an already-written on-disk GrowthBook cache and no `/api/claude_cli/bootstrap` response traverses this proxy run, v3.7.1 will not emit a fresh audit record. That is a reasonable v3.7.1 scope cut; it just should not be implicit.
- The test path in the directive does not match the repo. The current unit suite is `test/proxy-bootstrap-defense.test.mjs`, not `test/extensions/bootstrap-defense.test.mjs`.
- The test plan should include one integration case in `test/proxy-server-bootstrap.test.mjs` for `allowlist` mode. The unit suite can prove field population and strip logic, but the integration path is what proves a mutated `resCtx.body` is what actually gets serialized back to Claude Code.

## Recommendations

- Resolve the multi-key case explicitly. Either define an aggregate schema that can represent multiple detected prompt sources in one response, or define that `onResponse` emits one audit record per detected prompt-source surface. Then add explicit "both keys present" audit and allowlist tests.
- Replace `setup_detected` with the final chosen field name everywhere in the directive. If `remote_mode` is the contract, use that name consistently and drop the stale term entirely.
- Add one sentence to the directive that stale on-disk cache reuse without a bootstrap fetch is out of scope for v3.7.1, then correct the unit-test path and add the end-to-end allowlist test target.

## Bottom Line

Revise before implementation. The architecture call itself is sound: same delivery channel, in-place extension, unchanged default posture, and the `allowlist` insertion point fits the existing proxy server flow. But the directive still leaves the multi-key audit contract undefined and uses conflicting field names for the secondary env-var signal. Those two gaps are implementation-shaping enough that this directive-stage PR should stay in `changes-requested` until they are resolved.
