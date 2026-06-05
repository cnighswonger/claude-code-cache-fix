# Review: PR #189 install-service env-var escaping rereview

Date: 2026-06-05
Reviewed: PR #189 at d2893a88d42f71b9242186e787c727abfc97b929
Round: 2
Label applied: changes-requested

## What Is Correct
- The two blockers from the 2026-06-04 review are closed. `xmlEscape()` is applied to every launchd `<string>` interpolation in `bin/install-service.mjs:124-145`; I re-rendered a plist with `CACHE_FIX_PROXY_CA_FILE=/path/ca & co.pem`, parsed it with Python `plistlib`, and recovered the original value unchanged.
- The whitespace-bearing systemd case is also closed. `renderSystemdTemplate()` now routes each optional env line through `systemdEscape()` in `bin/install-service.mjs:92-121`; rendering `/path with spaces/ca.pem` now passes `systemd-analyze verify`, and a live `systemctl --user` oneshot unit received the full value unchanged.
- The new regression tests pin the exact whitespace/XML cases that were previously missing in `test/install-service.test.mjs:71-83` and `test/install-service.test.mjs:110-132`. I also re-ran the suites the author called out: `node --test test/install-service.test.mjs` passed 33/33 and `npm test` passed 908/908 on the PR head.

## Blockers
- `systemdEscape()` is still too narrow to be a correct "preserve arbitrary env value" helper for `Environment=` lines. At `proxy/helpers.mjs:1` it only wraps when the value contains a literal space or `"`, otherwise it returns the raw string. That leaves two real systemd transformations unhandled:
  - Bare `%` still triggers specifier expansion in unit files. I reproduced `Environment=X=a%20b` in a linked user unit; `systemd-analyze verify` reported `Failed to resolve specifiers ... Invalid slot`, and the variable was dropped entirely. This matters to this PR because `CACHE_FIX_PROXY_UPSTREAM` is documented as a user-supplied upstream URL in `README.md:145`, and percent-encoded URLs or credentials are legitimate inputs.
  - Bare backslashes are still parsed as C-style escapes. I reproduced `Environment=X=/path/with\\backslash.pem` in a linked user unit and the child process received `/path/with\x08ackslash.pem` because `\b` was interpreted as backspace.
  Because `bin/install-service.mjs:93-103` now applies this helper to all systemd env lines, the current patch closes the whitespace bug but still does not preserve some valid values. I do not think we should approve until the helper also handles `%` and `\` correctly and treats systemd-significant whitespace more generally than just U+0020 space.

## What Needs Attention
- The new systemd tests only cover the whitespace/quote path in `test/install-service.test.mjs:71-83`. There is still no regression test for a literal percent or backslash in a systemd-rendered value, which is why the helper currently looks green despite the live parser mismatch.
- `xmlEscape()` in `proxy/helpers.mjs:3-9` escapes all five XML entities, not just the minimum `&`/`<` needed for element text. That is defensible and I would keep it: the output is still valid plist XML, and the uniform escape rule is simpler than context-sensitive partial escaping.

## Bloat / Non-Functional
None.

## Size Baseline
- `proxy/helpers.mjs` — 9 LOC — tiny helper module, but now load-bearing because both renderers depend on it.
- `bin/install-service.mjs` — 489 LOC — service/plist/systemd orchestration remains localized; the change is a narrow templating edit.
- `test/install-service.test.mjs` — 676 LOC — large test file overall, but the added cases are targeted and justified.

## Recommendations
- Expand `systemdEscape()` so it preserves all systemd-significant characters, not just literal space and `"`. The minimum gaps I verified are `%` needing `%%` and raw backslashes needing escape/doubling; I would also treat any whitespace as a quoting trigger, not only U+0020 space.
- Add two regression tests for the remaining live-parser cases: one `UPSTREAM` value containing `%20`, and one value containing `\\b` or another backslash sequence that would be misread by systemd.
- Once those are fixed, I expect this PR to clear quickly.

## Bottom Line
This rereview closes the two original blockers: the launchd plist is now well-formed, and the space-bearing systemd env case now works. I am still requesting changes because the new `systemdEscape()` helper is not yet a general-safe renderer for `Environment=` values, and the remaining `%`/backslash cases are real enough to affect documented `CACHE_FIX_PROXY_UPSTREAM` inputs.
