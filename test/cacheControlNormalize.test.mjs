import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripCacheControlMarkers,
  countUserCacheControlMarkers,
  CACHE_CONTROL_CANONICAL_MARKER,
} from "../preload.mjs";

// -- stripCacheControlMarkers -----------------------------------------------

test("stripCacheControlMarkers: removes marker from a user-msg content block", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  const n = stripCacheControlMarkers(msg);
  assert.equal(n, 1);
  assert.equal(msg.content[0].cache_control, undefined);
  assert.equal(msg.content[0].text, "hello");
});

test("stripCacheControlMarkers: returns 0 when no markers present", () => {
  const msg = { role: "user", content: [{ type: "text", text: "x" }] };
  assert.equal(stripCacheControlMarkers(msg), 0);
});

test("stripCacheControlMarkers: strips multiple markers in the same message", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "b" },
      { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
  };
  const n = stripCacheControlMarkers(msg);
  assert.equal(n, 2);
  for (const block of msg.content) {
    assert.equal(block.cache_control, undefined);
  }
});

test("stripCacheControlMarkers: non-user roles are skipped", () => {
  const assistantMsg = {
    role: "assistant",
    content: [
      { type: "text", text: "reply", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  assert.equal(stripCacheControlMarkers(assistantMsg), 0);
  // marker still present
  assert.ok(assistantMsg.content[0].cache_control);
});

test("stripCacheControlMarkers: non-array content is skipped", () => {
  const stringMsg = { role: "user", content: "plain string" };
  assert.equal(stripCacheControlMarkers(stringMsg), 0);
  assert.equal(stringMsg.content, "plain string");
});

test("stripCacheControlMarkers: null / empty / missing msg returns 0 without throwing", () => {
  assert.equal(stripCacheControlMarkers(null), 0);
  assert.equal(stripCacheControlMarkers(undefined), 0);
  assert.equal(stripCacheControlMarkers({}), 0);
  assert.equal(stripCacheControlMarkers({ role: "user" }), 0);
  assert.equal(stripCacheControlMarkers({ role: "user", content: [] }), 0);
});

test("stripCacheControlMarkers: other block fields are preserved", () => {
  const msg = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "abc",
        content: "output",
        is_error: false,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  };
  stripCacheControlMarkers(msg);
  const b = msg.content[0];
  assert.equal(b.cache_control, undefined);
  assert.equal(b.type, "tool_result");
  assert.equal(b.tool_use_id, "abc");
  assert.equal(b.content, "output");
  assert.equal(b.is_error, false);
});

// -- countUserCacheControlMarkers ------------------------------------------

test("countUserCacheControlMarkers: counts markers across user messages only", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: "d", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  };
  // 1 on msg[0], 0 on assistant msg[1], 2 on msg[2] → 3 user-side total
  assert.equal(countUserCacheControlMarkers(body), 3);
});

test("countUserCacheControlMarkers: 0 when no markers present", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ],
  };
  assert.equal(countUserCacheControlMarkers(body), 0);
});

test("countUserCacheControlMarkers: null / empty body returns 0", () => {
  assert.equal(countUserCacheControlMarkers(null), 0);
  assert.equal(countUserCacheControlMarkers({}), 0);
  assert.equal(countUserCacheControlMarkers({ messages: [] }), 0);
  assert.equal(countUserCacheControlMarkers({ messages: null }), 0);
});

test("countUserCacheControlMarkers: string-content user message doesn't crash", () => {
  const body = {
    messages: [
      { role: "user", content: "string" },
      {
        role: "user",
        content: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ],
  };
  assert.equal(countUserCacheControlMarkers(body), 1);
});

// -- CACHE_CONTROL_CANONICAL_MARKER ----------------------------------------

test("CACHE_CONTROL_CANONICAL_MARKER is the expected shape", () => {
  assert.equal(CACHE_CONTROL_CANONICAL_MARKER.type, "ephemeral");
  assert.equal(CACHE_CONTROL_CANONICAL_MARKER.ttl, "1h");
});
