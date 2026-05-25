# Notes for Proxy Builder — v3.6.3 release-copy drafts

These are the lead's prep drafts staged for v3.6.3. Move them into the right destinations during the release PR, adjusting voice/cadence to match existing CHANGELOG and README structure.

**Heads-up on link rendering in this PR.** The relative paths inside the CHANGELOG and README drafts are written for their *final* destinations (`CHANGELOG.md` and `README.md` at repo root), not their current `docs/v3.6.3-prep/` location. That means the in-PR file preview will show "broken" links for these drafts — that is expected and by design, so the drafts are copy-paste-ready without path edits. The receipt page (`docs/disclosure/heron-brook-2026-05.md`) is already at its final path, so its links render correctly in the preview.

## Destinations

| Draft file | Destination |
|---|---|
| `docs/disclosure/heron-brook-2026-05.md` | Lands at `docs/disclosure/heron-brook-2026-05.md` (already at final path in this PR) |
| `docs/v3.6.3-prep/CHANGELOG-entry.md` | Insert as the v3.6.3 entry at the top of `CHANGELOG.md` |
| `docs/v3.6.3-prep/README-defense-section.md` | Insert into `README.md` after intro/quick-start, before configuration/usage detail |

## Notes on CHANGELOG-entry.md

- Section title is `v3.6.3 — Bootstrap-channel handling and audit logging` (subtitle covers both the routing/behavior change and the logging feature).
- "Behavior change" paragraph is the lead after the one-line summary so users running v3.6.2 today notice it on a skim. If existing CHANGELOG cadence puts behavior changes under a separate `Breaking changes` or `Behavior changes` heading, move accordingly.
- All operational-notes bullets are from the #146 reply: audit-isn't-no-behavioral-change disclosure, block-also-logs symmetry, no-statusline-yet note, concurrent-writer invariant, plus pipeline-hook design pointer.
- CHANGELOG stays tool-internal per Chris — no Reddit / community-link sprawl. Receipt page (`docs/disclosure/heron-brook-2026-05.md`) carries the full link set.
- The relative link to the receipt page is written as `docs/disclosure/heron-brook-2026-05.md` so it resolves correctly from `CHANGELOG.md` at repo root. In the in-PR preview it will look broken (current file lives in `docs/v3.6.3-prep/`) — that is intentional.

## Notes on README-defense-section.md

- The bootstrap-channel paragraph is ~150 words — longer than a first-pass draft — because the v3.6.2-vs-v3.6.3 behavior change needs to be addressable from the README, not just buried in the CHANGELOG. A user landing here from the receipt-page link should be able to understand the choice they're making.
- Parenthetical "(Note: cache-fix v3.6.2 and earlier..." can move to a footnote or a `> ` blockquote if you prefer to keep the main paragraph flowing. Left inline because the behavior change is load-bearing and footnotes get skipped.
- Mode toggle is an env var (`CACHE_FIX_BOOTSTRAP_MODE=audit|block`), not an `extensions.json` field — matches existing extension-config convention (extensions.json holds `enabled`/`order` only). If the README has an environment-variables / configuration section that documents proxy env knobs, `CACHE_FIX_BOOTSTRAP_MODE` and `CACHE_FIX_BOOTSTRAP_LOG_PATH` should land there alongside the existing entries; this section just references that the toggle exists and what it does.
- Relative links are written for the README at repo root (`docs/disclosure/heron-brook-2026-05.md`, `CHANGELOG.md#v363`). They will look broken in the in-PR preview because the draft currently lives in `docs/v3.6.3-prep/` — that is intentional; the paths are correct for the final destination.

## Notes on disclosure/heron-brook-2026-05.md

- Already at its final path in this PR. Three sections: what was filed (cites HackerOne #3760645), how it was closed (verbatim claudesec-h1 close text), what the proxy ships in response.
- Intentionally zero rebuttal — the tool is the statement. If you feel a phrasing nudge is needed for voice consistency, fine; please don't add adversarial framing.

## Sequencing reminder

Simultaneous flip: v3.6.3 release + heron-brook-poc public flip happen the same day, not staged. `docs/disclosure/heron-brook-2026-05.md` needs to be on `main` before — or in the same merge as — the v3.6.3 tag, because the public PoC README will link to it.

— AI Team Lead
