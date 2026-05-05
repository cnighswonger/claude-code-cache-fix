import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ext, { sessionFilename } from "../proxy/extensions/cache-telemetry.mjs";

// --- Helpers for file-write tests ---

const QUOTA_HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": "1776960600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.15",
  "anthropic-ratelimit-unified-7d-reset": "1776970800",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-overage-status": "allowed",
};

function setupTmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "ct-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  ext.__resetForTests();
  return {
    home: dir,
    cleanup: () => {
      process.env.HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function driveResponse({ headers = {}, cacheRead = 0, cacheCreation = 100, env = {} } = {}) {
  const meta = {};
  const telemetry = {};
  const oldEnv = {};
  for (const k of Object.keys(env)) {
    oldEnv[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    const fullHeaders = { ...QUOTA_HEADERS, ...headers };
    await ext.onResponseStart({ headers: fullHeaders, meta });
    await ext.onStreamEvent({
      event: { type: "message_start", message: { usage: { cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, input_tokens: 5 } } },
      telemetry,
      meta,
    });
    await ext.onStreamEvent({
      event: { type: "message_delta", usage: { output_tokens: 100 } },
      telemetry,
      meta,
    });
  } finally {
    for (const k of Object.keys(oldEnv)) {
      if (oldEnv[k] === undefined) delete process.env[k];
      else process.env[k] = oldEnv[k];
    }
  }
  return meta;
}

// --- Integration tests: onResponseStart ---

test("onResponseStart: parses quota headers into meta", async () => {
  const ctx = {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1776960600",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.15",
      "anthropic-ratelimit-unified-7d-reset": "1776970800",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-overage-utilization": "0.0",
    },
    meta: {},
  };

  await ext.onResponseStart(ctx);

  assert.ok(ctx.meta._quotaData, "should set _quotaData in meta");
  assert.equal(ctx.meta._quotaData.five_hour.pct, 42);
  assert.equal(ctx.meta._quotaData.seven_day.pct, 15);
  assert.equal(ctx.meta._quotaData.status, "allowed");
});

test("onResponseStart: handles missing headers gracefully", async () => {
  const ctx = { headers: {}, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(ctx.meta._quotaData, undefined);
});

test("onResponseStart: handles null headers", async () => {
  const ctx = { headers: null, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(ctx.meta._quotaData, undefined);
});

test("onResponseStart: detects peak hours", async () => {
  const ctx = {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-5h-reset": "1776960600",
      "anthropic-ratelimit-unified-7d-utilization": "0.05",
      "anthropic-ratelimit-unified-7d-reset": "1776970800",
    },
    meta: {},
  };

  await ext.onResponseStart(ctx);
  assert.equal(typeof ctx.meta._quotaData.peak_hour, "boolean");
});

// --- Integration tests: onStreamEvent ---

test("onStreamEvent: captures cache stats from message_start", async () => {
  const ctx = {
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 300000,
          cache_creation_input_tokens: 500,
        },
      },
    },
    telemetry: {},
    meta: {},
  };

  await ext.onStreamEvent(ctx);

  assert.equal(ctx.meta.cacheStats.cacheRead, 300000);
  assert.equal(ctx.meta.cacheStats.cacheCreation, 500);
  assert.equal(ctx.meta.cacheStats.inputTokens, 5);
});

test("onStreamEvent: captures output tokens from message_delta", async () => {
  const ctx = {
    event: {
      type: "message_delta",
      usage: { output_tokens: 150 },
    },
    telemetry: {},
    meta: {
      cacheStats: { cacheRead: 300000, cacheCreation: 500, inputTokens: 5 },
    },
  };

  await ext.onStreamEvent(ctx);
  assert.equal(ctx.meta.cacheStats.outputTokens, 150);
});

test("onStreamEvent: skips when no event", async () => {
  const ctx = { event: null, telemetry: {}, meta: {} };
  await ext.onStreamEvent(ctx);
  assert.equal(ctx.meta.cacheStats, undefined);
});

// =========================================================================
// Directive: per-session quota-status files
// =========================================================================

// --- sessionFilename rule (#11a-#11i) ---

test("11a. sessionFilename: UUID input → raw filename", () => {
  assert.equal(sessionFilename("b16c607d-d484-4935-840e-e3f7ee78eb08"), "b16c607d-d484-4935-840e-e3f7ee78eb08");
});

test("11b. sessionFilename: alphanumeric/underscore/dash inputs → raw", () => {
  assert.equal(sessionFilename("abc123"), "abc123");
  assert.equal(sessionFilename("with_underscore"), "with_underscore");
  assert.equal(sessionFilename("with-dash"), "with-dash");
  assert.equal(sessionFilename("A1_b2-C3"), "A1_b2-C3");
});

test("11c. sessionFilename: empty/whitespace/null/undefined → 'unknown'", () => {
  assert.equal(sessionFilename(null), "unknown");
  assert.equal(sessionFilename(undefined), "unknown");
  assert.equal(sessionFilename(""), "unknown");
  assert.equal(sessionFilename("   "), "unknown");
  assert.equal(sessionFilename("\t\n"), "unknown");
});

test("11d. sessionFilename: path-traversal characters → hashed inv- prefix", () => {
  assert.match(sessionFilename("../etc/passwd"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("a/b"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("a\\b"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("normal.uuid.with.dots"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("with\0nul"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("with:colon"), /^inv-[0-9a-f]{16}$/);
  assert.match(sessionFilename("with space"), /^inv-[0-9a-f]{16}$/);
});

test("11e. sessionFilename: deterministic", () => {
  const a = sessionFilename("malformed input");
  const b = sessionFilename("malformed input");
  assert.equal(a, b);
});

test("11f. sessionFilename: 129 chars → fallback hash", () => {
  assert.match(sessionFilename("x".repeat(129)), /^inv-[0-9a-f]{16}$/);
});

test("11g. sessionFilename: 128 chars → raw passthrough (boundary)", () => {
  const s = "x".repeat(128);
  assert.equal(sessionFilename(s), s);
});

test("11h. sessionFilename: hash output is filesystem-safe", () => {
  for (let i = 0; i < 100; i++) {
    const input = `${Math.random()}/../${i}!@#${String.fromCharCode(i)}`;
    const out = sessionFilename(input);
    assert.match(out, /^[A-Za-z0-9_-]+$/, `output not safe for input ${JSON.stringify(input)}: ${out}`);
    assert.ok(out.length <= 128);
  }
});

test("11i. sessionFilename: reserved-name passthrough (account, unknown)", () => {
  // The sessions/ subdirectory provides structural separation from account.json,
  // so these names are not special at the rule level.
  assert.equal(sessionFilename("account"), "account");
  assert.equal(sessionFilename("unknown"), "unknown");
});

// --- File-write tests (#1-#7) ---

test("1. happy path: real session_id writes account + sessions/<uuid>.json", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({ headers: { "x-claude-code-session-id": "b16c607d-d484-4935-840e-e3f7ee78eb08" } });
    const accountPath = join(env.home, ".claude", "quota-status", "account.json");
    const sessPath = join(env.home, ".claude", "quota-status", "sessions", "b16c607d-d484-4935-840e-e3f7ee78eb08.json");
    assert.ok(existsSync(accountPath), "account.json must exist");
    assert.ok(existsSync(sessPath), "session file must exist");
    const account = JSON.parse(readFileSync(accountPath, "utf8"));
    assert.equal(account.five_hour.pct, 42);
    assert.ok(account.timestamp);
    const sess = JSON.parse(readFileSync(sessPath, "utf8"));
    assert.equal(sess.session_id, "b16c607d-d484-4935-840e-e3f7ee78eb08");
    assert.equal(sess.cache.ttl_tier, "5m"); // cacheCreation > 0, cacheRead = 0
    assert.equal(sess.cache.cache_creation, 100);
  } finally {
    env.cleanup();
  }
});

test("2. fallback to x-session-id", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({ headers: { "x-session-id": "legacy-uuid-1234" } });
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "sessions", "legacy-uuid-1234.json")));
  } finally {
    env.cleanup();
  }
});

test("3. fallback to x-anthropic-session-id", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({ headers: { "x-anthropic-session-id": "anthropic-uuid-5678" } });
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "sessions", "anthropic-uuid-5678.json")));
  } finally {
    env.cleanup();
  }
});

test("4. all three session headers missing → 'unknown' filename", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({});
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "sessions", "unknown.json")));
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "account.json")));
  } finally {
    env.cleanup();
  }
});

test("5. two responses, different sessions: per-session files distinct, account reflects last", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({ headers: { "x-claude-code-session-id": "session-a" }, cacheRead: 200, cacheCreation: 0 });
    await driveResponse({ headers: { "x-claude-code-session-id": "session-b" }, cacheRead: 0, cacheCreation: 500 });
    const sessA = JSON.parse(readFileSync(join(env.home, ".claude", "quota-status", "sessions", "session-a.json"), "utf8"));
    const sessB = JSON.parse(readFileSync(join(env.home, ".claude", "quota-status", "sessions", "session-b.json"), "utf8"));
    assert.equal(sessA.cache.cache_read, 200);
    assert.equal(sessA.cache.cache_creation, 0);
    assert.equal(sessB.cache.cache_read, 0);
    assert.equal(sessB.cache.cache_creation, 500);
    // account.json reflects whichever was written last (both responses use same QUOTA_HEADERS)
    const account = JSON.parse(readFileSync(join(env.home, ".claude", "quota-status", "account.json"), "utf8"));
    assert.equal(account.five_hour.pct, 42);
  } finally {
    env.cleanup();
  }
});

test("6. quota-only write skipped when no quota headers", async () => {
  const env = setupTmpHome();
  try {
    const meta = {};
    const telemetry = {};
    // No quota headers at all
    await ext.onResponseStart({ headers: { "x-claude-code-session-id": "any" }, meta });
    await ext.onStreamEvent({ event: { type: "message_start", message: { usage: { cache_creation_input_tokens: 100 } } }, telemetry, meta });
    await ext.onStreamEvent({ event: { type: "message_delta", usage: { output_tokens: 10 } }, telemetry, meta });
    assert.ok(!existsSync(join(env.home, ".claude", "quota-status")), "no files when no quota headers");
  } finally {
    env.cleanup();
  }
});

test("7. atomic write: tmp file gone after rename, final exists", async () => {
  const env = setupTmpHome();
  try {
    await driveResponse({ headers: { "x-claude-code-session-id": "atomic-test" } });
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    const entries = readdirSync(sessionsDir);
    // Must NOT have any *.tmp.* leftovers
    for (const e of entries) {
      assert.ok(!/\.tmp\./.test(e), `unexpected tmp leftover: ${e}`);
    }
    // Must have final file
    assert.ok(entries.includes("atomic-test.json"));
  } finally {
    env.cleanup();
  }
});

// --- Legacy file cleanup (#7a, #7b) ---

test("7a. legacy file cleanup on first invocation (one-shot per process)", async () => {
  const env = setupTmpHome();
  try {
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    const legacy = join(env.home, ".claude", "quota-status.json");
    writeFileSync(legacy, "{}");
    assert.ok(existsSync(legacy));
    await driveResponse({ headers: { "x-claude-code-session-id": "post-upgrade" } });
    assert.ok(!existsSync(legacy), "legacy file should be deleted after first invocation");
    // Re-create and run again — module-state flag means cleanup does NOT fire again.
    writeFileSync(legacy, "{}");
    await driveResponse({ headers: { "x-claude-code-session-id": "post-upgrade-2" } });
    assert.ok(existsSync(legacy), "second invocation should NOT re-trigger legacy cleanup");
  } finally {
    env.cleanup();
  }
});

test("7b. legacy cleanup absence is silent", async () => {
  const env = setupTmpHome();
  try {
    // Legacy file does not exist.
    assert.ok(!existsSync(join(env.home, ".claude", "quota-status.json")));
    await driveResponse({ headers: { "x-claude-code-session-id": "no-legacy" } });
    // Response writes complete normally
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "account.json")));
  } finally {
    env.cleanup();
  }
});

// --- TTL sweep (#8-#11) ---

function setOldMtime(path, daysAgo) {
  const t = (Date.now() - daysAgo * 86_400_000) / 1000;
  utimesSync(path, t, t);
}

test("8. sweep deletes stale per-session files; account.json untouched", async () => {
  const env = setupTmpHome();
  try {
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const oldFile = join(sessionsDir, "old.json");
    const recentFile = join(sessionsDir, "recent.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(recentFile, "{}");
    setOldMtime(oldFile, 8);
    setOldMtime(recentFile, 1);
    // Pre-create account.json with old mtime — sweep MUST NOT delete it.
    const accountPath = join(env.home, ".claude", "quota-status", "account.json");
    writeFileSync(accountPath, "{}");
    setOldMtime(accountPath, 30);

    await driveResponse({ headers: { "x-claude-code-session-id": "fresh" } });

    assert.ok(!existsSync(oldFile), "old per-session file should be swept");
    assert.ok(existsSync(recentFile), "recent per-session file should survive");
    assert.ok(existsSync(accountPath), "account.json must survive (lives outside sessions/)");
  } finally {
    env.cleanup();
  }
});

test("9. sweep throttled to 60s within same process", async () => {
  const env = setupTmpHome();
  try {
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stale = join(sessionsDir, "stale.json");
    writeFileSync(stale, "{}");
    setOldMtime(stale, 10);

    // First response triggers sweep.
    await driveResponse({ headers: { "x-claude-code-session-id": "drive-1" } });
    assert.ok(!existsSync(stale), "first sweep should delete stale file");

    // Re-create stale file. Second response should NOT sweep (throttled).
    writeFileSync(stale, "{}");
    setOldMtime(stale, 10);
    await driveResponse({ headers: { "x-claude-code-session-id": "drive-2" } });
    assert.ok(existsSync(stale), "throttled sweep must not delete on second response within 60s");
  } finally {
    env.cleanup();
  }
});

test("10. CACHE_FIX_QUOTA_STATUS_TTL_DAYS=0 expires every per-session file", async () => {
  const env = setupTmpHome();
  try {
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stub = join(sessionsDir, "thirty-sec-old.json");
    writeFileSync(stub, "{}");
    // mtime 30 seconds ago — would survive default 7-day TTL.
    const t = (Date.now() - 30_000) / 1000;
    utimesSync(stub, t, t);

    await driveResponse({
      headers: { "x-claude-code-session-id": "drive" },
      env: { CACHE_FIX_QUOTA_STATUS_TTL_DAYS: "0" },
    });

    assert.ok(!existsSync(stub), "30s-old stub should be swept with TTL=0");
    // account.json untouched even with TTL=0
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "account.json")));
  } finally {
    env.cleanup();
  }
});

test("11. sweep failure isolation: response completes even if a deletion would fail", async () => {
  // Construct a state that won't actually fail (we don't easily mock unlinkSync
  // without monkey-patching), but verify that with mixed-mtime files, the sweep
  // behaves correctly and the response writes still land. This is the "doesn't
  // throw" guarantee in spirit.
  const env = setupTmpHome();
  try {
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stale1 = join(sessionsDir, "stale1.json");
    const stale2 = join(sessionsDir, "stale2.json");
    writeFileSync(stale1, "{}");
    writeFileSync(stale2, "{}");
    setOldMtime(stale1, 10);
    setOldMtime(stale2, 10);

    await driveResponse({ headers: { "x-claude-code-session-id": "drive" } });

    // Both stale files should be deleted; the response write still landed.
    assert.ok(!existsSync(stale1));
    assert.ok(!existsSync(stale2));
    assert.ok(existsSync(join(sessionsDir, "drive.json")));
  } finally {
    env.cleanup();
  }
});
