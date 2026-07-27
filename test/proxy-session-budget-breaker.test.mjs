import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import ext from "../proxy/extensions/session-budget-breaker.mjs";

// Directive: docs/directives/proxy-subagent-budget-circuit-breaker.md
// Highest-value class = the fail-open table. A block requires gate `on` + a
// confident per-session tally at/over an explicit ceiling; everything else forwards.

const SID = "sess-abc";
const H = (sid = SID) => ({ "x-claude-code-session-id": sid });
// A message_start stream event carrying input+cache_creation tokens. `model` is
// optional (cost lever prices per-model; token/rate levers ignore it).
const start = (inp, cc = 0, model = undefined, sid = SID, responseHeaders = undefined) => ({
  headers: H(sid),
  responseHeaders,
  event: { type: "message_start", message: { model, usage: { input_tokens: inp, cache_creation_input_tokens: cc, output_tokens: 0, cache_read_input_tokens: 0 } } },
});
// A response-headers block carrying the account-global 5h utilization.
const q5hHdr = (util) => ({ "anthropic-ratelimit-unified-5h-utilization": String(util) });
// A model id deliberately absent from tools/rates.json, and never a real model.
// The unknown-model fail-open tests below must NOT name a real one: they said
// "claude-fable-5", which was genuinely unpriced when this suite was written and
// became priced when rates.json was refreshed (PR #259), turning them red for a
// reason unrelated to the breaker.
const UNPRICED_MODEL = "claude-not-a-real-model-fixture";
// `meta` mirrors server.mjs preForward: one object threaded through onRequest →
// onResponse, which is how the non-streaming accrual path learns the session id.
const req = (sid = SID, stream = true, meta = { route: "messages" }) =>
  ({ headers: H(sid), body: { model: "claude-fable-5", stream }, meta });
// A non-streaming (stream:false) response body as server.mjs hands it to
// onResponse: parsed JSON, plus RESPONSE headers (no session id on them).
const jsonRes = (inp, cc = 0, model = undefined, meta = undefined, responseHeaders = {}) => ({
  status: 200,
  headers: responseHeaders,
  body: { type: "message", model, usage: { input_tokens: inp, cache_creation_input_tokens: cc, output_tokens: 0, cache_read_input_tokens: 0 } },
  meta,
});

function clearEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("CACHE_FIX_SESSION_BUDGET")) delete process.env[k];
}

// Every fire writes a JSONL event, and the extension's default path is the
// OPERATOR's ~/.claude/session-budget-events.jsonl. clearEnv() wipes
// _EVENT_LOG along with the rest, so without re-pointing it here each test
// would append to that real log — which is exactly what happened: a run of
// this suite plus the sim left ~12k synthetic events in a developer's file.
// Re-point it after every clear so no test can reach the default path.
const TEST_EVENT_LOG = join(tmpdir(), `sbb-suite-${process.pid}.jsonl`);
function isolateEventLog() {
  process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG = TEST_EVENT_LOG;
}

beforeEach(() => { clearEnv(); isolateEventLog(); ext.__testOnly.reset(); });

after(() => { rmSync(TEST_EVENT_LOG, { force: true }); });

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
  const r = await ext.onRequest({ headers: {}, body: { model: "m", stream: true }, meta: { route: "messages" } });
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

// --- cost lever (rates.json: claude-opus-4-6 input=$5/M, cache_write_1h=$10/M) ---

test("cost lever blocks when estimated USD crosses the ceiling (known model)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "1"; // $1
  // 200k input tokens of opus-4-6 = 200000 * 5 / 1e6 = $1.00 ≥ $1.
  await ext.onStreamEvent(start(120000, 0, "claude-opus-4-6"));
  await ext.onStreamEvent(start(80000, 0, "claude-opus-4-6")); // cumulative 200k = $1.00
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "cost should cross $1 and block");
});

test("cost lever prices cache_creation at the higher cache_write_1h rate", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "1";
  // 100k cache_creation of opus-4-6 = 100000 * 10 / 1e6 = $1.00 (would be only
  // $0.50 if mispriced at the input rate). Proves the split pricing.
  await ext.onStreamEvent(start(0, 100000, "claude-opus-4-6"));
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "cache_creation must be priced at cache_write_1h, not input");
  assert.ok(Math.abs(ext.__testOnly.costUsd(SID) - 1.0) < 1e-9, `expected ~$1.00, got ${ext.__testOnly.costUsd(SID)}`);
});

test("cost lever UNDER the ceiling → forward", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "1";
  await ext.onStreamEvent(start(100000, 0, "claude-opus-4-6")); // $0.50 < $1
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "$0.50 < $1 → forward");
});

test("unknown model → cost not accrued (fail-open); token lever still works", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "0.01"; // tiny cost ceiling
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100"; // and a token ceiling
  // Model absent from rates.json → costOf returns null → costUsd stays 0, so the
  // cost lever cannot block; but the token tally still accrues and CAN block.
  await ext.onStreamEvent(start(150, 0, UNPRICED_MODEL)); // 150 tokens ≥ 100
  assert.equal(ext.__testOnly.costUsd(SID), 0, "unknown model must not accrue cost");
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "token lever must still fire even when cost is unavailable");
});

test("cost lever alone with an unknown model → forward (cost cannot block)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "0.01";
  // Unknown model, no token/rate ceiling set → nothing can block → forward.
  await ext.onStreamEvent(start(1000000, 0, UNPRICED_MODEL));
  const r = await ext.onRequest(req());
  assert.equal(r, undefined, "cost-only + unknown model = fail-open forward");
});

// --- observational q5h contribution (never gates; event-log only) ---

test("q5h contribution: absent when no account header seen (API-key traffic)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  // No responseHeaders → no q5h signal ever recorded.
  await ext.onStreamEvent(start(500));
  assert.equal(ext.__testOnly.q5hContribution(SID), null, "no header → signal absent");
});

test("q5h contribution: single session gets ~100% of the account delta", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  // First observation delta is 0 (baseline); second adds +0.10.
  await ext.onStreamEvent(start(1000, 0, undefined, SID, q5hHdr(0.20)));
  await ext.onStreamEvent(start(1000, 0, undefined, SID, q5hHdr(0.30)));
  const c = ext.__testOnly.q5hContribution(SID);
  assert.ok(c, "signal should be present");
  assert.ok(Math.abs(c.account_q5h_delta - 0.10) < 1e-9, `account delta ${c.account_q5h_delta}`);
  assert.ok(Math.abs(c.session_token_share - 1.0) < 1e-9, `share ${c.session_token_share}`);
  assert.ok(Math.abs(c.attributed_q5h_delta - 0.10) < 1e-9, `attributed ${c.attributed_q5h_delta}`);
});

test("q5h contribution: split by token share across two sessions", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "1000000"; // don't block; just observe
  // Baseline (delta 0), then session A burns 3000 tok and B burns 1000 tok over
  // the same window with the account q5h climbing +0.20 total.
  await ext.onStreamEvent(start(1, 0, undefined, "A", q5hHdr(0.10))); // baseline
  await ext.onStreamEvent(start(3000, 0, undefined, "A", q5hHdr(0.20))); // +0.10
  await ext.onStreamEvent(start(1000, 0, undefined, "B", q5hHdr(0.30))); // +0.10
  const cA = ext.__testOnly.q5hContribution("A");
  const cB = ext.__testOnly.q5hContribution("B");
  // Account delta over window = 0.20; account tokens = 1+3000+1000 = 4001.
  assert.ok(Math.abs(cA.account_q5h_delta - 0.20) < 1e-9, `A acct delta ${cA.account_q5h_delta}`);
  // A share ≈ 3001/4001 ≈ 0.7501; B share ≈ 1000/4001 ≈ 0.2499.
  assert.ok(cA.session_token_share > cB.session_token_share, "A drove more of the burn than B");
  assert.ok(Math.abs((cA.attributed_q5h_delta + cB.attributed_q5h_delta) - 0.20) < 1e-3,
    "attributed deltas sum to ~the account delta");
});

test("q5h contribution: surfaced in the fire event log, never a block gate", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  const logPath = join(tmpdir(), `sbb-q5h-${process.pid}-${SID}.jsonl`);
  rmSync(logPath, { force: true });
  process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG = logPath;
  await ext.onStreamEvent(start(60, 0, undefined, SID, q5hHdr(0.10))); // baseline
  await ext.onStreamEvent(start(60, 0, undefined, SID, q5hHdr(0.25))); // +0.15, cumulative 120 ≥ 100
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true, "token lever still gates — q5h is not the reason, just observed");
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop());
  assert.equal(rec.lever, "TOKENS", "block is on tokens, not q5h");
  assert.ok(rec.account_q5h_contribution, "event carries the observational q5h contribution");
  assert.ok(Math.abs(rec.account_q5h_contribution.account_q5h_delta - 0.15) < 1e-9);
  rmSync(logPath, { force: true });
});

test("q5h contribution: omitted from the event when no header was seen", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  const logPath = join(tmpdir(), `sbb-noq5h-${process.pid}-${SID}.jsonl`);
  rmSync(logPath, { force: true });
  process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG = logPath;
  await ext.onStreamEvent(start(150)); // no responseHeaders
  const r = await ext.onRequest(req());
  assert.ok(r && r.skip === true);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop());
  assert.equal("account_q5h_contribution" in rec, false, "field omitted when signal absent");
  rmSync(logPath, { force: true });
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

// --- Non-streaming (stream:false) accrual: onResponse path ---
// Codex review r1 blocker: server.mjs routes non-streaming /v1/messages
// responses through onResponse only, so a breaker that learns spend from
// onStreamEvent alone lets the entire stream:false request mode bypass the
// ceilings. These tests drive the real hook with the real ctx shape.

test("stream:false response accrues via onResponse and can cross the ceiling", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  const meta = { route: "messages" };
  // Turn 1: onRequest forwards (no tally), then the non-streaming body accrues.
  assert.equal(await ext.onRequest(req(SID, false, meta)), undefined);
  await ext.onResponse(jsonRes(150, 0, "claude-fable-5", meta));
  assert.equal(ext.__testOnly.tally(SID).tokens, 150);
  // Turn 2 must now be blocked — this is what the streaming-only breaker missed.
  const r = await ext.onRequest(req(SID, false, { route: "messages" }));
  assert.ok(r && r.skip === true, "second stream:false request must block");
  assert.equal(r.headers["content-type"], "application/json");
});

test("onResponse without an onRequest stash does not accrue (no sid to attribute)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  // Response headers never carry the session id, so a bare onResponse can't
  // attribute — must be a no-op rather than tallying against a wrong key.
  await ext.onResponse(jsonRes(500, 0, "claude-fable-5", { route: "messages" }));
  assert.equal(ext.__testOnly.tally(SID), undefined);
  assert.equal(await ext.onRequest(req()), undefined, "still forwards");
});

test("onResponse ignores non-message bodies (error envelopes)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  const meta = { route: "messages" };
  await ext.onRequest(req(SID, false, meta));
  await ext.onResponse({ status: 429, headers: {}, meta, body: { type: "error", error: { type: "rate_limit_error" } } });
  assert.equal(ext.__testOnly.tally(SID), undefined, "error envelope must not accrue");
});

test("onResponse prices cost for stream:false the same as streaming", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_COST_USD = "1000";
  const meta = { route: "messages" };
  await ext.onRequest(req(SID, false, meta));
  await ext.onResponse(jsonRes(1_000_000, 0, "claude-opus-4-6", meta));
  const viaResponse = ext.__testOnly.costUsd(SID);
  ext.__testOnly.reset();
  await ext.onStreamEvent(start(1_000_000, 0, "claude-opus-4-6"));
  assert.equal(viaResponse, ext.__testOnly.costUsd(SID), "both paths price identically");
  assert.ok(viaResponse > 0, "known model must accrue cost");
});

test("onResponse gate off / no ceiling → no accrual", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "off";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await ext.onResponse(jsonRes(500, 0, "claude-fable-5", { route: "messages", _sbbSessionId: SID }));
  assert.equal(ext.__testOnly.tally(SID), undefined, "gate off must not accrue");
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  delete process.env.CACHE_FIX_SESSION_BUDGET_TOKENS;
  await ext.onResponse(jsonRes(500, 0, "claude-fable-5", { route: "messages", _sbbSessionId: SID }));
  assert.equal(ext.__testOnly.tally(SID), undefined, "no ceiling set must not accrue");
});

test("a throw in onResponse never propagates (fail-open)", async () => {
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "100";
  await assert.doesNotReject(() => ext.onResponse({ status: 200, headers: {}, meta: undefined, body: undefined }));
  await assert.doesNotReject(() => ext.onResponse({ status: 200, headers: {}, body: { type: "message", usage: null }, meta: { _sbbSessionId: SID } }));
  assert.equal(ext.__testOnly.tally(SID), undefined);
});
