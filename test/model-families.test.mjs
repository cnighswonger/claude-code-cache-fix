import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_FAMILIES, FAMILY_ROOT_FALLBACKS, modelFamily } from "../proxy/model-families.mjs";

// Canonical wire-format regex from the model-id-sanitize directive §1.
// Targets must validate against this so a future model addition that
// doesn't conform fails CI rather than silently producing a malformed
// fallback rewrite.
const CANONICAL_RE = /^claude-[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

test("MODEL_FAMILIES: every entry has root + family + fallbackTarget", () => {
  for (const e of MODEL_FAMILIES) {
    assert.ok(typeof e.root === "string" && e.root.length > 0, `root missing: ${JSON.stringify(e)}`);
    assert.ok(typeof e.family === "string" && e.family.length > 0, `family missing: ${JSON.stringify(e)}`);
    assert.ok(typeof e.fallbackTarget === "string" && e.fallbackTarget.length > 0, `fallbackTarget missing: ${JSON.stringify(e)}`);
  }
});

test("MODEL_FAMILIES: every fallbackTarget is a canonical wire-format ID", () => {
  for (const e of MODEL_FAMILIES) {
    assert.ok(CANONICAL_RE.test(e.fallbackTarget), `fallbackTarget not canonical: ${e.fallbackTarget}`);
  }
});

test("FAMILY_ROOT_FALLBACKS: every entry has root + fallbackTarget", () => {
  for (const e of FAMILY_ROOT_FALLBACKS) {
    assert.ok(typeof e.root === "string" && e.root.length > 0);
    assert.ok(typeof e.fallbackTarget === "string" && e.fallbackTarget.length > 0);
  }
});

test("FAMILY_ROOT_FALLBACKS: every fallbackTarget is a canonical wire-format ID", () => {
  for (const e of FAMILY_ROOT_FALLBACKS) {
    assert.ok(CANONICAL_RE.test(e.fallbackTarget), `fallbackTarget not canonical: ${e.fallbackTarget}`);
  }
});

test("FAMILY_ROOT_FALLBACKS: covers all 5 family roots", () => {
  const roots = new Set(FAMILY_ROOT_FALLBACKS.map((e) => e.root));
  for (const expected of ["opus", "sonnet", "haiku", "fable", "mythos"]) {
    assert.ok(roots.has(expected), `family root missing: ${expected}`);
  }
});

test("modelFamily: substring matching catches dated point-release IDs", () => {
  // The post-#225 test that Codex r1 called out: `claude-haiku-4-5-20251001`
  // must classify as `haiku` via the shorter family token.
  assert.equal(modelFamily("claude-haiku-4-5-20251001"), "haiku");
});

test("modelFamily: returns 'unknown' for unmatched + non-string inputs", () => {
  assert.equal(modelFamily("claude-future-x-1"), "unknown");
  assert.equal(modelFamily(""), "unknown");
  assert.equal(modelFamily(null), "unknown");
  assert.equal(modelFamily(undefined), "unknown");
  assert.equal(modelFamily(123), "unknown");
});

test("modelFamily: known canonical IDs classify correctly", () => {
  assert.equal(modelFamily("claude-opus-4-7"), "opus");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("claude-sonnet-4-6"), "sonnet");
  assert.equal(modelFamily("claude-sonnet-4-7"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-mythos-2"), "mythos");
});
