// proxy-stream-utf8-boundary — a multi-byte UTF-8 character that straddles
// two upstream chunks must come out of streamResponse() intact.
//
// The bug (#365): streamResponse decoded every chunk on its own with
// chunk.toString(). A CJK character is three bytes; cut it between chunks and
// each fragment decodes to U+FFFD, so the SSE JSON text_delta that reaches
// Claude Code carries "���" instead of the character. Nothing downstream can
// repair that — it lands in the reply, in tool-call arguments and in the
// session transcript.
//
// The fixture is the smallest wire shape that exercises the changed path:
// one content_block_delta event, no extensions (extSnapshot = []), so the
// only transform between upstream bytes and clientRes.write() is the decode.
// Every identifier here is synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { streamResponse, createTelemetryRecord } from "../proxy/stream.mjs";

const TEXT = "阴气渐重，露凝而白也 🐸 end";

function wireFor(text) {
  const event = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  return Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`);
}

// Async iterable that yields the wire bytes cut at the given byte offsets.
async function* chunked(buf, cuts) {
  let at = 0;
  for (const cut of cuts) {
    yield buf.subarray(at, cut);
    at = cut;
  }
  yield buf.subarray(at);
}

function fakeClient() {
  const out = [];
  return {
    out,
    ended: false,
    write(s) { out.push(String(s)); return true; },
    once() {},
    end() { this.ended = true; },
  };
}

function deltaTextFrom(client) {
  const dataLine = client.out.join("").split("\n").find((l) => l.startsWith("data: "));
  assert.ok(dataLine, "no data: line reached the client");
  return JSON.parse(dataLine.slice(6)).delta.text;
}

async function run(cuts, text = TEXT) {
  const wire = wireFor(text);
  const client = fakeClient();
  await streamResponse(chunked(wire, cuts), client, createTelemetryRecord(), [], {}, {});
  assert.equal(client.ended, true);
  return client;
}

// Byte offset that lands inside `ch` (after its first byte) within the wire.
function insideChar(ch, text = TEXT) {
  const wire = wireFor(text);
  const idx = wire.indexOf(Buffer.from(ch));
  assert.ok(idx > 0, `fixture does not contain ${ch}`);
  return idx + 1;
}

test("passthrough: a single chunk is relayed verbatim", async () => {
  const client = await run([]);
  assert.equal(deltaTextFrom(client), TEXT);
  assert.ok(!client.out.join("").includes("�"));
});

test("a 3-byte CJK character cut between two chunks survives", async () => {
  const client = await run([insideChar("渐")]);
  assert.equal(deltaTextFrom(client), TEXT);
  assert.ok(!client.out.join("").includes("�"));
});

test("a 4-byte emoji cut in the middle survives, and so does a second cut in the same event", async () => {
  const emojiCut = insideChar("🐸") + 1;        // two bytes in, two to go
  const client = await run([insideChar("露"), emojiCut]);
  assert.equal(deltaTextFrom(client), TEXT);
  assert.ok(!client.out.join("").includes("�"));
});

test("a character cut into one byte per chunk survives", async () => {
  const start = insideChar("重") - 1;
  const client = await run([start + 1, start + 2]);
  assert.equal(deltaTextFrom(client), TEXT);
});

test("a stream that ends mid-character flushes the partial as U+FFFD instead of dropping it", async () => {
  // No trailing newline and the last character truncated: the decoder must
  // still emit something for the dangling bytes at end-of-stream.
  const wire = Buffer.from("event: ping\ndata: {\"type\":\"ping\",\"note\":\"渐");
  const truncated = wire.subarray(0, wire.length - 1);
  const client = fakeClient();
  await streamResponse(chunked(truncated, [truncated.length - 1]), client, createTelemetryRecord(), [], {}, {});
  const tail = client.out.join("");
  assert.ok(tail.endsWith("�\n"), `expected a flushed replacement char at end-of-stream, got ${JSON.stringify(tail.slice(-8))}`);
});
