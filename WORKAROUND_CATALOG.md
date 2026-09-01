# Workaround Catalog — Claude Code symptoms and known mitigations

When a CC bug or surprising default hits a user, there are often several mitigation paths at different depths — a settings.json snippet, a CLI flag, an env var, a process wrapper, a proxy extension, a hook, a binary patch. This catalog indexes them by symptom so triage doesn't re-derive what's already known.

**Source-of-truth discipline:** every row's "knob" string must be verbatim from a primary source (an upstream CC issue, a settings.json key reachable in the published extension docs, an env var verified in the shipped binary, a configuration setting present in the extension's `package.json`). Where the source is community-reported and we have not independently verified, the "Verified by" column says so.

**Maintenance contract:** when we post on a CC issue OR ship a new proxy extension OR a community member reports a new workaround, the catalog row gets updated in the same change. Catalog drift starts at the moment a contributor stops doing this.

**What this catalog is NOT:**

- A list of every CC bug. That is `TRACKED_ISSUES.md`.
- An endorsement of binary-patching tools. Binary patches are listed when they are the source of an originator's published workaround, with the depth column making the tradeoff explicit.
- A pointer to non-CC tooling that modifies the CC binary or removes safety surfaces. We do not link such tools.

---

## Legend

**Surface depth** — how invasive the mitigation is, lowest to highest:

1. `settings.json` — User edits a known-supported VS Code or CC settings file.
2. `cli-flag` — User adds a documented or hidden-but-supported flag to their CC invocation.
3. `env-var` — User sets an environment variable.
4. `process-wrapper` — User installs a script that wraps `claude` invocations (officially supported by `claudeCode.claudeProcessWrapper` in the VS Code extension).
5. `proxy-extension` — User runs `cache-fix-proxy` with the relevant extension enabled.
6. `hook` — User installs a CC hook script (PreToolUse / PostToolUse / SessionStart).
7. `binary-patch` — User modifies the CC binary directly.
8. `tool` — User runs a separate companion tool.

**Survives CC update?** — whether the workaround keeps working after `npm install -g @anthropic-ai/claude-code` ships a new version.

**Verified by** — `cache-fix-team` (we ran it), `originator` (we accepted the report but did not independently reproduce), or `community` (multiple independent confirmations on the upstream issue).

**Recommendation** — `preferred` (the right starting point for most users), `narrow-use` (better for a subset), `community-reported` (we have not validated and do not recommend), `internal-only` (we use it; users probably should not).

---

## Catalog

### CC#59844 — `showThinkingSummaries: true` silently no-ops on Opus 4.7 in non-interactive surfaces

Upstream: https://github.com/anthropics/claude-code/issues/59844 — Open as of 2026-06-11.

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `process-wrapper` | `claudeCode.claudeProcessWrapper` setting + wrapper script that appends `--thinking-display summarized` when `--output-format` is present on the command line | Yes — patches nothing, just appends a flag | originator (claudio-felicioli, 2026-06-11) | `preferred` for VS Code extension users hitting this specific issue |
| `proxy-extension` | `thinking-display` extension at order 360 in `proxy/extensions.json` (`enabled: true` by default in cache-fix-proxy v3.6.1+); injects `thinking.display: "summarized"` at the API boundary when a request has `thinking.type` in `{enabled, adaptive}` but `display` unset | Yes — proxy is separate from CC | cache-fix-team (shipped v3.6.1, 2026-05-17) | `preferred` for users already running cache-fix-proxy for the broader cache-stability surface |
| `binary-patch` | Byte-patch the bundled CLI binary at offset 230510690 in the relevant CC version, replacing `!T6()&&` with 7 spaces. Length-preserving | No — offset shifts every CC release | originator (ojura, 2026-05-17) | `community-reported`; cited as empirical verification of the gate-drop fix, not as the deployment path. We do not deploy this. |

**Authoritative fix Anthropic should ship** (per the issue body): pass `--thinking-display summarized` when `showThinkingSummaries` is `true`. Two voices on the thread for it (issue author + AI Team Lead 2026-06-11).

---

### CC#59628 — Worktree sessions can edit files in the parent main checkout with no guardrail

Upstream: https://github.com/anthropics/claude-code/issues/59628 — Open as of 2026-06-11.

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `hook` | Install `hooks/examples/worktree-edit-guard.py` as a `PreToolUse` hook; matcher `Edit\|Write\|MultiEdit\|NotebookEdit`; settings.json snippet in `docs/hooks/worktree-edit-guard.md` | Yes — hook contract is stable | cache-fix-team (shipped 2026-05-26 — `hooks/README.md`) | `preferred` for users with worktree-heavy workflows |

---

### CC#63147 — Resuming an extended-thinking session fails permanently with 400 "thinking blocks cannot be modified"

Upstream: https://github.com/anthropics/claude-code/issues/63147 — Open as of 2026-06-11.

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `env-var` | `CLAUDE_CODE_DISABLE_THINKING=1` OR `MAX_THINKING_TOKENS=0` — both binary-confirmed to fully disable thinking | Yes — env-var contract is stable | cache-fix-team (binary inspection, see `playbook_heal_thinking_wedged_session`) | `narrow-use` — disables thinking entirely; lossy. Last resort for users who need session resume to work and don't need reasoning depth. |
| `env-var` (negative — do not cite) | `DISABLE_INTERLEAVED_THINKING=1` or `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | n/a | cache-fix-team (binary-verified NOT to stop the wedge) | Do NOT recommend; explicitly does not fix this symptom. The first only drops the interleaved beta; the second only adaptive-effort escalation. |
| `proxy-extension` | `session-health` extension in cache-fix-proxy; detects and surfaces the wedge condition pre-API | Yes | cache-fix-team (shipped — see cache-fix #160) | `preferred` for users running cache-fix-proxy. |

---

### CC#62272 — `cleanupPeriodDays` values above ~24 silently wipe or truncate historic session JSONLs

Upstream: https://github.com/anthropics/claude-code/issues/62272 — Open as of 2026-09-01. Related historical loss: #59248 (orphaned subagent/tool-results dirs), #41458 (490 sessions lost at 99999).

**Mechanism (theory, math-consistent with reports).** The daily retention cleanup path computes an age cutoff from `cleanupPeriodDays × 86400 × 1000` ms. Signed int32 max is 2,147,483,647 ms ≈ **24.855 days** — any value above that is a candidate for truncation. The empirical failure mode reported by gregmarkowitz-gif (2026-08-31, Windows 11, CLI-only, `cleanupPeriodDays: 99999` set on two seats) matches signed-int32 truncation of the cutoff:

- **99999 days** → 8.64e12 ms → mod 2³² lands NEGATIVE (~ −8.7e9), so the cutoff is in the future — everything classifies as older than cutoff → mass delete on next cleanup pass. Deletions are hard-unlinks; Recycle Bin empty.
- **365 days** → 3.15e10 ms → mod 2³² ≈ +1.47e9 ms ≈ **17 days effective retention**. Recent sessions survive (consistent with the reporter's "safe after downgrading to 365" observation) but anything older than ~17 days is silently deleted on the next pass.
- **≤ ~24 days** — the retention math does not overflow; the setting behaves as expected.

Mass-loss timing per the report: falls inside the 2.1.237 → 2.1.252 window, i.e. after the 2.1.248 retention rework. `~/.claude/.last-cleanup` tracks the last daily pass per config-dir seat.

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `settings.json` | `"cleanupPeriodDays": 24` (or any integer in `[1, 24]`) in `~/.claude/settings.json` and any per-project `.claude/settings.json`. Do NOT set `99999`, `36500`, or other "keep forever" placeholders on affected CC versions. | Yes — the setting key is stable | originator (gregmarkowitz-gif, 2026-09-01, 30-min tripwire since downgrade to 365 shows zero deletions) | `preferred` on 2.1.248+ until Anthropic ships a fix. Downside: retention capped at ~24 days; anything older will be purged on the next cleanup pass. Users who need longer retention should also snapshot `~/.claude/projects/` out-of-band (e.g. rsync to a location the cleanup does not touch). |
| `settings.json` | Downgrade to a CC version before 2.1.248 via `npm install -g @anthropic-ai/claude-code@2.1.237` and pin. | No — the point is to stay off the affected versions until the fix ships | cache-fix-team (one of our internal hosts, `cleanupPeriodDays: 99999` set, running a pre-2.1.248 CC, `.last-cleanup: 2026-08-31` — JSONLs from 2026-01-23 through today all present; 1985 files across 120 distinct days, no gaps consistent with truncation) | `narrow-use` — trades this bug against every fix that shipped after 2.1.237. Only for users whose retention needs strictly exceed 24 days and who can defer other CC updates. |

**What the reporter's evidence rules out:** VS Code extension involvement (CLI-only), scheduled-task deletion (audited), soft-delete (Recycle Bin empty), Retention Bot / third-party tools (none installed). The `.last-cleanup` timestamp advances daily per config-dir seat, so the deleter is CC's own built-in cleanup path.

**What the reporter's evidence does NOT prove:** the exact overflow site. The mod-2³² math above predicts the observed retention outcomes (99999 → mass delete, 365 → ~17-day silent retention, ≤24 → safe), but confirming it requires reading the 2.1.248+ cleanup path in the shipped binary — cc-watch extracts of that version window would let us pin the offset.

**Authoritative fix Anthropic should ship:** widen the retention-cutoff math to `Number` or `BigInt` (JS has no int32 by default — `Math.imul` and typed-array coercions do; if the cleanup path involves either, that's the site). Alternately, cap `cleanupPeriodDays` inputs at the safe boundary and warn users setting higher values.

---

### Cross-symptom — Post-update silent model remap (the Web Manager / April 17 pattern)

Upstream: This is a behavior, not a single tracked issue. Mechanism credit: @fgrosswig binary analysis of CC v2.1.91 (privately shared 2026-05-09; methodology is public, findings are not NDA-scoped, credit Falk by name in any public artifact that uses these).

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `env-var` | `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1` | Yes | cache-fix-team (via @fgrosswig binary analysis, 2026-05-09) | `preferred` — single most impactful flag for users who pin model versions. |

---

## Process notes

### Conventions for adding a row

1. **Symptom heading must point at a real, currently-open CC issue.** If the issue is closed-as-not-planned by the stale-bot, link the refile (see TRACKED_ISSUES.md row for #43657 → #67497 as an example).
2. **Knob field must be verbatim** from one of: (a) the upstream issue body, (b) the originator's reproduction, (c) the extension's `package.json`, (d) cache-fix-proxy source. Paraphrasing is not allowed; the field must be greppable.
3. **Originator field credits whoever first published the workaround.** Don't claim originator status for the cache-fix team unless we genuinely originated it (e.g., the `thinking-display` proxy extension).
4. **"Verified by" is honest about who actually tested it.** `cache-fix-team` means we ran it. `originator` means we accepted the report but did not independently reproduce. `community` means multiple independent confirmations on the upstream thread.
5. **Recommendation field is operationally meaningful.** `preferred` means we point users here first. `narrow-use` means it has tradeoffs that make it wrong for the general population. `community-reported` means we are not vouching for it. `internal-only` means we run it but it has properties (proprietary, undisclosed, complex) that make it wrong to recommend.

### When NOT to add a row

- A binary patch that removes safety surfaces, telemetry, or refusal logic. We do not catalog binary patches whose effect is removing classifier or AUP enforcement, regardless of whether the upstream bug is real (see "What this catalog is NOT" above).
- A workaround that requires modifying signed binaries without an explicit, narrow, length-preserving rationale (ojura's CC#59844 entry is on the edge; we list it because the entry is for empirical verification of a code-level fix, not for deployment).
- A workaround that depends on a third-party fork. The forked binary's behavior is the fork's responsibility, not Anthropic's; cataloging would imply equivalence we cannot vouch for.
- A workaround that is internal-only (e.g., `~/.claude/hooks/gh-bot-guard.sh` — our write-prefix guard for bot-identity discipline; not useful to general users).

### Relationship to TRACKED_ISSUES.md

- `TRACKED_ISSUES.md` is the index of CC issues we are monitoring, have commented on, or are directly relevant to our interceptor work.
- `WORKAROUND_CATALOG.md` is the index of mitigation paths organized by symptom.
- Most catalog symptoms point at a tracked issue. The reverse is not true: many tracked issues do not yet have an actionable workaround.
- When we post on a CC issue or ship a new proxy extension, both files should be updated in the same change.

---

## Seeding inventory (initial draft, to be expanded)

This is the seed for the catalog. Future additions are made by the contributor who discovers or posts on the issue, following the conventions above. Initial entries cover the highest-traffic surfaces:

1. **CC#59844 / thinking-display** — three mitigations at three depths; the claudio-felicioli wrapper is the cleanest for VS Code extension users.
2. **CC#59628 / worktree-edit-guard** — our shipped hook example.
3. **CC#63147 / thinking-wedge** — env-var workarounds (lossy) + proxy `session-health` extension.
4. **CC#62272 / cleanupPeriodDays overflow** — `settings.json` cap at 24 (originator-verified), OR pin CC to a pre-2.1.248 version (cache-fix-team-verified on our own host at 99999 with cleanup running daily, no losses).
5. **Silent model remap (Web Manager pattern)** — `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1` env-var.
