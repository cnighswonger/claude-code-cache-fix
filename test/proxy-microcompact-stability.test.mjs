import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { scratchDir } from "./scratch-registry.mjs";

import ext, {
  matchesSentinelPattern,
  walkToolResultsForSentinels,
  normalizeToolResultContent,
  buildDiagnosticRecord,
  runMicrocompactStability,
} from "../proxy/extensions/microcompact-stability.mjs";

// Registration lives in scratch-registry.mjs, which gates removal on the FILE's
// outcome: a green run cleans up, a red one keeps the dirs and names them. A
// test body that throws never reaches its own cleanup, which is the whole point.
const SCRATCH_PREFIX = "mc-";
const mcTemp = () => scratchDir(SCRATCH_PREFIX);

// --- Fixture helpers ---

const SENTINEL_BARE = "[Old tool result content cleared]";
const SENTINEL_TS = "[Old tool result content cleared at 2026-04-30T13:42:11Z]";
const SENTINEL_TS_MS = "[Old tool result content cleared at 2026-04-30T13:42:11.123Z]";
const SENTINEL_TS_NOT_ISO = "[Old tool result content cleared at not-a-real-timestamp]";
const SENTINEL_PARTIAL_TRAILING = "[Old tool result content cleared] (with extra notes)";

function trBlockString(toolUseId, content) {
  return { type: "tool_result", tool_use_id: toolUseId, content };
}

function trBlockArray(toolUseId, items) {
  return { type: "tool_result", tool_use_id: toolUseId, content: items };
}

function userMsg(content) {
  return { role: "user", content };
}

function assistantMsg(toolUseId, name = "Bash", input = {}) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  };
}

function makeBody(messages) {
  return { model: "claude-opus-4-7-20260101", messages };
}

async function runExt(body, { meta, headers } = {}) {
  const ctx = { body, meta: meta || {}, headers: headers || {} };
  await ext.onRequest(ctx);
  return ctx;
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function silenceStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    return [fn(), captured];
  } finally {
    process.stderr.write = orig;
  }
}

async function silenceStderrAsync(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    const r = await fn();
    return [r, captured];
  } finally {
    process.stderr.write = orig;
  }
}

// --- Mode A ---

test("1. exact bare sentinel → Mode A match in exact_matches", () => {
  const messages = [
    assistantMsg("tool_1"),
    userMsg([trBlockString("tool_1", SENTINEL_BARE)]),
  ];
  const { exact_matches, partial_matches, total_tool_results } = walkToolResultsForSentinels(messages);
  assert.equal(exact_matches.length, 1);
  assert.equal(partial_matches.length, 0);
  assert.equal(total_tool_results, 1);
  assert.equal(exact_matches[0].text, SENTINEL_BARE);
  assert.match(exact_matches[0].matched_pattern, /Old tool result content cleared\\\]/);
});

test("2. exact ISO-8601 timestamp variant → Mode A match", () => {
  const { exact_matches, partial_matches } = walkToolResultsForSentinels([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  assert.equal(exact_matches.length, 1);
  assert.equal(partial_matches.length, 0);
  assert.match(exact_matches[0].matched_pattern, /\\d\{4\}-\\d\{2\}-\\d\{2\}T/);
});

test("2a. ISO-8601 with milliseconds variant → Mode A match", () => {
  const { exact_matches } = walkToolResultsForSentinels([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS_MS)]),
  ]);
  assert.equal(exact_matches.length, 1);
});

test("3. malformed timestamp → does NOT match Mode A; falls through to Mode B", () => {
  const { exact_matches, partial_matches } = walkToolResultsForSentinels([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS_NOT_ISO)]),
  ]);
  assert.equal(exact_matches.length, 0);
  assert.equal(partial_matches.length, 1);
});

test("4. unrelated truncation message → no match in either mode (rejected from candidates)", () => {
  const { exact_matches, partial_matches } = walkToolResultsForSentinels([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", "[Tool result truncated by user]")]),
  ]);
  assert.equal(exact_matches.length, 0);
  assert.equal(partial_matches.length, 0);
});

// --- Mode B ---

test("4a. sentinel + trailing text → Mode B match, body NOT mutated, prefix_64 only in dump", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_PARTIAL_TRAILING)]),
  ]);
  const before = JSON.stringify(body);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: "1",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  // Body must NOT mutate — Mode B is never normalized even with normalize on.
  assert.equal(JSON.stringify(body), before);
  const raw = await readFile(dumpPath, "utf8");
  const rec = JSON.parse(raw.trim());
  assert.equal(rec.exact_matches.length, 0);
  assert.equal(rec.partial_matches.length, 1);
  // Full text NEVER in dump.
  assert.equal(rec.partial_matches[0].sentinel_text, undefined);
  assert.ok(rec.partial_matches[0].prefix_64.length <= 64);
  assert.ok(rec.partial_matches[0].prefix_64.startsWith("[Old tool result content cleared"));
});

test("4b. long trailing → prefix_64 captures only first 64 chars, byte_length reports full size", async () => {
  const long = SENTINEL_TS + " " + "x".repeat(200);
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", long)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_DUMP_MICROCOMPACT: dumpPath }, async () => {
      await runExt(body);
    });
  });
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.partial_matches.length, 1);
  assert.equal(rec.partial_matches[0].prefix_64.length, 64);
  assert.equal(rec.partial_matches[0].byte_length, Buffer.byteLength(long, "utf8"));
});

test("4c. CACHE_FIX_MICROCOMPACT_REDACT_LEN=0 → prefix_64 absent", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_PARTIAL_TRAILING)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_MICROCOMPACT_REDACT_LEN: "0",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.partial_matches.length, 1);
  assert.equal(rec.partial_matches[0].prefix_64, undefined);
  assert.equal(typeof rec.partial_matches[0].byte_length, "number");
});

// --- Custom patterns ---

test("5a. CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_1 adds custom Mode A pattern", () => {
  withEnv({ CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_1: "^\\[CC microcompact rev2\\]$" }, () => {
    const matched = matchesSentinelPattern("[CC microcompact rev2]", [
      { source: "^\\[CC microcompact rev2\\]$", re: /^\[CC microcompact rev2\]$/ },
    ]);
    assert.equal(matched, "^\\[CC microcompact rev2\\]$");
  });
});

test("5b. custom Mode A regex + custom Mode B prefix → exact match goes to exact_matches", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  // Exact match against a custom regex from a sentinel family that does NOT
  // share the built-in prefix. Verifies exact-match path for custom families.
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", "[CC microcompact rev2]")]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_1: "^\\[CC microcompact rev2\\]\\s*$",
        CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_1: "[CC microcompact",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches.length, 1);
  assert.equal(rec.partial_matches.length, 0);
  assert.equal(rec.exact_matches[0].sentinel_text, "[CC microcompact rev2]");
});

test("5c. custom Mode B prefix → variant-of-custom-family captured redacted in partial_matches", async () => {
  // The blocker Codex flagged: a custom sentinel family that matches
  // EXACTLY normalizes, but its prefix-only variant must also be captured
  // in Mode B (redacted) — not silently dropped just because the variant
  // doesn't share the built-in `[Old tool result content cleared` prefix.
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const text = "[CC microcompact rev2 at 2026-04-30T17:00:00Z] (with trailing content)";
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", text)]),
  ]);
  const before = JSON.stringify(body);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: "1",
        // Mode A regex won't match because of the trailing content.
        CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_1: "^\\[CC microcompact rev2\\]\\s*$",
        // Mode B prefix is what should fire here.
        CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_1: "[CC microcompact",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  // Body must not mutate — Mode B is never normalized.
  assert.equal(JSON.stringify(body), before);
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches.length, 0);
  assert.equal(rec.partial_matches.length, 1);
  assert.equal(rec.partial_matches[0].sentinel_text, undefined); // never full text
  assert.ok(rec.partial_matches[0].prefix_64.startsWith("[CC microcompact"));
});

// --- Tool_result content shapes ---

test("6. content as a string containing the sentinel → matched and normalizable at string level", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(body);
    });
  });
  assert.equal(body.messages[1].content[0].content, SENTINEL_BARE);
});

test("7. content as array [{type:text, text:<sentinel>}] → matched and normalized at item level", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockArray("t1", [{ type: "text", text: SENTINEL_TS }])]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(body);
    });
  });
  assert.equal(body.messages[1].content[0].content[0].text, SENTINEL_BARE);
});

test("8. mixed array (text + image) — only the text matches → image untouched", async () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  };
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockArray("t1", [{ type: "text", text: SENTINEL_TS }, image])]),
  ]);
  const beforeImage = JSON.stringify(body.messages[1].content[0].content[1]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(body);
    });
  });
  assert.equal(body.messages[1].content[0].content[0].text, SENTINEL_BARE);
  assert.equal(JSON.stringify(body.messages[1].content[0].content[1]), beforeImage);
});

// --- Diagnostic dump ---

test("9. dump set + sentinel match → JSONL line; session_id is hashed (no plaintext)", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_DUMP_MICROCOMPACT: dumpPath }, async () => {
      await runExt(body, { meta: { session_id: "secret-session-12345" } });
    });
  });
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches.length, 1);
  assert.equal(typeof rec.session_id_hash, "string");
  assert.equal(rec.session_id_hash.length, 8);
  assert.ok(!JSON.stringify(rec).includes("secret-session-12345"));
  assert.equal(rec.model, "claude-opus-4-7-20260101");
});

test("10. dump unset → no fs activity", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_BARE)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: undefined,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: undefined,
      },
      async () => {
        await runExt(body);
      },
    );
  });
  await assert.rejects(() => stat(dumpPath), /ENOENT/);
});

test("11. multiple matches in one request → ONE JSONL line with arrays split A/B", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([
      trBlockString("t1", SENTINEL_BARE), // exact
      trBlockString("t1b", SENTINEL_TS), // exact
      trBlockString("t1c", SENTINEL_PARTIAL_TRAILING), // partial
    ]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_DUMP_MICROCOMPACT: dumpPath }, async () => {
      await runExt(body);
    });
  });
  const lines = (await readFile(dumpPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.exact_matches.length, 2);
  assert.equal(rec.partial_matches.length, 1);
});

// --- Normalization ---

test("12. normalize on, default canonical → matched sentinel becomes bare; other fields preserved", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(body);
    });
  });
  const block = body.messages[1].content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "t1");
  assert.equal(block.content, SENTINEL_BARE);
});

test("13. normalize on + custom canonical → matched sentinel becomes the custom text", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_NORMALIZE_MICROCOMPACT: "1",
        CACHE_FIX_MICROCOMPACT_NORMALIZED: "[CLEARED]",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  assert.equal(body.messages[1].content[0].content, "[CLEARED]");
});

test("14. normalize disabled, dump enabled → matches recorded in dump but body NOT mutated", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  const before = JSON.stringify(body);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: undefined,
      },
      async () => {
        await runExt(body);
      },
    );
  });
  assert.equal(JSON.stringify(body), before);
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches.length, 1);
});

test("15. two requests with different timestamps → byte-identical bodies after normalization", async () => {
  const a = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", "[Old tool result content cleared at 2026-04-30T13:42:11Z]")]),
  ]);
  const b = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", "[Old tool result content cleared at 2026-04-30T17:55:33.001Z]")]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(a);
      await runExt(b);
    });
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// --- Activation ---

test("16. both gates unset → extension fires but exits early; no telemetry, no mutation, no fs", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_BARE)]),
  ]);
  const before = JSON.stringify(body);
  let ctx;
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: undefined,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: undefined,
      },
      async () => {
        ctx = await runExt(body);
      },
    );
  });
  assert.equal(JSON.stringify(body), before);
  assert.equal(ctx.meta.microcompactStats, undefined);
  await assert.rejects(() => stat(dumpPath), /ENOENT/);
});

test("17. only diagnostic enabled → telemetry present, JSONL written, no mutation", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  const before = JSON.stringify(body);
  let ctx;
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_DUMP_MICROCOMPACT: dumpPath }, async () => {
      ctx = await runExt(body);
    });
  });
  assert.equal(JSON.stringify(body), before);
  assert.ok(ctx.meta.microcompactStats);
  assert.equal(ctx.meta.microcompactStats.diagnostic_enabled, true);
  assert.equal(ctx.meta.microcompactStats.normalization_enabled, false);
  assert.equal(ctx.meta.microcompactStats.diagnostic_records_written, 1);
});

test("18. only normalize enabled → telemetry present, mutation happens, no JSONL", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  let ctx;
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      ctx = await runExt(body);
    });
  });
  assert.equal(body.messages[1].content[0].content, SENTINEL_BARE);
  assert.equal(ctx.meta.microcompactStats.normalization_enabled, true);
  assert.equal(ctx.meta.microcompactStats.sentinels_normalized, 1);
  await assert.rejects(() => stat(dumpPath), /ENOENT/);
});

test("19. both enabled → telemetry, mutation, AND JSONL all happen; raw text captured pre-normalization", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  let ctx;
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: "1",
      },
      async () => {
        ctx = await runExt(body);
      },
    );
  });
  // Body mutated.
  assert.equal(body.messages[1].content[0].content, SENTINEL_BARE);
  // Dump records the RAW pre-normalization text.
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches[0].sentinel_text, SENTINEL_TS);
  assert.equal(rec.exact_matches[0].normalized_text, undefined);
  // Telemetry attached.
  assert.equal(ctx.meta.microcompactStats.sentinels_normalized, 1);
});

test("19a. CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1 → adds normalized_text alongside raw sentinel_text", async () => {
  const dir = await mcTemp();
  const dumpPath = join(dir, "dump.jsonl");
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  await silenceStderrAsync(async () => {
    await withEnv(
      {
        CACHE_FIX_DUMP_MICROCOMPACT: dumpPath,
        CACHE_FIX_NORMALIZE_MICROCOMPACT: "1",
        CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED: "1",
      },
      async () => {
        await runExt(body);
      },
    );
  });
  const rec = JSON.parse((await readFile(dumpPath, "utf8")).trim());
  assert.equal(rec.exact_matches[0].sentinel_text, SENTINEL_TS);
  assert.equal(rec.exact_matches[0].normalized_text, SENTINEL_BARE);
});

// --- Telemetry shape ---

test("20. ctx.meta.microcompactStats contains every documented field after a sentinel-bearing request", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  let ctx;
  await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      ctx = await runExt(body);
    });
  });
  const s = ctx.meta.microcompactStats;
  for (const key of [
    "diagnostic_enabled",
    "normalization_enabled",
    "sentinel_pattern_used",
    "total_tool_results_scanned",
    "exact_matches_count",
    "partial_matches_count",
    "sentinels_matched",
    "sentinels_normalized",
    "bytes_original",
    "bytes_normalized",
    "bytes_saved",
    "diagnostic_records_written",
  ]) {
    assert.ok(key in s, `missing telemetry field: ${key}`);
  }
  assert.equal(s.exact_matches_count, 1);
  assert.equal(s.sentinels_matched, 1);
  assert.equal(s.sentinels_normalized, 1);
  assert.ok(s.bytes_saved > 0); // timestamp stripped
});

test("21. stderr summary line emitted with the spec format on enabled invocations", async () => {
  const body = makeBody([
    assistantMsg("t1"),
    userMsg([trBlockString("t1", SENTINEL_TS)]),
  ]);
  const [, captured] = await silenceStderrAsync(async () => {
    await withEnv({ CACHE_FIX_NORMALIZE_MICROCOMPACT: "1" }, async () => {
      await runExt(body);
    });
  });
  const line = captured.find((l) => l.startsWith("[microcompact]"));
  assert.ok(line, `no [microcompact] line, got: ${JSON.stringify(captured)}`);
  assert.match(line, /matched=1 normalized=1 bytes=\d+->\d+/);
});

// --- Direct unit tests on pure functions ---

test("matchesSentinelPattern returns null on non-string", () => {
  assert.equal(matchesSentinelPattern(undefined), null);
  assert.equal(matchesSentinelPattern(null), null);
  assert.equal(matchesSentinelPattern(42), null);
});

test("normalizeToolResultContent handles string and array shapes; returns false on missing target", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: SENTINEL_TS },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: SENTINEL_TS }] },
      ],
    },
  ];
  // String shape
  assert.equal(
    normalizeToolResultContent(messages, { msg_idx: 0, block_idx: 0, content_kind: "string" }, SENTINEL_BARE),
    true,
  );
  assert.equal(messages[0].content[0].content, SENTINEL_BARE);
  // Array shape
  assert.equal(
    normalizeToolResultContent(
      messages,
      { msg_idx: 0, block_idx: 1, content_kind: "array_item", item_idx: 0 },
      SENTINEL_BARE,
    ),
    true,
  );
  assert.equal(messages[0].content[1].content[0].text, SENTINEL_BARE);
  // Missing target
  assert.equal(
    normalizeToolResultContent(messages, { msg_idx: 99, block_idx: 0, content_kind: "string" }, SENTINEL_BARE),
    false,
  );
});

test("buildDiagnosticRecord captures total_messages and total_tool_results", () => {
  const reqCtx = {
    body: { model: "claude-opus-4-7", messages: [{ role: "user", content: [] }] },
    meta: { session_id: "abc" },
  };
  const rec = buildDiagnosticRecord(reqCtx, [], [], 0, { ts: "2026-04-30T00:00:00Z" });
  assert.equal(rec.ts, "2026-04-30T00:00:00Z");
  assert.equal(rec.total_messages, 1);
  assert.equal(rec.total_tool_results, 0);
  assert.equal(rec.model, "claude-opus-4-7");
  assert.equal(rec.exact_matches.length, 0);
  assert.equal(rec.partial_matches.length, 0);
});

// --- session_id fallback chain (#12-#15 from per-session quota-status directive) ---

import { createHash as _createHash } from "node:crypto";
function _hash8(s) {
  return _createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

test("12. hashSessionId reads x-claude-code-session-id (the canonical CC header)", () => {
  const sid = "b16c607d-d484-4935-840e-e3f7ee78eb08";
  const reqCtx = {
    body: { messages: [] },
    headers: { "x-claude-code-session-id": sid },
  };
  const rec = buildDiagnosticRecord(reqCtx, [], [], 0, { ts: "t" });
  assert.equal(rec.session_id_hash, _hash8(sid));
});

test("13. precedence: meta.session_id wins over canonical header", () => {
  const reqCtx = {
    body: { messages: [] },
    meta: { session_id: "from-meta" },
    headers: { "x-claude-code-session-id": "from-canonical-header" },
  };
  const rec = buildDiagnosticRecord(reqCtx, [], [], 0, { ts: "t" });
  assert.equal(rec.session_id_hash, _hash8("from-meta"));
});

test("14. precedence: canonical header wins over legacy x-session-id", () => {
  const reqCtx = {
    body: { messages: [] },
    headers: {
      "x-claude-code-session-id": "canonical",
      "x-session-id": "legacy",
    },
  };
  const rec = buildDiagnosticRecord(reqCtx, [], [], 0, { ts: "t" });
  assert.equal(rec.session_id_hash, _hash8("canonical"));
});

test("15. all sources missing → null", () => {
  const reqCtx = { body: { messages: [] } };
  const rec = buildDiagnosticRecord(reqCtx, [], [], 0, { ts: "t" });
  assert.equal(rec.session_id_hash, null);
});

// A dir minted outside mcTemp() is unregistered, so `after()` cannot remove it
// and a throwing case strands it, with the suite green either way.
// The lifecycle cannot be asserted in-process: the decision is taken on the way
// out, after every hook this file could run. So it is measured through a real
// child, both ways -- the passing arm is the control, without which "the dir is
// there" would also be what a registry that never cleans anything looks like.
test("scratch: a failing run keeps its scratch, a passing one does not", async () => {
  const registry = new URL("./scratch-registry.mjs", import.meta.url).href;
  const run = async (outcome) => {
    const dir = await mcTemp();
    const file = join(dir, `probe-${outcome}.test.mjs`);
    await writeFile(file, `
import { test } from "node:test";
import assert from "node:assert/strict";
import { scratchDir } from ${JSON.stringify(registry)};
test("probe", async () => {
  const d = await scratchDir("mcprobe-");
  console.error("PROBE_DIR=" + d);
  ${outcome === "fail" ? 'assert.fail("deliberate");' : "assert.ok(true);"}
});
`);
    // NODE_TEST_CONTEXT is inherited, and the runner refuses to run files when it
    // sees it ("run() is being called recursively"), so the child would report
    // nothing and the case would fail on its own plumbing.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", file],
                        { env, encoding: "utf8", timeout: 60_000 });
    // STDOUT, not stderr: node:test captures a case's output and re-emits it on
    // its own stream, so a child's `process.stderr.write` arrives here.
    const out = `${r.stdout}${r.stderr}`;
    const probe = /PROBE_DIR=(.*)/.exec(out)?.[1]?.trim();
    assert.ok(probe, `the probe never reported its dir: ${out}`);
    return { probe, status: r.status, out };
  };

  const failed = await run("fail");
  assert.notEqual(failed.status, 0, "premise: the failing probe exited 0");
  assert.ok(existsSync(failed.probe),
    "a failing run deleted the scratch that is the only record of what it was looking at");
  assert.match(failed.out, /\[scratch kept\]/,
    "the dir was kept and never named — the caller cannot find it");
  rmSync(failed.probe, { recursive: true, force: true });

  const passed = await run("pass");
  assert.equal(passed.status, 0, "premise: the passing probe did not pass");
  assert.ok(!existsSync(passed.probe),
    "a passing run left its scratch behind — the registry cleans nothing");
});

test("scratch: no test body mints an unregistered temp dir", async () => {
  const src = await readFile(new URL(import.meta.url), "utf8");
  // Matches any quoted prefix, which the registrar (passing a const) does not
  // have. Line comments are skipped and this line's own escaping keeps it from
  // matching itself, so neither the prose above nor the assertion self-flags.
  // Only "//": nothing can follow it on the line, while a block comment closes
  // mid-line, so skipping "/*" and "*" would hide a real mint after the close
  // and behind any generator method. Ceiling: a single-line textual match on
  // one exact call form, so any other spelling passes.
  const call = /mkdtemp(?:Sync)?\(join\(tmpdir\(\),\s*["'`][^"'`]+["'`]\s*\)\)/;
  const raw = src.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => !l.trim().startsWith("//"))
    .filter(([, l]) => call.test(l))
    .map(([n]) => n);
  assert.deepEqual(raw, [],
    `every temp dir must go through mcTemp(); raw mkdtemp at line(s): ${raw.join(", ")}`);
  // POSITIVE CONTROL. Without it the pattern can be neutered -- a typo, a
  // rename, anything -- and this case stays green over a file it no longer
  // matches. Assembled from pieces so the sample itself is not a mint on this
  // line for the pattern above to find.
  const sample = ["mkdtemp", "(join(tmpdir(), ", '"x-"))'].join("");
  assert.ok(call.test(sample), "the pattern no longer matches a raw mint");
  // The premise is a SOURCE count, not a runtime array: the registration moved
  // out of this file, so a runtime one would now be empty here and read green.
  assert.ok(src.split("mcTemp(").length - 1 > 1, "premise: this file does mint temp dirs");
});
