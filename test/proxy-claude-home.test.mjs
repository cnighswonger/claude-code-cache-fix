// Tests for CLAUDE_CONFIG_DIR honoring across the proxy's on-disk path builders
// (PR #246). claudeHome() is the single source of truth every path builder
// derives from (credential path, oauth-events path, quota-status, usage log,
// session mirrors, snapshots). It must:
//   - read the env live (positive: honor a set CLAUDE_CONFIG_DIR),
//   - fall back to ~/.claude when unset AND when empty-string (negative, not CWD),
//   - be consulted at write time by every builder — including usage-log, which
//     previously froze its path in a module-level const at import.
//
// The credential path (oauth/refresher credPath()) is module-private; it is
// join(claudeHome(), ".credentials.json"), so its root resolution is pinned by
// the direct claudeHome() cases below. The oauth-events path is proven
// behaviorally here via emitOAuthEvent().

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";

import { claudeHome } from "../proxy/claude-home.mjs";
import { logPath } from "../proxy/extensions/usage-log.mjs";
import { getLogPath } from "../proxy/extensions/rate-limit-log.mjs";
import { emitOAuthEvent } from "../proxy/oauth/events.mjs";

// Env keys that shadow claudeHome()-derived defaults. Clear them so each case
// exercises the CLAUDE_CONFIG_DIR path, then restore the prior environment.
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CACHE_FIX_USAGE_LOG", "CACHE_FIX_OAUTH_EVENTS_LOG"];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "cfgdir-"));
}

const DEFAULT_HOME = join(homedir(), ".claude");

test("claudeHome(): unset CLAUDE_CONFIG_DIR falls back to ~/.claude", () => {
  withEnv({}, () => {
    assert.equal(claudeHome(), DEFAULT_HOME);
  });
});

test("claudeHome(): a set CLAUDE_CONFIG_DIR is honored", () => {
  const dir = tmpDir();
  try {
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      assert.equal(claudeHome(), dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeHome(): empty CLAUDE_CONFIG_DIR falls back to ~/.claude (not CWD)", () => {
  withEnv({ CLAUDE_CONFIG_DIR: "" }, () => {
    assert.equal(claudeHome(), DEFAULT_HOME);
  });
});

test("path builders resolve under CLAUDE_CONFIG_DIR at call time", () => {
  const dir = tmpDir();
  try {
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      // usage-log: the builder that previously froze its path at import.
      assert.equal(logPath(), join(dir, "usage.jsonl"));
      // rate-limit-log (quota-status family): its exported path accessor.
      assert.equal(getLogPath(), join(dir, "usage-log", "rate-limit-events.jsonl"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oauth-events log writes under CLAUDE_CONFIG_DIR (security-sensitive path, behavioral)", () => {
  const dir = tmpDir();
  try {
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      emitOAuthEvent("test_event", { note: "claude-home-test" });
      const p = join(dir, "cache-fix-oauth-events.jsonl");
      assert.ok(existsSync(p), "oauth-events file should be created under CLAUDE_CONFIG_DIR");
      assert.match(readFileSync(p, "utf8").trim(), /"event":"test_event"/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage-log honors CLAUDE_CONFIG_DIR flipped at runtime (live read, not import-frozen)", () => {
  const a = tmpDir();
  const b = tmpDir();
  try {
    let first, second;
    withEnv({ CLAUDE_CONFIG_DIR: a }, () => { first = logPath(); });
    withEnv({ CLAUDE_CONFIG_DIR: b }, () => { second = logPath(); });
    assert.equal(first, join(a, "usage.jsonl"));
    assert.equal(second, join(b, "usage.jsonl"));
    assert.notEqual(first, second); // proves the path is not frozen at import
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
