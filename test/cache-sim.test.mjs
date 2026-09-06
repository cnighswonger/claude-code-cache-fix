import { test } from "node:test";
import assert from "node:assert/strict";

import { simulatePair } from "../tools/cache-sim.mjs";

const cc = { cache_control: { type: "ephemeral" } };

function msg(role, text, marked = false) {
  return {
    role,
    content: [marked ? { type: "text", text, ...cc } : { type: "text", text }],
  };
}

function body(messages, extra = {}) {
  return { model: "claude-opus-5", system: [{ type: "text", text: "sys" }], messages, ...extra };
}

test("simulatePair: pure append after a marker hits up to that marker", () => {
  const prev = body([msg("user", "a", true), msg("assistant", "b")]);
  const now = body([msg("user", "a", true), msg("assistant", "b"), msg("user", "c")]);
  const sim = simulatePair(prev, now);
  assert.equal(sim.divergence, "append");
  assert.equal(sim.bestMarker, 0, "marker at index 0 survived");
  assert.ok(sim.hitTok > 0);
  assert.ok(sim.writeTok < sim.totalTok);
});

test("simulatePair: front change (model) busts everything", () => {
  const prev = body([msg("user", "a", true)]);
  const now = body([msg("user", "a", true)], { model: "claude-sonnet-5" });
  const sim = simulatePair(prev, now);
  assert.equal(sim.divergence, "front");
  assert.equal(sim.hitTok, 0);
  assert.equal(sim.writeTok, sim.totalTok);
});

test("simulatePair: mid-history mutation falls back to the last marker BEFORE it", () => {
  // Markers at 0 and 3 (prev tail); mutation at index 2 -> only marker 0 usable.
  const mk = (midText) => [
    msg("user", "start", true),
    msg("assistant", "t1"),
    msg("user", midText),
    msg("assistant", "t2", true),
  ];
  const prev = body(mk("original"));
  const now = body(mk("MUTATED"));
  const sim = simulatePair(prev, now);
  assert.equal(sim.divergence, "messages@2");
  assert.equal(sim.bestMarker, 0, "index-0 marker is the only one before the mutation");
});

test("simulatePair: mutation before every marker leaves zero hit — the measured whole-context bust", () => {
  // Marker only at prev tail (index 1); mutation at index 0.
  const prev = body([msg("user", "orig"), msg("assistant", "t", true)]);
  const now = body([msg("user", "CHANGED"), msg("assistant", "t", true)]);
  const sim = simulatePair(prev, now);
  assert.equal(sim.divergence, "messages@0");
  assert.equal(sim.hitTok, 0, "no marker precedes the divergence");
  assert.equal(sim.writeTok, sim.totalTok);
});

test("simulatePair: a marker moving between requests is not a content change", () => {
  const prev = body([msg("user", "a", true), msg("assistant", "b")]);
  const now = body([msg("user", "a"), msg("assistant", "b", true), msg("user", "c")]);
  const sim = simulatePair(prev, now);
  assert.equal(sim.divergence, "append", "cache_control stripped before comparison");
});
