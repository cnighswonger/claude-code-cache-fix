import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testFile = join(dirname(fileURLToPath(import.meta.url)), "proxy-holder-handover.test.mjs");

describe("diagnostic evidence when a holder never comes up", () => {
  // A REAL, DETERMINISTIC repro of "the holder never came up" rather than the
  // rare freePort() race the actual flake needs. proxy-holder-handover's own
  // env-building does not delete CACHE_FIX_PROXY_BIND, so it is inherited
  // straight into the launcher it spawns; pointing it at a TEST-NET-3 address
  // (RFC 5737: reserved for documentation, never assigned to a real host) makes
  // the launcher's bindFailed() path fire immediately and settle(1) — the same
  // "holder never came up" shape the CI flake hit, on demand instead of by luck.
  it("keeps the launcher's stderr on the startup-timeout assertion, not just the constant message", () => {
    const env = { ...process.env, CACHE_FIX_PROXY_BIND: "203.0.113.1" };
    // This file itself runs under `node --test`, which sets NODE_TEST_CONTEXT
    // on its own process; inherited by the child, node's test runner reads it
    // as "already inside a --test run" and silently skips running the file
    // instead of executing it ("run() is being called recursively").
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath,
      ["--test", "--test-reporter", "tap",
       "--test-name-pattern", "no hop is configured", testFile],
      { env, encoding: "utf8", timeout: 90_000 });
    const out = r.stdout + r.stderr;
    const at = out.indexOf("the holder never came up");
    assert.ok(at >= 0, `expected the forced startup failure to fire:\n${out}`);
    const block = out.slice(at, at + 500);
    assert.match(block, /cache-fix\] cannot bind/,
      `the startup assertion's failure message dropped the launcher's stderr:\n${block}`);
  });
});
