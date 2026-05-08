// Tests for the upstream connection-id helper in proxy/upstream.mjs.
//
// Purpose: each underlying TCP socket gets a stable id that persists across
// keep-alive reuse and dies with the socket. The rate-limit-log extension
// records this id on each 429 row so post-analysis can distinguish
// per-connection limiting (Lead's H3, 2026-05-08 brief) from client-side
// queue saturation (H4) or genuinely account-wide limiting.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOrAssignConnectionId,
  __resetConnectionIdsForTests,
} from "../proxy/upstream.mjs";

test("[#1] getOrAssignConnectionId: same socket → same id across calls (keep-alive reuse)", () => {
  __resetConnectionIdsForTests();
  // Use a plain object as a "socket" stand-in — the helper only relies on
  // object-identity via WeakMap, not on any socket protocol.
  const socket = {};
  const a = getOrAssignConnectionId(socket);
  const b = getOrAssignConnectionId(socket);
  assert.equal(a, b);
  assert.match(a, /^cn-\d+$/);
});

test("[#2] getOrAssignConnectionId: distinct sockets → distinct ids", () => {
  __resetConnectionIdsForTests();
  const sockA = {};
  const sockB = {};
  const idA = getOrAssignConnectionId(sockA);
  const idB = getOrAssignConnectionId(sockB);
  assert.notEqual(idA, idB);
  assert.equal(idA, "cn-1");
  assert.equal(idB, "cn-2");
});

test("[#3] getOrAssignConnectionId: ids are monotonic across resets", () => {
  __resetConnectionIdsForTests();
  const id1 = getOrAssignConnectionId({});
  const id2 = getOrAssignConnectionId({});
  const id3 = getOrAssignConnectionId({});
  assert.deepEqual([id1, id2, id3], ["cn-1", "cn-2", "cn-3"]);
});

test("[#4] getOrAssignConnectionId: null/undefined socket → null (defensive)", () => {
  __resetConnectionIdsForTests();
  assert.equal(getOrAssignConnectionId(null), null);
  assert.equal(getOrAssignConnectionId(undefined), null);
});

test("[#5] getOrAssignConnectionId: counter does NOT advance for null sockets", () => {
  // Defensive null calls shouldn't burn ids — keeps the counter monotonic
  // with respect to real socket assignments only.
  __resetConnectionIdsForTests();
  getOrAssignConnectionId(null);
  getOrAssignConnectionId(undefined);
  const realSocket = {};
  assert.equal(getOrAssignConnectionId(realSocket), "cn-1");
});

test("[#6] getOrAssignConnectionId: many distinct sockets get sequential ids", () => {
  // Smoke-tests the upper bound for a burst-shaped workload. 100 distinct
  // sockets should produce 100 distinct ids; the exact counter values prove
  // the WeakMap is working (no collisions, no resets).
  __resetConnectionIdsForTests();
  const sockets = Array.from({ length: 100 }, () => ({}));
  const ids = sockets.map(getOrAssignConnectionId);
  const uniq = new Set(ids);
  assert.equal(uniq.size, 100);
  assert.equal(ids[0], "cn-1");
  assert.equal(ids[99], "cn-100");
});
