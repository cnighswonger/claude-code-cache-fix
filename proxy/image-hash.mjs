import { createHash } from "node:crypto";

// SHA-256 of the decoded bytes of every base64-encoded image content block in a
// messages-request body. Hash is over the decoded image bytes, not the base64
// string — the harness may re-encode with different line wrapping / padding, and
// we want identical-bytes equality, not identical-strings.
//
// Used by image-retry-circuit-breaker (directive: proxy-image-retry-circuit-breaker)
// to detect a harness retry of the same image content after a permanent
// image-processing failure.
//
// Returns a Set<string> of lowercase hex SHA-256 digests for matching against
// stashed failure entries. Empty Set when no qualifying image blocks are
// present (text-only request, references-only `source.type: "url"`, malformed
// payload, etc.).
//
// The breaker's failure-recording branch stashes the request's hash set on
// ctx.meta._imageRetryHashes at onRequest time so the matching onResponse can
// recover them without re-extracting from the body.

export function imageHashesFromBody(body) {
  const out = new Set();
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return out;
  for (const msg of body.messages) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const hash = hashImageBlock(block);
      if (hash) out.add(hash);
    }
  }
  return out;
}

function hashImageBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type !== "image") return null;
  const source = block.source;
  if (!source || typeof source !== "object") return null;
  if (source.type !== "base64") return null;
  const data = source.data;
  if (typeof data !== "string" || data.length === 0) return null;
  let bytes;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  if (!bytes || bytes.length === 0) return null;
  return createHash("sha256").update(bytes).digest("hex");
}
