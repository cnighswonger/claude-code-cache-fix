# Review: bootstrap-defense v3.7.1 directive

Date: 2026-05-27
Reviewed: `docs/directives/proxy-bootstrap-defense-v3.7.1.md`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The multi-surface subsection closes the prior schema gap. It now states exactly which fields are per-record (`surface`, `prompt_key`, `prompt_value_hash`, `stripped_keys`) and which are duplicated (`status`, `body_bytes`, `request_id`, `remote_mode`, etc.). Correlating by `request_id` plus timestamp window is consistent with the current record shape: `request_id` stays the primary join key, and the timestamp window is the fallback/disambiguator when ids are null or reused.
- `setup_detected` is gone from the directive, and the signal split is now clean: `prompt_key` carries the env-selected key only for `surface: "prompt_injection_gb"`, while `remote_mode` remains the explicit `CLAUDE_CODE_REMOTE` flag.
- The stale-cache note is now explicit and correctly scoped. It makes clear that v3.7.1 covers fresh bootstrap fetches only and does not overclaim retroactive coverage of previously written GrowthBook cache contents.
- The test plan now pins the contract at the right points. Case 3 fails the implementation if it emits only one audit record when both prompt-source keys are present, case 12 does the same on the allowlist path, and case 14 closes the end-to-end mutation gap through `handleBootstrap`.
- The revision does not introduce a new collision with the existing `request_blocked` path. Block mode remains single-record request-time logging; the multi-record rule is confined to response-time audit emission.

## Blockers

None

## What Needs Attention

- The implementation should preserve the surface-based contract even if `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` ever equals `tengu_heron_brook`. The directive's normative rule is clear enough to approve, but that same-key alias case is not one of the enumerated tests yet.

## Recommendations

- If it is easy to encode, add one implementation test for the same-key alias case so "surface" and "key" cannot accidentally collapse into a 1:1 assumption.

## Bottom Line

Approve. Commit `0dc9c2a` resolves the two blockers and the three secondary items from the prior review, and the directive is now specific enough to implement without further design guesses.
