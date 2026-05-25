# Notes for Proxy Builder — v3.6.3 release-copy drafts

These are the lead's prep drafts staged for v3.6.3. Move them into the right destinations during the release PR, adjusting voice/cadence to match existing CHANGELOG and README structure.

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
- The relative link `../disclosure/heron-brook-2026-05.md` resolves from `CHANGELOG.md` at repo root once you move the file out of `docs/v3.6.3-prep/`. Verify after relocation.

## Notes on README-defense-section.md

- The bootstrap-channel paragraph is ~150 words — longer than a first-pass draft — because the v3.6.2-vs-v3.6.3 behavior change needs to be addressable from the README, not just buried in the CHANGELOG. A user landing here from the receipt-page link should be able to understand the choice they're making.
- Parenthetical "(Note: cache-fix v3.6.2 and earlier..." can move to a footnote or a `> ` blockquote if you prefer to keep the main paragraph flowing. Left inline because the behavior change is load-bearing and footnotes get skipped.
- If the README has a `Configuration` section that documents `extensions.json` keys, `mode: audit | block` for the bootstrap-defense extension should land there alongside the existing entries; this section just references that mode exists and what it does.
- Relative links are written for the README at repo root (`docs/disclosure/...`, `CHANGELOG.md`). Verify after relocation.

## Notes on disclosure/heron-brook-2026-05.md

- Already at its final path in this PR. Three sections: what was filed (cites HackerOne #3760645), how it was closed (verbatim claudesec-h1 close text), what the proxy ships in response.
- Intentionally zero rebuttal — the tool is the statement. If you feel a phrasing nudge is needed for voice consistency, fine; please don't add adversarial framing.

## Sequencing reminder

Simultaneous flip: v3.6.3 release + heron-brook-poc public flip happen the same day, not staged. `docs/disclosure/heron-brook-2026-05.md` needs to be on `main` before — or in the same merge as — the v3.6.3 tag, because the public PoC README will link to it.

— AI Team Lead
