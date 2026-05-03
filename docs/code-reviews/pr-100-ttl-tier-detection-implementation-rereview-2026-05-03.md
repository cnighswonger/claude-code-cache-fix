# Review: TTL tier detection implementation re-review

Date: 2026-05-03
Reviewed: PR #100 implementation re-review (`c9bf9cf`)
Label applied: approved-by-codex-agent

## Verdict

approved

## What Is Correct

- Test #18 in [test/proxy-ttl-tier-pipeline.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-ttl-tier-pipeline.test.mjs:46) now exercises the real regression geometry. The only incoming `ttl: "5m"` marker is on `content[0]` of a single user message, while `content[1]` starts without `cache_control`. In [proxy/extensions/cache-control-normalize.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/cache-control-normalize.mjs:1), normalization strips markers from every user block and then reapplies the canonical marker only to the last block of the last user message. That means the `5m` signal is removed from `content[0]` and canonical placement moves to `content[1]`, so this test now covers the approved non-last-block strip/reapply path.
- The new `assert.equal(onlyMsg.content[0].cache_control, undefined)` in test #18 is the right observable check for normalize's strip behavior. It confirms the original block no longer carries its input marker after the pipeline.
- The rest of test #18 now meaningfully distinguishes the order-75 design from the rejected late-detection design. Given this geometry, if detection happened only in `ttl-management` after normalize, it would see no surviving `ttl: "5m"` anywhere in `body.messages` and would inject `1h`, not `5m`. The passing assertion on the canonical last block therefore depends on the earlier `ttl-tier-detect` capture.
- Test #19's new `assert.equal(relocatedSkills.cache_control, undefined)` is a valid end-state assertion for the relocatable `<skills>` path. Because the test sets `cache_control: { ttl: "5m" }` on the input `<skills>` block and then finds the relocated block in the first user message, asserting that the relocated copy has no `cache_control` field now locks in the strip-on-relocation behavior that was previously only implied. Static reading of [proxy/extensions/fresh-session-sort.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/fresh-session-sort.mjs:140) and [proxy/extensions/fresh-session-sort.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/fresh-session-sort.mjs:164) explains the cause; the test itself correctly proves the observable result.
- Full suite passes on the PR branch: `698/698`.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Proceed to final lead review. I did not find remaining implementation blockers in this re-review pass.

## Bottom Line

The blocking defect in pipeline test #18 is fixed: it now proves that `ttl-tier-detect` must capture `5m` before `cache-control-normalize` strips and relocates canonical placement. The added assertion in test #19 also closes the earlier end-state gap for the relocatable `<skills>` path. I did not find further blocking or non-blocking issues in this re-review.
