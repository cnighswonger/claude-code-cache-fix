# Review: Directive: microcompact cache stability

Date: 2026-04-30
Reviewed: `docs/directives/proxy-microcompact-cache-stability.md`
Label applied: `changes-requested`

## What Is Correct

- The two-phase split is directionally correct. Phase 1 is the right place for low-risk observability plus optional canonicalization, while Phase 2 clearly needs its own design pass because it introduces persistent state, restore policy, and interaction with the image-guard byte budget.
- Putting the extension at order 350, before `cache-control-normalize` at 400, is the right pipeline position if normalization is going to contribute to downstream byte stability.
- The default behavior for partial matches should be record-only, not normalize. If a block contains the sentinel plus additional data, the safe default is to preserve the original bytes.
- Independent env gates for diagnostic capture and normalization are the right operational shape. The feature should be observable without mutation, and mutation should be separately controllable.

## Blockers

1. The diagnostic-capture contract is internally contradictory, and one of the documented behaviors defeats Phase 1's stated purpose. `## Activation` says that when both gates are enabled the dump captures the post-normalized snapshot, while `## Diagnostic capture` says the record is written before normalization and includes the matched `sentinel_text`. Phase 1 is supposed to characterize real production sentinel drift; that requires raw pre-normalization capture. The directive needs one clear rule here, and it should preserve the original matched bytes.
2. The privacy guarantee is too strong for the matchers and partial-match behavior currently specified. The directive claims the dump contains "no user content" because it only records the sentinel text, but Test 4 explicitly records partial matches with trailing content, and the candidate regexes include broad forms like `^\\[microcompact.*\\]\\s*$`. Either case can capture real tool output or other user-derived text. The directive needs to narrow what is dumped for partial matches and unknown variants, or the privacy statement is not defensible.
3. The detection contract is ambiguous in a way that affects both correctness and privacy. The documented regexes are full-string matches, but Test 4 expects a prefix-plus-extra-text case to "match" as `partial_match: true`. That is a different detection mode than the regex list describes. The spec needs to separate exact-match normalization from prefix-only diagnostic detection so implementers are not forced to invent the boundary themselves.

## What Needs Attention

- The candidate sentinel patterns should not be treated as normalization-ready before the first production samples land. `^\[Tool result truncated.*\]\s*$` in particular reads more like a generic truncation message than a confirmed microcompact sentinel and risks false positives.
- The default canonical form of `[Old tool result content cleared]` is the right stability target for normalized request bodies. Any volatile fields needed for debugging belong in the diagnostic record, not in the forwarded request.
- The Phase 2 deferral list is mostly right, but it should also call out snapshot retention/GC and versioning of any persisted restore format. Those become real design constraints as soon as content is stored across requests.
- The telemetry field description for `bytes_saved` says it is "often negative-ish", which does not line up with the default rule that removes timestamp bytes. The field is fine; the wording is what needs tightening.

## Recommendations

- Require diagnostic dumps to store the raw matched text before normalization whenever dumping is enabled. If verification of the canonical rule is also needed, add a second field for normalized text rather than replacing the raw capture.
- Split detection into two explicit classes:
  - exact sentinel match or exact known volatile-field variant: eligible for normalization
  - prefix/partial or unknown bracketed variant: diagnostic-only, never dumped verbatim unless redacted or hashed
- Tighten the initial default matcher set to confirmed forms only, and state that any broader rule remains disabled until Phase 1 data confirms it.
- Reword the privacy section so it matches the actual capture surface, including the cases where only hashed or length-only diagnostics are retained.

## Bottom Line

Revise before approval. The overall Phase 1 / Phase 2 split is sound, and Phase 1 should remain limited to diagnostics plus opt-in normalization. But the directive currently leaves raw-vs-normalized capture ambiguous, overstates the privacy guarantees, and does not define partial-match detection precisely enough to guide a safe implementation.
