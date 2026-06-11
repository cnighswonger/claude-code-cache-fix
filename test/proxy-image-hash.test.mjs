import { test } from "node:test";
import assert from "node:assert/strict";
import { imageHashesFromBody } from "../proxy/image-hash.mjs";

const IMG_A_BYTES = Buffer.from("img-a-payload-bytes");
const IMG_B_BYTES = Buffer.from("a-completely-different-image-payload");

const IMG_A_B64 = IMG_A_BYTES.toString("base64");
const IMG_B_B64 = IMG_B_BYTES.toString("base64");

// Equivalent base64 encoding with different wrapping/padding: Node accepts
// embedded whitespace and we still decode to the same bytes.
const IMG_A_B64_REWRAPPED = IMG_A_B64.match(/.{1,4}/g).join("\n");

function userImageMsg(b64, mediaType = "image/png") {
  return { role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } }] };
}

function userTextMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

test("same image bytes via different base64 encodings hash identically", () => {
  const a = imageHashesFromBody({ messages: [userImageMsg(IMG_A_B64)] });
  const b = imageHashesFromBody({ messages: [userImageMsg(IMG_A_B64_REWRAPPED)] });
  assert.equal(a.size, 1);
  assert.equal(b.size, 1);
  assert.deepEqual([...a], [...b]);
});

test("different images produce different hashes", () => {
  const a = imageHashesFromBody({ messages: [userImageMsg(IMG_A_B64)] });
  const b = imageHashesFromBody({ messages: [userImageMsg(IMG_B_B64)] });
  assert.notDeepEqual([...a], [...b]);
});

test("non-image content blocks produce no hash", () => {
  const out = imageHashesFromBody({ messages: [userTextMsg("hello")] });
  assert.equal(out.size, 0);
});

test("multi-image request produces a hash per distinct image", () => {
  const out = imageHashesFromBody({
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: IMG_A_B64 } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: IMG_B_B64 } },
      { type: "text", text: "describe" },
    ] }],
  });
  assert.equal(out.size, 2);
});

test("URL-source images are ignored (only base64 source is hashed)", () => {
  const out = imageHashesFromBody({
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
    ] }],
  });
  assert.equal(out.size, 0);
});

test("empty / malformed inputs return empty set, never throw", () => {
  assert.equal(imageHashesFromBody(null).size, 0);
  assert.equal(imageHashesFromBody({}).size, 0);
  assert.equal(imageHashesFromBody({ messages: null }).size, 0);
  assert.equal(imageHashesFromBody({ messages: [{}] }).size, 0);
  assert.equal(imageHashesFromBody({ messages: [{ content: null }] }).size, 0);
  assert.equal(imageHashesFromBody({ messages: [{ content: [{ type: "image" }] }] }).size, 0);
  assert.equal(imageHashesFromBody({ messages: [{ content: [{ type: "image", source: { type: "base64", data: "" } }] }] }).size, 0);
});

test("duplicate images in the same body collapse to one hash entry", () => {
  const out = imageHashesFromBody({
    messages: [
      userImageMsg(IMG_A_B64),
      userImageMsg(IMG_A_B64),
      userImageMsg(IMG_A_B64),
    ],
  });
  assert.equal(out.size, 1);
});
