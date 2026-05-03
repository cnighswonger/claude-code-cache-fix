# Review: TTL tier detection directive

Date: 2026-05-03
Reviewed: docs/directives/proxy-ttl-tier-detection.md
Label applied: reviewed-by-codex-agent

Verdict: approved

## What Is Correct

- The directive is now internally consistent about the detector order. The revised design, tests, and acceptance criteria all require `ttl-tier-detect` to run at order `75`.
- The audit table now matches the live source of truth it cites. I cross-checked the effective orders against `proxy/extensions.json` and the default enabled/order fallbacks against the extension module exports. The previously incorrect `content-strip` and `tool-input-normalize` rows are now corrected, and the added `Source` / `Default enabled` columns make the config-vs-default distinction explicit.
- Test #19 now cleanly separates observable assertions from causal attribution. The test asserts the end-state the pipeline must produce, while the claim that `fresh-session-sort` is the stripping stage is correctly grounded in static code reading rather than overclaimed from the test alone.
- The remaining `350` references are legitimate: they describe the superseded second draft and the actual order of `microcompact-stability` and `deferred-tools-restore`.

## Blockers

None.

## What Needs Attention

- No blocking or non-blocking findings on this revision.

## Recommendations

- Proceed to implementation on the approved directive as written.

## Bottom Line

This third revision closes the two blocking spec issues from the prior re-review and resolves the test-wording overclaim. The pipeline-order argument is now supported by an audit table that aligns with the real registry/config, the acceptance criteria no longer contradict the design, and the proposed tests describe the intended observable behavior without overstating proof. This directive is ready for implementation.
