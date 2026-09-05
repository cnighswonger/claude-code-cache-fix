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

Upstream: https://github.com/anthropics/claude-code/issues/59628 — Closed 2026-07-08 as `not_planned` by Anthropic. The workaround below is still applicable for users who want the guardrail; Anthropic will not ship a native fix.

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

### CC#62272 — Silent JSONL deletion despite `cleanupPeriodDays` set high (mechanism unresolved)

Upstream: https://github.com/anthropics/claude-code/issues/62272 — Closed 2026-08-19 as duplicate of **#41458** (canonical tracker; follow that one). Related historical loss: #59248 (orphaned subagent/tool-results dirs).

**Status of the theories on the thread — read this before citing anything below.**

An earlier reading of gregmarkowitz-gif's 2026-08-31 report on the thread framed the mechanism as signed-int32 overflow of a days→ms cutoff. **That hypothesis has been retracted by the original reporter on 2026-09-01T15:42Z.** The kill argument is short: `2^31 - 1 ms ≈ 24.855 days`, so if a days→ms cutoff truly overflowed int32, the shipped default `cleanupPeriodDays: 30` would misbehave identically. The default doesn't misbehave for the general user base, so int32 overflow can't be the mechanism. Any earlier framing (including cache-fix-team's comment posted on the thread the same day) is superseded.

**What is known on the thread as of 2026-09-01:**

- **Version-specific.** Machine A on 2.1.252 lost files under `cleanupPeriodDays: 99999`. Machine B in the same org on 2.1.251 with the same setting lost none (714 transcripts intact back to 2026-08-01). Loss window narrows to 2.1.252+.
- **Not simple age reap.** After the wipe on machine A, the busiest project directory held **exactly 25** top-level `.jsonl`, none older than 2026-08-31T18:48Z, while quieter project directories on the same box kept files from 2026-08-24 through 08-28. A global age reap takes the oldest first; here the oldest survived in quiet dirs and newer files in the busy dir died. Working hypothesis on the thread: **per-project-directory count cap (~25) applied to the busiest dir**. Not confirmed.
- **Inverse pattern reported on WSL2** by dowdys on 2026-07-21: idle project directories deleted entirely (64 of 69), busy directories survived. Same directory axis, opposite sign. Possibly two mechanisms; possibly one mechanism keyed on "was this directory being written to at sweep time" with a sign that hasn't been pinned.
- **Age-based cleanup does work at moderate settings on 2.1.252.** Canary on machine A at `cleanupPeriodDays: 365`: two synthetic `.jsonl` files backdated to −40d and −400d — next pass deleted the −400d file and spared the −40d file. So the setting itself honors age when it's in the sane range; the Aug-31 mass loss under 99999 is the anomaly to explain, and it isn't age.
- **Sweep cadence on affected boxes is ~4 hours, not daily**, per the same reporter's `~/.claude/.last-cleanup` timeline on machine A (`12:16:17Z`, `16:16:17Z`, same seconds 4h apart). Docs describe daily.
- **Blast radius is broader than `~/.claude/projects/`** per the WSL2 report: `file-history/` and paste-cache siblings were swept with the same cutoff. So any workaround that only snapshots `projects/` is partial.

| Depth | Knob | Survives update? | Verified by | Recommendation |
|---|---|---|---|---|
| `settings.json` | `"cleanupPeriodDays": <sane value>` (default 30 or a smaller integer) in `~/.claude/settings.json` and any per-project `.claude/settings.json`. **Do NOT set 99999, 36500, or other "keep forever" placeholders on 2.1.252+.** Community-reported: they are the exact configurations under which the losses occurred. Note this is defensive-configuration only — it does not target the actual (unknown) mechanism. | Yes — the setting key is stable. | `community-reported` — several thread reporters on 2.1.252+ recovered stability by dropping to `365` or below. Mechanism still open on #41458. | `preferred` while the upstream fix is pending. |
| `settings.json` | Downgrade to a CC version before 2.1.252 via `npm install -g @anthropic-ai/claude-code@2.1.251` (or earlier) and pin. | No — the point is to stay off the affected versions until the fix ships. | community-reported (machine B in the reporter's org on 2.1.251 + 99999 lost nothing). | `narrow-use` — trades this bug against every fix that shipped after 2.1.251. Only for users whose retention needs strictly exceed the sane-range cap and who can defer other CC updates. |
| `tool` | Out-of-band snapshot of `~/.claude/` (not just `projects/` — include `file-history/`, `paste-cache/`, memory subdirs) to a filesystem the built-in cleanup does not walk. `rsync -a` with hardlink dedup between snapshots (or `cp --reflink` on Btrfs) is the durable-copy primitive; retention on the archive is orthogonal to whatever CC does. See `blain3white/clean-my-agent` on the thread for a shipped user-space implementation. | Yes — decoupled from CC entirely. | community-reported (`blain3white/clean-my-agent`); cache-fix-team runs an internal equivalent (hourly rsync to a Btrfs tier with 48h rotation). | `preferred` for users who need retention past whatever cap the mechanism turns out to be. This is the only workaround that survives if the mechanism turns out to be per-dir count cap or idle-dir removal rather than age. |

**What the thread has NOT established:** the actual mechanism, the exact CC version boundary (some reports use `2.1.114`, some `2.1.252`), whether Windows/WSL2/Linux/macOS all share one bug or multiple, and whether `.last-cleanup`'s ~4h cadence is intentional. Reading the shipped binary for 2.1.252+ is the missing evidence.

**Authoritative fix Anthropic should ship (from the thread):** the canonical tracker is #41458. Any workaround here is defensive; the upstream fix is theirs. Ship with the mechanism identified so users can distinguish "safe to leave setting high" from "safe to leave setting low" from "no configuration is safe."

#### Operational recipe: durable-snapshot + touch-refresh stack

The `tool`-depth row above ("out-of-band snapshot") is the mitigation that survives regardless of mechanism. Below is the operational shape cache-fix-team runs, with the gotchas we hit the hard way in the 2026-09-01 → 2026-09-05 window. Adapt to fit; the invariants that matter are called out.

**The stack (four pieces):**

1. **Settings:** `"cleanupPeriodDays": 30` (default) or lower in `~/.claude/settings.json`. Do not set 99999.
2. **Hourly snapshot:** `rsync -a --link-dest=<prev-snap>` from `~/.claude/` to an archive dir on a filesystem CC does not walk. Not just `projects/` — the WSL2 report on CC#62272 shows `file-history/` and paste-cache siblings in the blast radius. `--link-dest` gives hardlink dedup between snapshots when they share a filesystem; on Btrfs `cp --reflink=always` is the CoW alternative.
3. **Daily selective touch:** `find ~/.claude/projects/ -type f -mtime +20 -exec touch {} +`. Only bumps files near whatever mtime cliff CC uses, does NOT flatten recent mtimes.
4. **Systemd-timer with `Persistent=true` for both jobs** so a missed run catches up on next boot.

**Non-obvious behaviors (each one cost real evidence to pin):**

- **Blanket touch breaks `claude --continue`.** `--continue` picks the most-recently-modified JSONL in the current project's directory. A blanket touch across every file flattens all mtimes to the touch instant, and `--continue` then picks arbitrarily among tied siblings. Selective touch (`-mtime +20`, or wherever your safety buffer lands relative to your setting) preserves the mtime ordering `--continue` needs. If you must recover a specific old session, use `claude --resume <session-id>` — it bypasses the `--continue` heuristic entirely.
- **`/rename <name>` writes to two locations.** Runtime: `~/.claude/sessions/<pid>.json` (dies with the process, has `formerNames[]` for rename history). Durable: `~/.claude/projects/<project-key>/<session-id>/custom-title.json` — a `{"customTitle":"..."}` file inside the per-session subdir. `claude --resume <name>` reads the durable one at invocation time. Any snapshot that captures `~/.claude/projects/` recursively catches both cases; the selective touch above walks into the subdir and bumps `custom-title.json` too.
- **Archive on a separate filesystem breaks `--link-dest` hardlinks** (Linux hardlinks can't cross filesystems). Snapshots still succeed as independent copies but you lose the dedup. Keep previous-snapshot and new-snapshot on one filesystem (or switch to `cp --reflink` if that filesystem is Btrfs).
- **`find -newer` against the archive is not evidence of file freshness.** `rsync -a` preserves the source mtime, so a file the source hasn't changed in 60 days still shows a 60-day-old mtime in the archive even though the snapshot was written today. Use content hashes for reconciliation, not mtime.
- **Prune inside the snapshot cron, AFTER the current snapshot lands.** `find <archive> -maxdepth 1 -type d -name 'snap-*' -mmin +$((48*60)) -exec rm -rf {} +` — but ONLY on the success path. If snapshot creation fails, the prune step MUST be skipped so a broken cron can't cascade into history loss.

**Restore workflow (when a loss is caught):**

1. Identify affected project keys: `find ~/.claude/projects/ -maxdepth 1 -type d` — subdirs with no top-level `<sid>.jsonl` are candidates.
2. Rsync-back: `rsync -a <archive>/snap-<pre-loss-timestamp>/projects/-home-manager-.../ ~/.claude/projects/-home-manager-.../`. Path assumes the documented whole-`~/.claude/` snapshot shape above — the archive's `projects/` subdir mirrors `~/.claude/projects/`. Additive without `--delete`, so files created since the snapshot are preserved. Restore other sibling subtrees (`file-history/`, paste-cache) the same way: `rsync -a <archive>/snap-.../file-history/ ~/.claude/file-history/`.
3. `touch` the restored files so their mtimes are current and won't age out immediately: `find ~/.claude/projects/<project-key>/ -type f -exec touch {} +`.
4. Verify: `claude --resume <session-id>` — direct-session-id resume works even when `/resume`'s picker filters by cwd or session-recency.

If the top-level session JSONL itself is gone from every snapshot (e.g. loss predates the archive's oldest snap), the subagent tree under `~/.claude/projects/<key>/<sid>/subagents/` often survives, along with `~/.claude/history.jsonl` entries for the sessionId — enough to reconstruct a session-continuation brief without the main transcript.

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
4. **CC#62272 / cleanupPeriodDays silent JSONL loss (mechanism unresolved)** — closed as dupe of #41458. Defensive settings (`cleanupPeriodDays` at 365 or lower), pin to pre-2.1.252, and durable out-of-band snapshot are the three complementary paths; the int32-overflow theory from an earlier version of this entry has been retracted upstream.
5. **Silent model remap (Web Manager pattern)** — `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1` env-var.
