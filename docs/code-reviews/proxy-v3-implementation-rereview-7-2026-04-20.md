# Review: proxy v3 implementation

Date: 2026-04-20
Reviewed: commit 40b1dfc
Label applied: changes-requested

## What Is Correct
- The latest wrapper change addresses the previously suspected cross-test environment leakage by scrubbing `CACHE_FIX_PROXY_PORT` and `CACHE_FIX_PROXY_UPSTREAM` before forking the wrapper test process.
- `bin/claude-via-proxy.mjs` no longer depends on `shell: true` for `CACHE_FIX_CLAUDE_CMD`, which is a cleaner and less environment-sensitive execution path.
- The proxy/server/stream/upstream tests still pass in this environment; the remaining issue is isolated to the wrapper harness.

## Blockers
- `test/proxy-wrapper.test.mjs:89-112` and `:114-136` still fail under local verification because the fake child scripts are deleted before the forked wrapper process reliably consumes them. Reproducible failures:
  - `node --test test/proxy-wrapper.test.mjs` failed at `:107` with `Expected BASE_URL in output, got:`.
  - `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs` failed at `:134` with `Expected exit 42, got 1`, and stderr showed `ENOENT` opening `test/.fake-claude-exit.mjs`.
  - `npm test` failed on both wrapper assertions, including `Cannot find module '<repo-root>/test/.fake-claude-exit.mjs'`.

## What Needs Attention
- The current test cleanup strategy uses `finally { unlinkSync(script) }` immediately after awaiting wrapper process exit. That is not sufficient when the wrapper's spawned child may still be in module-load startup or stdio-drain timing; the test should not remove the file until the fake child has definitely finished consuming it.
- The new `cleanEnv()` helper appears directionally correct, but the reproduced failures show that environment leakage was not the only source of flakiness. The review comment should reflect the actual remaining failure mode.

## Recommendations
- Make the wrapper tests use uniquely named temporary files and defer deletion until after the fake child process is guaranteed complete, or avoid filesystem race entirely by invoking a stable checked-in helper script.
- Re-run the exact verification commands after that harness fix:
  - `node --test test/proxy-wrapper.test.mjs`
  - `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs`
  - `npm test`

## Bottom Line
`40b1dfc` improves the wrapper test setup, but it does not clear the blocker here. The branch still fails local verification because the wrapper tests race their own temporary fake-claude script cleanup, so I cannot remove `changes-requested` yet.
