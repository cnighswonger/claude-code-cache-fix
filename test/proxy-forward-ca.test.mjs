// Tests for the forward-proxy CA/leaf generation in proxy/forward-proxy.mjs.
//
// These lock down the CA-path correctness fixes Codex flagged on PR #251. Here:
// ensureCA() must return a matching, chaining leaf key/cert pair, reuse the root
// CA across calls, and never serve a mismatched key + cert (a stray/old leaf.key
// that does not correspond to the SAN-valid leaf.pem).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";

const REPO = new URL("..", import.meta.url).pathname;
const FWD = join(REPO, "proxy/forward-proxy.mjs");

const ENV_KEYS = [
  "CACHE_FIX_CA_DIR", "CACHE_FIX_FORWARD_PROXY", "CLAUDE_CONFIG_DIR",
  "CACHE_FIX_DOWNLOAD_REWRITE", "CACHE_FIX_CA_LOCK_WAIT_MS", "CACHE_FIX_CA_FORCE_ROTATE",
];

// Run fn with a fresh temp CA dir and forward-proxy on, restoring env after.
function withCA(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "fwd-ca-"));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CACHE_FIX_CA_DIR = dir;
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
    return fn(dir);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// forward-proxy.mjs reads config live, but ES modules are cached — importing it
// once is enough since ensureCA() re-reads config.caDir on every call.
const { ensureCA } = await import(FWD);

function spkiDer(keyLike) {
  return createPublicKey(keyLike).export({ type: "spki", format: "der" });
}
// The returned leaf key matches the returned leaf cert, and the leaf chains to
// the returned CA. This is the invariant every CA-path fix must preserve.
function assertValidPair(r) {
  const ca = new X509Certificate(readFileSync(r.caPath));
  const leaf = new X509Certificate(r.cert);
  assert.equal(leaf.verify(ca.publicKey), true, "leaf does not chain to the CA");
  assert.equal(
    Buffer.compare(spkiDer(r.key), leaf.publicKey.export({ type: "spki", format: "der" })), 0,
    "leaf private key does not match the leaf cert",
  );
}

test("ensureCA: returns a matching, chaining key/cert pair", () => {
  withCA({}, () => {
    assertValidPair(ensureCA());
  });
});

test("ensureCA: reuses the CA across calls (does not rotate the root)", () => {
  withCA({}, (dir) => {
    ensureCA();
    const caPemBefore = readFileSync(join(dir, "ca.pem"));
    const caKeyBefore = readFileSync(join(dir, "ca.key"));
    const r2 = ensureCA();
    assert.equal(Buffer.compare(readFileSync(join(dir, "ca.pem")), caPemBefore), 0, "ca.pem changed");
    assert.equal(Buffer.compare(readFileSync(join(dir, "ca.key")), caKeyBefore), 0, "ca.key changed");
    assertValidPair(r2);
  });
});

// Blocker #2: ready() checked existence + SAN only, not that leaf.key matches
// leaf.pem. A stray/old leaf.key that does not match the SAN-valid leaf.pem was
// accepted and served as a mismatched pair (tls.createSecureContext failure).
test("ensureCA: rejects a mismatched leaf.key/leaf.pem and regenerates a matching pair", () => {
  withCA({}, (dir) => {
    ensureCA(); // stage a valid ca + leaf
    // Overwrite leaf.key with an unrelated key so the on-disk pair is mismatched
    // while leaf.pem still exists and still covers the SAN.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(join(dir, "leaf.key"), privateKey.export({ type: "pkcs8", format: "pem" }));
    const r = ensureCA();
    assertValidPair(r); // must NOT return the mismatched pair
  });
});

