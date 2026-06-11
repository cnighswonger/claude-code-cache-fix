import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ext, {
  _resetState,
  buildSseString,
  buildJsonBody,
} from "../proxy/extensions/image-retry-circuit-breaker.mjs";

const IMG_A_B64 = Buffer.from("image-a-bytes").toString("base64");
const IMG_B_B64 = Buffer.from("image-b-bytes-completely-different").toString("base64");

function imageBlock(b64) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
}

function userMessage(blocks) {
  return { role: "user", content: blocks };
}

function makeBody({ stream = true, model = "claude-opus-4-7", messages = [] } = {}) {
  return { model, stream, messages };
}

function ctxFor({ body, sessionId = "session-aaa", route = "messages" }) {
  return {
    body,
    headers: sessionId ? { "x-claude-code-session-id": sessionId } : {},
    meta: { route },
  };
}

function errorResponseCtx({ meta, requestId = "req_test" }) {
  return {
    status: 400,
    headers: { "request-id": requestId },
    body: {
      type: "error",
      error: { type: "invalid_request_error", message: "image could not be processed" },
    },
    meta,
  };
}

let tmpDir;

beforeEach(() => {
  _resetState();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  tmpDir = mkdtempSync(join(tmpdir(), "image-retry-test-"));
  process.env.CACHE_FIX_IMAGE_RETRY_LOG_PATH = join(tmpDir, "events.jsonl");
  process.env.CACHE_FIX_IMAGE_RETRY_BREAKER = "on";
  delete process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS;
  delete process.env.CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES;
});

function logLines() {
  const path = process.env.CACHE_FIX_IMAGE_RETRY_LOG_PATH;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// Detection / fire path
// -----------------------------------------------------------------------------

test("first failure records but does NOT short-circuit (no prior entry)", async () => {
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  const result = await ext.onRequest(reqCtx);
  assert.equal(result, undefined);

  const resCtx = errorResponseCtx({ meta: reqCtx.meta });
  await ext.onResponse(resCtx);

  const events = logLines();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "failure_recorded");
  assert.equal(events[0].session_id, "session-aaa");
});

test("immediate retry with same image short-circuits with SSE for stream:true", async () => {
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx2 = ctxFor({ body: body2 });
  const result = await ext.onRequest(reqCtx2);

  assert.equal(result?.skip, true);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "text/event-stream");
  assert.equal(typeof result.body, "string", "SSE body must be a string for verbatim passthrough");
  assert.match(result.body, /event: message_start/);
  assert.match(result.body, /event: message_stop/);
  assert.match(result.body, /\[cache-fix-proxy\]/);

  const events = logLines();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "breaker_fire");
});

test("retry with stream:false short-circuits with JSON body", async () => {
  const body1 = makeBody({ stream: false, messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  const body2 = makeBody({ stream: false, messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx2 = ctxFor({ body: body2 });
  const result = await ext.onRequest(reqCtx2);

  assert.equal(result?.skip, true);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(typeof result.body, "object", "JSON body must be an object for JSON.stringify path");
  assert.equal(result.body.role, "assistant");
  assert.equal(result.body.content[0].type, "text");
  assert.match(result.body.content[0].text, /\[cache-fix-proxy\]/);
});

test("different image, same session → forwards (per-hash isolation)", async () => {
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_B_B64)])] });
  const reqCtx2 = ctxFor({ body: body2 });
  const result = await ext.onRequest(reqCtx2);
  assert.equal(result, undefined);
});

test("same image, different session → forwards (per-session isolation)", async () => {
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  await ext.onRequest(ctxFor({ body: body1, sessionId: "session-aaa" }));
  await ext.onResponse(errorResponseCtx({ meta: ctxFor({ body: body1, sessionId: "session-aaa" }).meta }));

  const reqCtx2 = ctxFor({ body: makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }), sessionId: "session-bbb" });
  const result = await ext.onRequest(reqCtx2);
  assert.equal(result, undefined);
});

test("requests with no image content are never short-circuited", async () => {
  const body = makeBody({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
  const reqCtx = ctxFor({ body });
  const result = await ext.onRequest(reqCtx);
  assert.equal(result, undefined);
});

// -----------------------------------------------------------------------------
// Mode gates
// -----------------------------------------------------------------------------

test("mode=off → no detection, no logging", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_BREAKER = "off";
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  const result = await ext.onRequest(reqCtx);
  assert.equal(result, undefined);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx.meta }));
  assert.equal(logLines().length, 0);
});

test("mode=dry-run → logs breaker_fire but does NOT short-circuit", async () => {
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  process.env.CACHE_FIX_IMAGE_RETRY_BREAKER = "dry-run";

  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx2 = ctxFor({ body: body2 });
  const result = await ext.onRequest(reqCtx2);
  assert.equal(result, undefined, "dry-run must forward upstream, not short-circuit");

  const events = logLines();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "breaker_fire");
  assert.equal(events[1].mode, "dry-run");
});

// -----------------------------------------------------------------------------
// Cool-off / sliding window
// -----------------------------------------------------------------------------

test("retry past cool-off window → forwards (entry has expired)", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS = "50";
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  await new Promise((r) => setTimeout(r, 80));

  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const result = await ext.onRequest(ctxFor({ body: body2 }));
  assert.equal(result, undefined);
});

test("sliding window: each fire extends cool-off from latest suppressed attempt", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS = "200";
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx0 = ctxFor({ body });
  await ext.onRequest(reqCtx0);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx0.meta }));

  // Three retries inside the cool-off, each at 100ms cadence. With a sliding
  // window each retry refreshes lastFailureAt, so the entry never expires.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const result = await ext.onRequest(ctxFor({ body: makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }) }));
    assert.equal(result?.skip, true, `retry ${i + 1} should short-circuit under sliding window`);
  }

  // Now wait past the cool-off; entry should expire.
  await new Promise((r) => setTimeout(r, 250));
  const final = await ext.onRequest(ctxFor({ body: makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }) }));
  assert.equal(final, undefined);
});

// -----------------------------------------------------------------------------
// Multi-image
// -----------------------------------------------------------------------------

test("replaced-bad-image+shared-good-image within cool-off → short-circuits (acknowledged trade-off)", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS = "60000";

  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64), imageBlock(IMG_B_B64)])] });
  const reqCtx1 = ctxFor({ body: body1 });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  // User replaces only the bad image (IMG_A); IMG_B stays the same.
  const IMG_REPLACEMENT = Buffer.from("a-different-replacement-image").toString("base64");
  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_REPLACEMENT), imageBlock(IMG_B_B64)])] });
  const result = await ext.onRequest(ctxFor({ body: body2 }));
  assert.equal(result?.skip, true, "any-hash overlap is the deliberate trade-off");
});

// -----------------------------------------------------------------------------
// Sessionless bucket — cross-contamination is the documented trade-off
// -----------------------------------------------------------------------------

test("sessionless requests bucket to 'unknown' and can cross-contaminate", async () => {
  // First sessionless request fails on IMG_A
  const body1 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx1 = ctxFor({ body: body1, sessionId: null });
  await ext.onRequest(reqCtx1);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx1.meta }));

  // Second sessionless request shares IMG_A in the hash set — same bucket key,
  // but a different request signature... so by directive: cross-contamination
  // happens when image hashes overlap WITHIN the same requestSignature entry.
  // Here we use the same body shape so the signatures match — directive's
  // documented "sessionless requests are NOT isolated by requestSignature"
  // case is exercised by the body identical → same signature path.
  const body2 = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const result = await ext.onRequest(ctxFor({ body: body2, sessionId: null }));
  assert.equal(result?.skip, true);

  const events = logLines();
  assert.ok(events.some((e) => e.event === "breaker_fire" && e.session_id === "unknown"));
});

// -----------------------------------------------------------------------------
// State management — LRU eviction
// -----------------------------------------------------------------------------

test("LRU eviction drops oldest entry at MAX_ENTRIES cap", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES = "3";

  // Record 4 distinct failures (different sessions).
  for (let i = 0; i < 4; i++) {
    const sessionId = `sess-${i}`;
    const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
    const reqCtx = ctxFor({ body, sessionId });
    await ext.onRequest(reqCtx);
    await ext.onResponse(errorResponseCtx({ meta: reqCtx.meta }));
  }

  // Oldest entry (sess-0) should have been evicted.
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const result = await ext.onRequest(ctxFor({ body, sessionId: "sess-0" }));
  assert.equal(result, undefined, "evicted entry should not short-circuit");

  const result3 = await ext.onRequest(ctxFor({ body: makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }), sessionId: "sess-3" }));
  assert.equal(result3?.skip, true, "most-recent entry should still short-circuit");
});

// -----------------------------------------------------------------------------
// Error-class predicate negative cases
// -----------------------------------------------------------------------------

test("overloaded_error response does NOT record failure (near-miss class)", async () => {
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  await ext.onRequest(reqCtx);
  await ext.onResponse({
    status: 529,
    headers: {},
    body: { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
    meta: reqCtx.meta,
  });
  assert.equal(logLines().length, 0);
});

test("429 rate-limit error does NOT record failure", async () => {
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  await ext.onRequest(reqCtx);
  await ext.onResponse({
    status: 429,
    headers: {},
    body: { type: "error", error: { type: "rate_limit_error", message: "rate-limited" } },
    meta: reqCtx.meta,
  });
  assert.equal(logLines().length, 0);
});

test("200 success response does NOT record failure", async () => {
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  await ext.onRequest(reqCtx);
  await ext.onResponse({
    status: 200,
    headers: {},
    body: { id: "msg_real", role: "assistant", content: [{ type: "text", text: "ok" }] },
    meta: reqCtx.meta,
  });
  assert.equal(logLines().length, 0);
});

// -----------------------------------------------------------------------------
// Replay fixture (CC#66815): first call upstream, 18 short-circuited
// -----------------------------------------------------------------------------

test("CC#66815 replay: 1 upstream call + 18 short-circuits = 1 failure_recorded + 18 breaker_fire events", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS = "60000";

  const replay = Array.from({ length: 19 }, () => makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }));

  let upstreamCalls = 0;
  let shortCircuited = 0;

  for (const body of replay) {
    const reqCtx = ctxFor({ body });
    const result = await ext.onRequest(reqCtx);
    if (result?.skip) {
      shortCircuited += 1;
      continue;
    }
    upstreamCalls += 1;
    // The first call hits upstream and fails with the canonical envelope.
    await ext.onResponse(errorResponseCtx({ meta: reqCtx.meta }));
  }

  assert.equal(upstreamCalls, 1, "directive § replay-fixture assertion: total upstream calls = 1");
  assert.equal(shortCircuited, 18);

  const events = logLines();
  const failureCount = events.filter((e) => e.event === "failure_recorded").length;
  const fireCount = events.filter((e) => e.event === "breaker_fire").length;
  assert.equal(failureCount, 1);
  assert.equal(fireCount, 18);
});

// -----------------------------------------------------------------------------
// SSE / JSON synthesis structural correctness
// -----------------------------------------------------------------------------

test("buildSseString emits the full event sequence (no [DONE] by default)", () => {
  const out = buildSseString("claude-opus-4-7", "hi");
  assert.match(out, /^event: message_start/);
  assert.ok(out.indexOf("event: content_block_start") > 0);
  assert.ok(out.indexOf("event: content_block_delta") > 0);
  assert.ok(out.indexOf("event: content_block_stop") > 0);
  assert.ok(out.indexOf("event: message_delta") > 0);
  assert.ok(out.indexOf("event: message_stop") > 0);
  assert.ok(!out.includes("[DONE]"), "[DONE] sentinel is deferred to sim validation per directive N1");
});

test("buildSseString event payloads are valid JSON and carry the required structural fields", () => {
  const out = buildSseString("claude-opus-4-7", "delta-text");
  const events = out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data:"));
      return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
    })
    .filter(Boolean);

  assert.equal(events.length, 6);
  const start = events[0];
  assert.equal(start.type, "message_start");
  assert.equal(start.message.role, "assistant");
  assert.equal(start.message.model, "claude-opus-4-7");
  assert.equal(typeof start.message.usage.input_tokens, "number");

  assert.equal(events[1].type, "content_block_start");
  assert.equal(events[1].index, 0);
  assert.equal(events[2].type, "content_block_delta");
  assert.equal(events[2].delta.text, "delta-text");
  assert.equal(events[3].type, "content_block_stop");
  assert.equal(events[4].type, "message_delta");
  assert.equal(events[4].delta.stop_reason, "end_turn");
  assert.equal(events[5].type, "message_stop");
});

test("buildJsonBody produces the upstream non-streaming envelope shape", () => {
  const out = buildJsonBody("claude-opus-4-7", "the text");
  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, "claude-opus-4-7");
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "the text");
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(typeof out.usage.input_tokens, "number");
});

// -----------------------------------------------------------------------------
// PII discipline on the event log
// -----------------------------------------------------------------------------

test("JSONL events carry no request body / no auth headers", async () => {
  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx = ctxFor({ body });
  await ext.onRequest(reqCtx);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx.meta }));

  const events = logLines();
  assert.ok(events.length > 0);
  for (const evt of events) {
    const serialized = JSON.stringify(evt);
    assert.ok(!/authorization|x-api-key|cookie/i.test(serialized), "no auth headers in event log");
    assert.ok(!serialized.includes(IMG_A_B64), "no image bytes in event log");
    assert.ok(!serialized.includes("image-a-bytes"), "no raw request data in event log");
  }
});

test("retryCount increments on successive fires", async () => {
  process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS = "60000";

  const body = makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] });
  const reqCtx0 = ctxFor({ body });
  await ext.onRequest(reqCtx0);
  await ext.onResponse(errorResponseCtx({ meta: reqCtx0.meta }));

  for (let i = 0; i < 3; i++) {
    await ext.onRequest(ctxFor({ body: makeBody({ messages: [userMessage([imageBlock(IMG_A_B64)])] }) }));
  }

  const events = logLines();
  const fires = events.filter((e) => e.event === "breaker_fire");
  assert.equal(fires.length, 3);
  assert.equal(fires[0].retry_count, 1);
  assert.equal(fires[1].retry_count, 2);
  assert.equal(fires[2].retry_count, 3);
});
