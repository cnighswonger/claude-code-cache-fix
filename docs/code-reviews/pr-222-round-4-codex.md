# Review: PR #222 gh-auth-status-shim CI-only follow-up

Date: 2026-06-12
Reviewed: delta `e7f6602..ad98755` (`tools/gh-auth-status-shim/install.sh`, `tools/gh-auth-status-shim/lib/classify-auth-status.sh`, `tools/gh-auth-status-shim/gh-auth-status-shim.sh`, `tools/gh-auth-status-shim/tests/integration.bats`) at `ad98755`
Round: 4
Label applied: approved-by-codex-agent

## What Is Correct
- The post-r3 delta is constrained to the four intended files and does not touch production proxy code outside the shim tooling/tests.
- The three `SC2016` suppressions in `tools/gh-auth-status-shim/install.sh:234`, `tools/gh-auth-status-shim/install.sh:237`, and `tools/gh-auth-status-shim/install.sh:240` are justified: each string is intentionally user-facing literal text showing ``which gh`` or `$PATH`, so expansion would be wrong behavior rather than a missed bug.
- The `SC1091` suppression in `tools/gh-auth-status-shim/gh-auth-status-shim.sh:40` is justified because the sourced helper path is resolved from the shim's runtime location (`$_self_dir`), and the file being sourced is separately present and linted at `tools/gh-auth-status-shim/lib/classify-auth-status.sh:1`.
- The `shellcheck shell=bash` directive at `tools/gh-auth-status-shim/lib/classify-auth-status.sh:1` is correct for a sourced Bash helper that intentionally omits a shebang but uses Bash semantics documented in the file (`local`, Bash-version floor comments, Bash-oriented caller contract).
- The `bats_require_minimum_version 1.5.0` declaration at `tools/gh-auth-status-shim/tests/integration.bats:7` correctly guards the `run -127` syntax added at `tools/gh-auth-status-shim/tests/integration.bats:145`; replacing `run gh auth status` + `[ "$status" = 127 ]` with `run -127 gh auth status` preserves the assertion while silencing BW01 on newer bats builds.
- The PATH save/restore added in `tools/gh-auth-status-shim/tests/integration.bats:16` and `tools/gh-auth-status-shim/tests/integration.bats:50` is isolated to each test's `setup`/`teardown` cycle. It restores the inherited PATH before cleanup after the one test that narrows PATH to the shim-only sandbox (`tools/gh-auth-status-shim/tests/integration.bats:141`), and does not leak a prior test's sandbox into later tests because every test rebuilds and exports its own sandboxed PATH in `setup` (`tools/gh-auth-status-shim/tests/integration.bats:40`).
- CI evidence matches the intended scope of these changes: both `test-linux` and `test-macos` are passing at `ad98755`.

## Blockers
None.

## What Needs Attention
None.

## Bloat / Non-Functional
None.

## Recommendations
- No further changes needed on this delta.

## Bottom Line
The two follow-up commits are narrowly scoped CI fixes, and the added shellcheck/bats directives are tied to intentional literal output or framework-version gating rather than masking functional defects. I found no behavioral regression in the `run -127` conversion or the PATH restore logic, so this delta is clean to approve.
