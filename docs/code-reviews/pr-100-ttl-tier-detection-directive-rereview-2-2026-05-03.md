# Review: TTL tier detection directive

Date: 2026-05-03
Reviewed: docs/directives/proxy-ttl-tier-detection.md
Label applied: changes-requested

Verdict: changes-requested

## What Is Correct

- Moving detection into a separate `ttl-tier-detect` extension at order `75` fixes the substantive preload-parity blocker from the prior review. `upstream-change-detection` is read-only in practice: its `onRequest` passes `ctx.body` into `_processRequest(...)` and persists observations, but does not assign back into `ctx.body` or `ctx.body.messages` (`proxy/extensions/upstream-change-detection.mjs:498-516`).
- The spot-checked post-75 extensions named in the directive do not introduce a new hidden `cache_control` loss path beyond the already-known ones. `output-efficiency-rewrite` only rewrites `body.system` text while preserving block fields (`proxy/extensions/output-efficiency-rewrite.mjs:30-39`); `image-strip` only rewrites image/tool-result content and preserves parent blocks via spread (`proxy/extensions/image-strip.mjs:88-110`, `146-169`); `sort-stabilization` only rewrites system text and sorts `body.tools` (`proxy/extensions/sort-stabilization.mjs:40-58`); `tool-input-normalize` only replaces `tool_use.input` (`proxy/extensions/tool-input-normalize.mjs:47-56`); `smoosh-split` only rewrites `tool_result.content` strings and appends text reminders (`proxy/extensions/smoosh-split.mjs:8-42`); `content-strip` filters selected blocks but does not destructure away `cache_control` (`proxy/extensions/content-strip.mjs:40-62`); `deferred-tools-restore` only swaps text back into an existing block (`proxy/extensions/deferred-tools-restore.mjs:344-347`). `microcompact-stability` can mutate tool-result content, but not `cache_control` (`proxy/extensions/microcompact-stability.mjs:347-409`).
- Test direction is improved. Rewording the pipeline cases around observable state (`ctx.meta._ttlTier`, final injected `ttl` values, canonicalized structure) is the right way to avoid brittle “ran first” assertions.
- Test #20’s chosen contract is defensible and consistent with preload behavior. In `preload.mjs`, `ttlValue === "none"` skips injection, but the detected tier still exists independently and is only consulted when injection is not skipped (`preload.mjs:2450-2459`). Keeping detection active while `none` suppresses mutation is therefore consistent with the source behavior being ported.

## Blockers

- The directive is still internally inconsistent in implementation-significant ways. The revised design says `ttl-tier-detect` must run at order `75` (`docs/directives/proxy-ttl-tier-detection.md:23`, `62-68`, `108-109`), but the acceptance criteria still require it to “run at order 350” (`docs/directives/proxy-ttl-tier-detection.md:177-183`). That is not a cosmetic typo: this PR is a directive for implementation, and the stale acceptance line points directly back to the previously rejected design.
- The “full audit” is not accurate enough yet to serve as proof against the live pipeline it cites. The directive says the integration tests should exercise the real `proxy/extensions.json` order (`docs/directives/proxy-ttl-tier-detection.md:150-152`), but several audit-table entries do not match that config or the actual loaded registry: `content-strip` is `330` in `proxy/extensions.json`, not `350` (`proxy/extensions.json:7-10`); `tool-input-normalize` is `340` in config, not `280` (`proxy/extensions.json:8-10`); `output-efficiency-rewrite`, `usage-log`, and `request-log` are discussed as part of a 20-extension audit even though the current default registry loaded from `proxy/extensions/` plus `proxy/extensions.json` contains 17 active extensions. The high-level safety claim “order 75 is before every extension that mutates cache_control or replaces user-message blocks” still looks true, but the audit table currently overstates its fidelity to the live registry.

## What Needs Attention

- Test #19 is close, but its current wording over-claims what it proves. As written, asserting `_ttlTier === "5m"`, a `5m` canonical marker, and the relocated block’s canonical position is sufficient to prove the regression is closed. It does not, by itself, prove that `fresh-session-sort` specifically stripped the original `cache_control`; by the end of the pipeline, `cache-control-normalize` has also removed user-message markers. The assertion language should stay on observable end state, not on attributing which extension removed the field.
- The audit table’s spot-checked cache-control classifications look directionally correct for the suspicious extensions named in the request, but the document should distinguish “all extension files in the tree” from “active default registry.” Right now it mixes those concepts.

## Recommendations

- Fix the acceptance section so every reference to the new detector’s order is `75`, not `350`.
- Reconcile the audit table against the actual pipeline source of truth used by the proposed integration tests: `loadExtensions(proxy/extensions, proxy/extensions.json)`. Either update the table to the real loaded registry or explicitly label it as a superset audit of all extension files, with correct config-vs-module order notes where they differ.
- Rephrase test #19’s final assertion to something observable such as “the relocatable block moved to the canonical position and the final canonical marker carries `ttl: "5m"`,” without claiming the test proves which downstream extension stripped the original field.

## Bottom Line

The substantive architecture issue from the earlier passes appears resolved: order `75` is early enough, and the suspicious post-75 extensions I spot-checked do not reveal a new cache-control-loss path. I am still not approving this directive because the document remains inconsistent about the detector’s required order and its audit table is not yet aligned with the real registry/config it cites as proof. Those are spec-quality issues, not implementation issues, but this PR is a directive and needs to be internally correct before implementation starts.
