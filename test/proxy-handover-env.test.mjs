import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handoverEnv, handoverEnvPath } from "../bin/handover-env.mjs";

// Every mkdtemp here is removed when the process exits. A per-case `finally` is
// not enough -- a throwing assertion skips it, and this file makes a directory
// per case plus one per fixture file, so a red run leaked more than a green one.
// NOT a root `after()` hook: node:test runs files concurrently and a root hook
// registered from one file reddened three timing cases in others. Measured, with
// the control -- the same tree without it was 1974/1973/0.
const made = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "cache-fix-handover-test-")); made.push(d); return d; };
process.on("exit", () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
const withFile = (body) => { const d = dir(); const p = join(d, "handover.env"); writeFileSync(p, body); return p; };

test("handoverEnv: a config file overrides the env the holder was started with", () => {
  // The whole point. A holder started before a switch existed hands its
  // successor that absence unless something re-reads.
  const p = withFile("CACHE_FIX_PREFIXDIFF=1\n");
  const out = handoverEnv({ CACHE_FIX_PREFIXDIFF: "0", PATH: "/bin" }, p);
  assert.equal(out.CACHE_FIX_PREFIXDIFF, "1");
  assert.equal(out.PATH, "/bin", "unrelated env survives");
});

test("handoverEnv: a key absent from the base is ADDED", () => {
  const p = withFile("CACHE_FIX_CAPTURE_MAX_MB=256\n");
  assert.equal(handoverEnv({}, p).CACHE_FIX_CAPTURE_MAX_MB, "256");
});

test("handoverEnv: no file — the base is returned untouched", () => {
  const base = { CACHE_FIX_PREFIXDIFF: "0" };
  assert.deepEqual(handoverEnv(base, join(dir(), "nope.env")), base);
});

// A DIRECTORY, NOT `chmod 000`. Mode bits do not stop root, and this package
// runs in root containers -- there the chmod succeeds, the read succeeds, and
// the case fails on an assertion that has nothing to do with what it tests.
// readFileSync on a directory throws for every uid, which is the branch under
// test: any failure leaves the inherited value standing.
test("handoverEnv: an unreadable path is OFF, not an error", () => {
  assert.equal(handoverEnv({ CACHE_FIX_PREFIXDIFF: "0" }, dir()).CACHE_FIX_PREFIXDIFF, "0");
});

test("handoverEnv: only CACHE_FIX_ keys are honoured — the file cannot inject arbitrary env", () => {
  // A long-lived proxy reads this. Anything else in it is ignored on purpose.
  const p = withFile("PATH=/evil\nLD_PRELOAD=/x.so\nCACHE_FIX_PREFIXDIFF=1\n");
  const out = handoverEnv({ PATH: "/bin", CACHE_FIX_PREFIXDIFF: "0" }, p);
  assert.equal(out.PATH, "/bin");
  assert.equal(out.LD_PRELOAD, undefined);
  assert.equal(out.CACHE_FIX_PREFIXDIFF, "1");
});

// A HALF-WRITTEN FILE PARSES CLEANLY, which is what makes it worse than a
// malformed one. `writeFileSync` truncates and then writes, so a handover that
// lands mid-write reads a prefix -- and a cut line like
// `CACHE_FIX_PROXY_UPSTREAM=http://ho` is a well-formed assignment with a broken
// value. Nothing later corrects it: the successor carries it until the next
// handover. A line is honoured once its terminator has been written, so a
// truncated tail is invisible and the inherited value stands.
test("handoverEnv: a line whose newline has not been written yet is not applied", () => {
  const p = withFile("CACHE_FIX_PREFIXDIFF=1\nCACHE_FIX_PROXY_UPSTREAM=http://ho");
  const out = handoverEnv({ CACHE_FIX_PROXY_UPSTREAM: "https://api.example.invalid" }, p);
  assert.equal(out.CACHE_FIX_PROXY_UPSTREAM, "https://api.example.invalid",
    "a half-written line was applied — the successor now points at a truncated " +
    "upstream and stays there until something hands the port on again");
  assert.equal(out.CACHE_FIX_PREFIXDIFF, "1",
    "the complete lines before the cut must still land");
});

test("handoverEnv: junk lines are skipped, valid ones still applied", () => {
  const p = withFile("# a comment\n\nnot-an-assignment\nCACHE_FIX_PREFIXDIFF=1\n");
  assert.equal(handoverEnv({}, p).CACHE_FIX_PREFIXDIFF, "1");
});

test("handoverEnv: the default path is per config dir, and read live", () => {
  // Every other piece of CCF state goes through claudeHome(), for the reason
  // that module's own header gives: one proxy per CLAUDE_CONFIG_DIR, so a
  // single global file makes two of them share one override.
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/cfg-a";
    assert.equal(handoverEnvPath(), join("/tmp/cfg-a", "cache-fix-handover.env"));
    // Read live, not frozen at import — the second config dir gets its own file.
    process.env.CLAUDE_CONFIG_DIR = "/tmp/cfg-b";
    assert.equal(handoverEnvPath(), join("/tmp/cfg-b", "cache-fix-handover.env"));
    process.env.CACHE_FIX_HANDOVER_ENV = "/tmp/elsewhere.env";
    assert.equal(handoverEnvPath(), "/tmp/elsewhere.env", "the explicit override still wins");
  } finally {
    delete process.env.CACHE_FIX_HANDOVER_ENV;
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// THE LIMIT, PINNED. A key absent from the file inherits; it does NOT unset. An
// operator who turns a switch on here and then deletes the line still has it on,
// on every handover after — so the documented way off is the switch's own off
// value. Asserting it rather than leaving it to be discovered in production.
test("a key missing from the file is inherited, not cleared", () => {
  const p = withFile("CACHE_FIX_PREFIXDIFF=1\n");
  const out = handoverEnv({ CACHE_FIX_REQUEST_CAPTURE: "1" }, p);
  assert.equal(out.CACHE_FIX_REQUEST_CAPTURE, "1",
    "a key the file omits was cleared — every switch not restated in the file " +
    "would silently turn off at the next handover");
  assert.equal(out.CACHE_FIX_PREFIXDIFF, "1", "the file's own key did not land");

  const off = handoverEnv({ CACHE_FIX_REQUEST_CAPTURE: "1" },
    withFile("CACHE_FIX_REQUEST_CAPTURE=0\n"));
  assert.equal(off.CACHE_FIX_REQUEST_CAPTURE, "0",
    "the documented way to turn a switch off no longer works, and there is no " +
    "other way — this file cannot express an unset");
});
