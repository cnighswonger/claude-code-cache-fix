import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import ext from "../proxy/extensions/session-budget-breaker.mjs";

// Directive: docs/directives/proxy-subagent-budget-circuit-breaker.md
// Highest-value class = the fail-open table. A block requires gate `on` + a
// confident per-session tally at/over an explicit ceiling; everything else forwards.

const SID = "sess-abc";
const H = (sid = SID) => ({ "x-claude-code-session-id": sid });
// A message_start stream event carrying input+cache_creation tokens.
const start = (inp, cc = 0) => ({
  headers: H(),
  event: { type: "message_start", message: { usage: { input_tokens: inp, cache_creation_input_tokens: cc, output_tokens: 0, cache_read_input_tokens: 0 } } },
});
const req = (sid = SID, stream = true) => ({ headers: H(sid), body: { model: "claude-fable-5", stream } });

function clearEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("CACHE_FIX_SESSION_BUDGET")) delete process.env[k];
}

beforeEach(() => { clearEnv(); ext.__testOnly.reset(); });

// --- Fail-open table ---

test("gate off → forward even when way over any conceivable ceiling", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "off";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  await ext.onStreamEvent(start(1000)); // tally would be 1000 ≥ 10 — but gate off
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "gate off must forward");
});

test("gate on but no ceiling set → inert, forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  await ext.onStreamEvent(start(1000));
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "no ceiling set → forward");
});

test("gate on, ceiling set, no session key → forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  const r = await ext.onRequest({ headers: {}, body: { model: "m", stream: true } });
  assert.equal(r, undefined, "no x-claude-code-session-id → forward");
});

test("gate on, ceiling set, first request (no tally yet) → forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "no tally yet → forward");
});

test("unparseable usage does not update tally (metric-local fail-open)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  await ext.onStreamEvent({ headers: H(), event: { type: "message_start", message: { usage: { input_tokens: "not-a-number" } } } });
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "unparseable input_tokens → tally not updated → forward");
  assert.equal(ext.__testOnly.tally(SID), undefined);
});

test("missing usage block → no update, forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  await ext.onStreamEvent({ headers: H(), event: { type: "message_start", message: {} } });
  const r = await ext.onRequest(req());
  assert.equal(r, undefined);
});

// --- Block path ---

test("token ceiling crossed → blocks with SSE for stream:true", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent(start(60));
  await ext.onStreamEvent(start(50)); // cumulative 110 ≥ 100
  const r = await ext.onRequest(req(SID, true));
  assert.ok(r && r.skip === true, "should block");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream");
  assert.match(r.body, /event: message_start/);
  assert.match(r.body, /CC#68285/);
});

test("token ceiling crossed → blocks with JSON body for stream:false", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent(start(150));
  const r = await ext.onRequest(req(SID, false));
  assert.ok(r && r.skip === true);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(typeof r.body, "object");
  assert.equal(r.body.type, "message");
});

test("under the token ceiling → forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent(start(99));
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "99 < 100 → forward");
});

test("input + cache_creation both count toward the tally", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent(start(40, 70)); // 40 + 70 = 110 ≥ 100
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "input+cache_creation should sum");
});

test("tally is per-session: session B is unaffected by session A's burn", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent({ headers: H("A"), event: { type: "message_start", message: { usage: { input_tokens: 500 } } } });
  const rA = await ext.onRequest(req("A"));
  const rB = await ext.onRequest(req("B"));
  assert.ok(rA && rA.skip === true, "A over → blocked");
  assert.equal(rB, undefined, "B has no tally → forward");
});

// --- dry-run ---

test("dry-run forwards even when over ceiling", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "dry-run";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onStreamEvent(start(500));
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "dry-run must forward, not block");
});

// --- rate lever ---

test("rate lever blocks when tokens/min over the window exceeds the ceiling", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_RATE_TPM = "1000";
  process.env.CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS = "60000";
  // Fire ~5000 tokens "just now" → within a ~1s effective span the tpm projection
  // far exceeds 1000/min.
  await ext.onStreamEvent(start(5000));
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "rate spike should trip the rate lever");
});

// --- throw safety ---

test("a throw in onStreamEvent never propagates (fail-open)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  // event undefined → internal guards return; must not throw
  await assert.doesNotReject(() => ext.onStreamEvent({ headers: H(), event: undefined }));
  const r = await ext.onRequest(req());
  assert.equal(r, undefined);
});
