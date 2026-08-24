import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handoverEnv, handoverEnvPath } from "../bin/handover-env.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "cache-fix-handover-test-"));
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

test("handoverEnv: unreadable file is OFF, not an error", () => {
  const p = withFile("CACHE_FIX_PREFIXDIFF=1\n");
  chmodSync(p, 0o000);
  assert.equal(handoverEnv({ CACHE_FIX_PREFIXDIFF: "0" }, p).CACHE_FIX_PREFIXDIFF, "0");
});

test("handoverEnv: only CACHE_FIX_ keys are honoured — the file cannot inject arbitrary env", () => {
  // A long-lived proxy reads this. Anything else in it is ignored on purpose.
  const p = withFile("PATH=/evil\nLD_PRELOAD=/x.so\nCACHE_FIX_PREFIXDIFF=1\n");
  const out = handoverEnv({ PATH: "/bin", CACHE_FIX_PREFIXDIFF: "0" }, p);
  assert.equal(out.PATH, "/bin");
  assert.equal(out.LD_PRELOAD, undefined);
  assert.equal(out.CACHE_FIX_PREFIXDIFF, "1");
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
