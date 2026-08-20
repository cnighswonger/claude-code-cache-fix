import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ext, {
  ALWAYS_PASSTHROUGH,
  betaEventsPath,
  betaSessionKey,
  isStabilizablePath,
  planStableBetas,
  resetBetaSnapshots,
} from "../proxy/extensions/anthropic-beta-stabilize.mjs";

// The token deferred-tool-rewrite adds on any turn it injects a tool_addition
// block. Written out rather than read from ALWAYS_PASSTHROUGH so a regression
// that empties the whitelist cannot also empty the test's expectation.
const DTR_BETA = "mid-conversation-tool-changes-2026-07-01";

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

// Captures the durable event rows instead of writing them. Tests that write
// to the real snapshots dir leave residue in the operator's ~/.claude — the
// same pollution class the persistent-stats isolation fixture exists to stop.
function mkFs(sink) {
  return {
    mkdir: async () => {},
    appendFile: async (file, line) => {
      sink.push({ file, row: JSON.parse(line) });
    },
  };
}

function mkCtx({
  beta = BASE, sid = SID, on = true, messages = CONV, system = SYSTEM,
  path = "/v1/messages", events = [],
} = {}) {
  if (on) process.env.CACHE_FIX_BETA_STABILIZE = "1";
  else delete process.env.CACHE_FIX_BETA_STABILIZE;
  const headers = { "anthropic-beta": beta };
  if (sid) headers["x-claude-code-session-id"] = sid;
  return {
    headers,
    meta: path === undefined ? {} : { path },
    body: { messages, system, model: "test-model" },
    __fs: mkFs(events),
    __events: events,
  };
}

// --- planStableBetas: the decision, in isolation ---

test("planStableBetas: first sight adopts what CC sent", () => {
  const p = planStableBetas(null, ["a", "b"]);
  assert.deepEqual(p, {
    tokens: ["a", "b"], action: "snapshot", added: [], removed: [], passthrough: [],
  });
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
  assert.equal(ctx.meta._betaStabilize, undefined,
    "a disabled extension must not annotate either");
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
  // __fs too: this is the one ctx not built by mkCtx, and without the seam
  // the append falls through to DEFAULT_FS and writes into the real
  // ~/.claude/cache-fix-snapshots. Found exactly that way — a stray
  // `…-nosys-empty-anthropic-beta-events.jsonl` in a live home directory.
  const ctx = {
    headers: { "Anthropic-Beta": "a,b", "x-claude-code-session-id": SID },
    meta: { path: "/v1/messages" }, body: {}, __fs: mkFs([]),
  };
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

test("registration: module declares its own order, and the registry agrees", () => {
  // loadExtensions resolves `cfg?.order ?? ext.order ?? 1000` and
  // `cfg?.enabled ?? ext.enabled ?? true`, so the module declaration stands
  // alone and the env gate is what keeps this inert until asked for.
  assert.equal(ext.name, "anthropic-beta-stabilize");
  assert.equal(ext.order, 530, "must run after auto-1m-guard (520) — see the module header");
  assert.equal(typeof ext.onRequest, "function");
});

test("registration: the extensions.json key matches the module name", async () => {
  // The lookup is BY NAME. A key that drifts from ext.name does not error —
  // cfg simply resolves undefined, the entry silently stops applying, and the
  // module defaults take over as if the registration were never made. That is
  // exactly what a rename does if only one side moves.
  const registry = JSON.parse(
    await readFile(new URL("../proxy/extensions.json", import.meta.url), "utf-8"),
  );
  assert.ok(registry[ext.name], `no extensions.json entry named ${ext.name}`);
  assert.equal(registry[ext.name].order, ext.order,
    "a registry order that disagrees with the module silently wins");
});

// --- The always-passthrough whitelist (directive Q1, R0 refinement) --------
//
// deferred-tool-rewrite (order 425) adds mid-conversation-tool-changes on ANY
// turn it injects a tool_addition block, turn N > 1 included. A strict pin
// strips it, Anthropic then ignores the addition for want of the beta, and
// DTR is silently defeated — no error on either side. The whitelist is why
// this ships as strict-pin-plus-exception rather than strict-pin.

test("whitelist: the DTR contract token is FORWARDED on a post-snapshot turn", () => {
  const p = planStableBetas(["a", "b"], ["a", "b", DTR_BETA]);
  assert.ok(p.tokens.includes(DTR_BETA),
    "stripping this token defeats deferred-tool-rewrite with no error surface");
});

test("whitelist: a forwarded token is accounted as passthrough, not as drift", () => {
  const p = planStableBetas(["a"], ["a", DTR_BETA]);
  assert.deepEqual(p.passthrough, [DTR_BETA]);
  assert.deepEqual(p.added, [],
    "counting it as `added` reports DTR's deliberate act as client drift");
  assert.equal(p.action, "passthrough",
    "and it is not a stabilization — nothing was withheld");
});

test("whitelist: passthrough does not soften the pin on anything else", () => {
  const p = planStableBetas(["a"], ["a", DTR_BETA, "unrelated-beta"]);
  assert.deepEqual(p.added, ["unrelated-beta"]);
  assert.deepEqual(p.passthrough, [DTR_BETA]);
  assert.equal(p.action, "stabilized");
  assert.ok(p.tokens.includes(DTR_BETA));
  assert.ok(!p.tokens.includes("unrelated-beta"),
    "the non-whitelisted add is still withheld");
});

test("whitelist: a snapshot that already holds the token reports no passthrough", () => {
  const p = planStableBetas(["a", DTR_BETA], ["a", DTR_BETA]);
  assert.equal(p.action, "stable");
  assert.deepEqual(p.passthrough, []);
});

test("whitelist: it is exactly one token, and that token is DTR's", () => {
  assert.deepEqual([...ALWAYS_PASSTHROUGH], [DTR_BETA],
    "widening this list widens what a client can force past the pin");
});

test("whitelist: the forwarded token reaches the WIRE header", async () => {
  const events = [];
  await ext.onRequest(mkCtx({ beta: "a, b", events }));
  const ctx = mkCtx({ beta: `a, b, ${DTR_BETA}`, events });
  await ext.onRequest(ctx);
  assert.ok(ctx.headers["anthropic-beta"].includes(DTR_BETA),
    "the planner forwarding it is worth nothing if onRequest drops it");
});

// --- Endpoint guard (directive Q3, settled across R0 -> R2) ---------------
//
// server.mjs sends every POST /v1/messages* to handleMessages, and the
// pipeline's route filter cannot see subpaths. Without a path check a
// count_tokens probe snapshots under the same tenant key the real turn uses.

// Proof-of-run is the SPACING canonicalization ("a,b" -> "a, b"), not a
// reorder: joinBetaTokens preserves token order by design, so a sorted
// expectation would pass on a pass that never ran.
test("path guard: exact /v1/messages runs", async () => {
  const ctx = mkCtx({ beta: "a,b" });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "a, b", "canonicalized, so it ran");
  assert.equal(ctx.meta._betaStabilize.beta_stabilize_action, "snapshot");
});

test("path guard: a query string does not stop it", async () => {
  const ctx = mkCtx({ beta: "a,b", path: "/v1/messages?beta=true" });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "a, b");
});

test("path guard: /v1/messages/count_tokens is a no-op", async () => {
  const ctx = mkCtx({ beta: "b, a", path: "/v1/messages/count_tokens" });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "b, a", "header untouched");
  assert.equal(ctx.meta._betaStabilize, undefined);
});

test("path guard: /v1/messages/batches is a no-op", async () => {
  const ctx = mkCtx({ beta: "b, a", path: "/v1/messages/batches" });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "b, a");
});

test("path guard: a missing path no-ops rather than guessing", async () => {
  // Fail-safe. An older server, or a call site that forgets baseMeta, must not
  // silently regain the unguarded behaviour.
  const ctx = mkCtx({ beta: "b, a", path: undefined });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "b, a");
});

test("path guard: THE DEFECT — a count_tokens probe cannot seed the snapshot", async () => {
  const events = [];
  // Probe first, carrying a set the real turn does not have.
  await ext.onRequest(mkCtx({
    beta: "a, probe-only-beta", path: "/v1/messages/count_tokens", events,
  }));
  const real = mkCtx({ beta: "a, b", events });
  await ext.onRequest(real);
  assert.equal(real.headers["anthropic-beta"], "a, b",
    "the real turn must snapshot ITSELF, not be stabilized against a probe");
  assert.equal(real.meta._betaStabilize.beta_stabilize_action, "snapshot");
});

test("path guard: isStabilizablePath rejects everything but the one endpoint", () => {
  for (const good of ["/v1/messages", "/v1/messages?x=1", "/v1/messages#frag"]) {
    assert.equal(isStabilizablePath(good), true, good);
  }
  for (const bad of [
    "/v1/messages/count_tokens", "/v1/messages/batches", "/v1/messages/",
    "/v1/complete", "", null, undefined, 42, {},
  ]) {
    assert.equal(isStabilizablePath(bad), false, String(bad));
  }
});

// --- Durable telemetry (directive R1, Codex-required) ---------------------

test("events: a row is written per turn, in DTR's shape", async () => {
  const events = [];
  const ctx = mkCtx({ beta: "a, b", events });
  await ext.onRequest(ctx);
  assert.equal(events.length, 1);
  const { row } = events[0];
  assert.deepEqual(Object.keys(row).sort(),
    ["action", "adds", "key", "passthrough", "pinned", "removes", "sid", "ts"]);
  assert.equal(row.action, "snapshot");
  assert.equal(row.sid, SID);
  assert.deepEqual(row.pinned, ["a", "b"]);
});

test("events: a stabilized turn records what was withheld", async () => {
  const events = [];
  await ext.onRequest(mkCtx({ beta: "a", events }));
  await ext.onRequest(mkCtx({ beta: "a, c", events }));
  const { row } = events.at(-1);
  assert.equal(row.action, "stabilized");
  assert.deepEqual(row.adds, ["c"]);
  assert.deepEqual(row.pinned, ["a"],
    "the record must show what we SENT, not what CC asked for");
});

test("events: a passthrough turn is distinguishable from a stabilized one", async () => {
  const events = [];
  await ext.onRequest(mkCtx({ beta: "a", events }));
  await ext.onRequest(mkCtx({ beta: `a, ${DTR_BETA}`, events }));
  const { row } = events.at(-1);
  assert.equal(row.action, "passthrough");
  assert.deepEqual(row.passthrough, [DTR_BETA]);
  assert.deepEqual(row.adds, []);
});

test("events: the file is per session key, beside DTR's own log", async () => {
  const events = [];
  const ctx = mkCtx({ beta: "a", events });
  await ext.onRequest(ctx);
  const key = betaSessionKey(ctx.headers, ctx.body);
  assert.ok(events[0].file.endsWith(`${key}-anthropic-beta-events.jsonl`));
});

test("events: no row when the pass no-ops on endpoint", async () => {
  const events = [];
  await ext.onRequest(mkCtx({
    beta: "a", path: "/v1/messages/count_tokens", events,
  }));
  assert.equal(events.length, 0,
    "a probe must leave no trace in the session's record");
});

test("events: a telemetry failure cannot fail the request", async () => {
  const ctx = mkCtx({ beta: "a,b" });
  ctx.__fs = {
    mkdir: async () => { throw new Error("disk full"); },
    appendFile: async () => { throw new Error("disk full"); },
  };
  await ext.onRequest(ctx);   // must not throw
  assert.equal(ctx.headers["anthropic-beta"], "a, b",
    "the header decision still lands");
});

test("hygiene: no test may write into the operator's real snapshots dir", async () => {
  // The guard for the hole above. Any ctx reaching onRequest without __fs
  // appends to claudeHome()/cache-fix-snapshots for real, and a test suite
  // that litters a live home directory is the defect this seam exists to
  // prevent — not a cosmetic one: those rows are indistinguishable from
  // production telemetry when an operator later reads them.
  const seen = [];
  const ctx = mkCtx({ beta: "a,b", events: seen });
  await ext.onRequest(ctx);
  assert.equal(seen.length, 1, "the injected fs must be the one that ran");
  assert.ok(seen[0].file.includes("cache-fix-snapshots"),
    "and it must still be aimed at the right directory shape");
});
