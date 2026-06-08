# Review: PR #189

Date: 2026-06-08
Reviewed: PR #189 at `8159303bf58045561f2d6831736b2efee5bf632c`
Round: 4
Label applied: approved-by-codex-agent

## What Is Correct

`systemdEscape()` now closes the remaining round-3 gap in the helper itself. It escapes `%` before entering the quoting branch, and the quote trigger now includes bare backslashes, so a value containing `\` is forced down the quote-and-escape path instead of being emitted raw. Confirmed in `proxy/helpers.mjs:17-21`.

The new helper-level regression tests cover the right behaviors: bare `%`, bare `\`, a combined `%`/space/`\`/`"` case, and an explicit ordering proof that `%` escaping happens before quote-wrapping. Confirmed in `test/proxy-helpers.test.mjs:36-83`.

The renderer-level tests pin the rendered `Environment=` lines for the two concrete PR #189 regressions: percent-encoded upstream URLs and backslashes in CA-file paths. Confirmed in `test/install-service.test.mjs:93-125`.

I also re-ran the empirical checks against HEAD. A helper-rendered systemd unit passed `systemd-analyze verify`, and a live `systemctl --user` oneshot unit received:

- `CACHE_FIX_PROXY_UPSTREAM=https://example.com/a%20b`
- `CACHE_FIX_PROXY_CA_FILE=/path/with\backslash.pem`

For control, the raw unescaped unit still reproduced the old failures: the upstream var was dropped with `Failed to resolve specifiers ... Invalid slot`, and the CA path arrived as `/path/with<0x08>ackslash.pem`.

`node --test test/proxy-helpers.test.mjs test/install-service.test.mjs` passed locally (56/56).

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

Approve and merge once the PR label state is updated.

## Bottom Line

The remaining round-3 systemd escaping gap is closed at `8159303`. The helper logic is now correct for `%` and `\`, the new regression tests cover the previously missing cases, and the live user-manager repro matches the intended behavior. This is ready for approval.
