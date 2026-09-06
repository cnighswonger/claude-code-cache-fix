// read-lines — the pull-based JSONL reader all capture-walking tools share.
//
// The load-bearing test here is backpressure. The readline shape this module
// replaced passed every functional test while buffering the entire remaining
// file the moment its consumer awaited (2.3 GB queued by line 75 on a live
// 1.5 GB capture, 2026-07-29). The functional tests below could never catch
// that; only watching the file position can. During development the
// backpressure test was run against the readline shape and failed with
// bytesRead === file size after ONE consumed line — that red run is what
// makes it a bite test rather than a hope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLines, READ_CHUNK_SIZE } from "../tools/read-lines.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTempFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "read-lines-"));
  const path = join(dir, "f.jsonl");
  await writeFile(path, content);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(iter) {
  const out = [];
  for await (const line of iter) out.push(line);
  return out;
}

test("splits lines; final unterminated line included; trailing newline adds none", async () => {
  await withTempFile("a\nb\nc", async (p) => {
    assert.deepEqual(await collect(readLines(p)), ["a", "b", "c"]);
  });
  await withTempFile("a\nb\n", async (p) => {
    assert.deepEqual(await collect(readLines(p)), ["a", "b"]);
  });
});

test("CRLF behaves like readline crlfDelay:Infinity; blank lines survive as empty strings", async () => {
  await withTempFile("a\r\nb\r\n\r\nc", async (p) => {
    assert.deepEqual(await collect(readLines(p)), ["a", "b", "", "c"]);
  });
});

test("UTF-8 sequence split across chunk boundaries stays intact", async () => {
  // A line of umlauts long enough that a 2-byte sequence is guaranteed to
  // straddle at least one chunk boundary at any chunk size.
  const line = "ü".repeat(READ_CHUNK_SIZE);
  await withTempFile(`${line}\nend`, async (p) => {
    const got = await collect(readLines(p));
    assert.equal(got[0], line);
    assert.equal(got[1], "end");
  });
});

test("a line larger than the chunk size is delivered whole", async () => {
  const big = "x".repeat(READ_CHUNK_SIZE * 2 + 17);
  await withTempFile(`${big}\nsmall`, async (p) => {
    const got = await collect(readLines(p));
    assert.equal(got[0].length, big.length);
    assert.equal(got[1], "small");
  });
});

// --- BITE: backpressure ---
//
// The mechanism, not a memory statistic: while the consumer sits in awaits
// between lines, the underlying stream's file position must stand still.
// bytesRead may exceed the consumed bytes only by the read-ahead bound
// (buffered chunks), never run to EOF. Run against the readline shape this
// asserts 20 MB read after one line and fails; against the pull-based reader
// it stays within the bound.
test("BITE — an awaiting consumer must not let the reader run ahead of the bound", async () => {
  const line = "y".repeat(64 * 1024);
  const lines = 300; // ~19 MB
  const content = Array(lines).fill(line).join("\n") + "\n";
  await withTempFile(content, async (p) => {
    const chunk = 256 * 1024;
    const stream = createReadStream(p, { encoding: "utf8", highWaterMark: chunk });
    // Generous bound: consumed bytes + internal read-ahead (a few chunks).
    // The defect this guards against overshoots by the WHOLE remaining file,
    // so the margin between bound and defect is ~18 MB — not a close call.
    const slack = 8 * chunk;
    let consumed = 0;
    let n = 0;
    for await (const l of readLines(stream)) {
      n++;
      consumed += Buffer.byteLength(l) + 1;
      await sleep(1); // park the consumer; a push-based reader runs to EOF here
      assert.ok(
        stream.bytesRead <= consumed + slack,
        `reader ran ahead: consumed=${consumed} bytesRead=${stream.bytesRead} after line ${n}`,
      );
      if (n >= 20) break;
    }
    assert.equal(n, 20);
    assert.ok(stream.bytesRead < content.length / 2, "reader must not have slurped the file");
  });
});
