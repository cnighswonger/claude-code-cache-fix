import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeFingerprint,
  diffFingerprints,
  bucketBlockSize,
  matchKnownSectionMarkers,
  matchKnownReminderPatterns,
  hasUnknownSectionMarker,
  hasUnknownReminderPattern,
  namespaceKey,
  loadBaseline,
  persistBaseline,
  processRequestForTest,
  formatStderrLine,
  _resetForTest,
} from "../proxy/extensions/upstream-change-detection.mjs";

async function freshExt() {
  const mod = await import(`../proxy/extensions/upstream-change-detection.mjs?t=${Date.now()}`);
  mod._resetForTest();
  return mod;
}

async function newTmp() {
  return mkdtemp(join(tmpdir(), "upstream-change-test-"));
}

function makeBody(overrides = {}) {
  return {
    model: "claude-opus-4-7",
    system: [{ type: "text", text: "You are Claude.\n# Environment\nLinux\n" }],
    tools: [
      { name: "Bash", input_schema: { properties: { command: {} } } },
      { name: "Read", input_schema: { properties: { file_path: {} } } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
    max_tokens: 4096,
    stream: true,
    ...overrides,
  };
}

// --- 1. Stability across prompt variation ---

test("1. same structure with different message text → identical fingerprint", () => {
  const a = makeBody({ messages: [{ role: "user", content: [{ type: "text", text: "first prompt" }] }] });
  const b = makeBody({ messages: [{ role: "user", content: [{ type: "text", text: "totally different prompt" }] }] });
  // Both have same number of blocks at the same size bucket (tiny).
  const fa = computeFingerprint(a);
  const fb = computeFingerprint(b);
  assert.deepEqual(fa, fb, "fingerprints should be identical for same structure");
});

// --- 2. Stability across timestamp drift ---

test("2. fingerprint contains no timestamp; identical across compute time", () => {
  const body = makeBody();
  const f1 = computeFingerprint(body);
  // Sleep is unnecessary — fingerprint must not include Date.now() at all.
  const f2 = computeFingerprint(body);
  assert.deepEqual(f1, f2);
  // Walk and assert no field name suggests time.
  const json = JSON.stringify(f1);
  assert.equal(json.includes("timestamp"), false);
  assert.equal(json.includes("\"ts\""), false);
});

// --- 3. Detect cache_control count change ---

test("3. cache_control count change produces diff entry", () => {
  const a = makeBody({
    system: [
      { type: "text", text: "block A", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block B", cache_control: { type: "ephemeral" } },
    ],
  });
  const b = makeBody({
    system: [
      { type: "text", text: "block A", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block B", cache_control: { type: "ephemeral" } },
      { type: "text", text: "block C", cache_control: { type: "ephemeral" } },
    ],
  });
  const fa = computeFingerprint(a);
  const fb = computeFingerprint(b);
  const diff = diffFingerprints(fa, fb);
  const paths = diff.map((d) => d.path);
  assert.ok(paths.includes("system.cache_control_count"), `expected system.cache_control_count in diff, got ${paths.join(",")}`);
});

// --- 4. Detect tool addition ---

test("4. tool addition changes count and names_sorted_hash", () => {
  const a = makeBody();
  const b = makeBody({
    tools: [
      ...makeBody().tools,
      { name: "Write", input_schema: { properties: { file_path: {}, content: {} } } },
    ],
  });
  const diff = diffFingerprints(computeFingerprint(a), computeFingerprint(b));
  const paths = diff.map((d) => d.path);
  assert.ok(paths.includes("tools.count"));
  assert.ok(paths.includes("tools.names_sorted_hash"));
});

// --- 5. Detect new known reminder tag ---

test("5. new known reminder tag changes set hash and count", () => {
  const a = makeBody({
    messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>foo</system-reminder>" }] }],
  });
  const b = makeBody({
    messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>foo</system-reminder> <command-name>/loop</command-name>" }] }],
  });
  const diff = diffFingerprints(computeFingerprint(a), computeFingerprint(b));
  const paths = diff.map((d) => d.path);
  assert.ok(paths.includes("messages.known_reminder_pattern_count"));
  assert.ok(paths.includes("messages.known_reminder_pattern_set_hash"));
});

// --- 6. Detect new UNKNOWN reminder tag ---

test("6. unknown reminder tag flips boolean false → true", () => {
  const a = makeBody({
    messages: [{ role: "user", content: [{ type: "text", text: "no tags here" }] }],
  });
  const b = makeBody({
    messages: [{ role: "user", content: [{ type: "text", text: "<brand-new-anthropic-tag>data</brand-new-anthropic-tag>" }] }],
  });
  const fa = computeFingerprint(a);
  const fb = computeFingerprint(b);
  assert.equal(fa.messages.unknown_reminder_pattern_present, false);
  assert.equal(fb.messages.unknown_reminder_pattern_present, true);
  const diff = diffFingerprints(fa, fb);
  const paths = diff.map((d) => d.path);
  assert.ok(paths.includes("messages.unknown_reminder_pattern_present"));
});

// --- 7. Detect system block size jump ---

test("7. block size bucket change produces diff", () => {
  const a = makeBody({ system: [{ type: "text", text: "x".repeat(100) }] }); // tiny
  const b = makeBody({ system: [{ type: "text", text: "x".repeat(50000) }] }); // large
  const fa = computeFingerprint(a);
  const fb = computeFingerprint(b);
  assert.equal(fa.system.block_size_buckets[0], "tiny");
  assert.equal(fb.system.block_size_buckets[0], "large");
  const diff = diffFingerprints(fa, fb);
  assert.ok(diff.some((d) => d.path === "system.block_size_buckets"));
});

// --- 8. Namespace separation ---

test("8. different model strings produce separate namespace keys", () => {
  const ka = namespaceKey("claude-opus-4-7", []);
  const kb = namespaceKey("claude-haiku-4-5", []);
  assert.notEqual(ka, kb);
  const kc = namespaceKey("claude-opus-4-7", []);
  assert.equal(ka, kc);
});

// --- 9. Beta header addition ---

test("9. beta header addition (via request header) produces a new namespace key AND fingerprint diff", () => {
  const ka = namespaceKey("claude-opus-4-7", ["claude-extended-cache-ttl-2025-04-11"]);
  const kb = namespaceKey("claude-opus-4-7", ["claude-extended-cache-ttl-2025-04-11", "thinking-2025-08-01"]);
  assert.notEqual(ka, kb);
  // Beta features arrive on the anthropic-beta REQUEST HEADER, not in the body.
  const headersA = { "anthropic-beta": "claude-extended-cache-ttl-2025-04-11" };
  const headersB = { "anthropic-beta": "claude-extended-cache-ttl-2025-04-11,thinking-2025-08-01" };
  const fa = computeFingerprint(makeBody(), headersA);
  const fb = computeFingerprint(makeBody(), headersB);
  assert.notEqual(fa.namespace.beta_headers_sorted_hash, fb.namespace.beta_headers_sorted_hash);
  assert.notEqual(fa.namespace.beta_headers_count, fb.namespace.beta_headers_count);
});

test("9b. beta source is the anthropic-beta request header (not body) — distinct sets do not collapse", () => {
  // The original bug: extractBetaHeaders read body.anthropic_beta. The proxy
  // doesn't put beta there — it lives on the request header. So in production,
  // every request would have the same (empty) beta and distinct sets would
  // collapse into one namespace.
  const fHeaderEmpty = computeFingerprint(makeBody(), {});
  const fHeaderSet = computeFingerprint(makeBody(), { "anthropic-beta": "feature-x,feature-y" });
  assert.notEqual(
    fHeaderEmpty.namespace.beta_headers_sorted_hash,
    fHeaderSet.namespace.beta_headers_sorted_hash,
    "header presence MUST flip the namespace hash",
  );
  assert.equal(fHeaderEmpty.namespace.beta_headers_count, 0);
  assert.equal(fHeaderSet.namespace.beta_headers_count, 2);
});

// --- 10. Baseline established event ---

test("10. first-ever fingerprint emits baseline_established, not alert", async () => {
  await freshExt();
  const dir = await newTmp();
  try {
    const result = await processRequestForTest(makeBody(), { dir, map: new Map() });
    assert.equal(result.event, "baseline_established");
    const text = await readFile(join(dir, "upstream-changes.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.equal(evt.event, "baseline_established");
    assert.ok(evt.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 11. Baseline persistence ---

test("11. baseline persists to disk and rehydrates after a fresh module load", async () => {
  process.env.CACHE_FIX_UPSTREAM_DETECTION = "1";
  process.env.CACHE_FIX_UPSTREAM_QUIET = "1";
  const dir = await newTmp();
  process.env.CACHE_FIX_UPSTREAM_DIR = dir;
  try {
    // Round 1: establish baseline.
    const ext1 = await freshExt();
    const ctx1 = { body: makeBody() };
    await ext1.default.onRequest(ctx1);
    // Round 2: simulate restart by loading a brand-new module instance.
    const ext2 = await freshExt();
    // Send the SAME body — should be a no-op (no alert, no new event line).
    const ctx2 = { body: makeBody() };
    await ext2.default.onRequest(ctx2);
    const text = await readFile(join(dir, "upstream-changes.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "expected only the original baseline_established event after restart");
  } finally {
    delete process.env.CACHE_FIX_UPSTREAM_DETECTION;
    delete process.env.CACHE_FIX_UPSTREAM_QUIET;
    delete process.env.CACHE_FIX_UPSTREAM_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 12. Atomic baseline write — crash before rename ---

test("12. rename failure leaves prior baseline intact and tmp cleaned up", async () => {
  await freshExt();
  const dir = await newTmp();
  try {
    // Pre-seed a known baseline file.
    const seed = { version: 1, namespaces: { keep: { fingerprint: { v: 1 } } } };
    const path = join(dir, "upstream-baseline.json");
    await writeFile(path, JSON.stringify(seed));
    const failingFs = {
      mkdir: async () => {},
      readFile: async (p) => readFile(p, "utf8"),
      writeFile: async (p, c) => writeFile(p, c),
      rename: async () => { throw new Error("simulated rename failure"); },
      unlink: async (p) => {
        // Track tmp file unlinks so we can verify cleanup happens in finally.
        const { unlink } = await import("node:fs/promises");
        try { await unlink(p); } catch {}
      },
      appendFile: async () => {},
    };

    let threw = false;
    try {
      await persistBaseline(failingFs, dir);
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, true, "persistBaseline should propagate rename failure");

    // Prior file unchanged.
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(after, seed, "prior baseline file must remain intact on rename failure");

    // No leftover tmp.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const tmps = files.filter((f) => f.includes(".tmp."));
    assert.equal(tmps.length, 0, `expected no leftover tmp files, found: ${tmps.join(",")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 13. Atomic baseline write — unique tmp suffix ---

test("13. concurrent persistBaseline calls use distinct tmp paths", async () => {
  await freshExt();
  const dir = await newTmp();
  try {
    const tmpPaths = new Set();
    const captureFs = {
      mkdir: async () => {},
      readFile: async (p) => readFile(p, "utf8"),
      writeFile: async (p, c) => {
        tmpPaths.add(p);
        await writeFile(p, c);
      },
      rename: async (from, to) => {
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
      unlink: async (p) => {
        const { unlink } = await import("node:fs/promises");
        try { await unlink(p); } catch {}
      },
      appendFile: async () => {},
    };

    await Promise.all([
      persistBaseline(captureFs, dir),
      persistBaseline(captureFs, dir),
      persistBaseline(captureFs, dir),
    ]);
    assert.equal(tmpPaths.size, 3, `expected 3 distinct tmp paths, got ${tmpPaths.size}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 14. JSONL append concurrency ---

test("14. 50 parallel appendEvent calls produce 50 well-formed JSON lines", async () => {
  const dir = await newTmp();
  try {
    const { appendEvent } = await import("../proxy/extensions/upstream-change-detection.mjs");
    const records = Array.from({ length: 50 }, (_, i) => ({
      ts: `2026-04-25T10:00:${String(i).padStart(2, "0")}Z`,
      event: "structural_change",
      seq: i,
    }));
    await Promise.all(records.map((r) => appendEvent(r, undefined, dir)));
    const text = await readFile(join(dir, "upstream-changes.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 50, `expected exactly 50 lines, got ${lines.length}`);
    for (const line of lines) {
      JSON.parse(line);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 15. Disabled ---

test("15. when env var unset, onRequest is a no-op — no files created", async () => {
  // Explicitly do NOT set CACHE_FIX_UPSTREAM_DETECTION.
  const dir = await newTmp();
  process.env.CACHE_FIX_UPSTREAM_DIR = dir;
  try {
    const ext = await freshExt();
    await ext.default.onRequest({ body: makeBody() });
    let baselineExists = false;
    try { await readFile(join(dir, "upstream-baseline.json"), "utf8"); baselineExists = true; } catch {}
    let jsonlExists = false;
    try { await readFile(join(dir, "upstream-changes.jsonl"), "utf8"); jsonlExists = true; } catch {}
    assert.equal(baselineExists, false, "baseline file must not be created when extension disabled");
    assert.equal(jsonlExists, false, "JSONL file must not be created when extension disabled");
  } finally {
    delete process.env.CACHE_FIX_UPSTREAM_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 16. Quiet mode ---

test("16. quiet mode suppresses stderr emission, still writes JSONL", async () => {
  process.env.CACHE_FIX_UPSTREAM_DETECTION = "1";
  process.env.CACHE_FIX_UPSTREAM_QUIET = "1";
  const dir = await newTmp();
  process.env.CACHE_FIX_UPSTREAM_DIR = dir;
  const origWrite = process.stderr.write.bind(process.stderr);
  let stderrBytes = "";
  process.stderr.write = (chunk) => { stderrBytes += chunk; return true; };
  try {
    const ext = await freshExt();
    // First call → baseline_established (no stderr expected for baseline)
    await ext.default.onRequest({ body: makeBody() });
    // Second call → structural change (would normally emit stderr)
    await ext.default.onRequest({ body: makeBody({ tools: [] }) });
    assert.equal(stderrBytes.includes("[upstream-change]"), false, "expected no stderr in quiet mode");
    const text = await readFile(join(dir, "upstream-changes.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
  } finally {
    process.stderr.write = origWrite;
    delete process.env.CACHE_FIX_UPSTREAM_DETECTION;
    delete process.env.CACHE_FIX_UPSTREAM_QUIET;
    delete process.env.CACHE_FIX_UPSTREAM_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 17. Allowlist match correctness ---

test("17. known section markers detected; unknown markers excluded", () => {
  const text = "intro\n# Environment\nlinux\n# Tools\nbash\n# FakeNew\nstuff";
  const known = matchKnownSectionMarkers(text);
  // Must include indices for "# Environment" (0) and "# Tools" (2).
  assert.ok(known.includes(0));
  assert.ok(known.includes(2));
  // Must NOT include any "# FakeNew" — it's not in the allowlist.
  // (we can't directly assert "doesn't include", since indices are integers,
  //  but we can assert the count matches what we expect)
  assert.equal(known.length, 2);
  assert.equal(hasUnknownSectionMarker(text), true, "should detect unknown # FakeNew");
});

test("17b. known reminder patterns detected; unknown excluded", () => {
  const text = "<system-reminder>x</system-reminder> <brand-new>y</brand-new>";
  const known = matchKnownReminderPatterns(text);
  assert.ok(known.includes(0)); // <system-reminder> is index 0
  assert.equal(hasUnknownReminderPattern(text), true);
});

test("17c. section-marker matching is strict line-based — no prefix-substring matches", () => {
  // Regression: "# Environment Details" must NOT count as the known marker
  // "# Environment". The original implementation used substring-based search
  // which would have falsely set the indices.
  const text = "intro\n# Environment Details\nstuff\n# Toolset News\n";
  const known = matchKnownSectionMarkers(text);
  // Neither "# Environment" (because " Details" follows on the same line) nor
  // "# Tools" (because "et News" follows) should match.
  assert.equal(known.length, 0, `expected zero strict matches, got ${JSON.stringify(known)}`);
  // The shape regex DOES match these lines, so unknown-marker boolean flips.
  assert.equal(hasUnknownSectionMarker(text), true);
});

test("17d. section-marker matches the exact line and nothing more", () => {
  const text = "intro\n# Environment\nlinux\n# Environment Details\nfoo\n";
  const known = matchKnownSectionMarkers(text);
  // "# Environment" appears on its own line in addition to "# Environment Details".
  // The exact-line one matches; the other doesn't.
  assert.deepEqual(known, [0], "only the exact-line '# Environment' should match");
});

// --- 18. Content-free guarantee ---

test("18. fingerprint never echoes prompt content (SECRET-TOKEN-XYZ probe)", () => {
  const SECRET = "SECRET-TOKEN-XYZ-DO-NOT-LEAK";
  const body = makeBody({
    system: [{ type: "text", text: `# Environment\nThe machine secret is ${SECRET}.\n` }],
    messages: [
      { role: "user", content: [{ type: "text", text: `Please use ${SECRET} to authenticate.` }] },
      { role: "assistant", content: [{ type: "text", text: `Acknowledged. Stored ${SECRET}.` }] },
      { role: "user", content: [{ type: "text", text: `<system-reminder>token=${SECRET}</system-reminder>` }] },
    ],
  });
  const fp = computeFingerprint(body);
  const json = JSON.stringify(fp);
  assert.equal(json.includes(SECRET), false, "secret must not appear anywhere in fingerprint");
  assert.equal(json.includes("DO-NOT-LEAK"), false, "secret fragment must not appear either");
});

// --- Bonus: bucket boundaries ---

test("bucketBlockSize honors documented thresholds", () => {
  assert.equal(bucketBlockSize(0), "tiny");
  assert.equal(bucketBlockSize(199), "tiny");
  assert.equal(bucketBlockSize(200), "small");
  assert.equal(bucketBlockSize(1999), "small");
  assert.equal(bucketBlockSize(2000), "medium");
  assert.equal(bucketBlockSize(19999), "medium");
  assert.equal(bucketBlockSize(20000), "large");
  assert.equal(bucketBlockSize(99999), "large");
});

test("formatStderrLine includes path summaries", () => {
  const line = formatStderrLine({
    ts: "2026-04-25T10:00:00Z",
    namespace: { model: "claude-opus-4-7", beta_headers_count: 2 },
    diff: [
      { path: "system.cache_control_count", from: 2, to: 3 },
      { path: "tools.count", from: 31, to: 33 },
    ],
  });
  assert.ok(line.startsWith("[upstream-change]"));
  assert.ok(line.includes("model=claude-opus-4-7"));
  assert.ok(line.includes("beta=2"));
  assert.ok(line.includes("system.cache_control_count"));
  assert.ok(line.includes("2 → 3"));
});

test("loadBaseline tolerates missing file", async () => {
  await freshExt();
  const dir = await newTmp();
  try {
    const map = await loadBaseline(undefined, dir);
    assert.equal(map.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBaseline tolerates corrupt file", async () => {
  await freshExt();
  const dir = await newTmp();
  try {
    const path = join(dir, "upstream-baseline.json");
    await writeFile(path, "not valid json {{{");
    const map = await loadBaseline(undefined, dir);
    assert.equal(map.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
