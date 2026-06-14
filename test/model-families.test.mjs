import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_FAMILIES, modelFamily } from "../proxy/model-families.mjs";

// --- Catalog shape ---

test("MODEL_FAMILIES: every entry has root + family", () => {
  assert.ok(MODEL_FAMILIES.length > 0, "catalog must seed with at least one entry");
  for (const e of MODEL_FAMILIES) {
    assert.ok(typeof e.root === "string" && e.root.length > 0, `root missing: ${JSON.stringify(e)}`);
    assert.ok(typeof e.family === "string" && e.family.length > 0, `family missing: ${JSON.stringify(e)}`);
  }
});

test("MODEL_FAMILIES: covers the 5 current family names", () => {
  const families = new Set(MODEL_FAMILIES.map((e) => e.family));
  for (const expected of ["opus", "sonnet", "haiku", "fable", "mythos"]) {
    assert.ok(families.has(expected), `family missing from catalog: ${expected}`);
  }
});

// --- modelFamily classification ---

test("modelFamily: known canonical IDs classify correctly", () => {
  assert.equal(modelFamily("claude-opus-4-7"), "opus");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("claude-sonnet-4-6"), "sonnet");
  assert.equal(modelFamily("claude-sonnet-4-7"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-mythos-2"), "mythos");
});

test("modelFamily: dated point-release IDs classify via the shorter substring", () => {
  // `claude-haiku-4-5-20251001` matches via the `claude-haiku-4-5` substring.
  // This is the load-bearing invariant for served-model divergence on pinned
  // point releases.
  assert.equal(modelFamily("claude-haiku-4-5-20251001"), "haiku");
});

test("modelFamily: returns 'unknown' for unmatched / empty / non-string", () => {
  assert.equal(modelFamily("claude-future-x-1"), "unknown");
  assert.equal(modelFamily(""), "unknown");
  assert.equal(modelFamily(null), "unknown");
  assert.equal(modelFamily(undefined), "unknown");
  assert.equal(modelFamily(123), "unknown");
});

// --- Back-compat: cache-telemetry re-exports modelFamily ---

test("back-compat: `modelFamily` is also exported from cache-telemetry.mjs (one indirection)", async () => {
  const ct = await import("../proxy/extensions/cache-telemetry.mjs");
  assert.equal(typeof ct.modelFamily, "function");
  // Same function reference is fine; same behavior is mandatory.
  assert.equal(ct.modelFamily("claude-opus-4-7"), "opus");
  assert.equal(ct.modelFamily("claude-future-x-1"), "unknown");
});
