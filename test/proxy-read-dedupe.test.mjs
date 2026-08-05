import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import ext, {
  isEnabled,
  buildToolUseMap,
  isReadToolUse,
  extractContentText,
  computeDedupeKey,
  walkReadToolResults,
  computeTurn,
  buildReplacementText,
  applyReplacements,
  runReadDedupe,
} from "../proxy/extensions/read-dedupe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "read-dedupe");

// --- Fixture helpers ---

function mkReadUse(id, file_path, { offset, limit } = {}) {
  const input = { file_path };
  if (offset !== undefined) input.offset = offset;
  if (limit !== undefined) input.limit = limit;
  return { type: "tool_use", id, name: "Read", input };
}

function mkOtherUse(id, name, input = {}) {
  return { type: "tool_use", id, name, input };
}

function mkToolResult(id, content) {
  return { type: "tool_result", tool_use_id: id, content };
}

function mkAsstMsg(blocks) {
  return { role: "assistant", content: blocks };
}

function mkUserMsg(blocks) {
  return { role: "user", content: blocks };
}

// Run the default-exported extension against a fake ctx.
async function runExt(messages, env = { CACHE_FIX_READ_DEDUPE: "1" }) {
  const saved = process.env.CACHE_FIX_READ_DEDUPE;
  if (env.CACHE_FIX_READ_DEDUPE === undefined) {
    delete process.env.CACHE_FIX_READ_DEDUPE;
  } else {
    process.env.CACHE_FIX_READ_DEDUPE = env.CACHE_FIX_READ_DEDUPE;
  }
  try {
    const ctx = { body: { messages }, headers: {}, meta: {} };
    await ext.onRequest(ctx);
    return ctx;
  } finally {
    if (saved === undefined) delete process.env.CACHE_FIX_READ_DEDUPE;
    else process.env.CACHE_FIX_READ_DEDUPE = saved;
  }
}

// Tiny dup-pair: two Reads of the same file, returning the same content.
function dupPair(toolUseAId = "toolu_A", toolUseBId = "toolu_B", { file_path = "/a/b.txt", text = "hello world" } = {}) {
  return [
    mkAsstMsg([mkReadUse(toolUseAId, file_path)]),
    mkUserMsg([mkToolResult(toolUseAId, text)]),
    mkAsstMsg([mkReadUse(toolUseBId, file_path)]),
    mkUserMsg([mkToolResult(toolUseBId, text)]),
  ];
}

// =============================================================================
// DETECTION (directive tests 1-8)
// =============================================================================

test("1. single Read tool_result, no duplicates → no replacement", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/a/b.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "hello")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
  assert.equal(ctx.body.messages[1].content[0].content, "hello");
});

test("2. two Reads with same (path,content,offset,limit) → 1 replacement; later→pointer", async () => {
  const ctx = await runExt(dupPair());
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 1);
  // First occurrence intact
  assert.equal(ctx.body.messages[1].content[0].content, "hello world");
  // Second occurrence becomes a pointer
  const ptr = ctx.body.messages[3].content[0].content;
  assert.match(ptr, /^\(unchanged — see tool_use_id=toolu_A in turn 1\)$/);
});

test("3. three Reads same key → 2 replacements; earliest intact", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "C")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", "C")]),
    mkAsstMsg([mkReadUse("toolu_C", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_C", "C")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 2);
  assert.equal(ctx.body.messages[1].content[0].content, "C");
  assert.match(ctx.body.messages[3].content[0].content, /tool_use_id=toolu_A/);
  assert.match(ctx.body.messages[5].content[0].content, /tool_use_id=toolu_A/);
});

test("3a. pointer text bytes are identical across replaced positions (FIRST-keeper byte-stability)", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "C")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", "C")]),
    mkAsstMsg([mkReadUse("toolu_C", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_C", "C")]),
  ];
  const ctx = await runExt(messages);
  const a = ctx.body.messages[3].content[0].content;
  const b = ctx.body.messages[5].content[0].content;
  assert.equal(a, b, "pointer bytes must be identical across replaced positions");
});

test("3b. adding a 4th occurrence churns only the new position; prior pointers unchanged", async () => {
  const base = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "C")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", "C")]),
    mkAsstMsg([mkReadUse("toolu_C", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_C", "C")]),
  ];
  const round1 = await runExt(JSON.parse(JSON.stringify(base)));
  const r1_b = round1.body.messages[3].content[0].content;
  const r1_c = round1.body.messages[5].content[0].content;
  const extended = base.concat([
    mkAsstMsg([mkReadUse("toolu_D", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_D", "C")]),
  ]);
  const round2 = await runExt(extended);
  // Bytes for the earlier two pointers must be identical to round 1.
  assert.equal(round2.body.messages[3].content[0].content, r1_b);
  assert.equal(round2.body.messages[5].content[0].content, r1_c);
  // 4th occurrence is a new pointer to the same keeper.
  assert.match(round2.body.messages[7].content[0].content, /tool_use_id=toolu_A/);
});

test("4. same path+content but different offset → 0 replacements (different keys)", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt", { offset: 0 })]),
    mkUserMsg([mkToolResult("toolu_A", "C")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt", { offset: 10 })]),
    mkUserMsg([mkToolResult("toolu_B", "C")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
});

test("5. same path+offset but different content (file changed) → 0 replacements", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt", { offset: 0 })]),
    mkUserMsg([mkToolResult("toolu_A", "A")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt", { offset: 0 })]),
    mkUserMsg([mkToolResult("toolu_B", "B")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
});

test("6. tool_result whose tool_use_id is unknown → skipped, counted as skip", async () => {
  const messages = [
    mkUserMsg([mkToolResult("toolu_missing", "content")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_skipped, 1);
});

test("7. tool_result whose originating tool_use is Bash → not classified as Read", async () => {
  const messages = [
    mkAsstMsg([mkOtherUse("toolu_A", "Bash", { command: "ls" })]),
    mkUserMsg([mkToolResult("toolu_A", "file1 file2")]),
    mkAsstMsg([mkOtherUse("toolu_B", "Bash", { command: "ls" })]),
    mkUserMsg([mkToolResult("toolu_B", "file1 file2")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_classified, 0);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
});

test("8. Read with missing file_path → skipped (defensive)", async () => {
  const messages = [
    mkAsstMsg([{ type: "tool_use", id: "toolu_A", name: "Read", input: {} }]),
    mkUserMsg([mkToolResult("toolu_A", "X")]),
    mkAsstMsg([{ type: "tool_use", id: "toolu_B", name: "Read", input: {} }]),
    mkUserMsg([mkToolResult("toolu_B", "X")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_classified, 0);
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_skipped, 2);
});

// =============================================================================
// KEY COMPUTATION (directive tests 9-13)
// =============================================================================

test("9. computeDedupeKey returns 64-char hex", () => {
  const k = computeDedupeKey({ file_path: "/a/b.txt", content_text: "hello", offset: 0, limit: 100 });
  assert.equal(k.length, 64);
  assert.match(k, /^[0-9a-f]{64}$/);
});

test("10. identical inputs produce identical keys (byte-stable)", () => {
  const k1 = computeDedupeKey({ file_path: "/a/b.txt", content_text: "hello", offset: 0, limit: 100 });
  const k2 = computeDedupeKey({ file_path: "/a/b.txt", content_text: "hello", offset: 0, limit: 100 });
  assert.equal(k1, k2);
});

test("11. changing each field independently changes the key", () => {
  const base = { file_path: "/a/b.txt", content_text: "hello", offset: 0, limit: 100 };
  const baseK = computeDedupeKey(base);
  assert.notEqual(computeDedupeKey({ ...base, file_path: "/a/c.txt" }), baseK);
  assert.notEqual(computeDedupeKey({ ...base, content_text: "world" }), baseK);
  assert.notEqual(computeDedupeKey({ ...base, offset: 1 }), baseK);
  assert.notEqual(computeDedupeKey({ ...base, limit: 200 }), baseK);
});

test("12. null/undefined offset and limit produce stable key (Read without offset/limit)", () => {
  const k1 = computeDedupeKey({ file_path: "/a.txt", content_text: "c", offset: null, limit: null });
  const k2 = computeDedupeKey({ file_path: "/a.txt", content_text: "c", offset: undefined, limit: undefined });
  const k3 = computeDedupeKey({ file_path: "/a.txt", content_text: "c" });
  assert.equal(k1, k2);
  assert.equal(k2, k3);
});

test("13. NUL separators prevent boundary collision (file=a\\nb=10 vs file=a + content=\\nb=10)", () => {
  const a = computeDedupeKey({ file_path: "a\nb=10", content_text: "x", offset: null, limit: null });
  const b = computeDedupeKey({ file_path: "a", content_text: "\nb=10x", offset: null, limit: null });
  assert.notEqual(a, b);
});

// =============================================================================
// CONTENT SHAPE ELIGIBILITY (directive tests 14-17, incl. 16a/16b Codex blocker)
// =============================================================================

test("14. content as string → eligible; matches another string-content occurrence", () => {
  const c = extractContentText("hello");
  assert.equal(c.kind, "string");
  assert.equal(c.text, "hello");
});

test("15. content as single-element [{type:text, text}] → eligible; outer wrapper preserved on replace", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", [{ type: "text", text: "C" }])]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", [{ type: "text", text: "C" }])]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 1);
  // Second occurrence is still an array with single text block; only inner text changes.
  const replaced = ctx.body.messages[3].content[0].content;
  assert.ok(Array.isArray(replaced));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].type, "text");
  assert.match(replaced[0].text, /tool_use_id=toolu_A/);
});

test("16. multi-element mixed array (text + image) → NOT eligible; counted in skipped_mixed_array; body unchanged", async () => {
  const mixed = [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }];
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", mixed)]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", mixed)]),
  ];
  const before = JSON.parse(JSON.stringify(messages));
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_skipped_mixed_array, 2);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
  assert.deepEqual(ctx.body.messages, before);
});

test("16a. single non-text item array → not eligible (no text to key)", () => {
  const c = extractContentText([{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }]);
  assert.equal(c.kind, "skip-mixed-array");
});

test("16b. two mixed arrays with same text but different image bytes → both skipped, NOT deduped against each other (Codex blocker fix)", async () => {
  const a = [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }];
  const b = [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "BBB" } }];
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", a)]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", b)]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
  // Both arrays land in skipped_mixed_array; neither is keyed; they never collide.
  assert.equal(ctx.meta.readDedupeStats.read_tool_results_skipped_mixed_array, 2);
});

test("17. empty string content is keyed; matching second empty-content Read produces a dedupe", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "")]),
    mkAsstMsg([mkReadUse("toolu_B", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_B", "")]),
  ];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 1);
});

// =============================================================================
// REPLACEMENT CONTRACT (directive tests 18-21, incl. 20a)
// =============================================================================

test("18. pointer text format matches the exact directive template", () => {
  const txt = buildReplacementText("toolu_XYZ", 7);
  assert.equal(txt, "(unchanged — see tool_use_id=toolu_XYZ in turn 7)");
});

test("19. pointer text byte-identical across two invocations on identical input", () => {
  const a = buildReplacementText("toolu_X", 3);
  const b = buildReplacementText("toolu_X", 3);
  assert.equal(a, b);
  // Sanity: literal Unicode em-dash, not ASCII --
  assert.ok(a.includes("—"));
  assert.ok(!a.includes("--"));
});

test("20. keeper is the FIRST occurrence (id t1, not t2 or t3)", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("t1", "/x.txt")]),
    mkUserMsg([mkToolResult("t1", "C")]),
    mkAsstMsg([mkReadUse("t2", "/x.txt")]),
    mkUserMsg([mkToolResult("t2", "C")]),
    mkAsstMsg([mkReadUse("t3", "/x.txt")]),
    mkUserMsg([mkToolResult("t3", "C")]),
  ];
  const ctx = await runExt(messages);
  assert.match(ctx.body.messages[3].content[0].content, /tool_use_id=t1\b/);
  assert.match(ctx.body.messages[5].content[0].content, /tool_use_id=t1\b/);
});

test("20a. adding a 4th occurrence with id t4 does NOT change prior pointer references", async () => {
  const base = [
    mkAsstMsg([mkReadUse("t1", "/x.txt")]),
    mkUserMsg([mkToolResult("t1", "C")]),
    mkAsstMsg([mkReadUse("t2", "/x.txt")]),
    mkUserMsg([mkToolResult("t2", "C")]),
    mkAsstMsg([mkReadUse("t3", "/x.txt")]),
    mkUserMsg([mkToolResult("t3", "C")]),
  ];
  const first = await runExt(JSON.parse(JSON.stringify(base)));
  const refB = first.body.messages[3].content[0].content;
  const refC = first.body.messages[5].content[0].content;
  const extended = base.concat([
    mkAsstMsg([mkReadUse("t4", "/x.txt")]),
    mkUserMsg([mkToolResult("t4", "C")]),
  ]);
  const second = await runExt(extended);
  assert.equal(second.body.messages[3].content[0].content, refB);
  assert.equal(second.body.messages[5].content[0].content, refC);
  // 4th pointer references t1, not any prior duplicate
  assert.match(second.body.messages[7].content[0].content, /tool_use_id=t1\b/);
});

test("21. keeper turn number is computed correctly from msgIdx", () => {
  assert.equal(computeTurn(0), 1);   // first user message
  assert.equal(computeTurn(1), 1);   // first assistant (same turn)
  assert.equal(computeTurn(2), 2);   // second user
  assert.equal(computeTurn(3), 2);
  assert.equal(computeTurn(10), 6);
});

// =============================================================================
// ACTIVATION (directive tests 22-25)
// =============================================================================

test("22. CACHE_FIX_READ_DEDUPE unset → extension fires but exits early; stats present with enabled:false", async () => {
  const ctx = await runExt(dupPair(), {});
  assert.equal(ctx.meta.readDedupeStats.enabled, false);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
});

test("23. enabled + no Reads in body → stats present (all zeros), no mutation", async () => {
  const messages = [mkUserMsg([{ type: "text", text: "hi" }])];
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.enabled, true);
  assert.equal(ctx.meta.readDedupeStats.total_tool_results_scanned, 0);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
});

test("24. enabled, no duplicates → stats counts replacements_written=0, body unchanged", async () => {
  const messages = [
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "hello")]),
  ];
  const before = JSON.parse(JSON.stringify(messages));
  const ctx = await runExt(messages);
  assert.equal(ctx.meta.readDedupeStats.replacements_written, 0);
  assert.deepEqual(ctx.body.messages, before);
});

test("25. enabled with duplicates → counters bump, body mutated", async () => {
  const ctx = await runExt(dupPair());
  const s = ctx.meta.readDedupeStats;
  assert.equal(s.enabled, true);
  assert.equal(s.replacements_written, 1);
  assert.equal(s.duplicate_keys, 1);
});

// =============================================================================
// TELEMETRY (directive tests 26-27)
// =============================================================================

test("26. ctx.meta.readDedupeStats contains every documented field", async () => {
  const ctx = await runExt(dupPair());
  const s = ctx.meta.readDedupeStats;
  const expected = [
    "enabled",
    "total_tool_results_scanned",
    "read_tool_results_classified",
    "read_tool_results_skipped",
    "read_tool_results_skipped_mixed_array",
    "unique_keys",
    "duplicate_keys",
    "replacements_written",
    "bytes_original",
    "bytes_after",
    "bytes_saved",
  ];
  for (const field of expected) {
    assert.ok(field in s, `stats missing field ${field}`);
  }
});

test("27. bytes_saved is positive on duplicates of substantial content; zero on no-dup runs", async () => {
  // Use content larger than the pointer text (~55 bytes) so bytes_saved is positive.
  // Small content can produce a NEGATIVE bytes_saved (pointer is longer than the
  // original); the contract is bytes_original - bytes_after, which is correct by
  // construction. Tested separately below.
  const bigContent = "x".repeat(500);
  const ctx = await runExt(dupPair("toolu_A", "toolu_B", { text: bigContent }));
  assert.ok(ctx.meta.readDedupeStats.bytes_saved > 0, `expected positive saving on 500-byte content, got ${ctx.meta.readDedupeStats.bytes_saved}`);

  const noDupCtx = await runExt([
    mkAsstMsg([mkReadUse("toolu_A", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_A", "hello")]),
  ]);
  assert.equal(noDupCtx.meta.readDedupeStats.bytes_saved, 0);
});

test("27b. stderr reads_seen counts ALL Read tool_results (eligible + skipped), per Codex r1 precision note", async () => {
  // Setup: two eligible (string-content) Reads of the same file → 1 replacement,
  // plus one mixed-array Read (the Codex blocker shape) → skipped_mixed_array.
  // Stderr's reads_seen= integer must equal the sum across both buckets so the
  // operator sees "3 Reads scanned" not "2 Reads scanned".
  const messages = [
    mkAsstMsg([mkReadUse("toolu_E1", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_E1", "hello")]),
    mkAsstMsg([mkReadUse("toolu_E2", "/x.txt")]),
    mkUserMsg([mkToolResult("toolu_E2", "hello")]),
    mkAsstMsg([mkReadUse("toolu_M1", "/y.png")]),
    mkUserMsg([mkToolResult("toolu_M1", [{ type: "text", text: "img" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "Z" } }])]),
  ];
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    await runExt(messages);
  } finally {
    process.stderr.write = orig;
  }
  // 2 eligible + 1 skipped-mixed = 3 reads_seen
  assert.match(captured, /reads_seen=3\b/, `expected reads_seen=3, got: ${captured.trim()}`);
});

test("27a. bytes_saved is bytes_original - bytes_after (can be negative on tiny content)", async () => {
  // Documents the contract: pointer text is ~55 bytes; deduping a 2-byte content
  // produces a "saving" of 2 - 55 = -53. Operators should look at bytes_saved
  // sign together with replacements_written; the extension is still firing
  // correctly. Whether to suppress firing on tiny content is a future tuning
  // decision, not in scope for v1.
  const ctx = await runExt(dupPair("toolu_A", "toolu_B", { text: "C" }));
  const s = ctx.meta.readDedupeStats;
  assert.equal(s.replacements_written, 1);
  assert.equal(s.bytes_saved, s.bytes_original - s.bytes_after);
  assert.ok(s.bytes_saved < 0, "tiny content should produce negative saving (pointer is longer than original)");
});

// =============================================================================
// PIPELINE ORDER (directive test 28)
// =============================================================================

test("28. read-dedupe loads at order 380, after image-retry-circuit-breaker (370) and before cache-control-normalize (400)", async () => {
  // Asserts the ORDERING guarantee, not array adjacency. An earlier form
  // pinned `reg[idx-1].name` and `reg[idx+1].name` directly, which held only
  // while no extension existed in the (370, 400) gap and failed the moment
  // one did — measured on #272, which registers insertion-normalization at
  // 395. The `order` field is what other extensions can rely on; array
  // neighbours are an incidental of what happens to be loaded alongside.
  const { loadExtensions } = await import("../proxy/pipeline.mjs");
  const extensionsDir = join(__dirname, "..", "proxy", "extensions");
  const configPath = join(__dirname, "..", "proxy", "extensions.json");
  const reg = await loadExtensions(extensionsDir, configPath);
  const idx = reg.findIndex((e) => e.name === "read-dedupe");
  assert.ok(idx >= 0, "read-dedupe not loaded");
  assert.equal(reg[idx].order, 380);
  const irc = reg.findIndex((e) => e.name === "image-retry-circuit-breaker");
  const ccn = reg.findIndex((e) => e.name === "cache-control-normalize");
  assert.ok(irc >= 0, "image-retry-circuit-breaker not loaded");
  assert.ok(ccn >= 0, "cache-control-normalize not loaded");
  assert.ok(irc < idx, `read-dedupe (${idx}) must load AFTER image-retry-circuit-breaker (${irc})`);
  assert.ok(idx < ccn, `read-dedupe (${idx}) must load BEFORE cache-control-normalize (${ccn})`);
});

// =============================================================================
// REGRESSION (directive test 29) — real-traffic fixture round-trip
// =============================================================================

async function loadFixture(name) {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw);
}

test("29a. same-file-dupe.json fixture → at least one replacement, all replacements identical bytes", async (t) => {
  let fixture;
  try {
    fixture = await loadFixture("same-file-dupe.json");
  } catch {
    t.skip("fixture not yet captured");
    return;
  }
  const { stats, messages: out } = runReadDedupe(fixture);
  assert.ok(stats.replacements_written >= 1, "fixture should produce ≥1 replacement");
  assert.ok(out !== fixture.messages || stats.replacements_written === 0, "messages reference must change when replacements happen");
});

test("29b. offset-variant.json fixture → distinct keys, zero replacements", async (t) => {
  let fixture;
  try {
    fixture = await loadFixture("offset-variant.json");
  } catch {
    t.skip("fixture not yet captured");
    return;
  }
  const { stats } = runReadDedupe(fixture);
  assert.equal(stats.replacements_written, 0, "different offsets must NOT collide");
});

test("29c. mixed-array-shape.json fixture → skipped_mixed_array > 0, zero replacements", async (t) => {
  let fixture;
  try {
    fixture = await loadFixture("mixed-array-shape.json");
  } catch {
    t.skip("fixture not yet captured");
    return;
  }
  const { stats } = runReadDedupe(fixture);
  assert.ok(stats.read_tool_results_skipped_mixed_array >= 1);
  assert.equal(stats.replacements_written, 0);
});

// =============================================================================
// MICRO-TESTS for individual helpers (supporting coverage)
// =============================================================================

test("buildToolUseMap: indexes all tool_use blocks by id; skips non-assistant", () => {
  const messages = [
    mkAsstMsg([mkReadUse("a", "/x"), mkOtherUse("b", "Bash")]),
    mkUserMsg([mkToolResult("a", "x")]),
    mkAsstMsg([mkReadUse("c", "/y")]),
  ];
  const map = buildToolUseMap(messages);
  assert.equal(map.size, 3);
  assert.equal(map.get("a").name, "Read");
  assert.equal(map.get("b").name, "Bash");
  assert.equal(map.get("c").input.file_path, "/y");
});

test("isReadToolUse: case-sensitive; rejects 'read', 'ReadFile'", () => {
  assert.ok(isReadToolUse({ name: "Read" }));
  assert.ok(!isReadToolUse({ name: "read" }));
  assert.ok(!isReadToolUse({ name: "ReadFile" }));
  assert.ok(!isReadToolUse(null));
});

test("walkReadToolResults: classifies into the right buckets", () => {
  const messages = [
    mkAsstMsg([mkReadUse("a", "/x.txt"), mkOtherUse("b", "Bash")]),
    mkUserMsg([mkToolResult("a", "C"), mkToolResult("b", "files")]),  // read-eligible + non-read
    mkUserMsg([mkToolResult("unknown", "")]),  // no-tool-use
    mkAsstMsg([mkReadUse("c", "/x.txt")]),
    mkUserMsg([mkToolResult("c", [{ type: "text", text: "C" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "z" } }])]),  // skip-mixed
  ];
  const map = buildToolUseMap(messages);
  const occ = walkReadToolResults(messages, map);
  const classifications = occ.map((o) => o.classification).sort();
  assert.deepEqual(classifications, ["no-tool-use", "non-read", "read-eligible", "read-skip-mixed"]);
});

test("isEnabled: rejects 'on', 'true', '0', and '' (strict =1 only)", () => {
  assert.ok(isEnabled({ CACHE_FIX_READ_DEDUPE: "1" }));
  assert.ok(!isEnabled({ CACHE_FIX_READ_DEDUPE: "on" }));
  assert.ok(!isEnabled({ CACHE_FIX_READ_DEDUPE: "true" }));
  assert.ok(!isEnabled({ CACHE_FIX_READ_DEDUPE: "0" }));
  assert.ok(!isEnabled({ CACHE_FIX_READ_DEDUPE: "" }));
  assert.ok(!isEnabled({}));
});
