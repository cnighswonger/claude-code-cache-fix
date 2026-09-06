// harvest --pin — BACKLOG.md "READY — harvest --pin freezes evidence
// ranges as fixtures".
//
// Motivating instances: test/insertion-suppression.test.mjs and
// test/mitigation-output-form.test.mjs both replay a specific real capture
// (s-4b6a435234bf, pair n=26->28) and SKIP once that capture rotates out of the
// per-machine retention window (~3 days, docs/dev-loop.md "Corpus
// hygiene"). `harvest --pin <key> <n..m>` freezes the sanitized range as a
// committed, rotation-immune fixture; both real-pair tests fall back to it
// when the live capture is gone.
//
// Two things have to hold or the mechanism is worse than useless:
//   - the pin mechanism itself: it writes a sanitized, well-formed fixture
//     (unit-level, tiny synthetic capture);
//   - the FALLBACK actually works on the real files: capture-absent +
//     fixture-absent skips (never a false pass), capture-absent +
//     fixture-present runs and PASSES using the real committed fixture
//     (never a false fail) — checked by literally invoking the two
//     real-pair test files as subprocesses with env overrides, never by
//     re-deriving their assertions here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { parsePinRange, pinRange, readPinnedFixture } from "../tools/harvest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const HARVEST_CLI = join(REPO, "tools", "harvest.mjs");

// --- parsePinRange ---

test("parsePinRange: n..m parses to {n, m}", () => {
  assert.deepEqual(parsePinRange("26..28"), { n: 26, m: 28 });
  assert.deepEqual(parsePinRange("0..0"), { n: 0, m: 0 });
});

test("parsePinRange: malformed range throws", () => {
  assert.throws(() => parsePinRange("28"), /--pin range must look like/);
  assert.throws(() => parsePinRange("a..b"), /--pin range must look like/);
  assert.throws(() => parsePinRange(undefined), /--pin range must look like/);
});

test("parsePinRange: end before start throws", () => {
  assert.throws(() => parsePinRange("3..1"), /end must be >= start/);
});

// --- pinRange: sanitized, well-formed, over a tiny synthetic capture ---

const SECRET = "the operator's actual private project detail";

async function writeTinyCapture(dir) {
  const path = join(dir, "s-tiny0000-requests.jsonl");
  const lines = [
    JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "boot", pid: 1, proxyTree: "abc123", gates: { X: "1" } }),
    JSON.stringify({
      ts: "2026-01-01T00:00:01Z",
      sid: "s-tiny0000",
      key: "s-tiny0000",
      headers: { "anthropic-beta": "x" },
      body: { model: "claude-sonnet-5", system: "sys0", messages: [{ role: "user", content: [{ type: "text", text: SECRET }] }] },
    }),
    JSON.stringify({
      ts: "2026-01-01T00:00:02Z",
      type: "outcome",
      id: "out-1",
      key: "s-tiny0000",
      requestId: "req-1",
      model: "claude-sonnet-5",
      usage: { cacheRead: 0, cacheCreation: 0, inputTokens: 10, outputTokens: 1 },
      outSha: "deadbeef",
      outBytes: 100,
      ms: 5,
    }),
    JSON.stringify({
      ts: "2026-01-01T00:00:03Z",
      sid: "s-tiny0000",
      key: "s-tiny0000",
      headers: { "anthropic-beta": "x" },
      body: {
        model: "claude-sonnet-5",
        system: "sys0",
        messages: [
          { role: "user", content: [{ type: "text", text: SECRET }] },
          { role: "assistant", content: [{ type: "text", text: "a reply" }] },
          { role: "user", content: [{ type: "text", text: "a second message" }] },
        ],
      },
    }),
  ];
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("pinRange: sanitized (no raw secret text), shape preserved, range covers boot/outcome/request through m", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harvest-pin-"));
  const path = await writeTinyCapture(dir);

  const records = await pinRange(path, 1);
  const raw = JSON.stringify(records);

  assert.ok(!raw.includes(SECRET), "no raw content leaks into the pinned fixture");
  assert.equal(records.filter((r) => r.type === "boot").length, 1, "boot record kept for gate provenance");
  assert.equal(records.filter((r) => r.type === "outcome").length, 1, "outcome record kept (the one before m)");
  const requests = records.filter((r) => r.type !== "boot" && r.type !== "outcome");
  assert.equal(requests.length, 2, "both request 0 and request 1 (the pinned range's full prefix) are present");
  assert.ok(requests[0].body.messages[0].content[0].text.startsWith("t_"), "request text is tokenized");
  assert.equal(requests[0].sid, requests[1].sid, "identity hashing is deterministic across records");
});

test("pinRange: m beyond available requests throws rather than writing a truncated fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harvest-pin-"));
  const path = await writeTinyCapture(dir);
  await assert.rejects(() => pinRange(path, 5), /has only 2 request record\(s\), cannot pin through m=5/);
});

// --- CLI end-to-end: the actual entry point, not a re-derivation of it ---

// The sanitized token that names the fixture, stated from its DEFINITION
// (docs/directives/fixture-sanitization-directive.md, settled design 2: a
// conversation key becomes "s-" + the first 12 hex of its sha256) rather than
// imported from tools/harvest.mjs — an expectation with the same parentage as
// the code pins the bug it should catch.
const KEY_TOKEN = `s-${createHash("sha256").update("s-tiny0000").digest("hex").slice(0, 12)}`;

test("harvest --pin CLI: writes pinned-<s-sha12>-<n>-<m>.json, no session key in the name, header or records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harvest-pin-cli-"));
  const capturesDir = join(dir, "captures");
  const outDir = join(dir, "out");
  await mkdir(capturesDir, { recursive: true });
  await writeTinyCapture(capturesDir);

  const stdout = execFileSync(
    process.execPath,
    [HARVEST_CLI, "--captures", capturesDir, "--out", outDir, "--pin", "s-tiny0000", "0..1"],
    { encoding: "utf-8" },
  );
  assert.match(stdout, /pinned 4 record\(s\), range 0\.\.1/);

  const outPath = join(outDir, `pinned-${KEY_TOKEN}-0-1.json`);
  assert.ok(existsSync(outPath), "fixture written at the expected name (the key's s-<sha12> token, never the session key)");

  const fixture = JSON.parse(await readFile(outPath, "utf-8"));
  assert.equal(fixture.header.key, KEY_TOKEN);
  assert.deepEqual(fixture.header.range, { n: 0, m: 1 });
  assert.equal(fixture.header.replayFrom, 0);
  assert.ok(fixture.header.sanitizer, "sanitizer note present");
  assert.ok(fixture.header.harvestedAt, "harvest date present");
  const serialized = JSON.stringify(fixture);
  assert.ok(!serialized.includes(SECRET), "no raw content leaks through the CLI path either");
  assert.ok(!serialized.includes("s-tiny0000"), "the raw conversation key leaks nowhere — header, records or metadata");
  // Rebased, not stamped: the capture's own 2026-01-01 wall-clock is gone and
  // the deltas between records survive (boot at +0s, the two requests at +1s
  // and +3s, matching writeTinyCapture's spacing).
  assert.equal(fixture.records[0].ts, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(
    fixture.records.map((r) => Date.parse(r.ts) - Date.parse(fixture.records[0].ts)),
    [0, 1000, 2000, 3000],
  );
  assert.ok(!serialized.includes("2026-01-01"), "no live wall-clock survives");
});

test("harvest --pin CLI: unknown key exits non-zero with a stated reason, writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harvest-pin-cli-"));
  const capturesDir = join(dir, "captures");
  const outDir = join(dir, "out");
  await mkdir(capturesDir, { recursive: true });
  await writeTinyCapture(capturesDir);

  assert.throws(() =>
    execFileSync(
      process.execPath,
      [HARVEST_CLI, "--captures", capturesDir, "--out", outDir, "--pin", "s-nope", "0..1"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  assert.ok(!existsSync(join(outDir, "pinned-s-nope-0-1.json")));
});

// --- readPinnedFixture: round-trips through the same [n, line] tuple shape readCapture yields ---

test("readPinnedFixture: yields [n, line] tuples whose parsed records match what was pinned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harvest-pin-"));
  const capturePath = await writeTinyCapture(dir);
  const records = await pinRange(capturePath, 1);
  const fixturePath = join(dir, "pinned-s-tiny0000-0-1.json");
  await writeFile(
    fixturePath,
    JSON.stringify({ header: { key: "s-tiny0000", range: { n: 0, m: 1 } }, records }) + "\n",
  );

  const seen = [];
  for await (const [n, line] of readPinnedFixture(fixturePath)) {
    seen.push([n, JSON.parse(line)]);
  }
  assert.equal(seen.length, records.length);
  assert.deepEqual(
    seen.map(([, r]) => r),
    // Compared through the same JSON round-trip the fixture file itself
    // applies (JSON.stringify drops `undefined`-valued keys such as a
    // tools-less body's `tools: undefined` from scrubRecord) — the fixture
    // on disk never carries those keys either, so this is the fidelity
    // contract that actually matters, not raw in-memory equality.
    JSON.parse(JSON.stringify(records)),
    "round-trips exactly — same records the pin wrote",
  );
  assert.deepEqual(
    seen.map(([n]) => n),
    records.map((_, i) => i),
    "indices are 0-based and contiguous, same shape readCapture's own [n, line] yields",
  );
});

// =====================================================================
// Fallback red-green — the actual real-pair tests, run as subprocesses
// =====================================================================
//
// Not a re-derivation of what insertion-suppression.test.mjs and
// mitigation-output-form.test.mjs assert: this literally invokes them with
// env overrides (CACHE_FIX_TEST_CAPTURE_OVERRIDE /
// CACHE_FIX_TEST_FIXTURE_OVERRIDE, both files) pointed at nonexistent paths
// or at the real committed fixture, and reads their own TAP output — the
// only way to know the fallback genuinely works end to end rather than
// merely compiling. Never touches the real capture file
// (~/.claude/cache-fix-captures/s-4b6a435234bf-...), which is read-only
// evidence.

const REAL_PAIR_TESTS = [
  { file: "mitigation-output-form.test.mjs", namePattern: "mitigation output-form: real capture n=26" },
  { file: "insertion-suppression.test.mjs", namePattern: "real capture n=26->28: pin-and-suppress" },
];
const COMMITTED_FIXTURE = join(__dirname, "fixtures", "harvested", "pinned-s-4b6a435234bf-26-28.json");

// --test-reporter=tap: a stable, greppable "# pass N" / "# skipped N" / "#
// fail N" summary — the default reporter's exact wording ("ℹ pass N", no
// leading "#") is not a documented contract to grep against.
//
// NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID must NOT reach the child: this
// file itself runs under `node --test`, which sets both; inherited by a
// NESTED `node --test` invocation, the child silently emits nothing to
// stdout (observed directly — reporter output present unset, empty string
// captured when inherited) rather than erroring, which would have looked
// like a false "fallback broken" red instead of a harness artifact.
function runRealPairTest({ file, namePattern }, env) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const result = execFileSync(
    process.execPath,
    ["--test", "--test-reporter=tap", `--test-name-pattern=${namePattern}`, join(__dirname, file)],
    { encoding: "utf-8", cwd: REPO, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  return result;
}

for (const spec of REAL_PAIR_TESTS) {
  test(`fallback RED: ${spec.file} skips (not fails) when capture and fixture are both absent`, () => {
    const out = runRealPairTest(spec, {
      CACHE_FIX_TEST_CAPTURE_OVERRIDE: "/nonexistent/no-such-capture.jsonl",
      CACHE_FIX_TEST_FIXTURE_OVERRIDE: "/nonexistent/no-such-fixture.json",
    });
    assert.match(out, /# pass 0/);
    // The child's TAP summary's own skipped-count line moves across node
    // majors (measured: CI red on node 18/20, green on 22, over an
    // unchanged fallback) — the per-test `# SKIP` directive on the test's
    // own `ok N - …` line does not, since it is node's TAP reporter
    // convention, not this repo's code. Discrimination checked directly:
    // this pattern matches the skip-case output and fails to match the
    // sibling "fallback GREEN" test's not-skipped output for the same file.
    assert.match(out, /# SKIP\b/);
    assert.match(out, /COULD NOT VERIFY/);
  });

  test(`fallback GREEN: ${spec.file} runs and passes from the committed pinned fixture when the capture is absent`, () => {
    assert.ok(existsSync(COMMITTED_FIXTURE), "the committed n=26->28 fixture must exist for this check to mean anything");
    const out = runRealPairTest(spec, {
      CACHE_FIX_TEST_CAPTURE_OVERRIDE: "/nonexistent/no-such-capture.jsonl",
    });
    assert.match(out, /# pass 1/);
    assert.match(out, /# fail 0/);
  });
}
