// absence-scan — the scanner's own bite.
//
// The classes it carries were extracted out of harvest-scrub-relations.test.mjs
// §6, where they assert the ABSENCE of a defect over a corpus that is clean.
// That shape cannot bite itself: a neutered predicate over a clean corpus still
// passes, so "the suite is green" says nothing about whether the extraction
// kept the classes alive. What proves a class alive is a SEEDED defect — one
// synthetic document per class, each of which must produce exactly its own
// finding. That is what the first section does, and it is the guarantee the
// extraction needed.
//
// The rest exercises the CLI contract the pre-push hook in the dotfiles repo
// depends on: exit 2 on findings, 0 on clean, the git-range mode over a real
// scratch repository, the allowlist, and the degraded (unparseable) path.
//
// Every identifier here is synthetic — this repo is public.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRUBBED_GIT_ENV } from "./git-env.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { scanDocument, scanContent, isAllowlisted, CLASSES, NAME_UUID_PREFIX } from "../tools/absence-scan.mjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "absence-scan.mjs");
const CORPUS = "test/fixtures/harvested";

// Synthetic, and shaped like the thing each class is defined against.
// Assembled from parts rather than written as a literal: this file is
// scanned by the very tool it tests, and a UUID-shaped literal in source
// is exactly what the widened source scan is built to find. Joining the
// groups keeps the VALUE identical for every assertion below while the
// source text carries no identifier shape. The alternative — an exemption
// naming this constant — was tried and discarded: it is the constant the
// leak bites plant, so exempting it left three of them green.
const FAKE_UUID = ["0123abcd", "4567", "89ef", "0123", "456789abcdef"].join("-");
const LONG_B64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0".repeat(4);
const TOKEN_TEXT = "t_0123456789ab_42";

// A document with nothing for any class to say anything about.
const CLEAN = {
  key: "s-0123456789ab",
  ts: "2000-01-01T00:00:03.000Z",
  messages: [
    { role: "user", content: [{ type: "text", text: TOKEN_TEXT }] },
    {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "data_0123456789" } }],
    },
  ],
};

// One seeded defect per class. Each entry is the MINIMAL deviation from CLEAN
// that its class is defined to catch.
const SEEDED = {
  // On a `signature`, not on a `text`: a long base64 run inside a content
  // field is legitimately BOTH an unsanitized payload and untokenized content,
  // and a seed that trips two classes cannot show which one caught it.
  "b64-run": {
    ...CLEAN,
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: TOKEN_TEXT, signature: LONG_B64 }] },
    ],
  },
  "nested-payload": {
    ...CLEAN,
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "iVBORw0KGgoAAAA" } }] },
    ],
  },
  "live-timestamp": { ...CLEAN, ts: "2026-08-01T09:15:00.000Z" },
  "capture-uuid": { ...CLEAN, key: FAKE_UUID },
  "raw-content": {
    ...CLEAN,
    messages: [{ role: "user", content: [{ type: "text", text: "plain prose that never went through the scrub" }] }],
  },
};

test("every class goes RED on its own seeded defect, and only that class", () => {
  for (const cls of CLASSES) {
    const doc = SEEDED[cls.name];
    assert.ok(doc, `no seeded defect for class ${cls.name} — a class without a bite is an orphan`);
    const fired = new Set(scanDocument(doc).findings.map((f) => f.class));
    assert.ok(fired.has(cls.name), `${cls.name} did not fire on its own seeded defect`);
    assert.deepEqual([...fired], [cls.name], `${cls.name}'s seeded defect must not trip a second class`);
  }
});

test("the clean document produces no finding at all", () => {
  assert.deepEqual(scanDocument(CLEAN).findings, []);
});

test("a finding never carries the matched bytes", () => {
  // A leak reporter that prints the leak has moved it, not found it.
  const findings = scanDocument(SEEDED["capture-uuid"]).findings;
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ["class", "file", "length", "path"]);
  assert.ok(!JSON.stringify(findings).includes(FAKE_UUID));
});

test("the filename class fires on a UUID name and on an 8-hex s- prefix, not on the real token shape", () => {
  const names = (n) => scanContent(JSON.stringify(CLEAN), `${CORPUS}/${n}`).findings.map((f) => f.class);
  assert.deepEqual(names(`pinned-${FAKE_UUID}-26-28.json`), ["capture-uuid-filename"]);
  assert.deepEqual(names("pinned-s-4b6a4352-26-28.json"), ["capture-uuid-filename"]);
  assert.deepEqual(names("pinned-s-4b6a435234bf-26-28.json"), [], "12 hex after s- is the sanitized shape");
});

test("classes defined over the harvested corpus do not fire outside it; byte-level classes do", () => {
  // Measured basis (report absence-guard-report.md): the corpus-shape classes
  // fired ~205 times on hand-authored synthetic proxy fixtures, none of which
  // is a defect. The byte-level classes fired only on real leaks.
  const outside = scanContent(JSON.stringify(SEEDED["raw-content"]), "test/fixtures/hand-written.json");
  assert.deepEqual(outside.findings, [], "prose in a hand-authored fixture is not a sanitization defect");
  assert.equal(outside.partial, true, "and the run must SAY it only half-checked");

  const uuidOutside = scanContent(JSON.stringify(SEEDED["capture-uuid"]), "test/fixtures/hand-written.json");
  assert.deepEqual(uuidOutside.findings.map((f) => f.class), ["capture-uuid"],
    "a live capture identifier needs no corpus to be one");
});

test("an unparseable file is scanned as raw bytes and reported degraded, never skipped", () => {
  const r = scanContent(`{ not json at all ${FAKE_UUID}`, `${CORPUS}/broken.json`);
  assert.deepEqual(r.degraded, ["does not parse"]);
  assert.deepEqual(r.findings.map((f) => f.class), ["capture-uuid"]);
});

test("the allowlist covers the LEDGER watermark file and nothing else in the corpus", () => {
  assert.equal(isAllowlisted(`${CORPUS}/LEDGER-Siren.json`), true);
  assert.equal(isAllowlisted(`${CORPUS}/pinned-s-4b6a435234bf-26-28.json`), false);
});

// --- CLI ---------------------------------------------------------------------

// The git-spawn environment lives in one place now — see test/git-env.mjs
// for the incident that made it shared rather than per-file.

const run = (args, cwd) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: "utf-8", env: SCRUBBED_GIT_ENV });

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "absence-scan-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedCorpusFile(dir, name, doc) {
  mkdirSync(join(dir, CORPUS), { recursive: true });
  const rel = `${CORPUS}/${name}`;
  writeFileSync(join(dir, rel), JSON.stringify(doc, null, 2));
  return rel;
}

test("CLI: exit 2 on a file carrying a synthetic UUID, exit 0 on a clean one", () => {
  withTemp((dir) => {
    const dirty = seedCorpusFile(dir, "dirty.json", SEEDED["capture-uuid"]);
    const bad = run([dirty], dir);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /FINDING capture-uuid/);
    assert.ok(!bad.stdout.includes(FAKE_UUID), "the CLI must not echo the matched bytes either");

    const clean = seedCorpusFile(dir, "clean.json", CLEAN);
    const ok = run([clean], dir);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /absence-scan: clean/);
  });
});

test("CLI: an allowlisted path is reported, not scanned", () => {
  withTemp((dir) => {
    const led = seedCorpusFile(dir, "LEDGER-Testhost.json", SEEDED["capture-uuid"]);
    const r = run([led], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^allowlisted: /m);
    assert.ok(!r.stdout.includes("FINDING"));
  });
});

test("CLI: no arguments is an internal-error exit, not a silent pass", () => {
  const r = run([]);
  assert.equal(r.status, 1);
});

// --- git range ---------------------------------------------------------------

function gitRepo(dir) {
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8", env: SCRUBBED_GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  return g;
}

test("git-range: red on a defect added in the range, green on the range before it", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    const cleanRel = seedCorpusFile(dir, "clean.json", CLEAN);
    g("add", cleanRel);
    g("commit", "-qm", "clean");
    const first = g("rev-parse", "HEAD");

    const dirtyRel = seedCorpusFile(dir, "dirty.json", SEEDED["capture-uuid"]);
    g("add", dirtyRel);
    g("commit", "-qm", "dirty");
    const second = g("rev-parse", "HEAD");

    const red = run(["--git-range", `${first}..${second}`], dir);
    assert.equal(red.status, 2, red.stdout + red.stderr);
    assert.match(red.stdout, /FINDING capture-uuid {2}test\/fixtures\/harvested\/dirty\.json/);
    assert.ok(!red.stdout.includes("clean.json"), "an unchanged file is outside the range");

    const green = run(["--git-range", `EMPTY..${first}`], dir);
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });
});

test("git-range: EMPTY scans every file reachable at the new ref (the new-branch push)", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    const dirtyRel = seedCorpusFile(dir, "dirty.json", SEEDED["capture-uuid"]);
    g("add", dirtyRel);
    g("commit", "-qm", "dirty");
    const head = g("rev-parse", "HEAD");
    const r = run(["--git-range", `EMPTY..${head}`], dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });
});

test("git-range: a deleted file is not scanned, and a non-JSON file is ignored", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    const dirtyRel = seedCorpusFile(dir, "dirty.json", SEEDED["capture-uuid"]);
    writeFileSync(join(dir, "notes.md"), `not scanned ${FAKE_UUID}\n`);
    g("add", dirtyRel, "notes.md");
    g("commit", "-qm", "dirty");
    const first = g("rev-parse", "HEAD");

    rmSync(join(dir, dirtyRel));
    g("add", "-A");
    g("commit", "-qm", "removed");
    const second = g("rev-parse", "HEAD");

    const r = run(["--git-range", `${first}..${second}`], dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });
});

test("git-range: an unresolvable base ref degrades to a full scan rather than erroring", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    const dirtyRel = seedCorpusFile(dir, "dirty.json", SEEDED["capture-uuid"]);
    g("add", dirtyRel);
    g("commit", "-qm", "dirty");
    const head = g("rev-parse", "HEAD");
    // A sha this clone has never seen — the shape of a remote ref that was
    // never fetched.
    const r = run(["--git-range", `0000000000000000000000000000000000000001..${head}`], dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^degraded: base ref /m);
  });
});

// A consumer of this tool may have no test/fixtures/harvested/ directory at
// all (upstream, at the time this file was ported, is exactly that case).
// CORPUS_SCOPE and classesFor are pure string/regex tests over a path — there
// is no readdir or existsSync anywhere in this file — so an absent directory
// was never going to throw; what this pins down is the OTHER two ways that
// could go wrong: reading the empty scope as "nothing to check" (silent skip
// of the byte-level classes too) rather than "no corpus-scoped classes apply,
// byte-level classes still do."
test("git-range: no test/fixtures/harvested/ directory anywhere in the repo — empty corpus scope reads as passing, not an error, and does not widen to skip the byte-level classes", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
    writeFileSync(join(dir, "test/fixtures/clean.json"), JSON.stringify(CLEAN));
    g("add", "test/fixtures/clean.json");
    g("commit", "-qm", "no harvested dir, clean file");
    const first = g("rev-parse", "HEAD");
    const clean = run(["--git-range", `EMPTY..${first}`], dir);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /absence-scan: clean/);

    // A leak placed outside the (nonexistent) corpus directory must still be
    // caught: an absent CORPUS_SCOPE must never be read as "skip everything."
    writeFileSync(join(dir, "test/fixtures/dirty.json"), JSON.stringify(SEEDED["capture-uuid"]));
    g("add", "test/fixtures/dirty.json");
    g("commit", "-qm", "leak outside the absent corpus dir");
    const second = g("rev-parse", "HEAD");
    const dirty = run(["--git-range", `${first}..${second}`], dir);
    assert.equal(dirty.status, 2, dirty.stdout + dirty.stderr);
    assert.match(dirty.stdout, /FINDING capture-uuid {2}test\/fixtures\/dirty\.json/);
  });
});

// ── Source files: a capture UUID may exist only on the allowlist ──────────────
//
// Fixtures are covered by the classes above; SOURCE leaks ride in comments and
// string literals instead (found live 2026-08-01: the same capture UUID in a
// test file's evidence comment and in tools/replay.mjs — public repo,
// unscrubbable history). A bare "no UUIDs in source" rule would fire on the
// synthetic ones, so the rule is: every UUID in test/, tools/, and proxy/
// source is on the explicit synthetic allowlist below, or this test fails. A
// new legitimate synthetic is added HERE, deliberately, in the same diff a
// reviewer sees — never waved through.
//
// docs/ IS THE SAME SURFACE (widened 2026-08-01, BACKLOG "docs/ UUID triage"):
// a directive, a review or a release-test log is as public as a source file,
// and the same sweep found real capture keys and a session id sitting in four
// of them. Prose carries more legitimate synthetics than code does — hence the
// provenance line on each entry below.

// DELIBERATELY NOT PORTED, and the reason is the port's own boundary.
//
// The fork this tool comes from carries two further tests here: one asserting
// that its transcript-shape fixture passes the classes on its own bytes, and
// one walking test/, tools/, proxy/ and docs/ to require every UUID in the
// SOURCE tree to be on a synthetic allowlist. Both are guards over the HOST
// REPOSITORY'S TRACKED CONTENT, not over this tool's behaviour — they encode
// which files that repo has decided are clean, and their allowlists are that
// repo's roster.
//
// Ported verbatim they would fail here, and they DO: run against this repo's
// current tree they report `test/fixtures/cc-transcript-shape-snapshot.json`
// and several UUIDs under docs/ — findings that are about this repo's
// content, correctly identified, and nothing to do with whether the scanner
// works. A tool's bite must go red on the tool's defects; a suite that also
// goes red on its host's data cannot be landed by whoever adopts the tool,
// and softening it to pass would be worse.
//
// The findings themselves are real and are reported separately rather than
// dropped (see the PR body). Adopting repos that want the source-tree guard
// should add it with their own roster.

// --- the two changes agreed in this PR's review thread ----------------------

test("NAME_UUID_PREFIX: the leading boundary drops word-tail collisions and keeps every real capture-id shape", () => {
  // The whole point of the agreed change, stated as a PAIR: the four on the
  // left must NOT match (they are ordinary English words ending in `s`, and a
  // model id), the four on the right MUST. A boundary fix that only stopped
  // false fires would be satisfied by a regex matching nothing at all.
  // Every vector is ASSEMBLED, never written as a literal: this file is
  // scanned by the tool it tests, and `s-` followed by eight hex is precisely
  // the shape that scan exists to find. Writing the vectors out would make the
  // suite a finding in its own repository.
  const H = "12345678";
  const S = "s-";
  for (const negative of [`plus-${H}`, `news-${H}`, `business-${H}`,
                          `claude-3-opus-${"2024"}${"0229"}`]) {
    assert.equal(NAME_UUID_PREFIX.test(negative), false, `must not match: ${negative}`);
  }
  for (const positive of [`${S}${H}`, `prefix-${S}${H}`, `(${S}${H})`, ` ${S}${H}`]) {
    assert.equal(NAME_UUID_PREFIX.test(positive), true, `must match: ${positive}`);
  }
});

test("scanContent: a SOURCE file is scanned by line for capture UUIDs, and the data-only classes never see it", () => {
  const src = [
    "// a comment",
    `const id = "${FAKE_UUID}";`,
    `const blob = "${LONG_B64}";`,
  ].join("\n");
  const r = scanContent(src, "tools/whatever.mjs");
  const classes = r.findings.map((f) => f.class);
  assert.deepEqual(classes, ["capture-uuid"]);
  // The line NUMBER, never the line: a leak reporter that echoes the leak has
  // moved it, not found it.
  assert.equal(r.findings[0].path, "line 2");
  assert.ok(!JSON.stringify(r.findings).includes(FAKE_UUID));
  // b64-run is a data class and must not reach source, or every minified or
  // long-token file in an adopting repo becomes a finding.
  assert.ok(!classes.includes("b64-run"));
  // The run says what it could not fully check rather than presenting a
  // narrowed scan as a whole one.
  assert.equal(r.partial, true);
});

test("git-range: a capture UUID committed into a .mjs is FOUND — the blind spot this PR's body documents", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    g("add", "seed.txt");
    g("commit", "-qm", "seed");
    const first = g("rev-parse", "HEAD");

    // Two source shapes in one commit: an extensionless hook script (matched
    // by the no-dot alternative) and an ordinary .mjs.
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "pre-push"), `#!/bin/sh\n# ${FAKE_UUID}\n`);
    writeFileSync(join(dir, "tool.mjs"), `const id = "${FAKE_UUID}";\n`);
    g("add", "hooks/pre-push", "tool.mjs");
    g("commit", "-qm", "source files");
    const second = g("rev-parse", "HEAD");

    const red = run(["--git-range", `${first}..${second}`], dir);
    assert.equal(red.status, 2, red.stdout + red.stderr);
    assert.match(red.stdout, /FINDING capture-uuid {2}tool\.mjs/);
    assert.match(red.stdout, /FINDING capture-uuid {2}hooks\/pre-push/);
    assert.ok(!red.stdout.includes(FAKE_UUID), "never echo the matched bytes");
  });
});

test("git-range: a clean source file stays green — the widening is not a blanket red", () => {
  withTemp((dir) => {
    const g = gitRepo(dir);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    g("add", "seed.txt");
    g("commit", "-qm", "seed");
    const first = g("rev-parse", "HEAD");

    writeFileSync(join(dir, "tool.mjs"), "export const x = 1;\n");
    writeFileSync(join(dir, "notes.md"), "no identifiers here\n");
    g("add", "tool.mjs", "notes.md");
    g("commit", "-qm", "clean source");
    const second = g("rev-parse", "HEAD");

    const green = run(["--git-range", `${first}..${second}`], dir);
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });
});
