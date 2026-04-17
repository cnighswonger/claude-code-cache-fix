import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  computeStickyMessageHash,
  cacheControlStickyStatePath,
  updateCacheControlStickyState,
  applyCacheControlSticky,
  readCacheControlStickyState,
  writeCacheControlStickyState,
  CACHE_CONTROL_STICKY_MAX_POSITIONS,
  CACHE_CONTROL_STICKY_DEFAULT_MARKER,
} from "../preload.mjs";

// Helper: build a user message with a tool_use_id-keyed shape.
function makeUserToolResult(toolUseId, text, cacheControl) {
  const block = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: text,
  };
  if (cacheControl) block.cache_control = { ...cacheControl };
  return { role: "user", content: [block] };
}

function makeUserText(text, cacheControl) {
  const block = { type: "text", text };
  if (cacheControl) block.cache_control = { ...cacheControl };
  return { role: "user", content: [block] };
}

const EPHEMERAL_1H = { type: "ephemeral", ttl: "1h" };

test("cache_control_sticky: no marker-able messages → no-op, state empty", () => {
  const body = { messages: [makeUserText("hello"), makeUserText("world")] };
  const { newState, mutations } = updateCacheControlStickyState(body, { version: 1, positions: [] });
  assert.equal(mutations.length, 0);
  assert.deepEqual(newState.positions, []);
});

test("cache_control_sticky: first body with a marker → state records hash of that msg", () => {
  const body = {
    messages: [
      makeUserToolResult("toolu_abc", "result text"),
      makeUserText("follow-up", EPHEMERAL_1H),
    ],
  };
  const { newState, mutations } = updateCacheControlStickyState(body, { version: 1, positions: [] });
  // No mutations — the marker is already there; sticky only re-adds when
  // missing. But the position must be recorded in state.
  assert.equal(mutations.length, 0);
  assert.equal(newState.positions.length, 1);
  assert.ok(typeof newState.positions[0].msg_hash === "string");
  assert.equal(newState.positions[0].msg_hash.length, 16);
  assert.deepEqual(newState.positions[0].marker, EPHEMERAL_1H);
});

test("cache_control_sticky: subsequent body where CC removed the marker → marker re-added at last block", () => {
  // Turn 1: user msg with hash H1 carries marker; record state.
  const firstBody = { messages: [makeUserText("first turn", EPHEMERAL_1H)] };
  const r1 = updateCacheControlStickyState(firstBody, { version: 1, positions: [] });
  assert.equal(r1.newState.positions.length, 1);

  // Turn 2: SAME first message, but marker dropped; CC has moved marker
  // to the new last user turn.
  const secondBody = {
    messages: [
      makeUserText("first turn"), // same content, no marker now
      makeUserText("second turn", EPHEMERAL_1H),
    ],
  };
  const r2 = updateCacheControlStickyState(secondBody, r1.newState);
  // Sticky should emit a mutation re-adding marker on msg[0].
  const firstMsgMuts = r2.mutations.filter((m) => m.msgIdx === 0);
  assert.equal(firstMsgMuts.length, 1);
  assert.deepEqual(firstMsgMuts[0].marker, EPHEMERAL_1H);
  assert.equal(firstMsgMuts[0].blockIdx, 0);
});

test("cache_control_sticky: caps at MAX_POSITIONS, drops oldest (LRU)", () => {
  assert.equal(CACHE_CONTROL_STICKY_MAX_POSITIONS, 3);
  // Build a body carrying 4 historical markers — one more than cap.
  const body = {
    messages: [
      makeUserText("m1", EPHEMERAL_1H),
      makeUserText("m2", EPHEMERAL_1H),
      makeUserText("m3", EPHEMERAL_1H),
      makeUserText("m4", EPHEMERAL_1H),
    ],
  };
  const r = updateCacheControlStickyState(body, { version: 1, positions: [] });
  assert.equal(r.newState.positions.length, 3);
  // LRU: keep the newest (end-of-list). Compute expected hashes:
  const hashM2 = computeStickyMessageHash(makeUserText("m2"));
  const hashM3 = computeStickyMessageHash(makeUserText("m3"));
  const hashM4 = computeStickyMessageHash(makeUserText("m4"));
  assert.deepEqual(
    r.newState.positions.map((p) => p.msg_hash),
    [hashM2, hashM3, hashM4]
  );
});

test("cache_control_sticky: message hash is stable across content-block insertions", () => {
  const original = {
    role: "user",
    content: [{ type: "text", text: "<reminder>stable prefix here</reminder> actual body content" }],
  };
  const afterSmooshSplit = {
    role: "user",
    content: [
      { type: "text", text: "<reminder>stable prefix here</reminder> actual body content" },
      { type: "text", text: "extra peeled reminder injected by smoosh_split" },
    ],
  };
  const h1 = computeStickyMessageHash(original);
  const h2 = computeStickyMessageHash(afterSmooshSplit);
  assert.ok(h1 && h2);
  assert.equal(h1, h2);
});

test("cache_control_sticky: tool_use_id-keyed messages hash by id (stable across text changes)", () => {
  const m1 = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_stable_123", content: "output v1" }],
  };
  const m2 = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_stable_123", content: "output v2 different text" }],
  };
  assert.equal(computeStickyMessageHash(m1), computeStickyMessageHash(m2));
});

test("cache_control_sticky: state file corruption → falls back to empty state (no throw)", async () => {
  const { mkdirSync } = await import("node:fs");
  const key = `corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = cacheControlStickyStatePath(key);
  try {
    // Ensure parent dir exists then write garbage JSON.
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not-json: true, broken", "utf-8");
    const state = readCacheControlStickyState(key);
    assert.equal(state.version, 1);
    assert.deepEqual(state.positions, []);
  } finally {
    try { rmSync(path, { force: true }); } catch {}
  }
});

test("cache_control_sticky: wraps cleanly with canonical last-msg marker (normalize + sticky compose)", () => {
  // Simulate the post-normalize body: canonical marker on the last user
  // message. Sticky has a prior state pointing at a historical msg with
  // no current marker. Sticky re-adds historical, normalize's canonical
  // stays untouched.
  const historicalMsg = makeUserText("historical content");
  const historicalHash = computeStickyMessageHash(historicalMsg);
  const body = {
    messages: [
      makeUserText("historical content"), // no marker — dropped by CC
      makeUserText("new last turn", EPHEMERAL_1H), // canonical from normalize
    ],
  };
  const prior = {
    version: 1,
    positions: [{ msg_hash: historicalHash, position_hint: "last_block", marker: EPHEMERAL_1H }],
  };
  const r = updateCacheControlStickyState(body, prior);
  // Only msg[0] gets a mutation; msg[1] already has canonical marker.
  assert.equal(r.mutations.length, 1);
  assert.equal(r.mutations[0].msgIdx, 0);
});

test("cache_control_sticky: idempotent — second pass emits no new mutations", () => {
  const historicalMsg = makeUserText("hist");
  const historicalHash = computeStickyMessageHash(historicalMsg);
  const body = { messages: [makeUserText("hist"), makeUserText("new", EPHEMERAL_1H)] };
  const prior = {
    version: 1,
    positions: [{ msg_hash: historicalHash, position_hint: "last_block", marker: EPHEMERAL_1H }],
  };
  const r1 = updateCacheControlStickyState(body, prior);
  assert.equal(r1.mutations.length, 1);
  // Apply the mutation.
  const mut = r1.mutations[0];
  const msg = body.messages[mut.msgIdx];
  msg.content[mut.blockIdx] = { ...msg.content[mut.blockIdx], cache_control: { ...mut.marker } };
  // Second pass: marker now present, no new mutations.
  const r2 = updateCacheControlStickyState(body, r1.newState);
  assert.equal(r2.mutations.length, 0);
});

test("cache_control_sticky: different project keys produce different state file paths", () => {
  const p1 = cacheControlStickyStatePath("/project/alpha");
  const p2 = cacheControlStickyStatePath("/project/beta");
  assert.notEqual(p1, p2);
  assert.ok(p1.includes("cache-control-sticky-"));
  assert.ok(p2.includes("cache-control-sticky-"));
  // Same key → same path (deterministic).
  assert.equal(cacheControlStickyStatePath("/project/alpha"), p1);
});

test("cache_control_sticky: end-to-end apply writes state file and mutates body", () => {
  const key = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const statePath = cacheControlStickyStatePath(key);
  try {
    // Seed a prior state: msg with hash H1 had a marker last turn.
    const historicalHash = computeStickyMessageHash(makeUserText("historical"));
    writeCacheControlStickyState(key, {
      version: 1,
      positions: [{ msg_hash: historicalHash, position_hint: "last_block", marker: EPHEMERAL_1H }],
    });
    const body = {
      messages: [
        makeUserText("historical"), // no marker this turn
        makeUserText("new last turn"),
      ],
    };
    const n = applyCacheControlSticky(body, key);
    assert.equal(n, 1);
    // Marker was added to msg[0].content[0].
    assert.deepEqual(body.messages[0].content[0].cache_control, EPHEMERAL_1H);
    // msg[1] untouched.
    assert.equal(body.messages[1].content[0].cache_control, undefined);
    // State persisted.
    assert.ok(existsSync(statePath));
    const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(persisted.version, 1);
    assert.ok(Array.isArray(persisted.positions));
  } finally {
    try { rmSync(statePath, { force: true }); } catch {}
  }
});

test("cache_control_sticky: body with no messages → applyCacheControlSticky returns 0, no crash", () => {
  assert.equal(applyCacheControlSticky({}, "k1"), 0);
  assert.equal(applyCacheControlSticky({ messages: [] }, "k2"), 0);
  assert.equal(applyCacheControlSticky(null, "k3"), 0);
});

test("cache_control_sticky: hash is null for messages with no identifiable content", () => {
  assert.equal(computeStickyMessageHash(null), null);
  assert.equal(computeStickyMessageHash({}), null);
  assert.equal(computeStickyMessageHash({ role: "user" }), null);
  assert.equal(computeStickyMessageHash({ role: "user", content: [] }), null);
  assert.equal(computeStickyMessageHash({ role: "user", content: [{ type: "image" }] }), null);
});

test("cache_control_sticky: default marker constant is ephemeral/1h", () => {
  assert.deepEqual(CACHE_CONTROL_STICKY_DEFAULT_MARKER, { type: "ephemeral", ttl: "1h" });
});
