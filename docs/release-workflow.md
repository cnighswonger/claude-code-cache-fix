# Release Workflow

Canonical procedure for cutting and publishing a release of `claude-code-cache-fix`. Owned by Proxy Builder; AI Team Lead reviews and Chris signs off per the authority boundaries below.

The project is in **maintenance mode** as of 2026-05-03 (see `~/.claude/memory/shared/feedback_cache_fix_maintenance_mode.md`). Patch releases are the default; minor and major are exceptions.

---

## Release types

| Type | Semver bump | When | Authority |
|------|-------------|------|-----------|
| **Patch** (bugfix) | x.y.**Z** | Bug fixes only, no API changes, no new env vars, no new behavior | Proxy Builder ships autonomously after Codex review |
| **Minor** (feature) | x.**Y**.0 | New extension, new env var, new opt-in behavior — backward-compatible | AI Team Lead approves the directive scope before implementation begins; Proxy Builder ships the release |
| **Major** (breaking) | **X**.0.0 | Removed/renamed env vars, changed default behavior, removed extensions, breaking output format changes | Chris's explicit go required before tagging |
| **Hotfix** (security or critical regression) | x.y.**Z** | Production-impacting issues that can't wait | Proxy Builder ships immediately, notifies AI Team Lead and Chris after |

The maintenance-mode gate sits at the **directive stage** for minor/major releases, not at the release stage. By the time you're cutting the release, the scope question has already been answered.

---

## The procedure

Steps run in order. Don't skip Codex review (step 7) — it's the final gate, applies to every release type.

### 1. Pre-flight checks

- All target PRs merged to `main`
- `npm test` green on `main`
- `npm run lint` green (if applicable)
- No uncommitted local changes (`git status` clean)
- **Usage-log local mod re-applied if needed** — see `~/.claude/memory/shared/feedback_cache_fix_release_checklist.md`. The local mod gets reverted by certain merges; verify it's still in place before tagging.

### 2. CHANGELOG update

Open `CHANGELOG.md`. The top section should be `## [Unreleased]` with bullet-listed changes accumulated since the last release. For this release:

- Rename the `[Unreleased]` heading to `## [X.Y.Z] - YYYY-MM-DD`
- Group bullets under conventional headings: `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`
- Reference issue/PR numbers inline (e.g., "fixes the resume-marker regex no-op (#96)")
- Credit external contributors at the end of relevant bullets (e.g., "(@vmfarms surfaced this)") — see `~/.claude/memory/shared/reference_key_contributors.md` for the canonical credit pattern
- Add a new empty `## [Unreleased]` heading at the top for the next round

### 3. Version bump

```bash
npm version <patch|minor|major> --no-git-tag-version
```

The `--no-git-tag-version` flag is important — we tag manually after Codex review, not automatically. This bumps `package.json` and `package-lock.json` only.

### 4. Commit the release

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "release: vX.Y.Z"
```

One clean commit. No extra files. Push to your release branch (or directly to `main` if Chris has pre-approved the procedure for this release).

### 5. Push the release commit

```bash
git push origin <branch>
```

### 6. Get a Codex review of the release commit

This is the **final gate** before tagging. It applies to every release type — patch, minor, major, and hotfix.

Use `mcp__llm-relay__cli_delegate` (cli: `codex`) with the cache-fix repo as `working_dir`. Ask Codex to verify:

- CHANGELOG entry accurately reflects every commit since the last release tag
- Version bump matches the change scope (patch for bugfix-only, minor for new feature, major for breaking)
- No stray uncommitted files
- Usage-log local mod still in place
- No accidentally-committed debug code, secrets, or local-only patches

Codex's verdict goes in a review doc at `docs/code-reviews/release-vX.Y.Z-codex-review-YYYY-MM-DD.md`. If Codex flags blockers, fix them and re-review. If approved with non-blocking notes, address inline or note "deferred" with a reason.

For hotfixes: Codex review still required, but can be expedited. The point is to catch CHANGELOG/version/stray-file issues, which take Codex < 60 seconds — there's no good reason to skip this even under time pressure.

### 7. Tag

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Annotated tags only (`-a`), not lightweight tags. The tag message can mirror the CHANGELOG section heading.

### 8. npm publish

```bash
npm publish
```

The npm token lives at `~/.claude/.npm/.npmrc` for the `vsitsllc` org (see `~/.claude/memory/shared/reference_npm_token.md` for current expiry — token rotates roughly every 90 days). If publish fails on auth, the token may have expired; ask Chris to rotate before retrying.

Verify the publish landed:

```bash
npm view claude-code-cache-fix version
```

Should return the new version within ~30 seconds.

### 9. GitHub Release

**Required for every release** — not just tagging. Per `~/.claude/memory/shared/feedback_release_process.md`, a tag without a GitHub Release is incomplete: the Release page is what users actually read.

```bash
gh release create vX.Y.Z --title "vX.Y.Z — <one-line summary>" --notes-file release-notes.md
```

`release-notes.md` content:

- One-paragraph summary of what's in this release and who it's for
- Bulleted change list (mirror the CHANGELOG section, but rendered for non-technical readers — focus on impact, not implementation detail)
- Contributor credits with @-handle links
- Upgrade instructions if non-obvious (`npm install -g claude-code-cache-fix@X.Y.Z`)
- For minor/major: link to the directive PR if there is one, for users who want the architectural detail

Use the `vsits-proxy-builder[bot]` token for this — the bot has `releases:write` on the repo. Generate via `~/.claude/github-apps/generate-token.sh proxy-builder` and inline as `GH_TOKEN=$(...) gh release create ...`.

### 10. Post-release

- Notify AI Team Lead (PR comment, issue comment, or memory note — whatever fits) so community-facing artifacts can be updated: vsits.co posts referencing the new version, replies to users waiting on the fix, blog/newsletter mentions if applicable
- For minor/major releases, also notify Chris directly so he can decide on social-media announcement, newsletter mention, etc.
- Verify the GitHub Release page renders correctly (markdown, links, contributor @-mentions resolve)

---

## Bot identity and authentication

| Bot | App ID | Used for | Token script |
|-----|--------|----------|--------------|
| `vsits-proxy-builder[bot]` | 3523665 | All cache-fix repo writes from Proxy Builder (commits, PRs, issues, releases) | `~/.claude/github-apps/generate-token.sh proxy-builder` |

Per `~/.claude/memory/shared/feedback_use_per_agent_bot_for_gh_writes.md`, inline the token at the call site:

```bash
export GH_TOKEN=$(~/.claude/github-apps/generate-token.sh proxy-builder)
gh release create ...
```

Don't persist the token in shell config; it's short-lived (1 hour by default) and re-generates instantly.

If you hit a `403` on push or release-create, check `playbook_codex_review_push_403.md` in shared memory — the issue may be App permissions, not bot identity.

---

## What can go wrong

A short list of failure modes seen on past releases:

- **GitHub Release creation fails with 403** — App permissions issue. The team-lead App had `releases:write` granted on 2026-05-02 after a previous failure; the proxy-builder App should have it too, but verify if the publish fails. See `playbook_codex_review_push_403.md`.
- **npm publish auth fails** — token expired. Rotate per the npm token memory entry; don't try to bypass.
- **Tag pushed but release not created** — incomplete release per the memory rule. Either complete it (preferred) or delete the tag and start over.
- **CHANGELOG missed an entry** — Codex review catches this in step 6 if you actually run it. Don't skip step 6.
- **Wrong semver bump** — patch when it should have been minor (e.g., shipped a new env var as a "fix"). Codex review catches this in step 6 if you ask it to verify "version bump matches change scope". Don't skip step 6.

---

## Authority boundaries (recap)

- **Patch / hotfix** — Proxy Builder ships autonomously after Codex review (step 6)
- **Minor** — AI Team Lead approves directive scope first; Proxy Builder ships the release after merge + Codex review
- **Major** — Chris's explicit go required before step 7 (tag); AI Team Lead reviews breaking-change documentation

When in doubt about which type a release is, ask AI Team Lead before step 3 (version bump).
