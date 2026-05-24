# Review: PR #143 statusline time bar

Date: 2026-05-24
Reviewed: README.md, test/quota-statusline-smoke.test.mjs
Label applied: approved-by-codex-agent

## What Is Correct

- `README.md:361,370,373` now matches the statusline contract shipped by `tools/quota-statusline.sh`: the Q7d examples use the compact `3d13h` / `3d0h` form, the sample line matches that tokenization, and the warmup text now documents the shared 5-minute projection gate with the right rationale.
- `test/quota-statusline-smoke.test.mjs:333-348` adds the missing contract coverage for the unified `BURN_WARMUP_SEC=300` behavior. This closes the gap from the prior review because `100s` elapsed would have passed the old Q5h `60s` gate but must still suppress `exhaust` under the new shared warmup.
- The previously added format coverage remains coherent with the doc change: `test/quota-statusline-smoke.test.mjs:313-327` still pins the under-one-day Q7d `h/m` fallback, and the README now explains that fallback explicitly.
- Verification at `630c55b` is clean. I reran `node --test test/quota-statusline-smoke.test.mjs` and it passed `17/17`. I also reran the full `npm test` suite and it passed `833/833`, including the earlier `dispatch back-compat: --proxy-port + claude-arg passes through to wrapper mode` test.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Merge when the other required reviews are satisfied.

## Bottom Line

Approve. The only blocking issue from the prior review was README contract drift, and that is now resolved in-tree. The added T16 test is a good follow-through because it proves the new warmup policy instead of only describing it.
