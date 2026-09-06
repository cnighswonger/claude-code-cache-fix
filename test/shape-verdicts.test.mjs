// shape-verdicts — the fork's own judgment over its shape/baseline telemetry.
//
// These cases are ported from the dotfiles doctor's selftests, where this
// judgment briefly lived: the port is the proof that moving the logic across
// repos changed nothing about what fires and what stays quiet. The deployment
// side now only invokes the CLI and books the verdicts.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shapeWatchVerdict, baselineStepVerdict, computeVerdicts } from "../tools/shape-verdicts.mjs";

const shape = (over = {}) => ({ pairs: 300, thinkingDropPairs: 2, thinkingTextCompleted: 0, ...over });
const ledger = (s) => ({ keys: { "s-a": { shape: s } } });

// Every test below runs against a scratch CLAUDE_CONFIG_DIR: the telemetry
// verdicts read real paths under claudeHome() (cache-fix-snapshots/,
// upstream-changes.jsonl, session-mirrors/), and without this the earlier,
// ledger-only tests would silently read whatever happens to be in the real
// ~/.claude on the machine running the suite.
let configDir;
let savedConfigDir;
const TELEMETRY_GATE_VARS = [
  "CACHE_FIX_OUTPUT_GUARD",
  "CACHE_FIX_UPSTREAM_DETECTION",
  "CACHE_FIX_UPSTREAM_DIR",
  "CACHE_FIX_INSERTION_NORMALIZE",
  "CACHE_FIX_TOOL_REWRITE",
  "CACHE_FIX_SESSION_MIRROR",
  "CACHE_FIX_SESSION_MIRROR_EVENT_LOG",
];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "shape-verdicts-config-"));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const v of TELEMETRY_GATE_VARS) delete process.env[v];
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  for (const v of TELEMETRY_GATE_VARS) delete process.env[v];
  await rm(configDir, { recursive: true, force: true });
});

test("shape-watch: could-not-verify is warn with the inability named, never green", () => {
  assert.equal(shapeWatchVerdict(null).level, "warn");
  assert.match(shapeWatchVerdict(null).message, /NOT currently watched/);
  assert.equal(shapeWatchVerdict({ keys: {} }).level, "warn");
  assert.match(shapeWatchVerdict({ keys: { "s-a": { requests: 5 } } }).message, /run harvest/);
});

test("shape-watch: dormant classes read ok with the counts on display", () => {
  const v = shapeWatchVerdict(ledger(shape()));
  assert.equal(v.level, "ok");
  assert.match(v.message, /2\/300/);
});

test("BITE — reappeared completed-turn thinking warns with count and CC#69568", () => {
  const v = shapeWatchVerdict(ledger(shape({ pairs: 10, thinkingTextCompleted: 7 })));
  assert.equal(v.level, "warn");
  assert.match(v.message, /69568/);
  assert.match(v.message, /7 blocks/);
});

test("BITE — drop rate over 5% warns on a real sample; the same rate on a tiny sample is noise", () => {
  assert.equal(shapeWatchVerdict(ledger(shape({ pairs: 100, thinkingDropPairs: 9 }))).level, "warn");
  assert.equal(shapeWatchVerdict(ledger(shape({ pairs: 10, thinkingDropPairs: 1 }))).level, "ok");
});

test("baseline: three answers — missing working ledger warns, missing committed state is a named ok", () => {
  assert.equal(baselineStepVerdict(null, null).level, "warn");
  const base = ledger(shape({ systemBytes: 20000, toolsBytes: 40000 }));
  assert.equal(baselineStepVerdict(null, base).level, "ok");
  assert.match(baselineStepVerdict(null, base).message, /no committed comparison/);
  assert.equal(baselineStepVerdict(base, base).level, "ok");
});

test("BITE — the +94% class fires with numbers; shrinkage and floor stay quiet", () => {
  const base = ledger(shape({ systemBytes: 20000, toolsBytes: 40000 }));
  const grown = ledger(shape({ systemBytes: 38800, toolsBytes: 40000 }));
  const v = baselineStepVerdict(base, grown);
  assert.equal(v.level, "warn");
  assert.match(v.message, /20000->38800/);
  assert.match(v.message, /committing the ledger acknowledges/);
  assert.equal(baselineStepVerdict(base, ledger(shape({ systemBytes: 9000, toolsBytes: 40000 }))).level, "ok");
  assert.equal(
    baselineStepVerdict(ledger(shape({ systemBytes: 100 })), ledger(shape({ systemBytes: 400 }))).level,
    "ok",
  );
});

test("computeVerdicts: a missing ledger file yields both verdicts as honest warns, exit path intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shape-verdicts-"));
  try {
    const verdicts = await computeVerdicts(join(dir, "no-such-ledger.json"));
    // 3 ledger-shape verdicts + the telemetry-consumer table (Q4). The
    // table length is asserted against the TABLE, not a literal — a row
    // legitimately added must not redden this test (the hardcoded-count
    // anti-pattern bit exactly once, 2026-07-30).
    const { TELEMETRY_CONSUMERS } = await import("../tools/shape-verdicts.mjs");
    assert.equal(verdicts.length, 3 + TELEMETRY_CONSUMERS.length);
    assert.ok(verdicts.every((v) => v.level === "warn" || v.name === "baseline"));
    assert.equal(verdicts[0].level, "warn", "shape-watch cannot read as green without a ledger");
    const telemetryNames = verdicts.slice(3).map((v) => v.name);
    assert.deepEqual(telemetryNames, TELEMETRY_CONSUMERS.map((e) => e.name));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BITE — a stalled harvest timer cannot print dormant forever: frozen numbers warn", async () => {
  const { HARVEST_MAX_AGE_H } = await import("../tools/shape-verdicts.mjs");
  const old = { keys: { "s-a": { lastHarvest: "2026-07-01T00:00:00Z", shape: shape() } } };
  const now = Date.parse("2026-07-29T00:00:00Z");
  const v = shapeWatchVerdict(old, now);
  assert.equal(v.level, "warn");
  assert.match(v.message, /frozen/);
  const fresh = { keys: { "s-a": { lastHarvest: new Date(now - 3600_000).toISOString(), shape: shape() } } };
  assert.equal(shapeWatchVerdict(fresh, now).level, "ok", `within ${HARVEST_MAX_AGE_H}h stays ok`);
});

test("retention: a NEW expired capture warns until the ledger commit acknowledges it", async () => {
  const { retentionVerdict } = await import("../tools/shape-verdicts.mjs");
  assert.equal(retentionVerdict(null, null).level, "warn");
  const committed = { keys: { "s-old": { gone: true }, "s-b": {} } };
  const sameGone = { keys: { "s-old": { gone: true }, "s-b": {} } };
  assert.equal(retentionVerdict(committed, sameGone).level, "ok", "already-acknowledged gone stays quiet");
  const newGone = { keys: { "s-old": { gone: true }, "s-b": { gone: true } } };
  const v = retentionVerdict(committed, newGone);
  assert.equal(v.level, "warn");
  assert.match(v.message, /s-b/);
  assert.match(v.message, /CAPTURE_MAX_MB/);
});

// --- Telemetry-consumer table (Q4: alarm-without-reader gap) ---
//
// Every case below writes fixtures at the EXACT relative paths the real
// writers use (output-guard.mjs, upstream-change-detection.mjs,
// insertion-normalization.mjs, deferred-tool-rewrite.mjs,
// session-mirror-writer.mjs), under the scratch CLAUDE_CONFIG_DIR set in
// beforeEach — so a path drift in either the writer or this table's
// resolution would be caught, not just a drift in shape-verdicts alone.

const oldMs = () => Date.now() - 48 * 3600_000; // outside HARVEST_MAX_AGE_H (26h)
const recentMs = () => Date.now() - 3600_000; // 1h ago, inside the window

async function writeFixture(path, mtimeMs) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, JSON.stringify({ ts: new Date(mtimeMs).toISOString() }) + "\n");
  const t = mtimeMs / 1000;
  await utimes(path, t, t);
}

test("BITE — telemetry alarm kind: a recent guard-events entry fires; an old one stays quiet", async () => {
  const { telemetryConsumerVerdict } = await import("../tools/shape-verdicts.mjs");
  process.env.CACHE_FIX_OUTPUT_GUARD = "1";
  const entry = {
    name: "telemetry-guard-events",
    kind: "alarm",
    maxAgeH: 26,
    gate: () => process.env.CACHE_FIX_OUTPUT_GUARD === "1",
    dir: () => join(configDir, "cache-fix-snapshots"),
    suffix: "-guard-events.jsonl",
  };
  const path = join(configDir, "cache-fix-snapshots", "s-abc123-guard-events.jsonl");
  await writeFixture(path, recentMs());
  const recent = await telemetryConsumerVerdict(entry);
  assert.equal(recent.level, "warn", "a recent alarm entry IS the finding");
  assert.match(recent.message, /needs a look/);

  await writeFixture(path, oldMs());
  const old = await telemetryConsumerVerdict(entry);
  assert.equal(old.level, "ok", "an alarm entry outside the window is dormant, not live");
});

test("BITE — telemetry log kind: an old-mtime insertion-events file warns; a fresh one stays quiet", async () => {
  const { telemetryConsumerVerdict } = await import("../tools/shape-verdicts.mjs");
  process.env.CACHE_FIX_INSERTION_NORMALIZE = "1";
  const entry = {
    name: "telemetry-insertion-events",
    kind: "log",
    maxAgeH: 26,
    gate: () => process.env.CACHE_FIX_INSERTION_NORMALIZE === "1",
    dir: () => join(configDir, "cache-fix-snapshots"),
    suffix: "-insertion-events.jsonl",
  };
  const path = join(configDir, "cache-fix-snapshots", "s-xyz789-insertion-events.jsonl");
  await writeFixture(path, oldMs());
  const stale = await telemetryConsumerVerdict(entry);
  assert.equal(stale.level, "warn", "gate on, no writes within maxAgeH — silence is the defect");
  assert.match(stale.message, /last write/);

  await writeFixture(path, recentMs());
  const fresh = await telemetryConsumerVerdict(entry);
  assert.equal(fresh.level, "ok");
});

test("BITE — telemetry could-not-verify: absent file never reads as a bare warn without the gate named", async () => {
  const { telemetryConsumerVerdict } = await import("../tools/shape-verdicts.mjs");
  // Gate off, file absent (both entries): could-not-verify, message names the inability.
  const alarmOff = {
    name: "telemetry-upstream-changes",
    kind: "alarm",
    maxAgeH: 26,
    gate: () => false,
    file: () => join(configDir, "upstream-changes.jsonl"),
  };
  const vAlarmOff = await telemetryConsumerVerdict(alarmOff);
  assert.equal(vAlarmOff.level, "warn");
  assert.match(vAlarmOff.message, /gate is off/);

  const logOff = {
    name: "telemetry-session-mirror",
    kind: "log",
    maxAgeH: 26,
    gate: () => false,
    file: () => join(configDir, "session-mirrors", "session-mirror-events.jsonl"),
  };
  const vLogOff = await telemetryConsumerVerdict(logOff);
  assert.equal(vLogOff.level, "warn");
  assert.match(vLogOff.message, /gate is off/);

  // Gate ON, file absent: alarm reads ok (no alarm ever fired); log warns
  // (writes were expected and never happened) — never silently "ok" either.
  const alarmOn = { ...alarmOff, gate: () => true };
  assert.equal((await telemetryConsumerVerdict(alarmOn)).level, "ok");
  const logOn = { ...logOff, gate: () => true };
  const vLogOn = await telemetryConsumerVerdict(logOn);
  assert.equal(vLogOn.level, "warn");
  assert.match(vLogOn.message, /never been written/);
});

test("computeTelemetryVerdicts: names and order match the declared table, real writer paths", async () => {
  const { computeTelemetryVerdicts } = await import("../tools/shape-verdicts.mjs");
  const verdicts = await computeTelemetryVerdicts();
  assert.deepEqual(
    verdicts.map((v) => v.name),
    [
      "telemetry-guard-events",
      "telemetry-upstream-changes",
      "telemetry-insertion-events",
      "telemetry-deferred-tool-events",
      "telemetry-session-mirror",
      "telemetry-upstream-errors",
    ],
  );
  // Nothing gated on, nothing written: every entry is could-not-verify (warn).
  assert.ok(verdicts.every((v) => v.level === "warn"));
});
