// Pipeline-level integration tests for per-session quota-status writes
// (directive #16, #17, #11j). Loads the real proxy/extensions/ directory +
// extensions.json via loadExtensions(), drives a synthetic response through
// onResponseStart + onStreamEvent, asserts on disk state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadExtensions, runOnRequest, runOnResponseStart, runOnStreamEvent } from "../proxy/pipeline.mjs";
import cacheTelemetry from "../proxy/extensions/cache-telemetry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, "..", "proxy", "extensions");
const EXT_CONFIG = join(__dirname, "..", "proxy", "extensions.json");

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

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "qsp-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  cacheTelemetry.__resetForTests();
  return {
    home,
    cleanup: () => {
      process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function driveFullResponse(extSnapshot, headers, { cacheRead = 0, cacheCreation = 100, body } = {}) {
  // Real proxy puts request and response headers on different ctx objects;
  // session-id headers come from the request, quota fields from the response.
  // For these synthetic tests we drive the same `headers` map through both
  // hooks since the helper is purely about exercising the per-session file
  // write path end-to-end.
  const meta = {};
  const telemetry = {};
  // body required by some upstream-of-cache-telemetry extensions (e.g.
  // ttl-tier-detect at order 75 walks body.system / body.messages).
  const reqBody = body || { system: [], messages: [] };
  await runOnRequest({ body: reqBody, headers, meta }, extSnapshot);
  await runOnResponseStart({ headers, meta }, extSnapshot);
  await runOnStreamEvent(
    {
      event: { type: "message_start", message: { usage: { cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, input_tokens: 5 } } },
      telemetry,
      meta,
    },
    extSnapshot,
  );
  await runOnStreamEvent(
    {
      event: { type: "message_delta", usage: { output_tokens: 100 } },
      telemetry,
      meta,
    },
    extSnapshot,
  );
  return meta;
}

test("[pipeline #16] end-to-end happy path: full pipeline writes account.json + sessions/<uuid>.json", async () => {
  const env = setupHome();
  try {
    const exts = await loadExtensions(EXT_DIR, EXT_CONFIG);
    const sid = "b16c607d-d484-4935-840e-e3f7ee78eb08";
    await driveFullResponse(exts, { ...QUOTA_HEADERS, "x-claude-code-session-id": sid });

    const accountPath = join(env.home, ".claude", "quota-status", "account.json");
    const sessionPath = join(env.home, ".claude", "quota-status", "sessions", `${sid}.json`);
    assert.ok(existsSync(accountPath), "account.json must exist");
    assert.ok(existsSync(sessionPath), "per-session file must exist");

    const account = JSON.parse(readFileSync(accountPath, "utf8"));
    assert.equal(account.five_hour.pct, 42);
    assert.equal(account.seven_day.pct, 15);

    const sess = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(sess.session_id, sid);
    assert.equal(sess.cache.cache_creation, 100);
  } finally {
    env.cleanup();
  }
});

test("[pipeline #17] two-session interleaving: per-session files distinct; account reflects last", async () => {
  const env = setupHome();
  try {
    const exts = await loadExtensions(EXT_DIR, EXT_CONFIG);
    await driveFullResponse(exts, { ...QUOTA_HEADERS, "x-claude-code-session-id": "session-A" }, { cacheRead: 200, cacheCreation: 0 });
    await driveFullResponse(exts, { ...QUOTA_HEADERS, "x-claude-code-session-id": "session-B" }, { cacheRead: 0, cacheCreation: 999 });

    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    const a = JSON.parse(readFileSync(join(sessionsDir, "session-A.json"), "utf8"));
    const b = JSON.parse(readFileSync(join(sessionsDir, "session-B.json"), "utf8"));
    assert.equal(a.cache.cache_read, 200, "session-A keeps its own cache_read");
    assert.equal(a.cache.cache_creation, 0);
    assert.equal(b.cache.cache_read, 0);
    assert.equal(b.cache.cache_creation, 999, "session-B keeps its own cache_creation");
    // account.json reflects the most recent write.
    const account = JSON.parse(readFileSync(join(env.home, ".claude", "quota-status", "account.json"), "utf8"));
    assert.ok(account.timestamp);
  } finally {
    env.cleanup();
  }
});

test("[pipeline #160] session-health fields are merged into the per-session JSON by the writer", async () => {
  const env = setupHome();
  try {
    const exts = await loadExtensions(EXT_DIR, EXT_CONFIG);
    const sid = "sess-health-merge";
    const body = {
      system: [],
      messages: [
        { role: "assistant", content: [
          { type: "thinking", thinking: "", signature: "S" },
          { type: "redacted_thinking", data: "OPAQUE" },
          { type: "text", text: "ok" },
        ] },
      ],
    };
    // input_tokens 5 + cacheRead 0 + cacheCreation 100 = 105 context tokens → risk "ok"
    await driveFullResponse(exts, { ...QUOTA_HEADERS, "x-claude-code-session-id": sid }, { body });

    const sessionPath = join(env.home, ".claude", "quota-status", "sessions", `${sid}.json`);
    const sess = JSON.parse(readFileSync(sessionPath, "utf8"));
    // existing cache fields still present
    assert.equal(sess.session_id, sid);
    assert.equal(sess.cache.cache_creation, 100);
    // merged session-health fields
    assert.equal(sess.context_tokens, 105);
    assert.equal(sess.thinking_block_count, 2, "counts thinking + redacted_thinking");
    assert.equal(sess.thinking_block_max, 2);
    assert.equal(sess.request_count, 1);
    assert.equal(sess.thinking_desync_risk, "ok");
    assert.match(sess.first_seen, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    env.cleanup();
  }
});

test("[pipeline #11j] malformed session-id ends up in a hashed file, no path-traversal escape", async () => {
  const env = setupHome();
  try {
    const exts = await loadExtensions(EXT_DIR, EXT_CONFIG);
    const malformedId = "../../../etc/passwd";
    await driveFullResponse(exts, { ...QUOTA_HEADERS, "x-claude-code-session-id": malformedId });

    // Must land in sessions/inv-<16hex>.json
    const sessionsDir = join(env.home, ".claude", "quota-status", "sessions");
    const entries = readdirSync(sessionsDir);
    const hashed = entries.find((f) => /^inv-[0-9a-f]{16}\.json$/.test(f));
    assert.ok(hashed, `expected a file matching inv-<16hex>.json in sessions/, got: ${entries.join(",")}`);

    // JSON payload preserves the raw id
    const payload = JSON.parse(readFileSync(join(sessionsDir, hashed), "utf8"));
    assert.equal(payload.session_id, malformedId);

    // account.json is written normally (every response writes it).
    assert.ok(existsSync(join(env.home, ".claude", "quota-status", "account.json")));

    // Path-traversal safety: NO file at ~/.claude/quota-status.json (legacy),
    // NO file at /etc/passwd or any nested-traversal target outside sessions/.
    assert.ok(!existsSync(join(env.home, ".claude", "quota-status.json")));
    // The whole quota-status tree only contains expected paths.
    const quotaDir = join(env.home, ".claude", "quota-status");
    const topLevel = readdirSync(quotaDir).sort();
    assert.deepEqual(topLevel, ["account.json", "sessions"]);
  } finally {
    env.cleanup();
  }
});
