#!/usr/bin/env node
// gate-live — run the replay gate over the LIVE captures, on a schedule.
//
// Why this exists, and it is not "extra coverage".
//
// Two defects surfaced in the gate itself on 2026-07-28, and both were
// invisible for the same structural reason: the gate had never been pointed at
// a production-shaped input.
//
//   1. it read the capture with readFile(..., "utf-8"), so a 955 MB capture
//      threw `RangeError: Invalid string length` before a single check ran;
//   2. it retained every request's full message history, peaking at 3.2 GB —
//      within sight of V8's default ceiling.
//
// Neither could ever be caught by `npm test`, and not by accident. The
// committed corpus is produced by harvest.mjs, which selects pairs by
// STRUCTURAL NOVELTY and sanitises them: small by construction, and
// deliberately so. A fixture corpus curated for structural novelty cannot
// contain a scale-shaped input — the blind spot is designed in. So scale,
// volume and ordering-at-scale are exactly the classes that stay green in CI
// forever while being broken in practice.
//
// The live captures are the only production-shaped inputs available, they
// exist on disk already, and something is already walking them twice a day
// (cache-fix-harvest). This runs the real gate against them and writes a
// verdict a checker can read, so "the gate cannot run" and "the gate found
// something in live traffic" both surface within a day instead of on the next
// occasion someone happens to try it by hand.
//
// One child process per capture, deliberately: memory stays bounded to the
// largest single capture rather than their sum, and a crash on one file is
// recorded rather than ending the sweep. Whatever kills one capture is
// precisely what this is here to report.

import { spawn, spawnSync } from "node:child_process";
import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { sourceFingerprint, PROXY_ROOT } from "../proxy/source-fingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPLAY = join(__dirname, "replay.mjs");
const CENSUS = join(__dirname, "reminder-migration-census.mjs");
const DEFAULT_CAPTURES = join(homedir(), ".claude", "cache-fix-captures");
const DEFAULT_STATUS = join(homedir(), ".claude", "cache-fix-gate-status.json");

// --- Production gate set ---
//
// The gate must replay the configuration that is actually SERVING, not the
// extensions' defaults. Learned the expensive way on 2026-07-28: replay
// inherits nothing from the systemd unit, and `CACHE_FIX_TOOL_REWRITE`
// defaults OFF while the unit sets it ON. So every gate run that day — this
// sweep included — exercised a pipeline nobody runs, and reported 0
// violations. Re-run with the unit's own gates, the same corpus produced 2
// stability violations attributed to deferred-tool-rewrite. A green verdict
// over the wrong configuration is worth nothing.
//
// The unit is the declaration of what production is, so it is the source
// here — read live rather than copied, because a copy is a second source that
// drifts. Two are overridden OFF deliberately: REQUEST_CAPTURE would have the
// replay write captures of the captures, and SESSION_MIRROR would write
// mirrors; neither transforms the request, so excluding them costs no
// coverage, and both are named in the output so nobody reads them as tested.
const ARTIFACT_ONLY = new Set(["CACHE_FIX_REQUEST_CAPTURE", "CACHE_FIX_SESSION_MIRROR"]);

export function parseUnitEnvironment(showOutput) {
  // `systemctl show -p Environment` yields one line: Environment=A=1 B=2
  const line = (showOutput || "").trim();
  const body = line.startsWith("Environment=") ? line.slice("Environment=".length) : line;
  const out = [];
  for (const tok of body.split(/\s+/)) {
    if (!tok.includes("=")) continue;
    const k = tok.slice(0, tok.indexOf("="));
    if (!k.startsWith("CACHE_FIX_")) continue;
    if (ARTIFACT_ONLY.has(k)) continue;
    out.push(tok);
  }
  return out;
}

function productionEnv() {
  const res = spawnSync(
    "systemctl",
    ["--user", "show", "cache-fix-proxy", "-p", "Environment", "--value"],
    { encoding: "utf-8" },
  );
  if (res.status !== 0 || !res.stdout) return { env: [], source: "unavailable" };
  const env = parseUnitEnvironment(res.stdout);
  return { env, source: env.length ? "cache-fix-proxy.service" : "empty" };
}

// The heap cap on replay children is a CHECK, not a tuning knob. A replay
// that truly streams needs memory only for its compact per-request retention
// (~15% of capture bytes; 0.61 GB measured on the 1.5 GB capture) — nowhere
// near this cap even at the 8 GB rotation ceiling (~1.2 GB projected). A
// replay that silently regressed into retaining its input needs a multiple
// of the file size and dies against the cap, turning the regression into an
// error row that fails the sweep the same day instead of an OOM years later.
// Proven red on the real defect: the pre-8b7ed9e replay OOMs under this cap
// in 5 s on the 1.5 GB capture; the fixed one finishes with 3× headroom.
export const CHILD_HEAP_CAP_MB = 2048;

export function replayArgs(file, env) {
  // --census rides on every sweep: the row-4 annotations (edit positions,
  // anchorDelta, tools deltas, mitigation pricing) were built as census-only
  // and a sweep without them re-derives nothing daily — the classifications
  // exist precisely so the next instance is recognized, not re-derived.
  const args = [`--max-old-space-size=${CHILD_HEAP_CAP_MB}`, REPLAY, file, "--json", "--census"];
  for (const kv of env) args.push("--env", kv);
  return args;
}

// The byte-gate rides the same sweep, as a second child per capture.
//
// Two answers only this delivers daily. The migration byte-test is the gate
// "every NORMALIZATION design must pass before it ships" (dev-loop.md) and was
// run by hand, at design time, over whatever corpus existed that day — while
// its own COVERAGE was the thing that failed silently (it skipped the four
// largest captures for weeks). And prune classification: an INTERIOR-DIVERGENT
// prune re-bills settled history, ranges from 2 messages to a whole context,
// and had no daily reader at all — it took a throwaway drop-scan probe to see
// one. Both are cheap next to the replay (20 s over the whole corpus against
// the replay's minutes), and neither has a home outside this sweep.
export function censusArgs(file) {
  return [`--max-old-space-size=${CHILD_HEAP_CAP_MB}`, CENSUS, file, "--json"];
}

// The census exits 1 when it could not read something, so the exit CODE is not
// the signal here — the JSON is. A run that produced no JSON could not answer
// at all, which is recorded as an error rather than as zero findings (the
// three-answer rule this tool exists to keep).
export function summariseCensus(res) {
  if (res.code === -1) return { error: res.err };
  let parsed = null;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    return { error: res.err.trim().split("\n").slice(-4).join("\n") || "no JSON output" };
  }
  return {
    pairs: parsed.pairs ?? 0,
    unreadable: (parsed.unreadable ?? []).length,
    tally: parsed.tally ?? null,
    extendedSub: parsed.extendedSub ?? null,
    prunes: parsed.prunes ?? null,
  };
}

// A capture being written to right now is not a defect and not a skip: the
// gate reads a prefix of it, which is a valid corpus. Recorded so a reader can
// tell a short run from a truncated one.
function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out: "", err: String(e?.message ?? e) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const runReplay = (file, env) => runChild(replayArgs(file, env));
const runCensus = (file) => runChild(censusArgs(file));

function summarise(file, bytes, res) {
  const row = { file, bytes, exit: res.code };
  if (res.code === -1) {
    row.error = res.err;
    return row;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    // The gate died before producing a verdict — a RangeError, an OOM, a
    // throw. This is the case the whole job exists for, so it is recorded
    // verbatim rather than smoothed into a count of zero.
    row.error = (res.err.trim().split("\n").slice(-4).join("\n") || "no JSON output");
    return row;
  }
  row.requests = parsed.report?.length ?? 0;
  row.stability = parsed.violations?.length ?? 0;
  row.safety = parsed.safety?.length ?? 0;
  // Content conservation (the fifth gate): bytes CC sent that the pipeline
  // neither forwarded nor accounted for. Ranked with safety rather than with
  // stability — a suppression whose copy is not on the wire is a truncated
  // conversation, not an expensive one. `conservationResidue` rides along as
  // the population the gate deliberately does NOT examine (assistant-role
  // blocks), so a reader of the status file sees the boundary instead of
  // inferring that a clean row covered everything.
  row.conservation = parsed.conservation?.length ?? 0;
  row.conservationResidue = parsed.conservationResidue ?? 0;
  row.sequence = parsed.sequence?.length ?? 0;
  row.order = parsed.orderViolations?.length ?? 0;
  row.unparseable = (parsed.report ?? []).filter((r) => r.error).length;
  // Replay fidelity: whether this run reproduced the bytes the proxy really
  // forwarded. A mismatch means the invariants above were measured on a
  // system that never ran, so it is recorded per capture rather than left in
  // stdout nobody reads. `comparable: 0` is an honest "proves nothing", NOT a
  // pass — the distinction the row must preserve.
  // A row that compared NOTHING proves nothing: zero same-conversation
  // pairs (empty bodies, single-request captures) ran zero cross-request
  // checks. Named rather than silently counted into the clean total —
  // "9 captures sauber" with three unproving rows was a padded verdict.
  row.pairs = parsed.census?.pairs ?? null;
  row.provesNothing = row.pairs === 0;
  const f = parsed.fidelity;
  if (f) {
    row.fidelityComparable = f.comparable ?? 0;
    row.fidelityMatched = f.matched ?? 0;
    row.fidelityMismatch = (f.mismatches ?? []).length;
    // Informational pair: on busy sessions every request is mutated, so the
    // comparable population stays 0 forever and this is the only fidelity
    // signal recorded. Never part of rowIsClean — a mutated mismatch is
    // legitimate state divergence.
    row.fidelityMutatedComparable = f.mutatedComparable ?? 0;
    row.fidelityMutatedMatched = f.mutatedMatched ?? 0;
  }
  // Threat-matrix row 6's consumer path (BACKLOG "Row 6's isolating query
  // is built and unread (Q3)"): findToolsDeltas already classifies every
  // tools[]-changing pair, --census rides every sweep (replayArgs above),
  // but nothing before this read it — a daily answer sat unread in stdout.
  // Compact counts only (no bodies): row 6 asks specifically for the
  // TOOLS-ONLY case (tools moved, message history did not — the isolating
  // pair) and whether what we FORWARDED held stable across it.
  // Consumers: threat-matrix row 6 and the operator reading gate status.
  if (Array.isArray(parsed.toolsDeltas)) {
    const deltas = parsed.toolsDeltas;
    const forwardedStable = deltas.filter((d) => d.forwardedStable).length;
    // heldStable narrows forwardedStable's whole-array claim to the
    // SHARED-name subset of the pair — the guarantee deferred-tool-rewrite
    // actually makes (BACKLOG "forwardedStable was a census framing gap": a
    // genuine new-tool announcement always moves the whole-array signature,
    // so forwardedStable=false on those pairs is expected, not a leak).
    const heldStable = deltas.filter((d) => d.heldStable).length;
    row.toolsDeltas = {
      count: deltas.length,
      toolsOnly: deltas.filter((d) => d.toolsOnly).length,
      forwardedStable,
      leaked: deltas.length - forwardedStable,
      heldStable,
      heldUnstable: deltas.length - heldStable,
    };
  }
  return row;
}

const rowIsClean = (r) =>
  !r.error &&
  r.exit === 0 &&
  !r.stability &&
  !r.safety &&
  !r.conservation &&
  !r.sequence &&
  !r.order &&
  // A fidelity mismatch invalidates every other number in the row.
  !r.fidelityMismatch &&
  // A capture the byte-gate could not READ is a could-not-verify, and this
  // sweep is where that has to bite: the whole defect was a normalization gate
  // reporting clean over a corpus it never read. Findings the byte-gate DOES
  // make (MISMATCH, interior prunes) are carried, not failed — they are
  // findings about Claude Code's traffic, not about this pipeline, and a check
  // that fires on a non-defect trains its reader to ignore red.
  !r.byteGate?.error &&
  !r.byteGate?.unreadable;

/** One line per capture: what the byte-gate measured, or why it could not. */
export function describeByteGate(g) {
  if (!g) return "not run";
  if (g.error) return `COULD NOT RUN — ${g.error.split("\n")[0]}`;
  if (g.unreadable) return `COULD NOT READ ${g.unreadable} capture(s) — verdict does not cover them`;
  const t = g.tally ?? {};
  const p = g.prunes ?? {};
  const merged = g.extendedSub?.["MERGED-STANDALONE"] ?? 0;
  return (
    `${t.EXACT ?? 0} EXACT / ${t.EXTENDED ?? 0} EXTENDED (${merged} merged) / ` +
    `${t.DROPPED ?? 0} DROPPED / ${t.MISMATCH ?? 0} MISMATCH; ` +
    `prunes ${p.pure ?? 0} pure / ${p.interior ?? 0} interior` +
    (p.unanchored ? ` / ${p.unanchored} unanchored` : "")
  );
}

function parseArgs(argv) {
  const args = { captures: DEFAULT_CAPTURES, status: DEFAULT_STATUS, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--captures") args.captures = argv[++i];
    else if (a === "--status") args.status = argv[++i];
    else if (a === "--quiet") args.quiet = true;
    else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const started = new Date().toISOString();

  // Resolve the SERVING configuration before anything else, and say so: a
  // sweep whose gate set is unknown is not a verdict about production.
  const { env: prodEnv, source: envSource } = productionEnv();
  if (!args.quiet) {
    process.stdout.write(`gates from ${envSource}: ${prodEnv.length ? prodEnv.join(" ") : "(none — replaying DEFAULTS, not production)"}\n`);
    process.stdout.write(`  excluded as artifact-only: ${[...ARTIFACT_ONLY].join(", ")}\n\n`);
  }

  let files = [];
  try {
    files = (await readdir(args.captures)).filter((f) => f.endsWith("-requests.jsonl"));
  } catch (e) {
    process.stderr.write(`no capture directory at ${args.captures}: ${e?.message ?? e}\n`);
    process.exit(2);
  }

  const rows = [];
  for (const f of files.sort()) {
    const full = join(args.captures, f);
    let bytes = 0;
    try {
      bytes = (await stat(full)).size;
    } catch {
      continue;
    }
    // An empty capture has no pairs to compare; running the gate on it proves
    // nothing and its "0 violations" would pad the verdict.
    if (bytes === 0) continue;
    const res = await runReplay(full, prodEnv);
    const row = summarise(f, bytes, res);
    row.byteGate = summariseCensus(await runCensus(full));
    rows.push(row);
    if (!args.quiet) {
      const verdict = row.error
        ? `ERROR ${row.error.split("\n")[0]}`
        : rowIsClean(row)
          ? "clean"
          : `stability=${row.stability} safety=${row.safety} conservation=${row.conservation} sequence=${row.sequence} order=${row.order}` +
            (row.fidelityMismatch ? ` FIDELITY-MISMATCH=${row.fidelityMismatch}` : "") +
            (row.byteGate?.unreadable ? " BYTE-GATE-UNREADABLE" : "") +
            (row.byteGate?.error ? " BYTE-GATE-ERROR" : "");
      process.stdout.write(`${f} (${(bytes / 1e6).toFixed(1)} MB, ${row.requests ?? "?"} req): ${verdict}\n`);
      process.stdout.write(`  byte-gate: ${describeByteGate(row.byteGate)}\n`);
    }
  }

  const failed = rows.filter((r) => !rowIsClean(r));
  const proving = rows.filter((r) => !r.error && !r.provesNothing);
  // Sweep-level byte-gate totals: the daily answer to "did a normalization
  // rule hold corpus-wide, and did any prune re-bill settled history". Read by
  // the operator and by doctor; per-capture rows keep the detail.
  const byteGate = rows.reduce((acc, r) => {
    const g = r.byteGate;
    if (!g) return acc;
    if (g.error) { acc.errors++; return acc; }
    acc.unreadable += g.unreadable ?? 0;
    for (const k of ["EXACT", "EXTENDED", "DROPPED", "MISMATCH"]) acc.tally[k] += g.tally?.[k] ?? 0;
    acc.merged += g.extendedSub?.["MERGED-STANDALONE"] ?? 0;
    acc.newText += g.extendedSub?.["NEW-TEXT"] ?? 0;
    for (const k of ["pure", "interior", "unanchored"]) acc.prunes[k] += g.prunes?.[k] ?? 0;
    return acc;
  }, { errors: 0, unreadable: 0, merged: 0, newText: 0,
       tally: { EXACT: 0, EXTENDED: 0, DROPPED: 0, MISMATCH: 0 },
       prunes: { pure: 0, interior: 0, unanchored: 0 } });
  // Fingerprints of the code this sweep actually exercised. The verdict
  // used to record which CONFIG it replayed but never which CODE — so a
  // morning verdict stayed "fresh" (age bound) across an afternoon of
  // replay/extension changes, and the compensating step was human memory.
  let code = null;
  try {
    code = {
      proxyTree: await sourceFingerprint(PROXY_ROOT),
      toolsTree: await sourceFingerprint(dirname(fileURLToPath(import.meta.url))),
    };
  } catch {
    code = null; // never block the verdict on the stamp; absent reads as unstamped
  }
  const status = {
    version: 1,
    started,
    finished: new Date().toISOString(),
    code,
    // os.hostname(), not $HOSTNAME: systemd user units export no HOSTNAME,
    // so the env var wrote "unknown" into every scheduled run's status file.
    host: hostname(),
    gates: prodEnv,
    gateSource: envSource,
    captures: rows.length,
    bytes: rows.reduce((a, r) => a + r.bytes, 0),
    failing: failed.length,
    proving: proving.length,
    unproving: rows.length - failed.length >= 0 ? rows.filter((r) => r.provesNothing).length : 0,
    // ok requires at least one PROVING row: a sweep of empty and
    // single-request captures ran zero cross-request checks.
    ok: failed.length === 0 && proving.length > 0,
    byteGate,
    rows,
  };
  await mkdir(dirname(args.status), { recursive: true });
  await writeFile(args.status, JSON.stringify(status, null, 2) + "\n");

  if (!args.quiet) {
    process.stdout.write(
      `\n${rows.length} capture(s), ${(status.bytes / 1e6).toFixed(0)} MB, ${failed.length} failing -> ${args.status}\n` +
      `byte-gate corpus-wide: ${byteGate.tally.EXACT} EXACT / ${byteGate.tally.EXTENDED} EXTENDED ` +
      `(${byteGate.merged} merged-standalone, ${byteGate.newText} new-text) / ` +
      `${byteGate.tally.DROPPED} DROPPED / ${byteGate.tally.MISMATCH} MISMATCH; ` +
      `prunes ${byteGate.prunes.pure} pure / ${byteGate.prunes.interior} INTERIOR-DIVERGENT` +
      (byteGate.prunes.unanchored ? ` / ${byteGate.prunes.unanchored} unanchored` : "") +
      (byteGate.unreadable || byteGate.errors
        ? `\n  COULD NOT VERIFY: ${byteGate.unreadable} unreadable capture(s), ${byteGate.errors} failed run(s)\n`
        : "\n"),
    );
  }
  // Non-zero on a failing sweep AND on an empty one: "no captures" means the
  // gate proved nothing, which must not read as a pass.
  process.exit(status.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`gate-live failed: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}

export { summarise, rowIsClean };
