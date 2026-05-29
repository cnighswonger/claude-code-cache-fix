# Review: manual-compact hotfix

Date: 2026-05-29
Reviewed: PR #169 (`fix/manual-compact-opus-relax-truncation`) at `2a260f3`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The model selection change is clean and centralized. `tools/manual-compact.sh` now defines `COMPACT_MODEL="${MANUAL_COMPACT_MODEL:-claude-opus-4-7}"` once, uses it at the only `claude --print` call site, and echoes the exact model being sent, so there is no stale hardcoded Sonnet fallback left in the execution path (`tools/manual-compact.sh:204-211`).
- The shell change is syntactically sound. `bash -n tools/manual-compact.sh` passes, the new variable expansion is correctly quoted, and the `:-` default keeps the old behavior of treating an empty env var as "use the default model."
- The doc stays aligned with the code on all material operator-facing points: the three truncation caps, the Opus default, the `MANUAL_COMPACT_MODEL` override, and the updated cost framing all match the shipped script (`tools/MANUAL-COMPACT.md:11-17`, `tools/MANUAL-COMPACT.md:141-160`).
- There is no model-ID blocker here. Current Claude Code docs still recognize `claude-opus-4-7` and `claude-sonnet-4-6`, and support `[1m]` on full model names for long-context runs, so the new default plus override pattern is operationally valid.
- Packaging impact is real but understood: `package.json` includes `tools/` in the published files array, so reviewing the script and doc together as a shipped operator tool is the right scope (`package.json:14-23`).

## Blockers

None.

## What Needs Attention

- The larger extract materially raises the ceiling of the summarizer input. The weighted per-turn cap moved from 1000 chars/turn max on average (`0.2*200 + 0.4*400 + 0.4*2000`) to 3860 chars/turn (`0.2*300 + 0.4*1500 + 0.4*8000`), about a 3.86x increase. On very large sessions that is enough to push some runs near or past a standard 200K context window. The important nuance is failure mode: because the script is `set -euo pipefail` and the `claude --print` stderr is swallowed, a model-side validation failure would most likely appear as the script stopping right after `Sending to Claude (...) for summarization...`, not as a false-success "empty summary generated" path (`tools/manual-compact.sh:23`, `tools/manual-compact.sh:171-174`, `tools/manual-compact.sh:208-213`). I do not think this should block the hotfix because the silent-exit behavior is pre-existing, Opus 4.7 supports 1M-context variants, and the new env override gives operators an immediate escape hatch. I do think the doc should eventually add one troubleshooting line: if the script stops after the send line, retry with `MANUAL_COMPACT_MODEL=claude-opus-4-7[1m]` (or another `[1m]` model) or lower the caps.
- `CHANGELOG.md` is not updated. Since `tools/` ships in the npm tarball (`package.json:14-23`), this is a user-visible tool change and should be called out in the next release notes even if Chris keeps this PR hotfix-minimal.

## Bloat / Non-Functional

None. This is a tight hotfix: one script behavior change and one matching doc update, with no new abstraction or dead code.

## Size Baseline

- `tools/manual-compact.sh` — 220 LOC — single shell entrypoint with one embedded Python extractor and one Claude CLI handoff.
- `tools/MANUAL-COMPACT.md` — 177 LOC — operator guide and cost/troubleshooting notes for the tool.

## Recommendations

- Approve the PR as-is.
- In a follow-up or before release notes are cut, add one troubleshooting sentence covering the "stops after Sending to Claude..." overflow case and mentioning `[1m]` model overrides explicitly.
- Add a changelog line when the next release entry is prepared.

## Bottom Line

Approve. The env-override/default-model change is implemented correctly, the docs and runtime path stay in sync, and there is no shell or model-ID defect that justifies blocking a hotfix. The only substantive caveat is operator ergonomics on oversized extracts: the relaxed caps make the pre-existing stderr-suppressed failure path more likely on some setups, but that is better handled with a short troubleshooting note than by holding this branch.
