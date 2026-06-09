# Review: PR #209 README v4 freshness cleanup

Date: 2026-06-09
Reviewed: README.md at f3284c0
Round: 1
Label applied: changes-requested

## What Is Correct

- `package.json` is `4.0.0`, so the new top-level version callout is aligned with the shipped package version.
- The two v4.0.0 default flips are documented correctly: `thinking-block-sanitize` v1 is default-on, and in-process hot-reload is opt-in via `CACHE_FIX_HOT_RELOAD=on`.
- The A/B baseline attribution is now correctly scoped to `v3.0.0` on CC `v2.1.117`; that matches the `v3.0.0` release notes.
- The Docker semver-ladder update is directionally correct: the workflow still emits `{{version}}`, `{{major}}.{{minor}}`, `{{major}}`, and `latest`, and the published GHCR tags `4`, `4.0`, `4.0.0`, and `latest` are present.
- The bootstrap-defense timeline is correctly reframed: `v3.7.0` added explicit bootstrap handling and `v3.7.1` extended it to the GrowthBook prompt-injection surface, with no subsequent changelog entry indicating a v4.x behavior break on that path.
- The table under “What the proxy does” is unchanged, which is appropriate for this narrow README cleanup.

## Blockers

- `README.md:32` replaces the stale count with a new claim that is still factually off: “opt-in modules cover image, microcompact, breakpoint, and bootstrap-channel surfaces.” The shipped loader does not model those as a separate “opt-in modules” bucket. `proxy/pipeline.mjs:15-30` loads every extension file by default unless `extensions.json` or the module export disables it, and `bootstrap-defense` itself defaults to `audit`, not opt-in (`proxy/extensions/bootstrap-defense.mjs:44-47`, `proxy/extensions/bootstrap-defense.mjs:148-165`). In the current tree, the default registry loaded from `proxy/extensions/` is 23 extensions, including default-loaded `bootstrap-defense`, `image-strip`, `microcompact-stability`, `messages-cache-breakpoint`, `thinking-block-sanitize`, and `session-health`. This wording should avoid introducing a new false partition while removing the old bad counts.

- `README.md:404` still says `preload.mjs` is “~1,700 lines,” but the checked-in file is 2,881 lines in the current tree (`preload.mjs`). Because this PR edits that exact supply-chain paragraph as part of a staleness cleanup, leaving the stale preload-size number in place is still a factual miss.

## What Needs Attention

- None beyond the blockers above.

## Bloat / Non-Functional

- None.

## Recommendations

- Reword `README.md:32` so it stays count-free without asserting an incorrect default-vs-opt-in split. For example, describe the table as “headliners” and say additional extensions cover image, breakpoint, bootstrap, telemetry, and thinking-desync surfaces, without classifying them as opt-in modules.
- Update the preload size note in `README.md:404` to reflect the current file size, or drop the numeric approximation entirely if the exact count is likely to drift again.

## Bottom Line

This PR fixes several real README staleness problems, and most of the targeted updates check out. But two factual inaccuracies remain in the edited text itself: the new pipeline-header wording misstates which shipped modules are “opt-in,” and the supply-chain paragraph still carries an outdated `preload.mjs` line-count claim. Revise those, then this is ready to approve.

— Codex review
