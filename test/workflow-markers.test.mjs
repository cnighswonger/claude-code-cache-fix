import { test } from "node:test";
import assert from "node:assert/strict";

import { WORKFLOW_MARKERS, matchWorkflowMarker, __testOnly } from "../proxy/workflow-markers.mjs";

// --- Catalog shape ---

test("catalog: every entry has the required fields", () => {
  assert.ok(WORKFLOW_MARKERS.length > 0, "catalog must seed with at least one entry");
  for (const e of WORKFLOW_MARKERS) {
    assert.ok(typeof e.marker_id === "string" && e.marker_id.length > 0, `marker_id missing/empty: ${JSON.stringify(e)}`);
    assert.ok(typeof e.cc_version === "string" && e.cc_version.length > 0);
    assert.ok(typeof e.cc_npm_sha256 === "string" && /^[0-9a-f]{64}$/.test(e.cc_npm_sha256), `cc_npm_sha256 not 64-hex: ${e.cc_npm_sha256}`);
    assert.ok(typeof e.discovered_at === "string");
    assert.ok(typeof e.discovered_by === "string");
    assert.ok(typeof e.marker === "string" && e.marker.length > 0);
    assert.ok(e.position === "system-prompt" || e.position === "first-user-message", `unknown position: ${e.position}`);
  }
});

test("catalog: position 'first-user-message' entries must declare first_message_authorship: 'tool'", () => {
  for (const e of WORKFLOW_MARKERS) {
    if (e.position === "first-user-message") {
      assert.equal(e.first_message_authorship, "tool", `first-user-message entry ${e.marker_id} must be tool-authored; got ${e.first_message_authorship}`);
    }
  }
});

test("catalog: marker_ids are unique", () => {
  const seen = new Set();
  for (const e of WORKFLOW_MARKERS) {
    assert.ok(!seen.has(e.marker_id), `duplicate marker_id: ${e.marker_id}`);
    seen.add(e.marker_id);
  }
});

// --- matchWorkflowMarker — system-prompt-position matching ---

test("match: system-prompt marker in body.system (string) → match", () => {
  const m = matchWorkflowMarker({
    system: "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
    messages: [{ role: "user", content: "Do something." }],
  });
  assert.ok(m, "expected a match");
  assert.equal(m.marker_id, "workflow-subagent-default-v1");
  assert.equal(m.position, "system-prompt");
});

test("match: system-prompt marker in body.system (block array) → match", () => {
  const m = matchWorkflowMarker({
    system: [
      { type: "text", text: "<system_reminder>foo</system_reminder>" },
      { type: "text", text: "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task." },
    ],
    messages: [{ role: "user", content: "Do something." }],
  });
  assert.ok(m);
  assert.equal(m.marker_id, "workflow-subagent-default-v1");
});

test("match: structured-output suffix marker matches via partial 'CRITICAL: You MUST call'", () => {
  const m = matchWorkflowMarker({
    system: "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\nCRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer.",
    messages: [{ role: "user", content: "Do x." }],
  });
  // Either entry can match (both have substrings present). The catalog
  // order returns the first; the load-bearing assertion is that detection
  // fires.
  assert.ok(m, "expected a match");
});

test("match: workflow-suffix marker (pOf — appended to agent prompts)", () => {
  const m = matchWorkflowMarker({
    system: "You are a code reviewer.\n\nNOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human.",
    messages: [{ role: "user", content: "Review file X." }],
  });
  assert.ok(m);
  // Could match `workflow-subagent-suffix-v1`. Verify position is
  // system-prompt regardless of which entry won.
  assert.equal(m.position, "system-prompt");
});

// --- Position-anchored matching: false-positive guards ---

test("match: marker text in user message content does NOT match a system-prompt entry (position-anchored)", () => {
  const m = matchWorkflowMarker({
    system: "You are a helpful assistant.",
    messages: [{
      role: "user",
      content: "Tell me about this string: `You are a subagent spawned by a workflow orchestration script.`",
    }],
  });
  assert.equal(m, null);
});

test("match: marker text in user message content (block-array shape) does NOT match", () => {
  const m = matchWorkflowMarker({
    system: "You are a helpful assistant.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "I'm asking about: You are a subagent spawned by a workflow orchestration script." },
      ],
    }],
  });
  assert.equal(m, null);
});

test("match: no markers → null (top-level conversation)", () => {
  const m = matchWorkflowMarker({
    system: "You are Claude.",
    messages: [{ role: "user", content: "Hello!" }],
  });
  assert.equal(m, null);
});

test("match: malformed body returns null without throwing", () => {
  assert.equal(matchWorkflowMarker(null), null);
  assert.equal(matchWorkflowMarker({}), null);
  assert.equal(matchWorkflowMarker({ messages: "not an array" }), null);
  assert.equal(matchWorkflowMarker({ messages: [{ role: "assistant", content: "x" }] }), null);
});

// --- Helper coverage ---

test("__testOnly.firstUserMessageText: string content shape", () => {
  const t = __testOnly.firstUserMessageText({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(t, "hello");
});

test("__testOnly.firstUserMessageText: block-array content shape", () => {
  const t = __testOnly.firstUserMessageText({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "image", source: {} },  // non-text block ignored
        { type: "text", text: "second" },
      ],
    }],
  });
  assert.equal(t, "first\nsecond");
});

test("__testOnly.systemPromptText: string shape and block-array shape", () => {
  assert.equal(__testOnly.systemPromptText({ system: "raw" }), "raw");
  assert.equal(__testOnly.systemPromptText({
    system: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  }), "a\nb");
});
