import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import ext, {
  countThinkingBlocks,
  computeContextTokens,
  computeRisk,
  loadConfig,
} from "../proxy/extensions/session-health.mjs";
import { sessionFilePath } from "../proxy/extensions/cache-telemetry.mjs";

// --- Pure-function unit tests ---

test("countThinkingBlocks: counts thinking + redacted_thinking across messages", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "S" }, { type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "tool_result", content: "x" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE" }, { type: "tool_use", id: "t" }] },
    ],
  };
  assert.equal(countThinkingBlocks(body), 2);
});

test("countThinkingBlocks: 0 for no thinking / no messages / string content", () => {
  assert.equal(countThinkingBlocks({ messages: [{ role: "user", content: "plain" }] }), 0);
  assert.equal(countThinkingBlocks({ messages: [] }), 0);
  assert.equal(countThinkingBlocks({}), 0);
  assert.equal(countThinkingBlocks(null), 0);
});

test("computeContextTokens: sums input + cache_read + cache_creation", () => {
  assert.equal(computeContextTokens({ inputTokens: 5, cacheRead: 300_000, cacheCreation: 2_000 }), 302_005);
  assert.equal(computeContextTokens({ cacheRead: 100 }), 100);
  assert.equal(computeContextTokens(null), 0);
  assert.equal(computeContextTokens({}), 0);
});

test("computeRisk: boundaries (ok / warn / high)", () => {
  const cfg = { warnTokens: 250_000, highTokens: 340_000 };
  assert.equal(computeRisk(249_999, cfg), "ok");
  assert.equal(computeRisk(250_000, cfg), "warn"); // == warn → warn
  assert.equal(computeRisk(339_999, cfg), "warn");
  assert.equal(computeRisk(340_000, cfg), "high"); // == high → high
  assert.equal(computeRisk(400_000, cfg), "high");
});

test("loadConfig: defaults, overrides, and off", () => {
  assert.deepEqual(loadConfig({}), { warnTokens: 250_000, highTokens: 340_000, enabled: true });
  assert.deepEqual(
    loadConfig({ CACHE_FIX_THINKING_RISK_WARN_TOKENS: "100000", CACHE_FIX_THINKING_RISK_HIGH_TOKENS: "200000" }),
    { warnTokens: 100_000, highTokens: 200_000, enabled: true },
  );
  assert.equal(loadConfig({ CACHE_FIX_THINKING_RISK: "off" }).enabled, false);
  // bad values fall back to defaults
  assert.equal(loadConfig({ CACHE_FIX_THINKING_RISK_WARN_TOKENS: "nope" }).warnTokens, 250_000);
});

// --- onRequest ---

test("onRequest: stashes thinking-block count on ctx.meta", async () => {
  ext.__resetForTests();
  const meta = {};
  const body = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "S" }] }] };
  await ext.onRequest({ body, meta });
  assert.equal(meta._thinkingBlockCount, 1);
});

// --- onStreamEvent integration ---

function setupTmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "sh-"));
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

// Drive one request through session-health, simulating cache-telemetry having
// already resolved the session id (onRequest, order 600) and captured usage
// (message_start). Returns the meta object so the caller can inspect
// _sessionHealth.
async function driveHealth({ sessionId = "sess-1", thinkingBlocks = 0, cacheStats = { inputTokens: 5, cacheRead: 0, cacheCreation: 0 }, env = {} } = {}) {
  const oldEnv = {};
  for (const k of Object.keys(env)) {
    oldEnv[k] = process.env[k];
    process.env[k] = env[k];
  }
  const meta = {};
  try {
    const content = Array.from({ length: thinkingBlocks }, () => ({ type: "thinking", thinking: "", signature: "S" }));
    await ext.onRequest({ body: { messages: [{ role: "assistant", content }] }, meta });
    // Simulate cache-telemetry's onRequest + message_start:
    meta._sessionId = sessionId;
    meta.cacheStats = cacheStats;
    await ext.onStreamEvent({ event: { type: "message_delta", usage: { output_tokens: 10 } }, meta });
  } finally {
    for (const k of Object.keys(oldEnv)) {
      if (oldEnv[k] === undefined) delete process.env[k];
      else process.env[k] = oldEnv[k];
    }
  }
  return meta;
}

test("onStreamEvent: stashes health fields with risk ok below thresholds", async () => {
  const env = setupTmpHome();
  try {
    const meta = await driveHealth({ thinkingBlocks: 3, cacheStats: { inputTokens: 5, cacheRead: 1000, cacheCreation: 0 } });
    assert.deepEqual(meta._sessionHealth, {
      context_tokens: 1005,
      thinking_block_count: 3,
      thinking_block_max: 3,
      first_seen: meta._sessionHealth.first_seen, // ISO string, set to now
      request_count: 1,
      thinking_desync_risk: "ok",
    });
    assert.match(meta._sessionHealth.first_seen, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    env.cleanup();
  }
});

test("onStreamEvent: risk 'high' at high threshold", async () => {
  const env = setupTmpHome();
  try {
    const meta = await driveHealth({ cacheStats: { inputTokens: 0, cacheRead: 345_000, cacheCreation: 0 } });
    assert.equal(meta._sessionHealth.context_tokens, 345_000);
    assert.equal(meta._sessionHealth.thinking_desync_risk, "high");
  } finally {
    env.cleanup();
  }
});

test("onStreamEvent: CACHE_FIX_THINKING_RISK=off omits risk field but keeps raw counts", async () => {
  const env = setupTmpHome();
  try {
    const meta = await driveHealth({
      thinkingBlocks: 2,
      cacheStats: { inputTokens: 0, cacheRead: 345_000, cacheCreation: 0 },
      env: { CACHE_FIX_THINKING_RISK: "off" },
    });
    assert.equal("thinking_desync_risk" in meta._sessionHealth, false, "risk field must be omitted when off");
    assert.equal(meta._sessionHealth.context_tokens, 345_000);
    assert.equal(meta._sessionHealth.thinking_block_count, 2);
    assert.equal(meta._sessionHealth.request_count, 1);
  } finally {
    env.cleanup();
  }
});

test("onStreamEvent: thinking_block_max is a high-water mark; request_count increments (within a process)", async () => {
  const env = setupTmpHome();
  try {
    await driveHealth({ sessionId: "sess-hw", thinkingBlocks: 10 });
    const meta2 = await driveHealth({ sessionId: "sess-hw", thinkingBlocks: 4 }); // fewer blocks this turn
    assert.equal(meta2._sessionHealth.thinking_block_count, 4);
    assert.equal(meta2._sessionHealth.thinking_block_max, 10, "max holds the earlier high");
    assert.equal(meta2._sessionHealth.request_count, 2, "count increments across requests");
  } finally {
    env.cleanup();
  }
});

test("onStreamEvent: seeds first_seen / max / count from the prior persisted file (survives restart)", async () => {
  const env = setupTmpHome();
  try {
    // Simulate a prior process having written this session's file.
    const sid = "sess-seed";
    const p = sessionFilePath(sid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      cache: { ttl_tier: "1h" },
      context_tokens: 300_000,
      thinking_block_count: 50,
      thinking_block_max: 800,
      first_seen: "2026-04-01T00:00:00.000Z",
      request_count: 1234,
      session_id: sid,
    }));
    // Fresh process (state cleared) sees this session for the first time.
    ext.__resetForTests();
    const meta = await driveHealth({ sessionId: sid, thinkingBlocks: 60 });
    assert.equal(meta._sessionHealth.first_seen, "2026-04-01T00:00:00.000Z", "first_seen carried from file");
    assert.equal(meta._sessionHealth.thinking_block_max, 800, "max carried (current 60 < 800)");
    assert.equal(meta._sessionHealth.request_count, 1235, "count seeded from file + 1");
  } finally {
    env.cleanup();
  }
});

test("onStreamEvent: one-time 'high' stderr warn fires exactly once per session per process", async () => {
  const env = setupTmpHome();
  const origWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    const high = { inputTokens: 0, cacheRead: 345_000, cacheCreation: 0 };
    await driveHealth({ sessionId: "sess-warn", cacheStats: high });
    await driveHealth({ sessionId: "sess-warn", cacheStats: high }); // still high — must NOT warn again
    const warns = lines.filter((l) => l.includes("[session-health]") && l.includes("high thinking-desync risk"));
    assert.equal(warns.length, 1, "warn must fire exactly once per session per process");
    assert.match(warns[0], /context_tokens=345000/);
    assert.equal(warns[0].includes("thinking"), true);
  } finally {
    process.stderr.write = origWrite;
    env.cleanup();
  }
});

test("onStreamEvent: no warn when CACHE_FIX_THINKING_RISK=off even at high context", async () => {
  const env = setupTmpHome();
  const origWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    await driveHealth({ sessionId: "sess-off", cacheStats: { inputTokens: 0, cacheRead: 345_000, cacheCreation: 0 }, env: { CACHE_FIX_THINKING_RISK: "off" } });
    assert.equal(lines.filter((l) => l.includes("[session-health]")).length, 0);
  } finally {
    process.stderr.write = origWrite;
    env.cleanup();
  }
});

test("onStreamEvent: ignores non-message_delta events and is idempotent per response", async () => {
  const env = setupTmpHome();
  try {
    ext.__resetForTests();
    const meta = {};
    meta._sessionId = "sess-idem";
    meta.cacheStats = { inputTokens: 0, cacheRead: 1000, cacheCreation: 0 };
    meta._thinkingBlockCount = 1;
    await ext.onStreamEvent({ event: { type: "message_start" }, meta });
    assert.equal(meta._sessionHealth, undefined, "no stash on message_start");
    await ext.onStreamEvent({ event: { type: "message_delta", usage: {} }, meta });
    await ext.onStreamEvent({ event: { type: "message_delta", usage: {} }, meta }); // second delta — must not double-count
    assert.equal(meta._sessionHealth.request_count, 1, "counted once per response");
  } finally {
    env.cleanup();
  }
});
