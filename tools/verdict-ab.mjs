#!/usr/bin/env node
// verdict-ab — per-request classification verdicts for TWO trees, diffed.
//
// Why a separate tool rather than a mode of replay.mjs (dev-loop: "extend an
// existing tool before writing a new one"): replay.mjs is single-tree by
// construction — it imports the extension it replays, and its whole gate
// vocabulary is about one pipeline against recorded traffic. The question here
// is different in kind: does CHANGING the code change any decision it takes on
// the committed corpus? That needs two extension modules resident at once,
// which is a harness concern, not a gate concern.
//
// It started as the throwaway A/B script of the unit-2b build (closing report
// 2026-07-30, "Corpus A/B — nothing else moved") and is committed here because
// it was needed a second time, by the reserved-entry-identity build — the
// dev-loop rule that a probe used twice graduates or dies.
//
// THREE ANSWERS, not two (dev-loop). The first version of the unit-2b probe
// printed "IDENTICAL" over two EMPTY dumps after crashing on both trees: an
// absence of evidence wearing a verdict's clothes. So an empty corpus, or a
// corpus in which no fixture yields a replayable request, exits 2 with
// COULD-NOT-VERIFY and never 0.
//
//   node tools/verdict-ab.mjs <treeA> <treeB> [options]
//
//     <treeA> <treeB>   a git ref (checked out DETACHED into a scratch
//                       worktree, removed afterwards) or an existing directory
//                       holding a tree. Never the shared working tree.
//     --seed-from-a     feed tree B, at every request, the canonical tree A
//                       wrote for the preceding request. This is the
//                       OLD-CANON COMPATIBILITY probe: it asks whether the new
//                       code takes the same decision the old code did when it
//                       starts from state the old code produced — i.e. whether
//                       a restart is transparent for conversations already in
//                       flight. Without it, each tree runs its own chain, which
//                       asks the different (and also useful) question of
//                       whether steady-state behaviour moved.
//     --fixtures <dir>  fixture corpus directory
//                       (default: <this repo>/test/fixtures/harvested)
//     --scratch <dir>   where scratch worktrees are created
//                       (default: $TMPDIR/verdict-ab-<pid>)
//     --verbose         print every verdict line, not only the differing ones
//
//   exit 0  every verdict line identical
//   exit 1  at least one differs (the diff is printed)
//   exit 2  COULD NOT VERIFY — nothing replayable was found, or a tree failed
//           to load. Never reported as a pass.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = "proxy/extensions/insertion-normalization.mjs";

function parseArgs(argv) {
  const positional = [];
  const opts = { seedFromA: false, verbose: false, fixtures: null, scratch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed-from-a") opts.seedFromA = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--fixtures") opts.fixtures = argv[++i];
    else if (a === "--scratch") opts.scratch = argv[++i];
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) fail("need exactly two trees: <treeA> <treeB>");
  return { a: positional[0], b: positional[1], ...opts };
}

function fail(msg) {
  console.error(`verdict-ab: ${msg}`);
  process.exit(2);
}

// A tree argument is either a directory that already holds the extension, or a
// git ref to check out detached. The shared working tree is never used as a
// scratch checkout: `git worktree add` refuses to reuse it, and a swap under a
// live working copy is the mistake the unit-2b report called out by name.
function resolveTree(spec, scratchRoot, created) {
  const asDir = resolve(spec);
  if (existsSync(join(asDir, EXT))) return { dir: asDir, label: spec };
  let sha;
  try {
    sha = execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${spec}^{commit}`], {
      encoding: "utf-8",
    }).trim();
  } catch {
    fail(`"${spec}" is neither a directory holding ${EXT} nor a git ref in ${REPO}`);
  }
  const dir = join(scratchRoot, sha.slice(0, 12));
  if (!existsSync(dir)) {
    execFileSync("git", ["-C", REPO, "worktree", "add", "--detach", dir, sha], { stdio: "pipe" });
    created.push(dir);
  }
  if (!existsSync(join(dir, EXT))) fail(`${spec} (${sha.slice(0, 12)}) has no ${EXT}`);
  return { dir, label: `${spec} (${sha.slice(0, 8)})` };
}

// The committed corpus carries three shapes and all three are read, because a
// corpus silently narrowed to the shape the reader happens to parse is the
// blindness dev-loop names ("whatever a corpus is curated for, every other
// property is where it is blind") — and the first version of this reader saw
// 2 of the 6 message-array fixtures.
//
//   { requests: [{ n, ts, messages }] }   pre-grouped request-range fixtures
//                                         (flap, reset-move)
//   { header, records: [captureRecord] }  pinned-range fixtures
//   *.jsonl of captureRecords             harvested pair fixtures
//
// A capture record is { ts, sid, key, headers, body:{ messages, system } }.
// A fixture that carries no message array at all (the growth snapshots, the
// oscillation fixture) yields nothing and is REPORTED as skipped — never
// silently counted as clean.
function requestsFromRecords(records) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!Array.isArray(r?.body?.messages)) continue;
    out.push({ n: i, messages: r.body.messages, headers: r.headers, system: r.body.system });
  }
  return out;
}

function loadCorpora(dir) {
  if (!existsSync(dir)) fail(`fixture directory ${dir} does not exist`);
  const corpora = [];
  const skipped = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith("LEDGER-")) continue;
    const path = join(dir, name);
    let requests = [];
    try {
      if (name.endsWith(".jsonl")) {
        const records = readFileSync(path, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
        requests = requestsFromRecords(records);
      } else if (name.endsWith(".json")) {
        const doc = JSON.parse(readFileSync(path, "utf-8"));
        requests = Array.isArray(doc?.requests)
          ? doc.requests.filter((r) => Array.isArray(r?.messages))
          : requestsFromRecords(doc?.records ?? []);
      } else {
        continue;
      }
    } catch (e) {
      skipped.push(`${name}: unreadable (${e.message})`);
      continue;
    }
    if (requests.length === 0) {
      skipped.push(`${name}: no request carries a messages array`);
      continue;
    }
    corpora.push({ name: name.replace(/\.(json|jsonl)$/, ""), requests });
  }
  return { corpora, skipped };
}

// The verdict line. Deliberately the same seven fields the unit-2b A/B used —
// action, reset reason, pinned, suppressed, moved, dropped, forwarded length —
// because they are what every downstream gate reads off `stats`, plus the
// forwarded length that says whether the wire changed shape.
const verdictLine = (corpus, n, res, rawLen) =>
  `${corpus} n=${n} action=${res.action}` +
  ` reset=${res.resetReason ?? "-"}` +
  ` pinned=${res.pinned ?? 0}` +
  ` suppressed=${res.suppressed ?? 0}` +
  ` moved=${res.moved ?? 0}` +
  ` dropped=${res.dropped ?? 0}` +
  ` out=${(res.messages ?? { length: rawLen }).length}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scratchRoot = resolve(opts.scratch ?? join(tmpdir(), `verdict-ab-${process.pid}`));
  mkdirSync(scratchRoot, { recursive: true });
  const created = [];
  let exitCode = 0;
  try {
    const treeA = resolveTree(opts.a, scratchRoot, created);
    const treeB = resolveTree(opts.b, scratchRoot, created);
    let modA;
    let modB;
    try {
      modA = await import(pathToFileURL(join(treeA.dir, EXT)).href);
      modB = await import(pathToFileURL(join(treeB.dir, EXT)).href);
    } catch (e) {
      fail(`a tree failed to load: ${e.message}`);
    }
    if (typeof modA.classifyPinned !== "function" || typeof modB.classifyPinned !== "function") {
      fail("classifyPinned is not exported by both trees");
    }
    // Canonical state is PER CONVERSATION, and one capture key carries the main
    // thread, every subagent and CC's own sidecar calls. Chaining one canonical
    // across all of them would make tenant switches look like churn and every
    // verdict line downstream of the first switch meaningless. The grouping
    // identity is the extension's OWN — imported, never re-derived (dev-loop,
    // "never hand-roll identity in a probe").
    const groupOf = (r) => modA.resolveInsertionSessionKey(r.headers, r.messages, r.system);

    const { corpora, skipped } = loadCorpora(resolve(opts.fixtures ?? join(REPO, "test/fixtures/harvested")));
    console.log(`A: ${treeA.label}  ${treeA.dir}`);
    console.log(`B: ${treeB.label}  ${treeB.dir}`);
    console.log(`mode: ${opts.seedFromA ? "seed-from-A (old-canon compatibility)" : "independent chains"}`);
    for (const s of skipped) console.log(`  skipped ${s}`);

    const diffs = [];
    let lines = 0;
    for (const { name, requests } of corpora) {
      const canonA = new Map();
      const canonB = new Map();
      const groups = new Set();
      for (const r of requests) {
        const g = groupOf(r);
        groups.add(g);
        const priorA = canonA.get(g) ?? null;
        const resA = modA.classifyPinned(r.messages, priorA);
        const resB = modB.classifyPinned(r.messages, opts.seedFromA ? priorA : (canonB.get(g) ?? null));
        const lineA = verdictLine(name, r.n, resA, r.messages.length);
        const lineB = verdictLine(name, r.n, resB, r.messages.length);
        lines++;
        if (opts.verbose) console.log(`  A ${lineA}\n  B ${lineB}`);
        if (lineA !== lineB) diffs.push({ a: lineA, b: lineB });
        canonA.set(g, resA.canonicalEntries);
        canonB.set(g, resB.canonicalEntries);
      }
      console.log(`  ${name}: ${requests.length} request(s), ${groups.size} conversation(s)`);
    }

    // The third answer. Zero lines is not "identical" — it is nothing checked.
    if (lines === 0) {
      console.log("COULD NOT VERIFY — no fixture yielded a replayable request");
      exitCode = 2;
    } else if (diffs.length === 0) {
      console.log(`IDENTICAL across ${lines} verdict lines, ${corpora.length} corpora`);
    } else {
      console.log(`DIFFERS on ${diffs.length} of ${lines} verdict lines:`);
      for (const d of diffs) console.log(`  - A ${d.a}\n  + B ${d.b}`);
      exitCode = 1;
    }
  } finally {
    for (const dir of created) {
      try {
        execFileSync("git", ["-C", REPO, "worktree", "remove", "--force", dir], { stdio: "pipe" });
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  process.exit(exitCode);
}

await main();
