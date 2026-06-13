import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ext, {
  classify,
  recoverExactCanonical,
  recoverFamilyFallback,
  __testOnly,
} from "../proxy/extensions/model-id-sanitize.mjs";

const ESC = "";
// Exact byte sequences from #68285 / #68279:
const FABLE_MALFORMED = `claude-fable-5${ESC}[1m`;
const OPUS_MALFORMED = `claude-opus-4-8${ESC}[1m${ESC}[22m`;
const BARE_FAMILY_ESCAPED = `opus${ESC}[1m`;

let origEnv;
let origStderr;
let capturedStderr = "";

beforeEach(() => {
  origEnv = process.env.CACHE_FIX_MODEL_ID_SANITIZE;
  delete process.env.CACHE_FIX_MODEL_ID_SANITIZE;
  ext.__resetForTests();
  capturedStderr = "";
  origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { capturedStderr += String(chunk); return true; };
});

afterEach(() => {
  process.stderr.write = origStderr;
  if (origEnv === undefined) delete process.env.CACHE_FIX_MODEL_ID_SANITIZE;
  else process.env.CACHE_FIX_MODEL_ID_SANITIZE = origEnv;
  ext.__resetForTests();
});

// --- Canonical regex (boundary cases) ---

test("regex: canonical wire IDs accepted", () => {
  const re = __testOnly.CANONICAL_MODEL_RE;
  for (const ok of [
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-sonnet-4-7",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-fable-5",
    "claude-mythos-2",
  ]) {
    assert.ok(re.test(ok), `expected accept: ${ok}`);
  }
});

test("regex: bare family / malformed shapes rejected", () => {
  const re = __testOnly.CANONICAL_MODEL_RE;
  for (const bad of [
    "opus",
    "claude-",
    "claude-opus",          // single segment; needs version
    "claude--oops",          // double-hyphen
    "Claude-Opus-4-7",       // uppercase
    "claude-opus-4-7[1m]",   // CC strips this before wire; treat as malformed
    "claude-opus-4-7[1m",
    "",
  ]) {
    assert.ok(!re.test(bad), `expected reject: ${bad}`);
  }
});

// --- recoverExactCanonical ---

test("recoverExactCanonical: extracts full canonical ID from #68285 byte sequence", () => {
  assert.equal(recoverExactCanonical(FABLE_MALFORMED), "claude-fable-5");
});

test("recoverExactCanonical: extracts full canonical from #68279 byte sequence", () => {
  assert.equal(recoverExactCanonical(OPUS_MALFORMED), "claude-opus-4-8");
});

test("recoverExactCanonical: returns longest match when multiple candidates", () => {
  // Pathological: a body where the malformed value somehow contains both
  // `claude-opus-4` and `claude-opus-4-7`. Longest wins.
  const val = `claude-opus-4 claude-opus-4-7${ESC}[1m`;
  assert.equal(recoverExactCanonical(val), "claude-opus-4-7");
});

test("recoverExactCanonical: returns null when no canonical substring present", () => {
  assert.equal(recoverExactCanonical(BARE_FAMILY_ESCAPED), null);
  assert.equal(recoverExactCanonical("random bytes blah"), null);
  assert.equal(recoverExactCanonical(""), null);
  assert.equal(recoverExactCanonical(null), null);
});

// --- recoverFamilyFallback ---

test("recoverFamilyFallback: single family-root substring → fallback target", () => {
  assert.equal(recoverFamilyFallback("opus" + ESC + "[1m"), "claude-opus-4-6");
  assert.equal(recoverFamilyFallback("sonnet stuff"), "claude-sonnet-4-6");
  assert.equal(recoverFamilyFallback("haiku random"), "claude-haiku-4-5-20251001");
  assert.equal(recoverFamilyFallback("fable suspended"), "claude-sonnet-4-6");
  assert.equal(recoverFamilyFallback("mythos suspended"), "claude-sonnet-4-6");
});

test("recoverFamilyFallback: multi-root → null (no-confidence)", () => {
  assert.equal(recoverFamilyFallback("opus and sonnet together"), null);
});

test("recoverFamilyFallback: no recognizable substring → null", () => {
  assert.equal(recoverFamilyFallback("zzzz qqqq"), null);
  assert.equal(recoverFamilyFallback(""), null);
});

// --- classify dispatcher ---

test("classify: mode=off → pass regardless of content", () => {
  assert.deepEqual(classify({ rawModel: FABLE_MALFORMED, mode: "off", isStream: false }), { decision: "pass" });
});

test("classify: clean canonical ID → pass in all modes", () => {
  for (const mode of ["warn", "strip", "block"]) {
    assert.deepEqual(classify({ rawModel: "claude-opus-4-7", mode, isStream: false }), { decision: "pass" });
  }
});

test("classify: warn mode + malformed → decision=warn, original preserved, no rewrite", () => {
  const r = classify({ rawModel: FABLE_MALFORMED, mode: "warn", isStream: false });
  assert.equal(r.decision, "warn");
  assert.equal(r.original, FABLE_MALFORMED);
  assert.equal(r.rewritten, undefined);
});

test("classify: strip mode + #68285 byte sequence → exact-canonical recovery to claude-fable-5", () => {
  const r = classify({ rawModel: FABLE_MALFORMED, mode: "strip", isStream: false });
  assert.equal(r.decision, "strip");
  assert.equal(r.rewritten, "claude-fable-5");
  assert.equal(r.recovery, "exact-canonical");
});

test("classify: strip mode + #68279 byte sequence → exact-canonical recovery to claude-opus-4-8", () => {
  const r = classify({ rawModel: OPUS_MALFORMED, mode: "strip", isStream: false });
  assert.equal(r.decision, "strip");
  assert.equal(r.rewritten, "claude-opus-4-8");
  assert.equal(r.recovery, "exact-canonical");
});

test("classify: strip mode + recoverable-but-no-canonical → family-fallback", () => {
  const r = classify({ rawModel: BARE_FAMILY_ESCAPED, mode: "strip", isStream: false });
  assert.equal(r.decision, "strip");
  assert.equal(r.rewritten, "claude-opus-4-6");
  assert.equal(r.recovery, "family-fallback");
});

test("classify: strip mode + multi-root no-confidence → block fallthrough", () => {
  const r = classify({ rawModel: "opus and sonnet" + ESC + "[1m", mode: "strip", isStream: false });
  assert.equal(r.decision, "block");
  assert.equal(r.recovery, "no-confidence-blocked");
});

test("classify: strip mode + unrecoverable → block fallthrough", () => {
  const r = classify({ rawModel: "qqqqzzzz" + ESC + "[1m", mode: "strip", isStream: false });
  assert.equal(r.decision, "block");
  assert.equal(r.recovery, "no-confidence-blocked");
});

test("classify: strip mode + fable family-fallback → claude-sonnet-4-6 (suspended)", () => {
  const r = classify({ rawModel: "fable" + ESC + "[1m", mode: "strip", isStream: false });
  assert.equal(r.decision, "strip");
  assert.equal(r.rewritten, "claude-sonnet-4-6");
  assert.equal(r.recovery, "family-fallback");
});

test("classify: block mode + any malformed → block", () => {
  const r = classify({ rawModel: FABLE_MALFORMED, mode: "block", isStream: false });
  assert.equal(r.decision, "block");
});

test("classify: block mode + clean input → pass", () => {
  const r = classify({ rawModel: "claude-opus-4-7", mode: "block", isStream: false });
  assert.equal(r.decision, "pass");
});

// --- onRequest integration: warn mode ---

test("integration: warn mode + #68285 sequence → stderr log + meta stash + body unchanged", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-1" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
  assert.equal(ctx.body.model, FABLE_MALFORMED, "warn mode must NOT mutate body");
  assert.equal(ctx.meta._modelIdSanitize.malformed, true);
  assert.equal(ctx.meta._modelIdSanitize.mode, "warn");
  assert.match(capturedStderr, /\[model-id-sanitize\] malformed model_id detected:/);
  assert.match(capturedStderr, /mode=warn/);
});

test("integration: clean canonical model + warn mode → no stash, no log", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-2" },
    body: { model: "claude-opus-4-7", stream: false },
    meta: {},
  };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._modelIdSanitize, undefined);
  assert.equal(capturedStderr, "");
});

// --- onRequest integration: strip mode ---

test("integration: strip mode rewrites body.model and stashes original", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "strip";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-3" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctx);
  assert.equal(ctx.body.model, "claude-fable-5");
  assert.equal(ctx.meta._modelIdSanitize.original, FABLE_MALFORMED);
  assert.equal(ctx.meta._modelIdSanitize.rewritten, "claude-fable-5");
  assert.equal(ctx.meta._modelIdSanitize.recovery, "exact-canonical");
  assert.equal(ctx.meta._modelIdSanitize.spread.model_id_corrections_count, 1);
});

test("integration: strip mode + family-fallback rewrites to oldest-in-family", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "strip";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-4" },
    body: { model: BARE_FAMILY_ESCAPED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctx);
  assert.equal(ctx.body.model, "claude-opus-4-6");
  assert.equal(ctx.meta._modelIdSanitize.recovery, "family-fallback");
});

test("integration: strip mode + no-confidence → block synthetic 400 returned", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "strip";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-5" },
    body: { model: "opus and sonnet" + ESC + "[1m", stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res.skip, true);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.type, "model_not_found");
});

test("integration: strip mode + corrections_count increments per request", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "strip";
  for (let i = 0; i < 3; i++) {
    const ctx = {
      headers: { "x-claude-code-session-id": "sess-counter" },
      body: { model: FABLE_MALFORMED, stream: false },
      meta: {},
    };
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._modelIdSanitize.spread.model_id_corrections_count, i + 1);
  }
});

// --- onRequest integration: block mode ---

test("integration: block mode + clean input → no short-circuit", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "block";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-b1" },
    body: { model: "claude-opus-4-7", stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
  assert.equal(ctx.meta._modelIdSanitize, undefined);
});

test("integration: block mode + malformed (stream:false) → JSON envelope 400", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "block";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-b2" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res.skip, true);
  assert.equal(res.status, 400);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.body.error.type, "model_not_found");
  assert.match(res.body.error.message, /\\x66\\x61\\x62\\x6c\\x65/); // fable hex-escaped
  assert.match(res.body.error.message, /#68285/);
  assert.match(res.body.error.message, /#68279/);
});

test("integration: block mode + malformed (stream:true) → SSE error frame", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "block";
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-b3" },
    body: { model: FABLE_MALFORMED, stream: true },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res.skip, true);
  assert.equal(res.status, 400);
  assert.equal(res.headers["content-type"], "text/event-stream");
  // SSE shape: `event: error\ndata: <json>\n\n`
  assert.match(res.body, /^event: error\ndata: /);
  assert.match(res.body, /model_not_found/);
});

// --- Mode = off (default) ---

test("integration: env unset → off; malformed body forwarded unchanged, no stash, no log", async () => {
  // CACHE_FIX_MODEL_ID_SANITIZE intentionally NOT set
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-off" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
  assert.equal(ctx.body.model, FABLE_MALFORMED, "off mode must NOT mutate");
  assert.equal(ctx.meta._modelIdSanitize, undefined);
  assert.equal(capturedStderr, "");
});

test("integration: unknown mode → falls back to off with one-time stderr warning", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "weirdvalue";
  const ctx1 = {
    headers: { "x-claude-code-session-id": "sess-unk-1" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctx1);
  assert.equal(ctx1.meta._modelIdSanitize, undefined);
  assert.match(capturedStderr, /unknown CACHE_FIX_MODEL_ID_SANITIZE=/);
  const afterFirst = capturedStderr;

  // Second request — no new warning (one-time)
  const ctx2 = {
    headers: { "x-claude-code-session-id": "sess-unk-2" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctx2);
  assert.equal(capturedStderr, afterFirst, "unknown mode warning must be one-time");
});

// --- Hex-escape format ---

test("hex-escape: never raw control bytes — matches \\x?? format", () => {
  const e = __testOnly.hexEscape;
  const value = `claude-fable-5${ESC}[1m`;
  const hex = e(value);
  assert.doesNotMatch(hex, new RegExp(ESC), "hex output must contain no raw control bytes");
  // 0x1b → \x1b, 0x5b → \x5b ([), 0x31 → \x31 (1), 0x6d → \x6d (m)
  assert.match(hex, /\\x1b\\x5b\\x31\\x6d/);
});

test("hex-escape: empty / non-string input safe", () => {
  const e = __testOnly.hexEscape;
  assert.equal(e(""), "");
  assert.equal(e(null), "");
  assert.equal(e(undefined), "");
});

test("hex-escape: multi-byte UTF-8 → byte-wise output, NOT one giant code-point escape (Codex r1 B1)", () => {
  // The 😀 grinning-face code point U+1F600 is 4 UTF-8 bytes:
  // 0xf0 0x9f 0x98 0x80. The byte-wise rule must emit four separate
  // \xf0\x9f\x98\x80 escapes, not a single \x1f600.
  const e = __testOnly.hexEscape;
  assert.equal(e("😀"), "\\xf0\\x9f\\x98\\x80");
  // The é (U+00E9) is 2 bytes 0xc3 0xa9.
  assert.equal(e("é"), "\\xc3\\xa9");
  // ASCII stays one-byte-per-char.
  assert.equal(e("a"), "\\x61");
});

// --- Session persistence (Codex r1 B2) ---

test("session persistence: malformed turn then clean turn → clean turn still carries model_id_* spread", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";

  // Turn 1: malformed
  const ctx1 = {
    headers: { "x-claude-code-session-id": "sess-persist" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctx1);
  assert.equal(ctx1.meta._modelIdSanitize.spread.model_id_malformed, true);
  const firstSeen = ctx1.meta._modelIdSanitize.spread.model_id_malformed_first_seen;

  // Turn 2: clean — still must carry the session-level summary so
  // cache-telemetry's per-session JSON re-emits it.
  const ctx2 = {
    headers: { "x-claude-code-session-id": "sess-persist" },
    body: { model: "claude-opus-4-7", stream: false },
    meta: {},
  };
  await ext.onRequest(ctx2);
  assert.ok(ctx2.meta._modelIdSanitize, "clean turn after malformed must still attach session summary");
  assert.equal(ctx2.meta._modelIdSanitize.malformed, false);
  assert.equal(ctx2.meta._modelIdSanitize.spread.model_id_malformed, true);
  assert.equal(ctx2.meta._modelIdSanitize.spread.model_id_malformed_first_seen, firstSeen);
});

test("session persistence: distinct sessions don't bleed state", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";

  const ctxA = {
    headers: { "x-claude-code-session-id": "sess-A" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctxA);

  const ctxB = {
    headers: { "x-claude-code-session-id": "sess-B" },
    body: { model: "claude-opus-4-7", stream: false },
    meta: {},
  };
  await ext.onRequest(ctxB);
  assert.equal(ctxB.meta._modelIdSanitize, undefined, "sess-B's clean turn must NOT inherit sess-A's summary");
});

// --- Synthetic-throw failure isolation (Codex r1 attention) ---

test("failure isolation: synthetic exception inside onRequest → no throw, stderr line emitted, request unchanged", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";
  // Force a throw via a body whose .model is a getter that throws.
  const ctx = {
    headers: { "x-claude-code-session-id": "sess-throw" },
    body: Object.defineProperty({ stream: false }, "model", {
      get() { throw new Error("synthetic detector failure"); },
      configurable: true,
    }),
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
  assert.match(capturedStderr, /\[model-id-sanitize\] detector error: synthetic detector failure/);
});

// --- Failure isolation ---

test("failure isolation: malformed ctx (no body) → onRequest returns undefined, no throw", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";
  const ctx = { headers: {}, body: null, meta: {} };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
});

test("failure isolation: hostile body shape (model is a number) → no throw, no mutation", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "strip";
  const ctx = {
    headers: {},
    body: { model: 12345, stream: false },
    meta: {},
  };
  const res = await ext.onRequest(ctx);
  assert.equal(res, undefined);
  assert.equal(ctx.body.model, 12345);
});

// --- First-seen latching ---

test("first-seen: timestamp set on first malformed observation per session, stable on subsequent", async () => {
  process.env.CACHE_FIX_MODEL_ID_SANITIZE = "warn";
  const ctxA = {
    headers: { "x-claude-code-session-id": "sess-first-seen" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctxA);
  const firstSeen1 = ctxA.meta._modelIdSanitize.spread.model_id_malformed_first_seen;
  assert.match(firstSeen1, /^\d{4}-\d{2}-\d{2}T/);

  // small delay so a re-stamp would differ
  await new Promise((r) => setTimeout(r, 10));

  const ctxB = {
    headers: { "x-claude-code-session-id": "sess-first-seen" },
    body: { model: FABLE_MALFORMED, stream: false },
    meta: {},
  };
  await ext.onRequest(ctxB);
  const firstSeen2 = ctxB.meta._modelIdSanitize.spread.model_id_malformed_first_seen;
  assert.equal(firstSeen2, firstSeen1, "first-seen must latch and stay stable");
});

// --- extensions.json registration ---

test("extensions.json: registered at order 50 with enabled=true", async () => {
  const fs = await import("node:fs");
  const cfg = JSON.parse(fs.readFileSync(new URL("../proxy/extensions.json", import.meta.url), "utf8"));
  const entry = cfg["model-id-sanitize"];
  assert.ok(entry);
  assert.equal(entry.enabled, true);
  assert.equal(entry.order, 50);
});

// --- Extension contract ---

test("contract: name + order + onRequest function", () => {
  assert.equal(ext.name, "model-id-sanitize");
  assert.equal(ext.order, 50);
  assert.equal(typeof ext.onRequest, "function");
});
