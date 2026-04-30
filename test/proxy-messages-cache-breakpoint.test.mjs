import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ext, {
  classifyBlock,
  detectAutoInjectedBoundary,
  countAllCacheControlMarkers,
  injectMessagesBreakpoint,
  buildDumpRecord,
} from "../proxy/extensions/messages-cache-breakpoint.mjs";

// --- Fixture helpers ---
//
// Five baseline fixtures sourced from real CC traffic via the
// CACHE_FIX_DUMP_MESSAGES_HEAD diagnostic introduced by this directive.
// Each is the first ~200 chars of the actual block text wrapped to a complete
// signature so classifyBlock can match it without relying on length.
//
// Synthetic fixtures supplement the baselines for over-match guards and edge
// cases that don't appear in real traffic.

function blockText(text) {
  return { type: "text", text };
}

function blockImage() {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  };
}

// Real CC fixture #1: SessionStart resume hook
const FIX_HOOKS_SESSIONSTART_RESUME = blockText(
  "<system-reminder>SessionStart:resume hook success: continuing prior session\n  - last activity: 2026-04-30T12:34:56Z\n</system-reminder>",
);

// Real CC fixture #2: PreToolUse hook
const FIX_HOOKS_PRETOOLUSE = blockText(
  "<system-reminder>PreToolUse hook success: validated tool inputs against settings allowlist</system-reminder>",
);

// Real CC fixture #3: skills listing
const FIX_SKILLS = blockText(
  "<system-reminder>The following skills are available:\n<available-skills>\n- claude-api: Build, debug, and optimize Claude API apps\n- coffee: Keep prompt cache warm\n</available-skills></system-reminder>",
);

// Real CC fixture #4: project CLAUDE.md
const FIX_CLAUDE_MD = blockText(
  "<system-reminder>Contents of /home/manager/git_repos/claude-code-cache-fix/CLAUDE.md (project instructions, checked into the codebase):\n\n# CLAUDE.md — claude-code-cache-fix\n## Git Workflow\n- Do not push directly to main</system-reminder>",
);

// Real CC fixture #5: deferred-tools
const FIX_DEFERRED_TOOLS = blockText(
  "<deferred-tools>\n<tool>tool-name-here</tool>\n<tool>another-tool</tool>\n</deferred-tools>",
);

// Real CC fixture #6: MCP via <mcp-resources>
const FIX_MCP_RESOURCES = blockText(
  "<mcp-resources>\n  <resource server=\"llm-relay\" uri=\"...\">resource description</resource>\n</mcp-resources>",
);

// Real CC fixture #7: MCP via "Available MCP servers:" sentinel
const FIX_MCP_AVAILABLE = blockText(
  "Available MCP servers:\n- llm-relay: CLI orchestration\n- gh: GitHub helpers\n",
);

// Synthetic over-match guards (must classify as user)
const FIX_USER_QUOTING_AVAILABLE_SKILLS = blockText(
  "I see you have <available-skills> in your output, but it should not be there",
);
const FIX_USER_RELATIVE_CLAUDE_MD = blockText(
  "see also CLAUDE.md in the docs for more context",
);
const FIX_USER_DEFERRED_TOOLS_PROSE = blockText(
  "the deferred tools feature is broken in version 3.2.1",
);
const FIX_USER_MCP_PROSE = blockText("I configured my MCP server yesterday and it works fine");
const FIX_USER_HOOK_PROSE = blockText("the hook success message is in the logs");

const FIX_PLAIN_USER = blockText("Please look at this file and tell me what's wrong.");

function userMsg(content) {
  return { role: "user", content };
}

function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeBody({ messages, system } = {}) {
  return {
    model: "claude-opus-4-7",
    messages: messages || [],
    ...(system ? { system } : {}),
  };
}

function systemBlocks({ tools = true, prompt = true } = {}) {
  // Mimics CC's typical 2-marker system shape: marker after tools (#1) +
  // marker after system prompt (#2).
  const blocks = [];
  if (tools) {
    blocks.push({ type: "text", text: "tool registrations here" });
    blocks.push({ type: "text", text: "more tools", cache_control: { type: "ephemeral" } });
  }
  if (prompt) {
    blocks.push({ type: "text", text: "system prompt body", cache_control: { type: "ephemeral" } });
  }
  return blocks;
}

function withCacheControl(block) {
  return { ...block, cache_control: { type: "ephemeral" } };
}

// Run the extension default export against a synthetic ctx.
async function runExt(body, { meta } = {}) {
  const ctx = { body, meta: meta || {}, headers: {} };
  await ext.onRequest(ctx);
  return ctx;
}

// Helpers to drive env vars per-test.
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- 1. Detection ---

test("1. [skills, CLAUDE.md, user-text] → boundary at index 1 (CLAUDE.md)", () => {
  const idx = detectAutoInjectedBoundary([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER]);
  assert.equal(idx, 1);
});

test("2. [skills, deferred-tools, mcp-resources, CLAUDE.md, user-text] → boundary at 3", () => {
  const idx = detectAutoInjectedBoundary([
    FIX_SKILLS,
    FIX_DEFERRED_TOOLS,
    FIX_MCP_RESOURCES,
    FIX_CLAUDE_MD,
    FIX_PLAIN_USER,
  ]);
  assert.equal(idx, 3);
});

test("3. [user-text only] → boundary -1, skip reason boundary_not_found", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_PLAIN_USER])],
  });
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.boundary_idx, -1);
  assert.equal(stats.skip_reason, "boundary_not_found");
});

test("4. [skills only] → boundary 0, inject on the only block", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS])],
  });
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, true);
  assert.equal(stats.boundary_idx, 0);
  assert.equal(stats.boundary_block_kind, "skills");
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("5. interleaved auto-injected blocks → boundary at LAST auto-injected position", () => {
  const idx = detectAutoInjectedBoundary([
    FIX_SKILLS,
    FIX_PLAIN_USER, // user content interleaved (defensive — current CC doesn't do this)
    FIX_CLAUDE_MD, // last auto-injected — boundary should land here
    FIX_PLAIN_USER,
  ]);
  assert.equal(idx, 2);
});

test("5a. [skills, hooks, user-text] → boundary at index 1 (hooks). Hooks-taxonomy load-bearing test.", () => {
  const idx = detectAutoInjectedBoundary([
    FIX_SKILLS,
    FIX_HOOKS_SESSIONSTART_RESUME,
    FIX_PLAIN_USER,
  ]);
  assert.equal(idx, 1);
});

test("5b. [hooks, skills, deferred-tools, mcp-resources, CLAUDE.md, user-text] → boundary at 4", () => {
  const idx = detectAutoInjectedBoundary([
    FIX_HOOKS_SESSIONSTART_RESUME,
    FIX_SKILLS,
    FIX_DEFERRED_TOOLS,
    FIX_MCP_RESOURCES,
    FIX_CLAUDE_MD,
    FIX_PLAIN_USER,
  ]);
  assert.equal(idx, 4);
});

test("5c. messages[0] is assistant role → skip with unexpected_role_or_shape", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [assistantMsg("hi"), userMsg([FIX_SKILLS, FIX_PLAIN_USER])],
  });
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.skip_reason, "unexpected_role_or_shape");
});

test("5d. messages[0].content is a string (legacy shape) → skip with unexpected_role_or_shape", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [{ role: "user", content: "hello, this is a legacy shape" }],
  });
  const before = JSON.stringify(body);
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.skip_reason, "unexpected_role_or_shape");
  assert.equal(JSON.stringify(body), before);
});

// --- Block classification ---

test("6. skills block (<system-reminder>...<available-skills>) → skills", () => {
  assert.equal(classifyBlock(FIX_SKILLS), "skills");
});

test("7. plugin-skills block → skills", () => {
  const block = blockText(
    "<system-reminder>The following <plugin-skills> are loaded: ...</system-reminder>",
  );
  assert.equal(classifyBlock(block), "skills");
});

test("8. project CLAUDE.md (absolute path) → claude_md", () => {
  assert.equal(classifyBlock(FIX_CLAUDE_MD), "claude_md");
});

test("8a. user text 'see also CLAUDE.md in the docs' → user (over-match guard)", () => {
  assert.equal(classifyBlock(FIX_USER_RELATIVE_CLAUDE_MD), "user");
});

test("9. deferred-tools block → deferred_tools", () => {
  assert.equal(classifyBlock(FIX_DEFERRED_TOOLS), "deferred_tools");
});

test("9a. user prose about deferred tools → user (over-match guard)", () => {
  assert.equal(classifyBlock(FIX_USER_DEFERRED_TOOLS_PROSE), "user");
});

test("10. MCP via <mcp-resources> → mcp_resources", () => {
  assert.equal(classifyBlock(FIX_MCP_RESOURCES), "mcp_resources");
});

test("10a. MCP via 'Available MCP servers:' literal → mcp_resources", () => {
  assert.equal(classifyBlock(FIX_MCP_AVAILABLE), "mcp_resources");
});

test("10b. user prose about MCP → user (over-match guard)", () => {
  assert.equal(classifyBlock(FIX_USER_MCP_PROSE), "user");
});

test("11. hooks block (SessionStart:resume) → hooks", () => {
  assert.equal(classifyBlock(FIX_HOOKS_SESSIONSTART_RESUME), "hooks");
});

test("11a. hooks block (PreToolUse) → hooks", () => {
  assert.equal(classifyBlock(FIX_HOOKS_PRETOOLUSE), "hooks");
});

test("11b. user prose 'the hook success message is in the logs' → user", () => {
  assert.equal(classifyBlock(FIX_USER_HOOK_PROSE), "user");
});

test("11c. user prose quoting <available-skills> → user (over-match guard)", () => {
  // Block doesn't START with <system-reminder>, so the skills signature must not match.
  assert.equal(classifyBlock(FIX_USER_QUOTING_AVAILABLE_SKILLS), "user");
});

test("12. image block → user", () => {
  assert.equal(classifyBlock(blockImage()), "user");
});

test("13. plain user text → user", () => {
  assert.equal(classifyBlock(FIX_PLAIN_USER), "user");
});

test("14. empty content / null → user (defensive)", () => {
  assert.equal(classifyBlock(null), "user");
  assert.equal(classifyBlock({}), "user");
  assert.equal(classifyBlock({ type: "text" }), "user");
  assert.equal(classifyBlock({ type: "text", text: "" }), "user");
});

// --- Marker count guard ---

test("15. body with 0 markers → skip with no_existing_markers", () => {
  const body = makeBody({
    messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
  });
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.skip_reason, "no_existing_markers");
  assert.equal(stats.existing_marker_count, 0);
});

test("16. body with 3 existing markers → inject (count becomes 4)", () => {
  // 2 system + 1 last-user (canonical post-normalize position)
  const body = makeBody({
    system: systemBlocks(),
    messages: [
      userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER]),
      assistantMsg("ack"),
      userMsg([withCacheControl(blockText("follow-up"))]),
    ],
  });
  assert.equal(countAllCacheControlMarkers(body), 3);
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, true);
  assert.equal(stats.existing_marker_count, 3);
  assert.equal(countAllCacheControlMarkers(body), 4);
});

test("17. body with 4 existing markers → skip with at_marker_limit, body unchanged", () => {
  // 2 system + 2 in messages
  const body = makeBody({
    system: systemBlocks(),
    messages: [
      userMsg([FIX_SKILLS, withCacheControl(FIX_CLAUDE_MD), FIX_PLAIN_USER]),
      assistantMsg("ack"),
      userMsg([withCacheControl(blockText("follow-up"))]),
    ],
  });
  assert.equal(countAllCacheControlMarkers(body), 4);
  const before = JSON.stringify(body);
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.skip_reason, "at_marker_limit");
  assert.equal(JSON.stringify(body), before);
});

test("18. body with 5 existing markers → skip + warning emitted", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [
      userMsg([
        withCacheControl(FIX_SKILLS),
        withCacheControl(FIX_CLAUDE_MD),
        FIX_PLAIN_USER,
      ]),
      assistantMsg("ack"),
      userMsg([withCacheControl(blockText("follow-up"))]),
    ],
  });
  assert.equal(countAllCacheControlMarkers(body), 5);
  // Capture stderr by spying on process.stderr.write.
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    const stats = injectMessagesBreakpoint({ body });
    assert.equal(stats.skip_reason, "at_marker_limit");
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(
    captured.some((line) => line.includes("exceeds Anthropic's documented max")),
    `expected stderr warning, got: ${JSON.stringify(captured)}`,
  );
});

// --- Injection ---

test("19. boundary block has no cache_control → inject 1h ephemeral, preserve other fields", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
  });
  const originalKeys = Object.keys(body.messages[0].content[1]).sort();
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, true);
  const block = body.messages[0].content[1];
  assert.deepEqual(block.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(block.type, "text");
  assert.equal(block.text, FIX_CLAUDE_MD.text);
  // All original keys still present.
  const newKeys = Object.keys(block).sort();
  for (const k of originalKeys) assert.ok(newKeys.includes(k), `lost field ${k}`);
});

test("20. boundary block already has cache_control → skip, do not overwrite", () => {
  const preMarked = withCacheControl(FIX_CLAUDE_MD);
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, preMarked, FIX_PLAIN_USER])],
  });
  const before = JSON.stringify(body.messages[0].content[1]);
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, false);
  assert.equal(stats.skip_reason, "boundary_already_marked");
  assert.equal(JSON.stringify(body.messages[0].content[1]), before);
});

test("21. marker count post-injection equals existing_count + 1", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [
      userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER]),
      assistantMsg("ack"),
      userMsg([withCacheControl(blockText("follow-up"))]),
    ],
  });
  const before = countAllCacheControlMarkers(body);
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, true);
  assert.equal(countAllCacheControlMarkers(body), before + 1);
});

// --- Diagnostic dump (CACHE_FIX_DUMP_MESSAGES_HEAD) ---

test("22. CACHE_FIX_DUMP_MESSAGES_HEAD set, valid request → JSONL line written, no mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "messages-bp-"));
  const dumpPath = join(dir, "head.jsonl");
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_HOOKS_SESSIONSTART_RESUME, FIX_SKILLS, FIX_PLAIN_USER])],
  });
  const before = JSON.stringify(body);
  await withEnv(
    {
      CACHE_FIX_DUMP_MESSAGES_HEAD: dumpPath,
      CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: undefined,
    },
    async () => {
      await runExt(body);
    },
  );
  assert.equal(JSON.stringify(body), before, "body must not mutate when only dump is on");
  const raw = await readFile(dumpPath, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.role, "user");
  assert.equal(rec.block_count, 3);
  assert.equal(rec.blocks[0].kind, "hooks");
  assert.equal(rec.blocks[1].kind, "skills");
  assert.equal(rec.blocks[2].kind, "user");
  assert.equal(typeof rec.blocks[0].text_prefix, "string");
  assert.ok(rec.blocks[0].text_prefix.length <= 200);
  assert.equal(rec.blocks[0].has_cache_control, false);
  await rm(dir, { recursive: true, force: true });
});

test("23. CACHE_FIX_DUMP_MESSAGES_HEAD unset → no fs activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "messages-bp-"));
  const dumpPath = join(dir, "head.jsonl");
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, FIX_PLAIN_USER])],
  });
  await withEnv(
    {
      CACHE_FIX_DUMP_MESSAGES_HEAD: undefined,
      CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: undefined,
    },
    async () => {
      await runExt(body);
    },
  );
  await assert.rejects(
    () => stat(dumpPath),
    /ENOENT/,
    "dump file should not be created when env unset",
  );
  await rm(dir, { recursive: true, force: true });
});

// --- Activation ---

test("24. CACHE_FIX_INJECT_MESSAGES_BREAKPOINT unset, no diagnostic → extension is no-op (no telemetry, no mutation)", async () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
  });
  const before = JSON.stringify(body);
  let ctx;
  await withEnv(
    {
      CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: undefined,
      CACHE_FIX_DUMP_MESSAGES_HEAD: undefined,
    },
    async () => {
      ctx = await runExt(body);
    },
  );
  assert.equal(JSON.stringify(body), before);
  assert.equal(ctx.meta.messagesBreakpointStats, undefined);
});

test("25. CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1, valid request → telemetry present, injection occurs", async () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
  });
  let ctx;
  // Silence stderr summary line for this test (we cover stderr in test 28).
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    await withEnv(
      {
        CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: "1",
        CACHE_FIX_DUMP_MESSAGES_HEAD: undefined,
      },
      async () => {
        ctx = await runExt(body);
      },
    );
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(ctx.meta.messagesBreakpointStats);
  assert.equal(ctx.meta.messagesBreakpointStats.injected, true);
  assert.equal(body.messages[0].content[1].cache_control.ttl, "1h");
});

// --- Telemetry ---

test("26. successful injection → telemetry has injected=true, boundary_idx, kind, count", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
  });
  const stats = injectMessagesBreakpoint({ body });
  assert.equal(stats.injected, true);
  assert.ok(stats.boundary_idx >= 0);
  assert.equal(stats.boundary_block_kind, "claude_md");
  assert.equal(typeof stats.existing_marker_count, "number");
});

test("27. skip path → injected=false and skip_reason is one of the documented values", () => {
  const documented = new Set([
    "boundary_not_found",
    "boundary_already_marked",
    "no_existing_markers",
    "at_marker_limit",
    "unexpected_role_or_shape",
  ]);
  // boundary_not_found
  let stats = injectMessagesBreakpoint({
    body: makeBody({ system: systemBlocks(), messages: [userMsg([FIX_PLAIN_USER])] }),
  });
  assert.ok(documented.has(stats.skip_reason));
  // no_existing_markers
  stats = injectMessagesBreakpoint({
    body: makeBody({ messages: [userMsg([FIX_SKILLS, FIX_PLAIN_USER])] }),
  });
  assert.equal(stats.skip_reason, "no_existing_markers");
  assert.ok(documented.has(stats.skip_reason));
  // unexpected_role_or_shape
  stats = injectMessagesBreakpoint({
    body: makeBody({ system: systemBlocks(), messages: [assistantMsg("hi")] }),
  });
  assert.ok(documented.has(stats.skip_reason));
});

test("28. stderr summary line emitted when extension enabled (both injection and skip paths)", async () => {
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    // Injection path
    await withEnv({ CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: "1" }, async () => {
      const body = makeBody({
        system: systemBlocks(),
        messages: [userMsg([FIX_SKILLS, FIX_CLAUDE_MD, FIX_PLAIN_USER])],
      });
      await runExt(body);
    });
    // Skip path
    await withEnv({ CACHE_FIX_INJECT_MESSAGES_BREAKPOINT: "1" }, async () => {
      const body = makeBody({
        system: systemBlocks(),
        messages: [userMsg([FIX_PLAIN_USER])],
      });
      await runExt(body);
    });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(
    captured.some((l) => l.includes("[messages-breakpoint] injected")),
    "expected an 'injected' stderr line",
  );
  assert.ok(
    captured.some((l) => l.includes("[messages-breakpoint] skipped")),
    "expected a 'skipped' stderr line",
  );
});

// --- Build dump record (pure) ---

test("buildDumpRecord captures kinds, prefixes, marker presence per block", () => {
  const body = makeBody({
    system: systemBlocks(),
    messages: [
      userMsg([
        FIX_HOOKS_SESSIONSTART_RESUME,
        withCacheControl(FIX_CLAUDE_MD),
        FIX_PLAIN_USER,
      ]),
    ],
  });
  const rec = buildDumpRecord(body, "2026-04-30T00:00:00.000Z");
  assert.equal(rec.ts, "2026-04-30T00:00:00.000Z");
  assert.equal(rec.role, "user");
  assert.equal(rec.block_count, 3);
  assert.equal(rec.blocks[0].kind, "hooks");
  assert.equal(rec.blocks[1].kind, "claude_md");
  assert.equal(rec.blocks[1].has_cache_control, true);
  assert.equal(rec.blocks[2].kind, "user");
  assert.equal(rec.blocks[2].has_cache_control, false);
  assert.equal(typeof rec.existing_marker_count, "number");
});
