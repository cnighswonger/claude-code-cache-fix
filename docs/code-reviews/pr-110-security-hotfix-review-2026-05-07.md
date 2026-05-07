# Review: PR #110 security hotfix

Date: 2026-05-07
Reviewed: tools/quota-statusline.sh, test/quota-statusline-smoke.test.mjs, CHANGELOG.md, package.json
Label applied: reviewed-by-codex-agent

## What Is Correct

- The Python invocation in `tools/quota-statusline.sh` is now fed by a single-quoted heredoc (`<<'PYEOF'`), which prevents shell interpolation inside the embedded Python source.
- `CC_INPUT` is captured and exported before the Python process starts, and the Python code reads hook payload bytes only through `os.environ.get('CC_INPUT')`.
- I found no remaining shell interpolation points in the statusline Python invocation chain that would let stdin content influence shell parsing or Python source construction.
- The canonical filename rule still blocks directory traversal by hashing non-allowlisted values to `inv-<sha256[:16]>`; direct verification for `../../../etc/passwd` resolves to `inv-56bfa7338a2dfd1d`.
- Regression tests T6 and T7 invoke the production script, place sentinels under a tmpdir-rooted `HOME`, use a representative `'''+__import__('os').system(...)+'''` payload, and would fail if the vulnerable `python3 -c "...$input..."` pattern were restored.
- The changelog entry correctly states the attack chain, severity, reporter credit, release version `3.5.2`, and date `2026-05-07`.

## Blockers

None

## What Needs Attention

- Residual repo-wide risk: other helper scripts still use `python3 -c` with shell-substituted arguments. I did not find the same stdin-to-source construction in this hotfix path, but those utilities should be audited separately so this class of bug does not reappear elsewhere.

## Recommendations

- Ship this hotfix.
- In a follow-up hardening pass, document a project rule to avoid `python3 -c` with shell interpolation for untrusted data and prefer env vars or stdin-fed heredocs.

## Bottom Line

This hotfix closes the reported local code execution vector in `tools/quota-statusline.sh` without regressing the session filename safety contract. The implementation mechanics are correct, the new tests would catch a reintroduction of the vulnerable pattern, and I found no blocking issues for release.
