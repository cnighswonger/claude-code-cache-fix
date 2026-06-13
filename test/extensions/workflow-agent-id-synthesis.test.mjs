import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync as readJSON } from "node:fs";

import ext from "../../proxy/extensions/workflow-agent-id-synthesis.mjs";

const FIXTURE = JSON.parse(
  readJSON(new URL("../fixtures/workflow-parallel-fanout-replay.json", import.meta.url), "utf8")
);

const WORKFLOW_SYSTEM = "You are a code reviewer.\n\nYou are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.";

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wfsyn-"));
  const logPath = join(dir, "workflow-derivation-events.jsonl");
  const oldEnv = {
    CACHE_FIX_WORKFLOW_DERIVATION_LOG_PATH: process.env.CACHE_FIX_WORKFLOW_DERIVATION_LOG_PATH,
    CACHE_FIX_WORKFLOW_AGENT_DERIVATION: process.env.CACHE_FIX_WORKFLOW_AGENT_DERIVATION,
  };
  process.env.CACHE_FIX_WORKFLOW_DERIVATION_LOG_PATH = logPath;
  delete process.env.CACHE_FIX_WORKFLOW_AGENT_DERIVATION;
  ext.__resetForTests();
  return {
    dir, logPath,
    cleanup: () => {
      for (const k of Object.keys(oldEnv)) {
        if (oldEnv[k] === undefined) delete process.env[k];
        else process.env[k] = oldEnv[k];
      }
      rmSync(dir, { recursive: true, force: true });
      ext.__resetForTests();
    },
  };
}

function makeCtx({ headers = {}, body = {} } = {}) {
  return { headers, body, meta: {} };
}

function readLog(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// --- Detection conditions ---

test("detection: all three conditions met → derived stash, event logged", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: { "x-claude-code-session-id": "sess-A" },
      body: {
        system: WORKFLOW_SYSTEM,
        messages: [{ role: "user", content: "Do thing alpha" }],
      },
    });
    await ext.onRequest(ctx);
    assert.ok(ctx.meta._workflowAgentId);
    assert.equal(ctx.meta._workflowAgentId.source, "cache_fix_derived");
    assert.match(ctx.meta._workflowAgentId.id, /^[0-9a-f]{16}$/);
    assert.match(ctx.meta._workflowAgentId.parentId, /^[0-9a-f]{16}$/);
    const events = readLog(env.logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].agent_id_source, "cache_fix_derived");
    assert.equal(events[0].marker_id, "workflow-subagent-default-v1");
  } finally {
    env.cleanup();
  }
});

test("detection: no sessionId → no stash, no event", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: {},
      body: {
        system: WORKFLOW_SYSTEM,
        messages: [{ role: "user", content: "Do thing" }],
      },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId, undefined);
    assert.equal(readLog(env.logPath).length, 0);
  } finally {
    env.cleanup();
  }
});

test("detection: canonical x-claude-code-agent-id present → cc_header stash, NO derivation, no event", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: {
        "x-claude-code-session-id": "sess-A",
        "x-claude-code-agent-id": "task-canonical-12345",
        "x-claude-code-parent-agent-id": "parent-67890",
      },
      body: {
        system: WORKFLOW_SYSTEM, // marker text irrelevant — canonical wins
        messages: [{ role: "user", content: "Do x" }],
      },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId.source, "cc_header");
    assert.equal(ctx.meta._workflowAgentId.id, "task-canonical-12345");
    assert.equal(ctx.meta._workflowAgentId.parentId, "parent-67890");
    assert.equal(readLog(env.logPath).length, 0); // canonical path doesn't log
  } finally {
    env.cleanup();
  }
});

test("detection: canonical present without parent → parentId is null", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: {
        "x-claude-code-session-id": "sess-A",
        "x-claude-code-agent-id": "task-canonical-only",
      },
      body: { messages: [{ role: "user", content: "Do x" }] },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId.source, "cc_header");
    assert.equal(ctx.meta._workflowAgentId.parentId, null);
  } finally {
    env.cleanup();
  }
});

test("detection: sessionId + no canonical + no marker → drift_canary logged, no stash", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: { "x-claude-code-session-id": "sess-toplevel" },
      body: {
        system: "You are Claude, a regular top-level assistant.",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId, undefined);
    const events = readLog(env.logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].agent_id_source, "drift_canary");
  } finally {
    env.cleanup();
  }
});

test("detection: marker text in user message content does NOT trigger derivation (position-anchored)", async () => {
  const env = setupEnv();
  try {
    const ctx = makeCtx({
      headers: { "x-claude-code-session-id": "sess-toplevel" },
      body: {
        system: "You are Claude.",
        messages: [{
          role: "user",
          content: "What does this string mean: 'You are a subagent spawned by a workflow orchestration script.'?",
        }],
      },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId, undefined);
    // No marker means a drift canary fires (the extension can't tell user-
    // quoting-marker apart from top-level traffic).
    const events = readLog(env.logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].agent_id_source, "drift_canary");
  } finally {
    env.cleanup();
  }
});

// --- Master switch ---

test("master switch: CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off → no behavior, no stash, no event", async () => {
  const env = setupEnv();
  try {
    process.env.CACHE_FIX_WORKFLOW_AGENT_DERIVATION = "off";
    const ctx = makeCtx({
      headers: { "x-claude-code-session-id": "sess-A" },
      body: {
        system: WORKFLOW_SYSTEM,
        messages: [{ role: "user", content: "Do thing" }],
      },
    });
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._workflowAgentId, undefined);
    assert.equal(readLog(env.logPath).length, 0);
  } finally {
    env.cleanup();
  }
});

// --- parallel() 3-leg fan-out fixture ---

test("parallel() fan-out: 3 distinct agent ids, same parent id, same session", async () => {
  const env = setupEnv();
  try {
    const ids = [];
    const parents = [];
    for (const leg of FIXTURE.legs) {
      const ctx = makeCtx({ headers: leg.headers, body: leg.body });
      await ext.onRequest(ctx);
      assert.ok(ctx.meta._workflowAgentId, `leg ${leg.leg} produced no stash`);
      assert.equal(ctx.meta._workflowAgentId.source, "cache_fix_derived");
      ids.push(ctx.meta._workflowAgentId.id);
      parents.push(ctx.meta._workflowAgentId.parentId);
    }
    // 3 distinct agent ids.
    const uniqIds = new Set(ids);
    assert.equal(uniqIds.size, 3, `expected 3 distinct agent ids, got ${ids}`);
    // 1 shared parent id.
    const uniqParents = new Set(parents);
    assert.equal(uniqParents.size, 1, `expected 1 shared parent id, got ${parents}`);
  } finally {
    env.cleanup();
  }
});

// --- Determinism across re-tries of the same leg ---

test("re-try: same leg fired twice produces the same derived id (deterministic across CC's retry)", async () => {
  const env = setupEnv();
  try {
    const body = {
      system: WORKFLOW_SYSTEM,
      messages: [{ role: "user", content: "Do thing alpha" }],
    };
    const ctx1 = makeCtx({ headers: { "x-claude-code-session-id": "sess-A" }, body });
    const ctx2 = makeCtx({ headers: { "x-claude-code-session-id": "sess-A" }, body });
    await ext.onRequest(ctx1);
    await ext.onRequest(ctx2);
    assert.equal(ctx1.meta._workflowAgentId.id, ctx2.meta._workflowAgentId.id);
    assert.equal(ctx1.meta._workflowAgentId.parentId, ctx2.meta._workflowAgentId.parentId);
  } finally {
    env.cleanup();
  }
});

// --- Tools-list churn invariance ---

test("MCP tools churn: same prompt + different tools list → same derived id", async () => {
  const env = setupEnv();
  try {
    const bodyA = {
      system: WORKFLOW_SYSTEM,
      messages: [{ role: "user", content: "Do thing alpha" }],
      tools: [{ name: "Read" }, { name: "Edit" }, { name: "Bash" }],
    };
    const bodyB = {
      system: WORKFLOW_SYSTEM,
      messages: [{ role: "user", content: "Do thing alpha" }],
      tools: [{ name: "Read" }],
    };
    const ctxA = makeCtx({ headers: { "x-claude-code-session-id": "sess-A" }, body: bodyA });
    const ctxB = makeCtx({ headers: { "x-claude-code-session-id": "sess-A" }, body: bodyB });
    await ext.onRequest(ctxA);
    await ext.onRequest(ctxB);
    assert.equal(ctxA.meta._workflowAgentId.id, ctxB.meta._workflowAgentId.id);
  } finally {
    env.cleanup();
  }
});

// --- Drift canary throttle ---

test("drift canary throttle: only one event per session within the throttle window", async () => {
  const env = setupEnv();
  try {
    const body = {
      system: "You are Claude.",
      messages: [{ role: "user", content: "Hello" }],
    };
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx({ headers: { "x-claude-code-session-id": "sess-spam" }, body });
      await ext.onRequest(ctx);
    }
    const events = readLog(env.logPath);
    assert.equal(events.length, 1, `expected 1 throttled canary, got ${events.length}`);
  } finally {
    env.cleanup();
  }
});

test("drift canary throttle: distinct sessions each get their own canary", async () => {
  const env = setupEnv();
  try {
    const body = {
      system: "You are Claude.",
      messages: [{ role: "user", content: "Hello" }],
    };
    for (const sid of ["sess-A", "sess-B", "sess-C"]) {
      const ctx = makeCtx({ headers: { "x-claude-code-session-id": sid }, body });
      await ext.onRequest(ctx);
    }
    const events = readLog(env.logPath);
    assert.equal(events.length, 3);
  } finally {
    env.cleanup();
  }
});

// --- Extension contract metadata ---

test("contract: extension exposes the directive-mandated metadata", () => {
  assert.equal(ext.name, "workflow-agent-id-synthesis");
  assert.equal(ext.order, 365);
  assert.equal(typeof ext.onRequest, "function");
});

// --- extensions.json sanity check ---

test("extensions.json: registered at order 365 with enabled=true", () => {
  const cfg = JSON.parse(
    readJSON(new URL("../../proxy/extensions.json", import.meta.url), "utf8")
  );
  const entry = cfg["workflow-agent-id-synthesis"];
  assert.ok(entry, "missing extensions.json entry");
  assert.equal(entry.enabled, true);
  assert.equal(entry.order, 365);
});
