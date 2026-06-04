# Review: install-service env var propagation

Date: 2026-06-04
Reviewed: PR #189 (`bin/install-service.mjs`, `templates/cache-fix-proxy.service.template`, `templates/com.cnighswonger.cache-fix-proxy.plist.template`)
Label applied: changes-requested

## What Is Correct
- The PR closes a real install/runtime gap. `CACHE_FIX_PROXY_CA_FILE` and `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED` are already documented user-facing inputs and already affect runtime behavior in `proxy/config.mjs` and `proxy/upstream.mjs`.
- The added placeholders are placed in the right sections of both templates, adjacent to the existing optional env wiring.
- The `...defaults` refactor is behavior-preserving today. `getDefaults()` currently returns only `port`, `upstream`, `caFile`, `rejectUnauthorized`, `debug`, and `workingDir`, so it does not collide with the fixed `node` / `serverPath` / `requires` / `logDir` fields used by the install helpers.
- Existing install-service tests still pass on the branch (`node --test test/install-service.test.mjs`: 32/32).
- No extra install-time warning is required for `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0`. The runtime already emits the load-bearing warning at first use, which is the right place because the service environment can change after install.

## Blockers
- `bin/install-service.mjs:95-99` writes the new systemd env vars as raw `Environment=KEY=value` lines. That breaks legitimate CA-file paths containing spaces. I reproduced it by rendering `CACHE_FIX_PROXY_CA_FILE=/path with spaces/ca.pem` and running `systemd-analyze verify`, which reported `Invalid environment assignment, ignoring: with` and `...spaces/ca.pem`. Since `CACHE_FIX_PROXY_CA_FILE` is explicitly a filesystem path, this is a real correctness bug in the new feature, not a contrived edge case.
- `bin/install-service.mjs:127-131` writes the new launchd env vars as raw XML text inside `<string>...</string>`. That makes the generated plist invalid when the value contains XML-sensitive characters such as `&` or `<`. I reproduced this by rendering `CACHE_FIX_PROXY_CA_FILE=/path/ca & co.pem` and parsing the result with Python `plistlib`, which failed with `ExpatError: not well-formed`. This PR extends the existing unescaped-plist pattern into a new path-valued setting where such characters are plausible.

## What Needs Attention
- `test/install-service.test.mjs:48-112` only covers basic include/omit behavior for optional env vars. It does not exercise the new `CA_FILE` / `REJECT_UNAUTHORIZED` render path, and it does not assert safe rendering for spaces or XML-sensitive characters. The blocker above slipped through because those cases are currently untested.
- The `...defaults` spread in `installSystemd()` / `installLaunchd()` is safe today, but it is a mild future footgun because it comes after the fixed fields. If `getDefaults()` ever grows a `node`, `serverPath`, `requires`, or `logDir` key, it will silently override the install-generated values.

## Bloat / Non-Functional
None.

## Size Baseline
- `bin/install-service.mjs` — 488 LOC — moderate orchestration/helper module; render helpers are small and easy to patch centrally.
- `templates/cache-fix-proxy.service.template` — 19 LOC — simple systemd unit with optional env placeholders.
- `templates/com.cnighswonger.cache-fix-proxy.plist.template` — 35 LOC — simple plist template; string escaping is the load-bearing concern.
- `test/install-service.test.mjs` — 640 LOC — broad install-service coverage, but current rendering assertions stop short of escaping/quoting cases.

## Recommendations
- Add a small shared renderer for optional environment entries instead of interpolating raw strings. For systemd, quote/escape values so spaces and special characters remain part of the assignment. For launchd, XML-escape string contents before insertion.
- Cover the fix with direct rendering tests. At minimum: one systemd case for a CA path containing spaces, and one launchd case that proves XML-sensitive characters are escaped and the rendered plist still parses.
- If the spread style stays, consider moving `...defaults` before the fixed keys or explicitly selecting the known default fields. That keeps the current brevity without leaving a silent override trap for future additions.

## Bottom Line
This is a worthwhile community contribution and the feature itself is correct in intent, but the current rendering is not safe enough to ship. Once the new env vars are emitted with proper systemd quoting and plist escaping, and the test file pins those cases, this should be ready.
