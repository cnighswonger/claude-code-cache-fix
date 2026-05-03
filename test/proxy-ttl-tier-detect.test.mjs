import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { detectExistingTier } from "../proxy/extensions/ttl-tier-detect.mjs";

// --- Unit tests on detectExistingTier (directive tests #1-#8) ---

test("detectExistingTier: empty body → '1h'", () => {
  assert.equal(detectExistingTier({}), "1h");
});

test("detectExistingTier: array body.system, no cache_control blocks → '1h'", () => {
  const body = { system: [{ type: "text", text: "hi" }], messages: [] };
  assert.equal(detectExistingTier(body), "1h");
});

test("detectExistingTier: system block with cache_control but no ttl → '1h'", () => {
  const body = {
    system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
  };
  assert.equal(detectExistingTier(body), "1h");
});

test("detectExistingTier: system block with ttl='1h' → '1h'", () => {
  const body = {
    system: [
      { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  assert.equal(detectExistingTier(body), "1h");
});

test("detectExistingTier: system block with ttl='5m' → '5m'", () => {
  const body = {
    system: [
      { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
  };
  assert.equal(detectExistingTier(body), "5m");
});

test("detectExistingTier: 1h system + 5m message-content block → '5m'", () => {
  const body = {
    system: [
      { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "text", text: "y", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  };
  assert.equal(detectExistingTier(body), "5m");
});

test("detectExistingTier: non-array body.system (string) → '1h' (no scan)", () => {
  const body = { system: "You are Claude.", messages: [] };
  assert.equal(detectExistingTier(body), "1h");
});

test("detectExistingTier: missing body.messages → '1h'", () => {
  const body = { system: [] };
  assert.equal(detectExistingTier(body), "1h");
});

// --- Extension tests (directive tests #9-#11) ---

test("onRequest: sets ctx.meta._ttlTier to detected value", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      messages: [],
    },
    headers: {},
    meta: {},
  };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._ttlTier, "5m");
});

test("onRequest: does not mutate ctx.body (deep structural equality)", async () => {
  const body = {
    system: [
      { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ],
  };
  const before = JSON.stringify(body);
  const ctx = { body, headers: {}, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(JSON.stringify(ctx.body), before);
});

test("onRequest: idempotent (running twice yields same _ttlTier)", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      messages: [],
    },
    headers: {},
    meta: {},
  };
  await ext.onRequest(ctx);
  const first = ctx.meta._ttlTier;
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._ttlTier, first);
});
