// Tests for the forward-proxy CA/leaf generation in proxy/forward-proxy.mjs.
//
// These lock down the CA-path correctness fixes Codex flagged on PR #251:
// ensureCA() must return a matching, chaining leaf key/cert pair, reuse the root
// CA across calls, never serve a mismatched key + cert (a stray/old leaf.key
// that does not correspond to the SAN-valid leaf.pem), and only ever generate
// while positively owning .gen.lock — a waiter that times out on a lock held by
// a LIVE peer must not generate over it and must not delete the peer's lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const REPO = new URL("..", import.meta.url).pathname;
const FWD = join(REPO, "proxy/forward-proxy.mjs");

// The launcher's own trust decision, imported rather than re-implemented.
import { bundleCarriesOurCA } from "../bin/ca-trust.mjs";

const ENV_KEYS = [
  "CACHE_FIX_CA_DIR", "CACHE_FIX_FORWARD_PROXY", "CLAUDE_CONFIG_DIR",
  "CACHE_FIX_DOWNLOAD_REWRITE", "CACHE_FIX_CA_LOCK_WAIT_MS", "CACHE_FIX_CA_FORCE_ROTATE",
];

// Run fn with a fresh temp CA dir and forward-proxy on, restoring env after.
// Handles both sync and async fn (cleanup waits for a returned promise).
function withCA(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "fwd-ca-"));
  const cleanup = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CACHE_FIX_CA_DIR = dir;
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
    const r = fn(dir);
    if (r && typeof r.then === "function") return r.finally(cleanup);
    cleanup();
    return r;
  } catch (err) {
    cleanup();
    throw err;
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

// Blocker #1 (never generate without the lock): a .gen.lock owned by a LIVE
// process means a generator is really working (or wedged) — after the bounded
// wait, ensureCA must refuse to generate over it rather than fall through,
// reuse the same temp filenames, and clobber the live generator's output. And
// it must NOT delete a lock it does not own: doing so lets a third starter in,
// republishing artifacts out from under the real owner (UNKNOWN_ISSUER).
test("ensureCA: lock held by a live process — refuses to generate, leaves the lock alone", () => {
  withCA({ CACHE_FIX_CA_LOCK_WAIT_MS: "300" }, (dir) => {
    const lock = join(dir, ".gen.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid)); // this test process: alive
    assert.throws(() => ensureCA(), /lock/i, "must throw instead of generating without the lock");
    assert.equal(existsSync(lock), true, "peer's lock was deleted");
    assert.equal(readFileSync(join(lock, "pid"), "utf8"), String(process.pid), "peer's pid file was touched");
    assert.equal(existsSync(join(dir, "ca.pem")), false, "generated artifacts despite not owning the lock");
  });
});

// Blocker #1 (stale reclaim): a lock whose owner is DEAD (crashed generator) is
// abandoned — after the bounded wait, ensureCA must reclaim it, generate a
// valid pair while owning the reclaimed lock, and clean the lock up after. A
// lock with no pid stamp at all (older build / crash before the stamp) counts
// as stale too.
test("ensureCA: reclaims a dead owner's lock, generates a valid pair, cleans up", () => {
  withCA({ CACHE_FIX_CA_LOCK_WAIT_MS: "300" }, (dir) => {
    const lock = join(dir, ".gen.lock");
    mkdirSync(lock, { recursive: true });
    const dead = spawnSync("true").pid; // reaped by the time spawnSync returns
    writeFileSync(join(lock, "pid"), String(dead));
    const r = ensureCA();
    assertValidPair(r);
    assert.equal(existsSync(lock), false, "reclaimed lock was not cleaned up");
  });
});

test("ensureCA: reclaims a pid-less stale lock the same way", () => {
  withCA({ CACHE_FIX_CA_LOCK_WAIT_MS: "300" }, (dir) => {
    mkdirSync(join(dir, ".gen.lock"), { recursive: true }); // no pid stamp
    const r = ensureCA();
    assertValidPair(r);
    assert.equal(existsSync(join(dir, ".gen.lock")), false, "reclaimed lock was not cleaned up");
  });
});

// Blocker #1 (no clobber, integration): many fresh starters against one shared
// CA dir must all end up with a key/cert pair that chains to the single
// published CA — and the dir must hold only the durable artifacts afterwards:
// no .gen.lock, no .tmp.* litter (unique-per-process temp names, cleaned up).
test("ensureCA: concurrent starters all chain to one CA; no lock or temp litter left", async () => {
  await withCA({}, async (dir) => {
    const worker = join(dir, "worker.mjs");
    writeFileSync(worker, `
import { readFileSync } from "node:fs";
import { X509Certificate, createPublicKey } from "node:crypto";
process.env.CACHE_FIX_CA_DIR = ${JSON.stringify(dir)};
process.env.CACHE_FIX_FORWARD_PROXY = "on";
const { ensureCA } = await import(${JSON.stringify(FWD)});
const r = ensureCA();
const ca = new X509Certificate(readFileSync(r.caPath));
const leaf = new X509Certificate(r.cert);
const keyPub = createPublicKey(r.key).export({ type: "spki", format: "der" });
const certPub = leaf.publicKey.export({ type: "spki", format: "der" });
process.stdout.write(JSON.stringify({ chains: leaf.verify(ca.publicKey), keyMatch: Buffer.compare(keyPub, certPub) === 0 }));
`);
    const N = 8;
    const runWorker = () => new Promise((resolve) => {
      const p = spawn(process.execPath, [worker]);
      let out = "", errOut = "";
      p.stdout.on("data", (c) => { out += c; });
      p.stderr.on("data", (c) => { errOut += c; });
      p.on("close", (status) => resolve({ status, out, errOut }));
    });
    const procs = await Promise.all(Array.from({ length: N }, runWorker));
    for (const p of procs) {
      assert.equal(p.status, 0, `worker failed: ${p.errOut}`);
      const j = JSON.parse(p.out);
      assert.equal(j.chains, true, "a worker's leaf did not chain to the CA");
      assert.equal(j.keyMatch, true, "a worker's key did not match its cert");
    }
    assert.equal(existsSync(join(dir, ".gen.lock")), false, "lock left behind");
    const litter = readdirSync(dir).filter((f) => f.startsWith(".tmp."));
    assert.deepEqual(litter, [], `leftover temp files: ${litter.join(", ")}`);
  });
});

// Review follow-up: private-key file modes are normalized to 0600 on every
// successful return — including reuse of preexisting on-disk keys with loose
// permissions (openssl defaults are not guaranteed, and an operator-supplied
// ca.key must not stay world-readable just because it already existed).
test("ensureCA: normalizes ca.key/leaf.key to 0600, including on reuse", () => {
  withCA({}, (dir) => {
    ensureCA();
    chmodSync(join(dir, "ca.key"), 0o644);
    chmodSync(join(dir, "leaf.key"), 0o644);
    ensureCA(); // reuse path: artifacts exist and are valid
    for (const f of ["ca.key", "leaf.key"]) {
      const mode = statSync(join(dir, f)).mode & 0o777;
      assert.equal(mode, 0o600, `${f} mode ${mode.toString(8)} != 600`);
    }
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


// The trust DECISION vs the trust CHAIN. Every other check in this area — ours
// and every peer component's — inspects file CONTENT: is our CA in the bundle,
// are the BEGIN/END markers balanced. None of that proves Node actually verifies
// a leaf with the file we hand it. Those are cheap pre-flight guards, necessary
// and not sufficient; a real handshake is the only evidence.
//
// So: stand up a TLS server using the leaf ensureCA() issued, connect trusting
// ONLY the bundle the launcher would select, and require authorization. The
// CONTROL — the same handshake with no extra CA — must FAIL. Without the control
// a green assertion says nothing: it could pass because the ambient store already
// trusted something, and nobody would know.
async function handshakeTrusting(caFileContent, r) {
  const { createServer, connect } = await import("node:tls");
  const dir = mkdtempSync(join(tmpdir(), "fwd-tls-"));
  const caFile = join(dir, "trust.pem");
  if (caFileContent !== null) writeFileSync(caFile, caFileContent);
  const server = createServer({ key: r.key, cert: r.cert }, (s) => s.end());
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  try {
    return await new Promise((res) => {
      const opts = { host: "127.0.0.1", port, servername: "api.anthropic.com" };
      if (caFileContent !== null) opts.ca = readFileSync(caFile);
      const c = connect(opts, () => { const ok = c.authorized; c.destroy(); res({ ok, err: null }); });
      c.on("error", (e) => res({ ok: false, err: e.code || e.message }));
      setTimeout(() => { c.destroy(); res({ ok: false, err: "timeout" }); }, 10000);
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ca-trust: a bundle carrying our CA really verifies the proxy leaf (and the control fails)", async () => {
  await withCA({}, async (dir) => {
    const r = ensureCA();
    const ourCa = readFileSync(join(dir, "ca.pem"), "utf8");
    // A realistic merged bundle: an unrelated root ahead of ours, as a builder
    // concatenating sort(ca-trust.d/*.pem) plus ambient roots would produce.
    const other = readFileSync(join(dir, "leaf.pem"), "utf8");
    const good = await handshakeTrusting(`${other}${ourCa}`, r);
    assert.equal(good.ok, true, `merged bundle must verify the leaf, got err=${good.err}`);

    const control = await handshakeTrusting(null, r);
    assert.equal(control.ok, false, "control must fail — otherwise the pass above proves nothing");
    assert.match(String(control.err), /UNABLE_TO_VERIFY|SELF_SIGNED|UNKNOWN_ISSUER|DEPTH_ZERO/,
      `control should fail to verify, got err=${control.err}`);
  });
});

test("ca-trust: a bundle torn AHEAD of our CA does NOT verify (why the marker check exists)", async () => {
  await withCA({}, async (dir) => {
    const r = ensureCA();
    const ourCa = readFileSync(join(dir, "ca.pem"), "utf8");
    // Truncate an earlier entry mid-block: BEGIN with no END, then our complete
    // CA. Containment still finds our CA verbatim, so a contains-only gate accepts
    // this file — and Node then trusts NOTHING in it, our own proxy included.
    // This is the measurement that makes the BEGIN/END count load-bearing rather
    // than belt-and-braces.
    const torn = ourCa.split("\n").slice(0, 3).join("\n") + "\n";
    const bundle = `${torn}${ourCa}`;
    assert.ok(bundle.includes(ourCa.trim()), "fixture must contain our CA verbatim");
    const res = await handshakeTrusting(bundle, r);
    assert.equal(res.ok, false, "a torn-ahead bundle must not verify — if it did, the marker guard would be pointless");
  });
});

// Verify a leaf the way the LAUNCHER does: hand the bundle to a fresh node via
// NODE_EXTRA_CA_CERTS, not via tls.connect({ca}).
//
// The distinction is load-bearing, not pedantry. Measured (node v24.11.1,
// openssl 3.6.1) on our own CA relabelled to TRUSTED CERTIFICATE, byte-identical
// DER otherwise: the `ca` option ACCEPTS it and authorizes, NODE_EXTRA_CA_CERTS
// SKIPS it and fails UNABLE_TO_VERIFY_LEAF_SIGNATURE. So the two paths genuinely
// disagree, and the previous version of this table cross-checked the guard
// against the option the launcher does not use — which is why it certified a
// guard that accepted a bundle every real session would have failed on.
async function handshakeViaExtraCerts(bundle, r) {
  const dir = mkdtempSync(join(tmpdir(), "fwd-extra-"));
  const bundlePath = join(dir, "trust.pem");
  const keyPath = join(dir, "leaf.key");
  const certPath = join(dir, "leaf.pem");
  writeFileSync(bundlePath, bundle);
  writeFileSync(keyPath, r.key);
  writeFileSync(certPath, r.cert);
  // The server must live in a child that has NODE_EXTRA_CA_CERTS set from birth:
  // node reads the variable once at startup, so assigning it in this process
  // after boot would have no effect and every row would silently test nothing.
  const script = `
    import { createServer, connect } from "node:tls";
    import { readFileSync } from "node:fs";
    const srv = createServer({ key: readFileSync(${JSON.stringify(keyPath)}),
                               cert: readFileSync(${JSON.stringify(certPath)}) }, (s) => s.end());
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    const c = connect({ host: "127.0.0.1", port, servername: "api.anthropic.com" });
    const out = await new Promise((res) => {
      c.on("secureConnect", () => res({ ok: c.authorized, err: c.authorizationError }));
      // A rejected chain surfaces as 'error', never 'secureConnect', so the
      // timeout must not be the thing that ends a failing row — it would add ten
      // seconds per negative case and report every real failure as "timeout".
      c.on("error", (e) => res({ ok: false, err: e.code || e.message }));
      c.on("close", () => res({ ok: false, err: "closed before handshake" }));
      setTimeout(() => res({ ok: false, err: "timeout" }), 10000).unref();
    });
    console.log(JSON.stringify(out));
    c.destroy(); srv.close();
  `;
  try {
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: bundlePath },
      encoding: "utf8",
    });
    return JSON.parse(p.stdout.trim());
  } catch (e) {
    return { ok: false, err: `probe failed: ${e.message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A PUBLIC KEY block, the cheapest stand-in for the non-certificate blocks a
// real merged bundle carries (CRLs, keys, DH params). Derived from the CA's own
// key so the fixture needs no extra material.
function pubKeyPem(caPem) {
  return new X509Certificate(caPem).publicKey.export({ type: "spki", format: "pem" });
}

// The guard's decision, cross-checked against a real handshake on every shape.
//
// This drives bin/ca-trust.mjs — the module the launcher imports — rather than a
// copy of it. It used to be a hand-maintained duplicate under a "change one,
// change both" comment, and measured: mutating the launcher's copy to accept
// everything left the entire suite green, so the trust path had no regression
// cover at all. Two call sites is below this repo's bar for a new module; the
// justification is that a test cannot import a top-level script, and a copy is
// not the thing that ships.
//
// The asymmetry in what each verdict must mean is deliberate. An accept MUST
// verify: waving through a bundle node cannot load makes claude distrust the
// very proxy it is routed through and every request fails TLS. A reject need not
// mean the handshake fails — refusing a usable-but-odd bundle only costs the
// other components' CAs for that session. Conservative is allowed, permissive is
// not, so only the accepts are cross-checked.
test("ca-trust: the bundle guard never accepts a bundle NODE_EXTRA_CA_CERTS cannot load", async () => {
  await withCA({}, async (dir) => {
    const r = ensureCA();
    const ourCa = readFileSync(join(dir, "ca.pem"));
    const ours = ourCa.toString("utf8");
    const other = readFileSync(join(dir, "leaf.pem"), "utf8");
    // A PEM body with no END line — the shape that makes a block unterminated.
    const body = ours.split("\n").slice(1, -2).join("\n");

    const rows = [
      ["healthy: ours alone", ours, true],
      ["healthy: unrelated root ahead of ours", `${other}${ours}`, true],
      ["CRLF line endings", ours.replace(/\n/g, "\r\n"), true],
      // Non-certificate blocks. A real corporate bundle carries these; node's
      // loader skips them and verifies fine. Parsing every block as a
      // certificate rejected the whole file, which does not fail safe — it drops
      // every sibling and corporate CA for the session.
      ["PUBLIC KEY block ahead of ours", `${pubKeyPem(ourCa)}${ours}`, true],
      // A provenance header that happens to name the marker. Counting raw
      // occurrences of "-----BEGIN " saw two markers and one parsed block and
      // called a healthy file torn.
      ["comment naming the marker", `# see -----BEGIN CERTIFICATE-----\n${ours}`, true],
      // Markers balanced and our CA present verbatim, but the FIRST block's body
      // is not base64. Node aborts the whole extras load on it.
      ["corrupt base64 ahead", `-----BEGIN CERTIFICATE-----\n!!!not base64!!!\n-----END CERTIFICATE-----\n${ours}`, false],
      // A label other than CERTIFICATE, torn.
      ["torn TRUSTED CERTIFICATE ahead", `-----BEGIN TRUSTED CERTIFICATE-----\n${body}\n${ours}`, false],
      // THE false accept this guard exists to prevent. Same DER as our CA, so a
      // parse-and-compare that ignores the label says "carries us" — while node's
      // CA loader skips any block not labelled exactly CERTIFICATE, leaving the
      // session trusting nothing and failing every request.
      ["our CA relabelled TRUSTED CERTIFICATE", ours.replaceAll("CERTIFICATE-----", "TRUSTED CERTIFICATE-----"), false],
      // A CORRUPT non-certificate block. The "node ignores non-cert blocks"
      // rule holds only for well-formed ones — node's reader aborts the whole
      // extras load on any block it cannot decode, whatever the label. Skipping
      // every non-CERTIFICATE block outright waved these through: measured,
      // guard=accept while the handshake failed UNABLE_TO_VERIFY_LEAF_SIGNATURE.
      ["corrupt PUBLIC KEY ahead", `-----BEGIN PUBLIC KEY-----\n!!!not base64!!!\n-----END PUBLIC KEY-----\n${ours}`, false],
      // Alphabet-valid but not whole 4-char quanta. Every character is legal
      // base64, so an alphabet-only test called this decodable — measured, node
      // reported `bad base64 decode` and loaded zero extra CAs. Without this row
      // the length check can be deleted with the suite still green.
      ["PUBLIC KEY body of one char", `-----BEGIN PUBLIC KEY-----\nA\n-----END PUBLIC KEY-----\n${ours}`, false],
      // Padding is positional, not merely present: `AAA=` loads, `A===` does not.
      ["PUBLIC KEY body with misplaced padding", `-----BEGIN PUBLIC KEY-----\nA===\n-----END PUBLIC KEY-----\n${ours}`, false],
      ["corrupt X509 CRL ahead", `-----BEGIN X509 CRL-----\n!!!not base64!!!\n-----END X509 CRL-----\n${ours}`, false],
      // Whitespace inside a body is stripped before the alphabet test, and WHICH
      // whitespace decides the verdict. JavaScript's `\s` covers the Unicode set;
      // node's PEM reader accepts only ASCII space, tab, CR and LF. Measured, one
      // character at a time, against a real NODE_EXTRA_CA_CERTS load:
      //
      //   space, tab, CR, LF                                    -> loads 1
      //   U+00A0 U+2003 U+2028 U+2029 U+FEFF U+1680 U+205F      -> loads 0
      //   U+3000, and ASCII VTAB (\x0b) and FORMFEED (\x0c)     -> loads 0
      //
      // Every one of those ten is stripped by `\s`, so stripping with `\s` makes
      // the guard read a damaged body as clean. A NBSP is what a paste through a
      // rich-text field leaves behind, which is exactly how a bundle acquires one.
      ["PUBLIC KEY body with U+00A0", `-----BEGIN PUBLIC KEY-----\nMFkw EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n${ours}`, false],
      ["PUBLIC KEY body with a vertical tab", `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n${ours}`, false],
      ["our CA with U+2028 in its body", ours.replace(/\n/, "\n "), false],
      // ...and the other direction, or the fix above becomes an over-strict guard
      // that drops the sibling CAs this PR exists to keep. A tab and a bare CR
      // inside a body are both loader-legal.
      ["PUBLIC KEY body with a tab", `-----BEGIN PUBLIC KEY-----\nMFkw\tEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n${ours}`, true],
      // ...but a WELL-FORMED one must still be accepted, or the fix above turns
      // into the over-strict guard this PR set out to remove.
      ["valid PUBLIC KEY ahead", `${pubKeyPem(ourCa)}${ours}`, true],
      // A trailing space on the marker line. openssl still reacts to it, so a
      // `$`-anchored pattern made the block invisible to us while node still
      // tried to load it — the corrupt block then rode through unseen.
      ["corrupt block, BEGIN has a trailing space", `-----BEGIN CERTIFICATE----- \n!!!not base64!!!\n-----END CERTIFICATE-----\n${ours}`, false],
      // An unterminated block whose END line belongs to a LATER entry. Searching
      // to end-of-file let the torn block borrow it, so the unterminated check
      // never fired and the slice spanned two entries.
      ["torn block borrowing a later END", `-----BEGIN CERTIFICATE-----\n${body}\n${other}${ours}`, false],
      // The END marker must end its own line. `indexOf` alone ignored whatever
      // followed it, so a block openssl rejects read as terminated here — both
      // of these were measured as false accepts on an otherwise healthy bundle.
      ["END marker with trailing garbage", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE-----garbage"), false],
      ["END marker with extra dashes", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE-------"), false],
      // ...but trailing whitespace is fine, and must stay fine: node loads it.
      ["END marker with a trailing space", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE----- "), true],
      // Real cert, just not ours: the stale-builder case.
      ["stale: a real cert that is not ours", other, false],
      ["empty bundle", "", false],
    ];

    for (const [name, bundle, expectUsable] of rows) {
      const verdict = bundleCarriesOurCA(bundle, ourCa);
      assert.equal(verdict.ok, expectUsable,
        `guard verdict wrong for "${name}"${verdict.ok ? "" : ` (reason: ${verdict.reason})`}`);
      if (expectUsable) {
        const res = await handshakeViaExtraCerts(bundle, r);
        assert.equal(res.ok, true, `guard accepted "${name}" but NODE_EXTRA_CA_CERTS failed: ${res.err}`);
      }
    }
  });
});

// The row above proves the guard refuses the relabelled bundle. This proves the
// refusal is EARNED — that the shape really is fatal — so the row cannot decay
// into asserting its own fixture.
test("ca-trust: the relabelled-CA bundle really does fail NODE_EXTRA_CA_CERTS", async () => {
  await withCA({}, async (dir) => {
    const r = ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const relabelled = ours.replaceAll("CERTIFICATE-----", "TRUSTED CERTIFICATE-----");
    assert.ok(
      new X509Certificate(relabelled).raw.equals(new X509Certificate(ours).raw),
      "premise: relabelling leaves the DER identical, which is why a label-blind compare accepts it",
    );
    const control = await handshakeViaExtraCerts(ours, r);
    assert.equal(control.ok, true, `control must verify, got err=${control.err}`);
    const res = await handshakeViaExtraCerts(relabelled, r);
    assert.equal(res.ok, false, "a TRUSTED CERTIFICATE block must NOT be loaded by NODE_EXTRA_CA_CERTS");
  });
});

test("ca-trust: an empty ca.pem does not make the guard vacuously accept", () => {
  // "".includes("") is true, so a zero-byte CA made the old substring check pass
  // against ANY bundle — including one that does not carry us at all. Parsing
  // rejects it instead: X509Certificate throws on empty input, and the guard
  // lets that throw rather than treating it as a verdict.
  const stale = "-----BEGIN CERTIFICATE-----\nc3RhbGU=\n-----END CERTIFICATE-----\n";
  assert.equal("".includes(""), true, "premise: the old check was vacuous on an empty CA");
  assert.throws(() => bundleCarriesOurCA(stale, Buffer.from("")),
    "an empty ca.pem must not yield a verdict at all");
});
