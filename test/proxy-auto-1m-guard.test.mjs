import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ext, {
  __resetAdvisedForTests,
  findBetaHeader,
  parseBetaTokens,
  planSanitizeBetaHeader,
  joinBetaTokens,
} from "../proxy/extensions/auto-1m-guard.mjs";

const ONEM = "context-1m-2025-08-07";
const STD_BETAS_WITH_1M =
  "claude-code-20250219, oauth_auth, interleaved-thinking-2025-05-14, context-1m-2025-08-07, context-management-2025-06-27";
const STD_BETAS_NO_1M =
  "claude-code-20250219, oauth_auth, interleaved-thinking-2025-05-14, context-management-2025-06-27";

let origEnv;
beforeEach(() => {
  origEnv = process.env.CACHE_FIX_AUTO_1M_GUARD;
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.CACHE_FIX_AUTO_1M_GUARD;
  else process.env.CACHE_FIX_AUTO_1M_GUARD = origEnv;
});

function mkCtx({ headers = {}, mode } = {}) {
  if (mode !== undefined) process.env.CACHE_FIX_AUTO_1M_GUARD = mode;
  else delete process.env.CACHE_FIX_AUTO_1M_GUARD;
  return { headers: { ...headers }, meta: {}, body: {} };
}

// --- findBetaHeader: case-insensitive lookup ---

test("findBetaHeader: case-insensitive lookup returns the actual key+value present", () => {
  assert.deepEqual(findBetaHeader({ "anthropic-beta": "a,b" }), { key: "anthropic-beta", raw: "a,b" });
  assert.deepEqual(findBetaHeader({ "Anthropic-Beta": "a" }), { key: "Anthropic-Beta", raw: "a" });
  assert.deepEqual(findBetaHeader({ "ANTHROPIC-BETA": "x" }), { key: "ANTHROPIC-BETA", raw: "x" });
});

test("findBetaHeader: absent header → null", () => {
  assert.equal(findBetaHeader({}), null);
  assert.equal(findBetaHeader({ "x-other": "v" }), null);
  assert.equal(findBetaHeader(null), null);
});

// --- parseBetaTokens ---

test("parseBetaTokens: comma-separated string, trim whitespace, drop empties", () => {
  assert.deepEqual(parseBetaTokens("a, b,c ,, d"), ["a", "b", "c", "d"]);
});

test("parseBetaTokens: array input passes through trimmed", () => {
  assert.deepEqual(parseBetaTokens([" a ", "b", ""]), ["a", "b"]);
});

test("parseBetaTokens: nullish input → []", () => {
  assert.deepEqual(parseBetaTokens(undefined), []);
  assert.deepEqual(parseBetaTokens(null), []);
  assert.deepEqual(parseBetaTokens(""), []);
});

// --- planSanitizeBetaHeader: pure planner ---

test("planSanitize: detect-only when token present in warn mode", () => {
  const r = planSanitizeBetaHeader(["a", ONEM, "b"], "warn");
  assert.equal(r.detected, true);
  assert.equal(r.stripped, false);
  assert.deepEqual(r.tokensAfter, ["a", ONEM, "b"]);
});

test("planSanitize: strip mode removes token and preserves order of remaining", () => {
  const r = planSanitizeBetaHeader(["a", ONEM, "b"], "strip");
  assert.equal(r.detected, true);
  assert.equal(r.stripped, true);
  assert.deepEqual(r.tokensAfter, ["a", "b"]);
});

test("planSanitize: token absent → detected false, no change", () => {
  const r = planSanitizeBetaHeader(["a", "b"], "strip");
  assert.equal(r.detected, false);
  assert.equal(r.stripped, false);
  assert.deepEqual(r.tokensAfter, ["a", "b"]);
});

test("planSanitize: duplicate tokens all removed in strip mode (defensive)", () => {
  const r = planSanitizeBetaHeader(["a", ONEM, "b", ONEM, "c"], "strip");
  assert.equal(r.stripped, true);
  assert.deepEqual(r.tokensAfter, ["a", "b", "c"]);
});

test("planSanitize: single-element [ONEM] → tokensAfter is empty (header becomes empty string)", () => {
  const r = planSanitizeBetaHeader([ONEM], "strip");
  assert.equal(r.stripped, true);
  assert.deepEqual(r.tokensAfter, []);
});

test("planSanitize: substring `context-1m-` in a different token is NOT a false positive", () => {
  // exact-token check, not substring — defensive against future token shapes
  const r = planSanitizeBetaHeader(["a", "context-1m-anything-else", "b"], "strip");
  assert.equal(r.detected, false);
  assert.equal(r.stripped, false);
});

// --- joinBetaTokens ---

test("joinBetaTokens: canonical `, ` separator", () => {
  assert.equal(joinBetaTokens(["a", "b", "c"]), "a, b, c");
});

test("joinBetaTokens: empty array → empty string", () => {
  assert.equal(joinBetaTokens([]), "");
});

// --- extension: integration via onRequest ---

test("onRequest: mode=off — no annotation, no mutation, even with token present", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_WITH_1M }, mode: "off" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard, undefined);
  assert.equal(ctx.headers["anthropic-beta"], STD_BETAS_WITH_1M);
});

test("onRequest: mode=warn (default by absent env) — token present → annotation, no mutation", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_WITH_1M } }); // no mode → defaults to warn
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_detected, true);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_action, "warn");
  assert.match(ctx.meta._auto1mGuard.auto_1m_advice, /context-1m-2025-08-07/);
  assert.equal(ctx.headers["anthropic-beta"], STD_BETAS_WITH_1M); // unchanged
});

test("onRequest: mode=warn — token absent → no annotation, no mutation", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_NO_1M }, mode: "warn" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard, undefined);
  assert.equal(ctx.headers["anthropic-beta"], STD_BETAS_NO_1M);
});

test("onRequest: mode=strip — token present → annotation + header rewritten with `, ` separator", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_WITH_1M }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_detected, true);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_action, "stripped");
  assert.equal(ctx.headers["anthropic-beta"], STD_BETAS_NO_1M);
});

test("onRequest: mode=strip — token absent → no annotation, no mutation", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_NO_1M }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard, undefined);
  assert.equal(ctx.headers["anthropic-beta"], STD_BETAS_NO_1M);
});

test("onRequest: mode=strip — single-element header becomes empty string (not deleted)", async () => {
  const ctx = mkCtx({ headers: { "anthropic-beta": ONEM }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.headers["anthropic-beta"], "");
  assert.equal("anthropic-beta" in ctx.headers, true); // not deleted
});

test("onRequest: no anthropic-beta header at all — no annotation, no error", async () => {
  const ctx = mkCtx({ headers: {}, mode: "warn" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard, undefined);
});

test("onRequest: token with surrounding whitespace in raw header — detected and stripped", async () => {
  const headerWithWhitespace = `claude-code-20250219,  ${ONEM}  ,oauth_auth`;
  const ctx = mkCtx({ headers: { "anthropic-beta": headerWithWhitespace }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_action, "stripped");
  assert.equal(ctx.headers["anthropic-beta"], "claude-code-20250219, oauth_auth");
});

test("onRequest: case-insensitive header lookup (Anthropic-Beta capitalized)", async () => {
  const ctx = mkCtx({ headers: { "Anthropic-Beta": STD_BETAS_WITH_1M }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_action, "stripped");
  // header rewritten on the SAME (original-case) key
  assert.equal(ctx.headers["Anthropic-Beta"], STD_BETAS_NO_1M);
});

test("onRequest: duplicate `context-1m-2025-08-07` tokens (defensive) — all removed in strip mode", async () => {
  const dup = `claude-code-20250219, ${ONEM}, oauth_auth, ${ONEM}, interleaved-thinking-2025-05-14`;
  const ctx = mkCtx({ headers: { "anthropic-beta": dup }, mode: "strip" });
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._auto1mGuard.auto_1m_action, "stripped");
  assert.equal(
    ctx.headers["anthropic-beta"],
    "claude-code-20250219, oauth_auth, interleaved-thinking-2025-05-14",
  );
});

// --- the advisory is advice, not a per-request fact ---

// The advisory sampler, shared by the two cases below. Forwards what it is not
// sampling, so it cannot swallow an unrelated line. Resets the latch on both
// sides -- a spent one makes a case appended later count 0 and read green for
// the wrong reason.
async function sampleAdvisories(fn) {
  __resetAdvisedForTests();
  const seen = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => {
    if (!String(s).includes("[auto-1m-guard]")) return orig.call(process.stderr, s);
    seen.push(String(s));
    return true;
  };
  try { await fn(); } finally { process.stderr.write = orig; __resetAdvisedForTests(); }
  return seen;
}

test("onRequest: the advisory is written once, but every request is still annotated", async () => {
  const seen = await sampleAdvisories(async () => {
    for (let i = 0; i < 5; i++) {
      const ctx = mkCtx({ headers: { "anthropic-beta": STD_BETAS_WITH_1M }, mode: "warn" });
      await ext.onRequest(ctx);
      // The latch sits below the annotation, which every request's session JSON needs.
      assert.equal(ctx.meta._auto1mGuard?.auto_1m_detected, true, `request ${i} lost its annotation`);
    }
  });
  assert.equal(seen.length, 1, `advisory written ${seen.length}x for 5 requests`);
});

test("onRequest: the advisory latch spans the process, not one module instance", async () => {
  // loadExtensions cache-busts every import (pipeline.mjs), so this module is
  // re-evaluated inside ONE process on every reload -- and a module-scoped latch
  // re-arms there, returning the advisory this exists to silence.
  const href = new URL("../proxy/extensions/auto-1m-guard.mjs", import.meta.url).href;
  const a = await import(`${href}?latch=a`);
  const b = await import(`${href}?latch=b`);
  assert.notEqual(a.default, b.default,
    "premise: both imports resolved to the same module, so this case proves nothing");

  const seen = await sampleAdvisories(async () => {
    for (const m of [a, b]) {
      await m.default.onRequest(mkCtx({ headers: { "anthropic-beta": STD_BETAS_WITH_1M } }));
    }
  });
  assert.equal(seen.length, 1,
    `two module instances in one process wrote ${seen.length} advisories`);
});
