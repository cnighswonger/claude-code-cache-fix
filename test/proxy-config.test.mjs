// Tests for config.mjs path resolution that honors CLAUDE_CONFIG_DIR.
//
// The forward-proxy CA dir is on-disk proxy state, so it defaults under the
// Claude config root and follows CLAUDE_CONFIG_DIR when the config dir is
// relocated (same resolution the claudeHome() helper uses), with
// CACHE_FIX_CA_DIR as an explicit override.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import config from "../proxy/config.mjs";

const KEYS = ["CACHE_FIX_CA_DIR", "CLAUDE_CONFIG_DIR"];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  try {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("config.caDir: honors CLAUDE_CONFIG_DIR so the CA follows the config root", () => {
  withEnv({ CLAUDE_CONFIG_DIR: "/tmp/relocated-cfg" }, () => {
    assert.equal(config.caDir, join("/tmp/relocated-cfg", "cache-fix-ca"));
  });
});

test("config.caDir: falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
  withEnv({}, () => {
    assert.equal(config.caDir, join(homedir(), ".claude", "cache-fix-ca"));
  });
});

test("config.caDir: CACHE_FIX_CA_DIR override wins over CLAUDE_CONFIG_DIR", () => {
  withEnv({ CACHE_FIX_CA_DIR: "/pinned/ca", CLAUDE_CONFIG_DIR: "/tmp/relocated-cfg" }, () => {
    assert.equal(config.caDir, "/pinned/ca");
  });
});
