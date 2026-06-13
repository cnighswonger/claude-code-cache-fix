# Review: PR #227 — model-id-sanitize directive

Date: 2026-06-13
Reviewed: `docs/directives/proxy-model-id-sanitize.md` at `bf20dc7`
Round: 1
Label applied: `changes-requested`

Verdict: REQUEST_CHANGES

## What Is Correct

- The directive picked the right hook surface. `proxy/pipeline.mjs:91-96` does isolate `onRequest` failures, and `proxy/extensions/image-retry-circuit-breaker.mjs:249-268` is a real `{ skip, status, headers, body }` precedent.
- The current mainline family-helper site the directive wants to consolidate is real: `proxy/extensions/cache-telemetry.mjs:48-65` holds the family map, and a shared flat helper for #225 + this extension looks like a small/realistic refactor rather than something that needs a separate PR.
- `proxy/extensions/auto-1m-guard.mjs:11-12` really does establish that healthy outbound `body.model` values do not carry the `[1m]` suffix on the wire. The directive is right to use that as a design constraint, even though the regex it proposes does not yet follow through on it.
- The hex-escaped logging/persistence rule at `docs/directives/proxy-model-id-sanitize.md:114-117` is the right hygiene choice. Reflecting raw control bytes back into stderr or per-session JSON would be a terminal-safety footgun.
- The NFR section is structurally complete per `CLAUDE.md`: size/complexity, threat model, maintainability, perf/reliability, and load-bearing classification are all present.

## Blockers

1. **The “canonical regex” and the strip recovery rule do not match the known bad shapes or the healthy wire format.** `docs/directives/proxy-model-id-sanitize.md:46-78` calls `^[a-z][a-z0-9-]+(\[1m\])?$` the canonical validator, but that accepts non-canonical values such as `opus`, `sonnet`, `haiku`, `claude`, `claude-`, and `claude--oops`, while the cited wire precedent (`proxy/extensions/auto-1m-guard.mjs:11-12`) says healthy outbound `body.model` never carries `[1m]` at all. It also specifies strip recovery only when the extracted substring is a family root, which means known recoverable corruptions like `claude-fable-5<ESC>[1m` from CC#68285 and `claude-opus-4-8<ESC>[1m` from CC#68279 would fall into `block` instead of restoring the intended full ID. The directive needs a stricter “valid outbound model id” rule and explicit recovery precedence: exact canonical full-ID recovery first, family-root fallback second.
2. **The “cheapest current variant” selection rule is not true for the families it names.** `docs/directives/proxy-model-id-sanitize.md:66-75` maps `opus -> claude-opus-4-6` and `sonnet -> claude-sonnet-4-6` as the “cheapest current” targets. As of June 13, 2026, Anthropic’s pricing table shows Opus 4.8 / 4.7 / 4.6 / 4.5 all at the same `$5 / $25` MTok price point, and Sonnet 4.6 / 4.5 share the same `$3 / $15` price point. So choosing Opus 4.6 is not a cost-saving fallback; it is a capability downgrade at the same price. Anthropic’s model overview also still treats `claude-haiku-4-5-20251001` as the pinned Haiku 4.5 API ID, so that target is fine. Separately, Anthropic’s June 12, 2026 suspension notice for Fable 5 and Mythos 5 makes `fable/mythos -> claude-sonnet-4-6` a defensible availability fallback, but that is not “family-cheapest.” Reword the rule and targets to reflect the real decision criterion. Official sources reviewed for this point: `https://platform.claude.com/docs/en/about-claude/pricing`, `https://platform.claude.com/docs/en/about-claude/models/overview`, and `https://www.anthropic.com/news/fable-mythos-access`.
3. **The block-mode safety section overstates both precedent and evidence.** `docs/directives/proxy-model-id-sanitize.md:37-40` and `:82-97` say the synthetic `400` adds no new wire surface and cite `#59843 / #68284` as evidence that the failure mode is “stuck session but safer.” `#59843` is a plan-approval permission-mode bug, not a malformed-400/session-recovery issue, and `#68284` is about resuming after quota/rate-limit exhaustion, not proxy-synthesized model errors. Also, the only real messages-route precedent we have today is `proxy/extensions/image-retry-circuit-breaker.mjs:249-268`, which synthesizes `200` success envelopes, not HTTP `400`s. That proves skip-result plumbing and SSE string passthrough, but it does not prove Claude Code will handle a proxy-generated streaming `400` cleanly. The directive needs corrected citations, a more honest risk statement, and an explicit `needs-sim-validation` requirement for any implementation that ships `block`.
4. **Two of the central file:line anchors are wrong on current `main`.** The directive’s “one-line spread addition” cites `cache-telemetry.mjs:225-261`, but on `origin/main` that range is still inside header parsing; the per-session JSON build is actually `proxy/extensions/cache-telemetry.mjs:392-427`. Likewise `server.mjs:118` is only the outer `if (pre.handled)` guard; the actual short-circuit client write lives in `proxy/server.mjs:88-95`. Because this directive is intentionally file-anchored, those anchors should be corrected before it is approved as an implementation contract.

## What Needs Attention

- `docs/directives/proxy-model-id-sanitize.md:64-78` should explicitly call out the operator tradeoff in `strip` mode: when exact full-ID recovery is impossible and the code falls back to a cheaper/lower-tier target, the result may be cheaper but materially worse than the operator intended. That is acceptable only as an explicit opt-in safety override, not as an unstated “obviously better” default.
- If the shared helper from PR #225 is introduced, preserve the current substring-match behavior from `proxy/extensions/cache-telemetry.mjs:48-65`. That current map intentionally catches dated variants such as `claude-haiku-4-5-20251001` via a shorter family token.
- The public PR is mostly additive relative to the original private draft; I did not find a load-bearing requirement that was present there and then dropped here. The important changes are the new specifics PB filled in, not missing content.

## Bloat / Non-Functional

- None. The proposed #225 consolidation into a shared `proxy/model-families.mjs` still looks proportionate. If the helper stays flat and narrowly scoped, I do not see a strong reason to defer it to a separate PR.

## Recommendations

- Tighten the validator to the actual outbound model-id space, not a broad lowercase-token regex, and document whether wire-valid aliases such as `claude-haiku-4-5` are intentionally allowed.
- Specify strip recovery in ordered steps: recover exact canonical full ID when possible; otherwise recover a family root; only then fall back to a pinned safe target or `block`.
- Replace the “cheapest current variant” wording with the real policy the implementation should follow, and update the Opus target if the goal is same-price highest-fidelity recovery rather than arbitrary downgrade.
- Add a reviewer checklist section. At minimum it should pin: the stricter validator, exact-ID-before-family-root recovery order, corrected `cache-telemetry` / `server.mjs` anchors, `needs-sim-validation` for `block`, and the current June 12, 2026 Fable/Mythos suspension rationale for the Sonnet fallback.
- If `block` remains in scope for v1, require implementation-review evidence on both `stream: true` and `stream: false` request paths before merge.

## Bottom Line

The directive is directionally right and the implementation surface is mostly real, but the load-bearing parts are not tight enough yet. The validator/recovery contract does not match the actual known malformed shapes, the fallback-map rationale is factually wrong against current Anthropic pricing, and the block-mode safety section leans on the wrong evidence. Fix those points and this should be ready for approval.

— Codex review
