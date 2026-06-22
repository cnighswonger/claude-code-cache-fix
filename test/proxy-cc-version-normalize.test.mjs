// Tests for proxy/extensions/cc-version-normalize.mjs (issue #238).
// Covers env-mode parsing, the rewrite function, the full onRequest hook
// against realistic billing-header system blocks, ordering interplay with
// fingerprint-strip, and fail-open behavior.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import ext, {
  parseMode,
  rewriteCcVersion,
  __resetFirstFireForTests,
} from "../proxy/extensions/cc-version-normalize.mjs";
import fingerprintExt from "../proxy/extensions/fingerprint-strip.mjs";

const ENV = "CACHE_FIX_NORMALIZE_CC_VERSION";

function billingBlock(version) {
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${version}; other=stuff`,
  };
}

function bodyWith(version, opts = {}) {
  const system = [billingBlock(version)];
  if (opts.extraSystem) system.push(...opts.extraSystem);
  return {
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }],
  };
}

function ctxFor(body) { return { body, headers: {}, meta: {} }; }

beforeEach(() => {
  delete process.env[ENV];
  __resetFirstFireForTests();
});

// --- parseMode ---

test("parseMode: undefined → off", () => {
  assert.deepEqual(parseMode(undefined), { mode: "off" });
});
test("parseMode: empty string → off", () => {
  assert.deepEqual(parseMode(""), { mode: "off" });
});
test("parseMode: 'off' → off", () => {
  assert.deepEqual(parseMode("off"), { mode: "off" });
});
test("parseMode: 'strip' → strip", () => {
  assert.deepEqual(parseMode("strip"), { mode: "strip" });
});
test("parseMode: 'pin:2.1.185' → pin", () => {
  assert.deepEqual(parseMode("pin:2.1.185"), { mode: "pin", value: "2.1.185" });
});
test("parseMode: 'pin:2.1.0' → pin", () => {
  assert.deepEqual(parseMode("pin:2.1.0"), { mode: "pin", value: "2.1.0" });
});
test("parseMode: 'pin:' (empty value) → off with reason", () => {
  const result = parseMode("pin:");
  assert.equal(result.mode, "off");
  assert.match(result.reason, /invalid_pin_value/);
});
test("parseMode: 'pin:has;semicolon' → off with reason (would break header grammar)", () => {
  const result = parseMode("pin:has;semicolon");
  assert.equal(result.mode, "off");
  assert.match(result.reason, /invalid_pin_value/);
});
test("parseMode: 'pin:has=equals' → off with reason", () => {
  const result = parseMode("pin:has=equals");
  assert.equal(result.mode, "off");
  assert.match(result.reason, /invalid_pin_value/);
});
test("parseMode: 'pin:has space' → off with reason", () => {
  const result = parseMode("pin:has space");
  assert.equal(result.mode, "off");
  assert.match(result.reason, /invalid_pin_value/);
});
test("parseMode: 'random-mode' → off with reason", () => {
  const result = parseMode("random-mode");
  assert.equal(result.mode, "off");
  assert.match(result.reason, /unrecognized_mode/);
});

// --- rewriteCcVersion ---

test("rewriteCcVersion: strip 4-segment to 3-segment", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185.abc123; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, true);
  assert.match(out, /cc_version=2\.1\.185;/);
  assert.ok(!out.includes("abc123"));
});

test("rewriteCcVersion: strip 5-segment (just in case) to 3-segment", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185.abc123.deadbeef; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, true);
  assert.match(out, /cc_version=2\.1\.185;/);
});

test("rewriteCcVersion: strip on already-3-segment is a no-op", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("rewriteCcVersion: pin replaces 4-segment with the literal", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185.abc123; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "pin", value: "2.1.0" });
  assert.equal(changed, true);
  assert.match(out, /cc_version=2\.1\.0;/);
});

test("rewriteCcVersion: pin replaces 3-segment with the literal", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "pin", value: "2.1.0" });
  assert.equal(changed, true);
  assert.match(out, /cc_version=2\.1\.0;/);
});

test("rewriteCcVersion: pin to the same value is a no-op (changed=false)", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "pin", value: "2.1.185" });
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("rewriteCcVersion: off mode does nothing", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185.abc123; other=stuff";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "off" });
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("rewriteCcVersion: text without cc_version is left alone", () => {
  const text = "x-anthropic-billing-header: other=stuff; foo=bar";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("rewriteCcVersion: only the cc_version assignment is touched (other=stuff preserved)", () => {
  const text = "x-anthropic-billing-header: cc_version=2.1.185.abc123; other=stuff";
  const { text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.match(out, /other=stuff/);
});

test("rewriteCcVersion: non-string input → no-op", () => {
  const { changed, text } = rewriteCcVersion(null, { mode: "strip" });
  assert.equal(changed, false);
  assert.equal(text, null);
});

// --- onRequest hook integration ---

test("onRequest: env unset → no mutation", async () => {
  const body = bodyWith("2.1.185.abc123");
  const before = JSON.stringify(body);
  await ext.onRequest(ctxFor(body));
  assert.equal(JSON.stringify(body), before);
});

test("onRequest: CACHE_FIX_NORMALIZE_CC_VERSION=off → no mutation", async () => {
  process.env[ENV] = "off";
  const body = bodyWith("2.1.185.abc123");
  const before = JSON.stringify(body);
  await ext.onRequest(ctxFor(body));
  assert.equal(JSON.stringify(body), before);
});

test("onRequest: strip mode collapses 4-segment to 3-segment", async () => {
  process.env[ENV] = "strip";
  const body = bodyWith("2.1.185.abc123");
  await ext.onRequest(ctxFor(body));
  assert.match(body.system[0].text, /cc_version=2\.1\.185;/);
  assert.ok(!body.system[0].text.includes("abc123"));
});

test("onRequest: strip mode is idempotent (run twice = same result)", async () => {
  process.env[ENV] = "strip";
  const body = bodyWith("2.1.185.abc123");
  await ext.onRequest(ctxFor(body));
  const after1 = body.system[0].text;
  await ext.onRequest(ctxFor(body));
  const after2 = body.system[0].text;
  assert.equal(after1, after2);
});

test("onRequest: pin mode replaces with operator literal", async () => {
  process.env[ENV] = "pin:2.1.0";
  const body = bodyWith("2.1.185.abc123");
  await ext.onRequest(ctxFor(body));
  assert.match(body.system[0].text, /cc_version=2\.1\.0;/);
});

test("onRequest: malformed pin value → fail-open, no mutation", async () => {
  process.env[ENV] = "pin:has;semicolon";
  const body = bodyWith("2.1.185.abc123");
  const before = JSON.stringify(body);
  await ext.onRequest(ctxFor(body));
  assert.equal(JSON.stringify(body), before, "malformed pin must not mutate the body");
});

test("onRequest: unrecognized mode → fail-open, no mutation", async () => {
  process.env[ENV] = "bogus";
  const body = bodyWith("2.1.185.abc123");
  const before = JSON.stringify(body);
  await ext.onRequest(ctxFor(body));
  assert.equal(JSON.stringify(body), before);
});

test("onRequest: body without system → no-op", async () => {
  process.env[ENV] = "strip";
  const body = { messages: [{ role: "user", content: "hi" }] };
  await ext.onRequest(ctxFor(body));
  // No crash; body still has no system block
  assert.equal(body.system, undefined);
});

test("onRequest: system block without billing-header → no-op on that block", async () => {
  process.env[ENV] = "strip";
  const body = {
    system: [
      { type: "text", text: "You are a helpful assistant." },
      billingBlock("2.1.185.abc123"),
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  await ext.onRequest(ctxFor(body));
  assert.equal(body.system[0].text, "You are a helpful assistant.", "non-billing block untouched");
  assert.match(body.system[1].text, /cc_version=2\.1\.185;/);
});

test("onRequest: missing block.text → skipped without crash", async () => {
  process.env[ENV] = "strip";
  const body = {
    system: [{ type: "text" }, billingBlock("2.1.185.abc123")],
    messages: [{ role: "user", content: "hi" }],
  };
  await ext.onRequest(ctxFor(body));
  assert.match(body.system[1].text, /cc_version=2\.1\.185;/);
});

// --- Interaction with fingerprint-strip ---

test("interaction: after cc-version-normalize strip, fingerprint-strip is a no-op (3-segment guard)", async () => {
  process.env[ENV] = "strip";
  const body = bodyWith("2.1.185.abc123");
  await ext.onRequest(ctxFor(body));
  const afterCcNormalize = body.system[0].text;

  // Now run fingerprint-strip on the same body. Its dotParts.length < 4
  // guard means it should NOT touch a 3-segment version.
  await fingerprintExt.onRequest(ctxFor(body));
  assert.equal(body.system[0].text, afterCcNormalize,
    "fingerprint-strip must not re-add a suffix after cc-version-normalize");
});

test("interaction: after cc-version-normalize pin, fingerprint-strip is a no-op", async () => {
  process.env[ENV] = "pin:2.1.0";
  const body = bodyWith("2.1.185.abc123");
  await ext.onRequest(ctxFor(body));
  const afterPin = body.system[0].text;
  await fingerprintExt.onRequest(ctxFor(body));
  assert.equal(body.system[0].text, afterPin);
});

// --- Order verification ---

test("extension order is 90 (before fingerprint-strip at 100)", () => {
  assert.equal(ext.order, 90);
  assert.ok(ext.order < fingerprintExt.order,
    "cc-version-normalize must run before fingerprint-strip");
});

// --- Codex r1 blocker 1: field-boundary anchoring ---

test("rewriteCcVersion (blocker 1): cc_version embedded in another field's value is NOT rewritten", () => {
  // Pathological but legal: another field's value happens to contain
  // `cc_version=` as a substring. The naive regex would rewrite both.
  const text = "x-anthropic-billing-header: other=prefix_cc_version=zzz.attacker.value; cc_version=2.1.185.real_hash";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, true);
  // The real cc_version (at field boundary) is rewritten
  assert.match(out, /;\s?cc_version=2\.1\.185/, "real cc_version is stripped");
  // The embedded occurrence inside `other=...` MUST be preserved verbatim
  assert.match(out, /other=prefix_cc_version=zzz\.attacker\.value/,
    "embedded cc_version inside another field's value must NOT be rewritten");
});

test("rewriteCcVersion (blocker 1): pin mode also does NOT touch embedded cc_version=", () => {
  const text = "x-anthropic-billing-header: other=prefix_cc_version=zzz.attacker.value; cc_version=2.1.185";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "pin", value: "2.1.0" });
  assert.equal(changed, true);
  assert.match(out, /;\s?cc_version=2\.1\.0/, "real cc_version is pinned");
  assert.match(out, /other=prefix_cc_version=zzz\.attacker\.value/,
    "embedded cc_version inside another field's value must NOT be rewritten");
});

test("rewriteCcVersion: matches at start-of-string boundary", () => {
  const text = "cc_version=2.1.185.hash";
  const { changed, text: out } = rewriteCcVersion(text, { mode: "strip" });
  assert.equal(changed, true);
  assert.equal(out, "cc_version=2.1.185");
});

// --- Codex r1 attention item: multiple billing-header blocks ---

test("onRequest: multiple billing-header blocks → ALL get rewritten in one tick", async () => {
  process.env[ENV] = "strip";
  const body = {
    system: [
      billingBlock("2.1.185.hashA"),
      { type: "text", text: "You are a helpful assistant." },
      billingBlock("2.1.185.hashB"),
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  await ext.onRequest(ctxFor(body));
  assert.match(body.system[0].text, /cc_version=2\.1\.185;/, "first billing block rewritten");
  assert.equal(body.system[1].text, "You are a helpful assistant.", "non-billing block untouched");
  assert.match(body.system[2].text, /cc_version=2\.1\.185;/, "second billing block also rewritten");
});

// --- Codex r1 blocker 2: atomic fail-open ---

test("onRequest (blocker 2): if iteration throws AFTER a candidate block, the body is byte-intact", async () => {
  process.env[ENV] = "strip";
  // First system block: normal billing block (rewrite candidate).
  // Second system block: a Proxy that throws on `.text` access during
  // the scan loop. The atomic-staging contract requires the first block
  // NOT to be mutated when a later scan iteration throws.
  const realBlock = billingBlock("2.1.185.hashX");
  const beforeText = realBlock.text;
  const throwingBlock = new Proxy({}, {
    get(_target, prop) {
      if (prop === "text") throw new Error("synthetic-scan-error");
      return undefined;
    },
    has(_target, _prop) { return true; },
  });
  const body = {
    system: [realBlock, throwingBlock],
    messages: [{ role: "user", content: "hi" }],
  };
  await ext.onRequest(ctxFor(body));
  assert.equal(body.system[0].text, beforeText,
    "first block must be byte-identical — staged rewrites must NOT be applied when the scan throws");
});

// --- The motivating scenario: cache-bust across auto-update ---

test("motivating scenario: same base version with different per-build hashes both normalize to the same text (cache stability across auto-update)", async () => {
  process.env[ENV] = "strip";

  // Turn N, before auto-update
  const body1 = bodyWith("2.1.185.buildhash_A");
  await ext.onRequest(ctxFor(body1));

  // Turn N+1, after VS Code auto-update installed a new binary with a
  // different build hash but same MAJOR.MINOR.PATCH
  __resetFirstFireForTests(); // simulate fresh process-state-irrelevant first-fire
  const body2 = bodyWith("2.1.185.buildhash_B");
  await ext.onRequest(ctxFor(body2));

  assert.equal(body1.system[0].text, body2.system[0].text,
    "across an auto-update, the normalized billing-header text must be identical so the cache prefix matches");
});
