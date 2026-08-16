#!/usr/bin/env node
// absence-scan — the fixture hygiene classes, as an importable scanner and a
// CLI, so they can run where the exposure actually is.
//
// WHY THIS EXISTS AT ALL. The classes below were written as assertions inside
// test/harvest-scrub-relations.test.mjs §6 and fire at TEST time. The cost
// they guard against is paid at PUSH time: a harvested fixture carrying
// capture identifiers reached a public PR, and public git history cannot be
// scrubbed afterwards (the remediation for a leaked origin IP in a sibling
// repo was recreating the host). A check that only runs when someone runs the
// suite is not in front of that boundary. This file is the same check, made
// runnable by the pre-push hook the dotfiles repo deploys — the manual
// finding is the prototype, the mechanism is the deliverable
// (docs/dev-loop.md, "Adding a check").
//
// WHAT IT IS NOT. This is an EXTRACTION, not a redesign. Every predicate here
// is the one §6 encoded on 2026-07-31; nothing was tightened and nothing was
// loosened. The classes' DEFINITION is
// docs/directives/fixture-sanitization-directive.md ("Threat model" + settled
// designs 2 and 5), restated in §6 and restated again here — deliberately not
// read back out of tools/harvest.mjs, because an expectation with the same
// parentage as the code pins the bug it should catch.
//
// FINDINGS NEVER ECHO THE MATCH. A leak reporter that prints the leak into a
// terminal, a CI log or a hook transcript has moved the leak, not found it. A
// finding carries the class, the file, the JSON path that reaches the string,
// and lengths. Never the bytes.
//
// THE THIRD ANSWER (docs/dev-loop.md, "A checker has THREE answers"): a file
// that does not parse is neither silently skipped nor silently passed — it is
// scanned as raw bytes (so the two byte-level classes still apply) and named
// on a `degraded:` line, so a run that could not fully verify says so.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// --- Allowlist ---------------------------------------------------------------
//
// Lives here rather than in either caller, so the test and the push hook
// cannot drift apart on what is accepted.
//
// LEDGER-*.json is the per-machine harvest watermark ledger: fork-only, never
// part of an upstream slice, and keyed by raw capture key BY DESIGN. That is a
// real residual (operator ruling 2026-07-31) and is named rather than left
// implicit.
export const ALLOWLIST = [
  /(^|\/)test\/fixtures\/harvested\/LEDGER-[^/]*\.json$/,
];
//
// RETIRED 2026-08-05: `test/fixtures/cc-transcript-shape-snapshot.json`. The
// entry existed because that fixture was captured from a real transcript and
// carried its identifiers — an exemption for content the fork could not
// change. The fixture has since been REBUILT from known-safe parts (synthetic
// identifiers, no UUID-shaped values, no base64 run), so it now passes the
// classes on their merits and needs no exemption. Recorded rather than
// deleted silently: an allowlist that shrinks because the hazard was removed
// is a different fact from one that shrinks because someone softened it.

export function isAllowlisted(path) {
  const p = String(path).replace(/\\/g, "/");
  return ALLOWLIST.some((re) => re.test(p));
}

// --- Scope -------------------------------------------------------------------
//
// §6 states its scope in the same breath as its classes: "every committed
// fixture under test/fixtures/harvested". That scope is part of the
// DEFINITION, not an implementation detail of the test, and carrying it over
// is what keeps the classes honest — three of the five say what a SANITIZED
// HARVEST looks like, and a hand-authored proxy fixture is not one.
//
// Measured 2026-08-01, all five classes over every tracked *.json/*.jsonl in
// this repo (`node tools/absence-scan.mjs $(git ls-files '*.json' '*.jsonl')`
// before this scoping existed): 219 findings, of which ~205 were synthetic
// hand-authored test data — English prose in `text` fields, `ts` fields
// written by hand, a 4-character `source.data` placeholder. A guard that fires
// on those fires on every push and trains the --no-verify reflex that kills
// it (docs/dev-loop.md: "a check that fires on a non-defect is also broken").
//
// The two BYTE-level classes are not scoped, because they need no corpus to be
// true: a 200-character base64 run and an 8-4-4-4-12 UUID are a payload and a
// live capture identifier wherever they sit. Their measured false-fire rate
// over the same sweep was zero, and their true positives were real.
export const CORPUS_SCOPE = /(^|\/)test\/fixtures\/harvested\//;
export const inCorpus = (file) => CORPUS_SCOPE.test(String(file).replace(/\\/g, "/"));

// --- The class definitions ---------------------------------------------------

// (a) An image payload, a thinking signature or an encoded blob looks like a
//     long run of the base64 alphabet. 200 characters is the threshold §6 set.
export const B64_RUN = /[A-Za-z0-9+/]{201,}/;
// (d) A capture identifier. Session keys and sids appear only as `s-<sha12>`
//     tokens, which carry no dashes and so cannot satisfy this shape.
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// (d) …and a filename is as public as the content it names. The capture-derived
//     name carries `s-<sha12>`: 12 hex, never 8, so a name can never be matched
//     back to a session by prefix.
//     LEADING BOUNDARY, agreed in review on this PR: `[^0-9a-zA-Z]`, not
//     `[^0-9a-f]`. Every non-hex LETTER satisfies `[^0-9a-f]`, so the older
//     form fired on any ordinary English word ending in `s` followed by eight
//     hex — "plus-", "news-", "business-" and the like, and on a model id of
//     the `claude-3-opus-<8-digit date>` shape. The form below rejects all of
//     those while still matching every real capture-id shape: the token alone,
//     hyphen-prefixed, parenthesised, or preceded by a space. A guard that
//     fires on legitimate text trains its reader to wave it through, and on
//     the one gate standing in front of unscrubbable public history that is
//     the expensive kind of wrong.
//     The examples above are described rather than written out on purpose:
//     this file is scanned by its own tool, and a literal `s-` + 8 hex in a
//     comment is a finding. The suite carries the vectors, assembled at run
//     time — see the boundary bite there.
export const NAME_UUID_PREFIX = /(^|[^0-9a-zA-Z])s-[0-9a-f]{8}(?![0-9a-f])/;
// (c) A whole-string ISO-8601 instant. Deliberately whole-string: a date inside
//     authored prose (a fixture's own "measured on …" provenance note, a growth
//     artifact's filename) is documentation the artifact exists to carry.
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const EPOCH_START = Date.parse("2000-01-01T00:00:00.000Z");
export const EPOCH_END = Date.parse("2001-01-01T00:00:00.000Z");
// (b) A nested wire payload, tokenized.
export const DATA_TOKEN = /^data_[0-9a-f]{10}$/;
// (e) A tokenized text: `t_<sha256-prefix-12>_<length>` per "\n\n" segment,
//     with a <system-reminder> wrapper surviving verbatim around a tokenized
//     inner text.
export const TOKEN = /^t_[0-9a-f]{12}_[0-9]+$/;
export const WRAP = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>\s*$/;
export const CONTENT_KEYS = new Set(["text", "thinking", "content"]);

export const wellFormed = (scrubbed) =>
  scrubbed.split("\n\n").every((seg) => seg === "" || TOKEN.test(seg));

// Every string VALUE in a document, with the path that reaches it, plus the
// object that owns it — the scan has to see structure (`source.data`) as well
// as bytes.
export function* strings(node, path = "$") {
  if (typeof node === "string") return yield { path, value: node, owner: null };
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* strings(node[i], `${path}[${i}]`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") yield { path: `${path}.${k}`, value: v, owner: node, key: k };
      else yield* strings(v, `${path}.${k}`);
    }
  }
}

// `applies` is the class's DOMAIN — how many strings it had an opinion about.
// A caller that wants to know the scan was not vacuous reads the per-class
// counter, which is why the domain is not folded into `violates`.
// `scope`: "any" = true of any committed JSON, "corpus" = defined over the
// sanitized harvested fixture corpus only (see CORPUS_SCOPE above).
export const CLASSES = [
  {
    name: "b64-run",
    scope: "any",
    why: "a base64 run longer than 200 characters is an unsanitized payload",
    applies: () => true,
    violates: ({ value }) => {
      const m = B64_RUN.exec(value);
      return m ? { run: m[0].length } : null;
    },
  },
  {
    name: "nested-payload",
    scope: "corpus",
    why: "a raw source.data is the measured 2026-07-31 image gap",
    applies: ({ key, owner, path }) => key === "data" && !!owner && path.endsWith(".source.data"),
    violates: ({ value }) => (DATA_TOKEN.test(value) ? null : {}),
  },
  {
    name: "live-timestamp",
    scope: "corpus",
    why: "a live wall-clock timestamp survived the rebase onto the fixed epoch",
    applies: ({ value }) => ISO_INSTANT.test(value),
    violates: ({ value }) => {
      const t = Date.parse(value);
      return t >= EPOCH_START && t < EPOCH_END ? null : {};
    },
  },
  {
    name: "capture-uuid",
    scope: "any",
    why: "a session UUID is a live capture identifier",
    applies: () => true,
    violates: ({ value }) => (UUID.test(value) ? {} : null),
  },
  {
    name: "raw-content",
    scope: "corpus",
    why: "raw capture prose in a public-repo fixture",
    // Two accepted non-token literals, both content-free by construction:
    // "REDACTED" (tool-input key shapes, and the pre-2026-07-30 fixed-constant
    // reminder scrub still present in the legacy harvested-*.jsonl fixtures)
    // and the empty string.
    applies: ({ key, value }) => CONTENT_KEYS.has(key) && value !== "" && value !== "REDACTED",
    violates: ({ value }) => {
      const inner = WRAP.exec(value)?.[1] ?? value;
      if (inner === "REDACTED") return null;
      return wellFormed(inner) ? null : {};
    },
  },
];

export const CLASS_NAMES = CLASSES.map((c) => c.name);
const zeroSeen = () => Object.fromEntries(CLASS_NAMES.map((n) => [n, 0]));

/** The classes a given path is in scope for. */
export const classesFor = (file) => (inCorpus(file) ? CLASSES : CLASSES.filter((c) => c.scope === "any"));

/**
 * Scan one parsed document (or a bare string, for the raw-byte fallback).
 * Returns { findings, seen, scanned } — findings carry class, path and
 * lengths, never the matched bytes.
 *
 * ALL classes by default: a caller holding a document already knows what it
 * is. Path-driven scoping is the job of scanContent, which has a path.
 */
export function scanDocument(doc, { file = "", path = "$", classes = CLASSES } = {}) {
  const findings = [];
  const seen = zeroSeen();
  let scanned = 0;
  for (const entry of strings(doc, path)) {
    scanned++;
    for (const cls of classes) {
      if (!cls.applies(entry)) continue;
      seen[cls.name]++;
      const detail = cls.violates(entry);
      if (detail) {
        findings.push({ class: cls.name, file, path: entry.path, length: entry.value.length, ...detail });
      }
    }
  }
  return { findings, seen, scanned };
}

/** The filename class (d, second half). Names, not contents. */
export function scanName(file) {
  const name = basename(String(file));
  if (UUID.test(name) || NAME_UUID_PREFIX.test(name)) {
    return [{ class: "capture-uuid-filename", file, path: "<filename>", length: name.length }];
  }
  return [];
}

/**
 * A SOURCE file's text, scanned by LINE for the one class that can meaningfully
 * apply to it: a capture UUID written into prose or code.
 *
 * Why by line and why only this class. A source file has no document shape, so
 * the path-driven classes (`nested-payload`, `live-timestamp`, `raw-content`)
 * have nothing to walk, and `b64-run` over source fires on legitimate long
 * tokens. Bounding by INPUT FILTER — deciding what a file is before any class
 * sees it — is what keeps the data-only classes off source without each class
 * having to re-derive the scoping rule (the shape agreed in this PR's review
 * thread). Findings carry the line NUMBER; never the line.
 */
export function scanSourceText(text, file) {
  const findings = [];
  String(text).split("\n").forEach((line, i) => {
    if (!UUID.test(line)) return;
    findings.push({ class: "capture-uuid", file, path: `line ${i + 1}`, length: line.length });
  });
  return findings;
}

// NO EXEMPTION LIST HERE, and the absence is deliberate — it was tried and
// discarded the same hour. Widening the scan to source files makes it reach
// this suite's own synthetic UUID, which is a guard firing on legitimate work
// and normally earns a declared exemption. Here it does not: the constant it
// would have to excuse is the very constant every leak bite PLANTS, so the
// exemption swallowed three of the tool's own red-first cases and left them
// green. An exemption that blinds the instrument to its own defect class is
// worse than the false fire it removes.
// The suite assembles its UUID-shaped constants from parts at run time
// instead, so the source text contains no identifier shape at all and the
// scanner is green on its own repository with no predicate softened and
// nothing blessed by name.

/**
 * Scan file CONTENT already in hand (a blob out of git, a fixture read from
 * disk). `.jsonl` is split per line; a unit that does not parse is scanned as
 * raw bytes and named on the returned `degraded` list — never skipped.
 */
export function scanContent(text, file) {
  // A source file is not a fixture: no document shape, one applicable class.
  // It reports `partial` for the same reason a non-corpus JSON file does —
  // the run says what it could NOT check rather than presenting a narrowed
  // scan as a full one.
  if (SOURCE_SCANNABLE.test(file) && !SCANNABLE.test(file)) {
    return {
      findings: [...scanName(file), ...scanSourceText(text, file)],
      seen: zeroSeen(), scanned: 0, degraded: [], partial: true,
    };
  }
  const findings = [...scanName(file)];
  const seen = zeroSeen();
  const degraded = [];
  const classes = classesFor(file);
  let scanned = 0;
  const isJsonl = /\.jsonl$/i.test(file);
  const units = isJsonl ? text.split("\n").filter((l) => l.trim()) : [text];
  units.forEach((unit, i) => {
    let doc;
    try {
      doc = JSON.parse(unit);
    } catch {
      // Fail closed: the bytes still get the two byte-level classes.
      degraded.push(isJsonl ? `line ${i + 1} does not parse` : "does not parse");
      doc = unit;
    }
    const r = scanDocument(doc, { file, path: isJsonl ? `$[${i}]` : "$", classes });
    findings.push(...r.findings);
    for (const n of CLASS_NAMES) seen[n] += r.seen[n];
    scanned += r.scanned;
  });
  return { findings, seen, scanned, degraded, partial: !inCorpus(file) };
}

/** Scan a file from disk. */
export function scanFile(file) {
  return scanContent(readFileSync(file, "utf-8"), file);
}

// --- git range mode ----------------------------------------------------------

// The CORPUS filter: files whose content is a hygiene document to be walked
// path by path. Unchanged.
const SCANNABLE = /\.jsonl?$/i;

// The SOURCE filter, added in review on this PR. Until now `--git-range`
// filtered candidates to `.jsonl?$` BEFORE any class ran, so a capture
// identifier committed into a `.mjs`, a `.md`, a hook script or a YAML file
// was invisible to this scanner whatever the class definitions said — the
// blind spot this PR's own body documents and tells adopters to pair with a
// source-file grep. These are the file kinds where a leak has a plausible
// home: extensionless hook scripts and shell wrappers included, which is why
// the last two alternatives match a name with no dot at all.
//
// Measured cost of the widening on the fork that runs it: 0 findings across
// every tracked file, i.e. it cost nothing to turn on there.
const SOURCE_SCANNABLE =
  /(\.(mjs|cjs|js|md|sh|bash|zsh|ya?ml|py|txt|bats|template|toml|cfg|conf|env)$|^[^.]+$|\/[^./]+$)/i;

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8", maxBuffer: 1 << 28 });
}

function rangeFiles(oldRef, newRef) {
  const out =
    oldRef === "EMPTY"
      ? git(["ls-tree", "-r", "--name-only", newRef])
      : git(["diff", "--name-only", "--diff-filter=ACMR", oldRef, newRef]);
  return out.split("\n").map((l) => l.trim())
    .filter((l) => l && (SCANNABLE.test(l) || SOURCE_SCANNABLE.test(l)));
}

/**
 * Files added or modified between two refs, with their content at `newRef`.
 * `oldRef === "EMPTY"` means every file reachable at `newRef` — the new-branch
 * push, where there is no remote side to diff against.
 *
 * An `oldRef` git cannot resolve (a remote sha this clone never fetched)
 * degrades to EMPTY rather than erroring: scanning everything is the
 * fail-closed answer, and it is named on a `degraded:` line.
 */
export function scanGitRange(oldRef, newRef) {
  const degraded = [];
  let from = oldRef;
  if (from !== "EMPTY") {
    try {
      git(["cat-file", "-e", `${from}^{commit}`]);
    } catch {
      degraded.push(`base ref ${from} is not resolvable here — scanning everything at ${newRef}`);
      from = "EMPTY";
    }
  }
  const files = rangeFiles(from, newRef);
  const findings = [];
  const allowlisted = [];
  const seen = zeroSeen();
  let scanned = 0;
  let partial = 0;
  for (const file of files) {
    if (isAllowlisted(file)) {
      allowlisted.push(file);
      continue;
    }
    const text = git(["show", `${newRef}:${file}`]);
    const r = scanContent(text, file);
    findings.push(...r.findings);
    for (const n of CLASS_NAMES) seen[n] += r.seen[n];
    scanned += r.scanned;
    if (r.partial) partial++;
    degraded.push(...r.degraded.map((d) => `${file}: ${d}`));
  }
  return { findings, seen, scanned, degraded, allowlisted, files, partial };
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `usage:
  node tools/absence-scan.mjs <file...>
  node tools/absence-scan.mjs --git-range <old>..<new>   (from a repo root; <old> may be EMPTY)

exit 0 = clean, 2 = findings, 1 = internal error`;

function report(out, { findings, allowlisted = [], degraded = [], partial = 0 }) {
  for (const p of allowlisted) out(`allowlisted: ${p}`);
  for (const d of degraded) out(`degraded: ${d}`);
  // Never silence about what was only half-checked (docs/dev-loop.md, "A
  // checker has THREE answers").
  if (partial) {
    out(`scope: ${partial} file(s) outside test/fixtures/harvested/ — byte-level classes only ` +
        `(${CLASSES.filter((c) => c.scope === "any").map((c) => c.name).join(", ")})`);
  }
  for (const f of findings) {
    const extra = f.run ? ` run=${f.run}` : "";
    out(`FINDING ${f.class}  ${f.file || "<input>"}  ${f.path}  (${f.length} chars${extra})`);
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 ? 1 : 0;
  }
  const out = (s) => process.stdout.write(`${s}\n`);
  let result;
  if (args[0] === "--git-range") {
    const range = args[1];
    if (!range || !range.includes("..")) {
      process.stderr.write(`absence-scan: --git-range needs <old>..<new>\n${USAGE}\n`);
      return 1;
    }
    const [oldRef, newRef] = range.split("..");
    if (!newRef) {
      process.stderr.write("absence-scan: --git-range needs <old>..<new>\n");
      return 1;
    }
    result = scanGitRange(oldRef, newRef);
  } else {
    const findings = [];
    const allowlisted = [];
    const degraded = [];
    let partial = 0;
    for (const file of args) {
      if (isAllowlisted(file)) {
        allowlisted.push(file);
        continue;
      }
      const r = scanFile(file);
      findings.push(...r.findings);
      if (r.partial) partial++;
      degraded.push(...r.degraded.map((d) => `${file}: ${d}`));
    }
    result = { findings, allowlisted, degraded, partial };
  }
  report(out, result);
  if (result.findings.length) {
    out(`absence-scan: ${result.findings.length} finding(s) — these bytes must not reach a public history.`);
    return 2;
  }
  out("absence-scan: clean");
  return 0;
}

// Entrypoint guard. pathToFileURL, NOT `file://${argv[1]}`: on Windows
// import.meta.url is file:///C:/... while argv[1] is C:\... with backslashes,
// so the template form never matches and main() never runs — the CLI becomes a
// silent exit-0 no-op, and the pre-push hook that depends on it passes
// everything. Same helper proxy/pipeline.mjs already uses for its loader.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code;
  try {
    code = main(process.argv);
  } catch (err) {
    process.stderr.write(`absence-scan: internal error — ${err?.message ?? err}\n`);
    code = 1;
  }
  process.exit(code);
}
