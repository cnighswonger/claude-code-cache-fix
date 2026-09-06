// replay warns on gateless runs of gated captures — BACKLOG.md "READY —
// replay warns on gateless runs of gated captures".
//
// Grounding: the same operator-side instrument error happened three times in
// one day (2026-07-29) — a default-gates census booked a wrong matrix
// verdict, and two verification reruns repeated it, each time with the
// dev-loop warning already loaded. Prose was exhausted; this mechanizes the
// tell: replay.mjs already parses a capture's boot record (buildBootRecord,
// proxy/extensions/request-capture.mjs) into `boots`, and the boot record
// already carries the CACHE_FIX_* gates the traffic was served under.
//
// This spawns the REAL CLI (node tools/replay.mjs ...), not the exported
// pure functions in isolation, because the thing under test is what a reader
// actually sees on stderr/stdout — the same reasoning replay-class-matrix
// gives for running the real pipeline instead of just its classifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readBootRecords, resolveGatesFromCapture } from "../tools/replay.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPLAY = join(__dirname, "..", "tools", "replay.mjs");

// Real gate names (image-strip.mjs, microcompact-stability.mjs,
// overage-warning.mjs) rather than invented ones — the boot record's own
// `gates` dict is just "every CACHE_FIX_* var present at boot", so any real
// name exercises the same code path, and using real ones means turning them
// on in the "gates passed" case cannot hit an unknown-flag code path.
const GATE_KEYS = ["CACHE_FIX_IMAGE_GUARD", "CACHE_FIX_NORMALIZE_MICROCOMPACT", "CACHE_FIX_OVERAGE_WARNING"];

function bootLine(gates) {
  return JSON.stringify({ ts: "2026-07-29T00:00:00Z", type: "boot", pid: 1, proxyTree: "test", gates });
}

function reqLine(ts, messages) {
  return JSON.stringify({
    ts,
    id: `id-${ts}`,
    sid: "test-sid",
    key: "s-test-sid",
    headers: { "anthropic-beta": null, "session-id": "test-sid" },
    body: { model: "claude-opus-5", system: [{ type: "text", text: "sys" }], messages },
  });
}

const u = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const a = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });

async function writeFixture(dir, gates) {
  const path = join(dir, "capture.jsonl");
  const lines = [
    bootLine(gates),
    // Two requests of ONE growing conversation (shared first message) so the
    // census has an actual pair to classify, not just single-message groups.
    reqLine("2026-07-29T00:00:01Z", [u("hello")]),
    reqLine("2026-07-29T00:00:02Z", [u("hello"), a("hi"), u("more")]),
  ];
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

// An explicit env (PATH only, plus whatever the case wants) so the test
// runner's own environment can never leak a CACHE_FIX_* var into the child —
// which would silently make the "empty effective env" case not actually
// empty and the bite meaningless.
function runReplay(file, envOverrides, extraArgs = []) {
  return spawnSync(process.execPath, [REPLAY, file, "--census", "--json", ...extraArgs], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH, ...envOverrides },
  });
}

// A restart mid-capture: first boot GATELESS (nothing declared), second
// boot declares GATE_KEYS — the shape --gates-from-capture exists for
// (BACKLOG.md: "extract gates via the ALL-boots union, never head -1").
// One request sits under each boot so the boot record's own `afterRequest`
// bookkeeping (main()'s read loop) has something to attach to.
async function writeMultiBootFixture(dir, gates) {
  const path = join(dir, "capture.jsonl");
  const lines = [
    bootLine({}),
    reqLine("2026-07-29T00:00:00.500Z", [u("pre-restart")]),
    bootLine(gates),
    reqLine("2026-07-29T00:00:01Z", [u("hello")]),
    reqLine("2026-07-29T00:00:02Z", [u("hello"), a("hi"), u("more")]),
  ];
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("gated capture replayed under empty env: warns on stderr, census stamped 'none'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-gate-warn-"));
  try {
    const gates = Object.fromEntries(GATE_KEYS.map((k) => [k, "1"]));
    const file = await writeFixture(dir, gates);
    const res = runReplay(file, {});
    assert.equal(res.status, 0, `replay exited nonzero: ${res.stderr}`);
    assert.ok(
      res.stderr.includes(
        "WARNING: replaying under DEFAULT gates — this traffic was served with 3 gate(s). Pass --gates-from-capture, --env, or use gate-live.",
      ),
      `expected warning on stderr, got: ${res.stderr}`,
    );
    const out = JSON.parse(res.stdout);
    assert.equal(out.census.gateSource, "none (capture declares 3)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gated capture replayed WITH the declared gates: no warning, census stamped set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-gate-warn-"));
  try {
    const gates = Object.fromEntries(GATE_KEYS.map((k) => [k, "1"]));
    const file = await writeFixture(dir, gates);
    const res = runReplay(file, gates);
    assert.equal(res.status, 0, `replay exited nonzero: ${res.stderr}`);
    assert.ok(
      !res.stderr.includes("WARNING: replaying under DEFAULT gates"),
      `expected no warning on stderr, got: ${res.stderr}`,
    );
    const out = JSON.parse(res.stdout);
    assert.equal(out.census.gateSource, "3 of 3 declared set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture with no declared gates: no warning, header names it explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-gate-warn-"));
  try {
    const file = await writeFixture(dir, {});
    const res = runReplay(file, {});
    assert.equal(res.status, 0, `replay exited nonzero: ${res.stderr}`);
    assert.ok(
      !res.stderr.includes("WARNING: replaying under DEFAULT gates"),
      `expected no warning on stderr, got: ${res.stderr}`,
    );
    const out = JSON.parse(res.stdout);
    assert.equal(out.census.gateSource, "no gates declared in capture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --gates-from-capture — BACKLOG.md's mechanized remedy: the multi-boot
// case (first boot gateless, second declares gates) is exactly the shape
// the ALL-boots union exists for, and is the one an operator's --env
// hand-extraction would get wrong by reading only the FIRST boot record.
test("--gates-from-capture on a multi-boot fixture: no warning, header 'N of N declared set'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-gate-warn-"));
  try {
    const gates = Object.fromEntries(GATE_KEYS.map((k) => [k, "1"]));
    const file = await writeMultiBootFixture(dir, gates);
    // No --env at all: the flag alone must resolve the union and set it,
    // with nothing left for the operator to hand-extract.
    const res = runReplay(file, {}, ["--gates-from-capture"]);
    assert.equal(res.status, 0, `replay exited nonzero: ${res.stderr}`);
    assert.ok(
      !res.stderr.includes("WARNING: replaying under DEFAULT gates"),
      `expected no warning on stderr, got: ${res.stderr}`,
    );
    const out = JSON.parse(res.stdout);
    assert.equal(out.census.gateSource, "3 of 3 declared set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The flag's own merge, asserted directly per BACKLOG's design ("--env
// still wins over the flag where both name a gate") — the CLI-spawning
// bites above cannot observe a per-key VALUE override (gateSourceSummary
// only checks presence, not value), so this calls the SAME merge function
// main() calls (resolveGatesFromCapture), never a re-derived one
// (dev-loop.md, "never hand-roll identity in a probe").
test("--gates-from-capture: resolveGatesFromCapture lets an explicit --env value win per-key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-gate-warn-"));
  try {
    const gates = Object.fromEntries(GATE_KEYS.map((k) => [k, "1"]));
    const file = await writeMultiBootFixture(dir, gates);
    const boots = await readBootRecords(file);
    assert.equal(boots.length, 2, "fixture must carry both boot records for the union to be meaningful");

    const merged = resolveGatesFromCapture(boots, { [GATE_KEYS[0]]: "override-value" });
    // The overridden key: --env wins.
    assert.equal(merged[GATE_KEYS[0]], "override-value");
    // The other two declared gates: capture's own value survives untouched.
    assert.equal(merged[GATE_KEYS[1]], "1");
    assert.equal(merged[GATE_KEYS[2]], "1");
    assert.equal(Object.keys(merged).length, 3, "no extra keys beyond the union + override");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
