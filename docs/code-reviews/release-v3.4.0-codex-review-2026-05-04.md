# Review: release v3.4.0

Date: 2026-05-04
Reviewed: PR #102 / branch `release/v3.4.0`
Label applied: none

## Summary

approve-with-notes

## Findings

1. CHANGELOG entry accuracy: Passed.
`git log v3.3.0..origin/main --oneline` shows six mainline commits in scope: `#90/#12`, `#91/#36`, `#95`, `#99/#96/#98`, `#100/#97`, and `#101`. The new `## [3.4.0] - 2026-05-04` section accounts for all of them: three added extensions, the `ttl-management` behavior change tied to `ttl-tier-detect`, two bug fixes, the vsits.co metadata/doc cleanup, and the new release workflow doc.

2. Version bump correctness: Passed.
The release is correctly cut as a minor bump for three new default-enabled extensions plus two fixes. `package.json` is bumped `3.3.0` -> `3.4.0`.

3. Release commit file scope: Passed.
`git show release/v3.4.0 --stat` shows only `CHANGELOG.md` and `package.json` changed in commit `d0668b7`.

4. Usage-log local mod handling: Passed.
`git show release/v3.4.0:proxy/extensions.json` does not contain `usage-log`. The working tree still has the expected local-only `usage-log` addition, but it is not part of the committed release artifact.

5. Debug code / secrets / local-only patches: Passed.
The release diff is docs + version only. No debug code, secrets, or leaked local patches are present in the release commit.

6. Contributor credits: Passed.
`CHANGELOG.md` credits `@vmfarms` on the `ttl-tier-detect`, `identity-normalization`, and `image-strip` items corresponding to `#97/#96/#98`, and credits `@wadabum` on the `messages-cache-breakpoint` item corresponding to `#12`, matching shared-memory guidance.

## Recommendation

Ship this release. Non-blocking note: `docs/release-workflow.md` still says the version bump/commit should include `package-lock.json`, but this repo does not track that file and PR #102 correctly limits the release commit to `CHANGELOG.md` and `package.json`. The workflow doc should be tightened in a follow-up so future release-cut reviews do not have to special-case it.
