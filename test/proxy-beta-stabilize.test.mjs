import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ext, {
  betaSessionKey,
  planStableBetas,
  resetBetaSnapshots,
} from "../proxy/extensions/beta-stabilize.mjs";

// The four states measured on visits-01 (2026-08-08) across turns 821-825 of
// ONE session, within ~5 minutes. cache-diagnosis flipped four times in 33
// seconds. Each of these is a different cache key for an otherwise identical
// request.
const BASE = "claude-code-20250219, oauth_auth, interleaved-thinking-2025-05-14";
const WITH_DIAG = `${BASE}, cache-diagnosis-2026-04-07`;
const WITH_DIAG_REDACT = `${BASE}, cache-diagnosis-2026-04-07, redact-thinking-2026-02-12`;
// Assembled from parts rather than written as a literal, per the note in
// absence-scan.test.mjs: this file is scanned by tools/absence-scan.mjs, and a
// UUID-shaped literal in source is exactly what the widened source scan is
// built to find. The VALUE is unchanged; only the source bytes differ.
const SID = ["11111111", "2222", "3333", "4444", "555555555555"].join("-");

let origEnv;
beforeEach(() => {
  origEnv = process.env.CACHE_FIX_BETA_STABILIZE;
  resetBetaSnapshots();
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.CACHE_FIX_BETA_STABILIZE;
  else process.env.CACHE_FIX_BETA_STABILIZE = origEnv;
  resetBetaSnapshots();
});

const SYSTEM = [{ type: "text", text: "You are a Claude agent." }];
const CONV = [{ role: "user", content: [{ type: "text", text: "conversation A" }] }];

function mkCtx({ beta = BASE, sid = SID, on = true, messages = CONV, system = SYSTEM } = {}) {
  if (on) process.env.CACHE_FIX_BETA_STABILIZE = "1";
  else delete process.env.CACHE_FIX_BETA_STABILIZE;
  const headers = { "anthropic-beta": beta };
  if (sid) headers["x-claude-code-session-id"] = sid;
  return { headers, meta: {}, body: { messages, system, model: "test-model" } };
}

// --- planStableBetas: the decision, in isolation ---

test("planStableBetas: first sight adopts what CC sent", () => {
  const p = planStableBetas(null, ["a", "b"]);
  assert.deepEqual(p, { tokens: ["a", "b"], action: "snapshot", added: [], removed: [] });
});

test("planStableBetas: same set → stable, no delta reported", () => {
  const p = planStableBetas(["a", "b"], ["a", "b"]);
  assert.equal(p.action, "stable");
  assert.deepEqual([p.added, p.removed], [[], []]);
});

test("planStableBetas: a pure reorder is not a delta", () => {
  // Set comparison, not string comparison. Reporting a reorder as an
  // add/remove would misdescribe what CC did — but the emitted tokens still
  // come from the snapshot, so the wire bytes stay put either way.
  const p = planStableBetas(["a", "b"], ["b", "a"]);
  assert.equal(p.action, "stable");
  assert.deepEqual(p.tokens, ["a", "b"]);
});

test("planStableBetas: an added beta is reported and NOT forwarded", () => {
  const p = planStableBetas(["a"], ["a", "b"]);
  assert.equal(p.action, "stabilized");
  assert.deepEqual(p.added, ["b"]);
  assert.deepEqual(p.tokens, ["a"], "the snapshot must win — first-seen wins");
});

test("planStableBetas: a removed beta is reported and NOT forwarded", () => {
  const p = planStableBetas(["a", "b"], ["a"]);
  assert.equal(p.action, "stabilized");
  assert.deepEqual(p.removed, ["b"]);
  assert.deepEqual(p.tokens, ["a", "b"]);
});

test("planStableBetas: add and remove in one turn compose", () => {
  const p = planStableBetas(["a", "b"], ["a", "c"]);
  assert.deepEqual([p.added, p.removed], [["c"], ["b"]]);
  assert.deepEqual(p.tokens, ["a", "b"]);
});

test("planStableBetas: an empty snapshot is treated as no snapshot", () => {
  assert.equal(planStableBetas([], ["a"]).action, "snapshot");
});

// --- betaSessionKey ---

const body = (messages, system = SYSTEM) => ({ messages, system, model: "test-model" });
const H = { "x-claude-code-session-id": SID };

test("betaSessionKey: no session header → null", () => {
  assert.equal(betaSessionKey({ "anthropic-beta": BASE }, body(CONV)), null);
});

test("betaSessionKey: separates CONVERSATIONS under one session id", () => {
  // The collision test/session-key-invariants.test.mjs exists for: every
  // subagent of a session runs the same agent prompt under the same session
  // id, so (session-id, system-prompt) put 39 conversations in one bucket for
  // insertion-normalization and deferred-tool-rewrite inherited it.
  const convB = [{ role: "user", content: [{ type: "text", text: "conversation B" }] }];
  assert.notEqual(betaSessionKey(H, body(CONV)), betaSessionKey(H, body(convB)));
});

test("betaSessionKey: separates SYSTEM PROMPTS (sidecar classes)", () => {
  const sidecar = [{ type: "text", text: "Generate a concise 5-word title." }];
  assert.notEqual(betaSessionKey(H, body(CONV)), betaSessionKey(H, body(CONV, sidecar)));
});

test("betaSessionKey: STABLE as the conversation grows", () => {
  // The other half of an identity: a key that moves every turn abandons the
  // snapshot every request instead of colliding, which fails just as quietly.
  const grown = [...CONV, { role: "assistant", content: [{ type: "text", text: "reply" }] }];
  assert.equal(betaSessionKey(H, body(CONV)), betaSessionKey(H, body(grown)));
});

test("onRequest: a subagent under the same session id gets its own snapshot", () => {
  // End-to-end consequence of the key: without the conversation sub-key the
  // subagent would inherit the parent's first-seen set and be sent a beta
  // header it never asked for.
  const parent = mkCtx({ beta: BASE });
  ext.onRequest(parent);
  const sub = mkCtx({
    beta: WITH_DIAG,
    messages: [{ role: "user", content: [{ type: "text", text: "subagent task" }] }],
  });
  ext.onRequest(sub);
  assert.equal(parent.headers["anthropic-beta"], BASE);
  assert.equal(sub.headers["anthropic-beta"], WITH_DIAG,
    "the subagent was handed the parent's beta set");
});

// --- onRequest: the wire behaviour ---

test("onRequest: THE DEFECT — four toggles produce one stable header", async () => {
  // Replays the measured visits-01 sequence through one session.
  const SEQUENCE = [BASE, WITH_DIAG, WITH_DIAG_REDACT, BASE, WITH_DIAG];

  // Control: the same sequence with the extension OFF is what reaches
  // Anthropic today. Three distinct header values for one conversation means
  // three cache keys, and each change re-charges cache_creation for the whole
  // prefix. Asserted rather than described, so the defect this fixes is
  // visible in the test and not only in the issue.
  const unstabilized = [];
  for (const beta of SEQUENCE) {
    const ctx = mkCtx({ beta, on: false });
    await ext.onRequest(ctx);
    unstabilized.push(ctx.headers["anthropic-beta"]);
  }
  assert.equal(new Set(unstabilized).size, 3, "premise check: the input really does oscillate");

  resetBetaSnapshots();
  const sent = [];
  for (const beta of SEQUENCE) {
    const ctx = mkCtx({ beta });
    await ext.onRequest(ctx);
    sent.push(ctx.headers["anthropic-beta"]);
  }
  assert.equal(new Set(sent).size, 1, `header still varied: ${JSON.stringify(sent)}`);
  assert.equal(sent[0], BASE, "the first-seen set is the one that should survive");
});

test("onRequest: the first turn normalizes separators and that value sticks", async () => {
  const ctx1 = mkCtx({ beta: "a,b,   c" });
  await ext.onRequest(ctx1);
  assert.equal(ctx1.headers["anthropic-beta"], "a, b, c");
  const ctx2 = mkCtx({ beta: "a,b,c" });
  await ext.onRequest(ctx2);
  assert.equal(ctx2.headers["anthropic-beta"], "a, b, c",
    "spacing drift alone must not change the wire bytes");
});

test("onRequest: sessions are independent", async () => {
  const a = mkCtx({ beta: BASE, sid: "sid-a" });
  await ext.onRequest(a);
  const b = mkCtx({ beta: WITH_DIAG, sid: "sid-b" });
  await ext.onRequest(b);
  assert.equal(a.headers["anthropic-beta"], BASE);
  assert.equal(b.headers["anthropic-beta"], WITH_DIAG,
    "sid-b took sid-a's snapshot — sessions must not share a tenant");
});

test("onRequest: off by default", async () => {
  const ctx = mkCtx({ beta: WITH_DIAG, on: false });
  const before = ctx.headers["anthropic-beta"];
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], before);
  assert.deepEqual(ctx.meta, {}, "a disabled extension must not annotate either");
});

test("onRequest: no session id → header untouched", async () => {
  // Sharing one snapshot across unrelated sessions would send a set the
  // caller never asked for — worse than not stabilizing at all.
  const ctx = mkCtx({ beta: WITH_DIAG, sid: null });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], WITH_DIAG);
  assert.equal(ctx.meta._betaStabilize, undefined);
});

test("onRequest: absent or empty beta header is left alone", async () => {
  for (const beta of [undefined, "", "  ,  "]) {
    const ctx = mkCtx({ beta: beta ?? "" });
    if (beta === undefined) delete ctx.headers["anthropic-beta"];
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._betaStabilize, undefined);
  }
});

test("onRequest: case-insensitive header key is rewritten in place", async () => {
  process.env.CACHE_FIX_BETA_STABILIZE = "1";
  const ctx = { headers: { "Anthropic-Beta": "a,b", "x-claude-code-session-id": SID }, meta: {}, body: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["Anthropic-Beta"], "a, b");
  assert.equal(ctx.headers["anthropic-beta"], undefined, "must not add a second casing");
});

test("onRequest: the delta is reported in ctx.meta, not forwarded", async () => {
  const first = mkCtx({ beta: BASE });
  await ext.onRequest(first);
  assert.equal(first.meta._betaStabilize.beta_stabilize_action, "snapshot");

  const second = mkCtx({ beta: WITH_DIAG });
  await ext.onRequest(second);
  assert.equal(second.meta._betaStabilize.beta_stabilize_action, "stabilized");
  assert.deepEqual(second.meta._betaStabilize.beta_stabilize_added, [
    "cache-diagnosis-2026-04-07",
  ]);
  assert.equal(second.headers["anthropic-beta"], BASE);
});

test("onRequest: the snapshot map is bounded", async () => {
  // A long-lived proxy sees many sessions; unbounded per-session state is a
  // slow leak rather than a bug you notice.
  process.env.CACHE_FIX_BETA_STABILIZE = "1";
  for (let i = 0; i < 600; i++) {
    await ext.onRequest(mkCtx({ beta: BASE, sid: `sid-${i}` }));
  }
  // The oldest entries are evicted, so an early session re-snapshots rather
  // than reading a neighbour's set.
  const old = mkCtx({ beta: WITH_DIAG, sid: "sid-0" });
  await ext.onRequest(old);
  assert.equal(old.meta._betaStabilize.beta_stabilize_action, "snapshot");
  assert.equal(old.headers["anthropic-beta"], WITH_DIAG);
});

test("registration: declares its own order so extensions.json needs no edit", () => {
  // loadExtensions resolves `cfg?.order ?? ext.order ?? 1000` and
  // `cfg?.enabled ?? ext.enabled ?? true`, so a module-declared order is the
  // default and the env gate is what keeps this inert until asked for.
  assert.equal(ext.name, "beta-stabilize");
  assert.equal(ext.order, 530, "must run after auto-1m-guard (520) — see the module header");
  assert.equal(typeof ext.onRequest, "function");
});
