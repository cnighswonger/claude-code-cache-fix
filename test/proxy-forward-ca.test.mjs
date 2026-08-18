// Tests for the forward-proxy CA/leaf generation in proxy/forward-proxy.mjs.
//
// These lock down the CA-path correctness fixes Codex flagged on PR #251:
// ensureCA() must return a matching, chaining leaf key/cert pair, reuse the root
// CA across calls, never serve a mismatched key + cert (a stray/old leaf.key
// that does not correspond to the SAN-valid leaf.pem), and only ever generate
// while positively owning .gen.lock — a waiter that times out on a lock held by
// a LIVE peer must not generate over it and must not delete the peer's lock.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer as netServer } from "node:net";

const REPO = new URL("..", import.meta.url).pathname;
const FWD = join(REPO, "proxy/forward-proxy.mjs");

// The launcher's own trust decision, imported rather than re-implemented.
import { bundleUsable, carriesOurCA, salvageBundle, subsumes } from "../bin/ca-trust.mjs";

// The oracle judges a FILE, because that is what NODE_EXTRA_CA_CERTS names. The
// shape table below is written in bundle TEXT, so it goes through a temp file.
// Every temp dir goes through here so `after()` can remove it. Enforced by a
// source-level test at the end of this file, the same way the sibling wrapper
// suite enforces it.
const scratchDirs = [];
function scratchDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}
after(() => {
  for (const d of scratchDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function leafOf(dir) {
  return { keyPath: join(dir, "leaf.key"), certPath: join(dir, "leaf.pem"),
           host: "api.anthropic.com" };
}
function verdictFor(text, dir) {
  const p = join(scratchDir("ca-verdict-"), "bundle.pem");
  writeFileSync(p, text);
  return bundleUsable(p, leafOf(dir));
}

// Every variable withCA must clear on entry and restore on exit. A variable a
// test passes as an override but that is MISSING here is not restored, so it
// leaks into every later test in the file.
//
// CACHE_FIX_PROXY_UPSTREAM was missing, and it decides the leaf's SAN. Measured:
// after the --proxy-upstream case ran, every subsequent ensureCA() minted a leaf
// for `api.example.internal`, so a probe asking for api.anthropic.com got
// ERR_TLS_CERT_ALTNAME_INVALID and the bundle read `{ok:false}` — a healthy CA
// failing to verify its own leaf. Nothing caught it because no later test asked
// that question until this one did.
const ENV_KEYS = [
  "CACHE_FIX_CA_DIR", "CACHE_FIX_FORWARD_PROXY", "CLAUDE_CONFIG_DIR",
  "CACHE_FIX_DOWNLOAD_REWRITE", "CACHE_FIX_CA_LOCK_WAIT_MS", "CACHE_FIX_CA_FORCE_ROTATE",
  "CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_CA_SALVAGE_BUDGET_MS",
  // Two tests set this deliberately. A leak makes every LATER test's CA probe
  // answer "could not ask", which turns their assertions into measurements of
  // the fallback rather than of the guard — the same class of silent corruption
  // that `CACHE_FIX_PROXY_UPSTREAM` caused here before it was added to the list.
  "CACHE_FIX_CA_PROBE_UNANSWERABLE",
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

// Asked of the runtime, not derived from its version string: `engines` allows
// >=18 and `tls.getCACertificates` arrived in v22.15, where the CA census
// answers `null` for everything. A test whose control needs a YES cannot
// establish its premise there.
const canCountCAs = typeof (await import("node:tls")).getCACertificates === "function";

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
  const dir = scratchDir("fwd-tls-");
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
  const dir = scratchDir("fwd-extra-");
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
      // An unterminated block whose END line belongs to a LATER entry. The
      // predicate refused this, and the refusal was WRONG: measured against the
      // loader, node reads 2 certificates from it and the handshake succeeds.
      // The old table recorded the predicate's behaviour as the expectation, so
      // five rounds of review re-certified a false reject as correct — which is
      // the failure mode the oracle exists to end.
      ["torn block borrowing a later END", `-----BEGIN CERTIFICATE-----\n${body}\n${other}${ours}`, true],
      // The END marker must end its own line. `indexOf` alone ignored whatever
      // followed it, so a block openssl rejects read as terminated here — both
      // of these were measured as false accepts on an otherwise healthy bundle.
      ["END marker with trailing garbage", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE-----garbage"), false],
      ["END marker with extra dashes", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE-------"), false],
      // The SAME defect on the BEGIN side, which the END fix above did not cover.
      // `$`-anchoring the marker made an over-dashed opener invisible to us — the
      // block was skipped entirely, so nothing was ever checked and our CA later
      // in the file carried the verdict. openssl does NOT skip it: it consumes
      // the line as an opener and then fails the whole extras load on the END it
      // cannot match. Measured, node v24.11.1: guard=accept, loader=0 CAs,
      // `bad end line`. A block we cannot parse must never be one we ignore.
      ["BEGIN marker with extra dashes", `-----BEGIN CERTIFICATE-------\nZm9vYmFy\n-----END CERTIFICATE-----\n${ours}`, false],
      // ...and the trailing-whitespace tolerance on BEGIN must survive the fix,
      // for the same reason the END side keeps it: openssl accepts it and so
      // must we, or we drop a healthy bundle.
      ["BEGIN marker with a trailing space", ours.replace("-----BEGIN CERTIFICATE-----", "-----BEGIN CERTIFICATE----- "), true],
      // ...but trailing whitespace is fine, and must stay fine: node loads it.
      ["END marker with a trailing space", ours.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE----- "), true],
      // Real cert, just not ours: the stale-builder case.
      ["stale: a real cert that is not ours", other, false],
      ["empty bundle", "", false],
    ];

    for (const [name, bundle, expectUsable] of rows) {
      const verdict = verdictFor(bundle, dir);
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

// Requirement: three outcomes, never two. A probe that cannot run must yield
// `unknown` — NOT `ok:false`. Answering "unusable" when we could not ask drops
// every corporate root on a host whose bundle was fine. Nothing asserted this
// before, and its absence hid a real defect: an earlier probe used an API that
// does not exist before node v22.15, so every verdict on a supported runtime
// was `unknown` and the launcher was silently unguarded.
test("ca-trust: a probe that cannot run yields unknown, not a refusal", () => {
  withCA({}, (dir) => {
    ensureCA();
    const bundle = join(dir, "ca.pem");            // a perfectly good bundle
    assert.equal(bundleUsable(bundle, leafOf(dir)).ok, true, "premise: this bundle is fine");
    // Same bundle, but the probe cannot start: no leaf to serve.
    const broken = { keyPath: join(dir, "nope.key"), certPath: join(dir, "nope.pem"),
                     host: "api.anthropic.com" };
    const v = bundleUsable(bundle, broken);
    assert.equal(v.unknown, true, `must be unknown, got ${JSON.stringify(v)}`);
    assert.notEqual(v.ok, false, "a probe that could not run must not read as a refusal");
  });
});

// salvageBundle: a damaged MERGE must not cost the other publishers their CAs.
// The old answer was "fall back to our own CA alone", which drops every peer for
// the session — measured: this box holds ours + one peer, where narrowing loads
// 1 certificate and salvage gives 2; on a three-publisher host it is 1 against 3.
test("ca-trust: salvage rebuilds from the publishers that load, dropping only the broken one", async () => {
  await withCA({}, async (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    // A second, unrelated publisher. Any cert node's extras loader accepts will
    // do; this one is to hand and is not our CA, which is what the test needs.
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    // `abad` sorts first, so a naive concat puts the damage AHEAD of ours. The
    // damage must be genuinely FATAL: a tear whose body is a prefix of a real
    // certificate is recovered by openssl and is harmless, so using one here
    // would test nothing. Overlapping BEGIN markers take the whole load down.
    writeFileSync(join(trustDir, "abad.pem"),
      "-----BEGIN PUBLIC KEY----------BEGIN CERTIFICATE-----\nAAAA\n-----END PUBLIC KEY-----\n");
    writeFileSync(join(trustDir, "bpeer.pem"), peer);
    writeFileSync(join(trustDir, "ccf.pem"), ours);

    const out = join(scratchDir("ca-salv-"), "rebuilt.pem");
    let n = 0;
    const got = salvageBundle(trustDir, ours, leafOf(dir),
      (text) => { const p = out + (++n) + ".pem"; writeFileSync(p, text); return p; });
    assert.ok(got, "salvage must produce a bundle when a healthy publisher exists");

    // The rebuild must be USABLE — the same question asked of any other
    // candidate. Trusting it because we assembled it is the assumption this
    // module exists to stop making.
    assert.equal(bundleUsable(got, leafOf(dir)).ok, true, "the rebuilt bundle must verify our leaf");
    // ...and it must DROP the file that breaks the merge while KEEPING the one
    // that does not. Measured by cert count, not by substring: the torn file is
    // a byte-prefix of the healthy one, so `includes()` is true whenever our CA
    // is present at all and proves nothing either way.
    const text = readFileSync(got, "utf8");
    const blocks = (text.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(blocks, 2,
      `expected the peer publisher + our CA, got ${blocks} blocks`);   // ccf.pem IS our CA: skipped as a duplicate, appended once
    assert.ok(!text.includes("-----BEGIN PUBLIC KEY----------BEGIN"),
      "salvage kept the publisher file that breaks the merge");
  });
});

// The damaged file above loads ZERO on its own, yet the same damage followed by
// a healthy CA yields ONE certificate — openssl consumes to the next `-` and
// recovers whatever is complete DER, so an identical tear behaves differently by
// CONTEXT. That is unknowable from a parser and is why salvage judges each
// publisher file in isolation rather than reasoning about the merge.
test("ca-trust: an identical tear loads differently depending on what follows it", async () => {
  await withCA({}, async (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const torn = ours.split("\n").slice(0, -2).join("\n") + "\n";   // BEGIN + body, no END
    const alone = join(scratchDir("ca-ctx-"), "a.pem");
    const trailed = join(scratchDir("ca-ctx-"), "b.pem");
    writeFileSync(alone, torn);
    writeFileSync(trailed, torn + ours);
    // Asked the same way the shipped guard asks — a handshake, not
    // `tls.getCACertificates`. That API does not exist before v22.15 and this
    // package declares `engines: >=18`, so a test using it is red on the very
    // runtimes CI runs, while testing an implementation that deliberately
    // avoids it. And `Number(r.stdout)` on a crashed child is `Number("") === 0`,
    // so the first assertion below used to pass for the wrong reason.
    const loadsOurs = (p) => bundleUsable(p, leafOf(dir)).ok;
    assert.equal(loadsOurs(alone), false, "premise: the tear alone yields nothing usable");
    assert.equal(loadsOurs(trailed), true, "premise: the same tear followed by a CA recovers one");
  });
});

// Every temp dir a TEST mints must be registered for cleanup. Source-level on
// purpose: the bundles written here are cert text rather than key material, so
// the cost is litter rather than a leak — but 605 stale dirs accumulated across
// development runs before anything noticed, and the next person to add a test
// is exactly who would reintroduce it.
//
// Scoped to the test bodies, not the whole file: the three helpers above
// (`withCA` and friends) mint their own dirs and remove them in their own
// `finally`, which is a different discipline that works. Measured while writing
// this: those three sites had leaked ZERO dirs, every one of the 605 came from
// an unregistered mint inside a test. Flagging them would be a guard failing on
// correct code, which is how guards get deleted.
//
// Comment lines are skipped and the pattern is assembled, so neither this
// assertion nor the prose above it can flag itself.
test("ca-trust: no test body mints an unregistered temp dir", () => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const call = new RegExp(["mkdtempSync\\(join\\(tmpdir\\(\\),", "\\s*\"[^\"]+\"\\s*\\)\\)"].join(""));
  const raw = src.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trim().startsWith("//"))
    .filter(([, line]) => !line.includes("mkdtempSync(join(tmpdir(), prefix))"))  // the registrar
    .filter(([, line]) => !line.includes('"fwd-ca-"'))    // withCA: removes it in its own finally
    .filter(([, line]) => call.test(line))
    .map(([n]) => n);
  assert.deepEqual(raw, [],
    `every temp dir in a test must go through scratchDir(); raw mkdtempSync at line(s): ${raw.join(", ")}`);
  assert.ok(scratchDirs.length > 0, "premise: this file does create temp dirs");
});

// The docs must not describe a mechanism the code no longer has. Prose rots
// silently — nothing runs it — and this file's own history is the argument: a
// 26-row table survived five review rounds with one row recording the buggy
// behaviour as correct, because every round compared the code to the table and
// none compared the table to reality. The README is a bigger table.
//
// Matched on the specific claims the predicate made and the oracle does not:
// terminator scanning, marker balance, and "cannot tell so it refuses". Their
// presence means the docs are describing a deleted implementation.
test("ca-trust: the docs do not describe the deleted predicate", () => {
  const claims = [
    "every PEM block in it is terminated",
    "searched for only up to",
    "borrow the `END` line",
    "Where the guard cannot tell",
  ];
  // Fenced blocks are exempt: quoting the old behaviour on purpose (a changelog
  // entry, a historical note) is documentation, not drift. Without this the
  // guard fails for the wrong reason on correct prose — the same trap the
  // sibling implementation hit writing its own version of this test, where a
  // docstring naming the deleted API tripped a comment-stripping check.
  const prose = (t) => t.replace(/```[\s\S]*?```/g, "");
  for (const f of ["README.md", "CHANGELOG.md"]) {
    let text;
    try { text = prose(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")); }
    catch { continue; }                       // absent is not a failure
    const found = claims.filter((c) => text.includes(c));
    assert.deepEqual(found, [],
      `${f} still documents the predicate: ${found.map((c) => JSON.stringify(c)).join(", ")}`);
  }
});

// The launcher reads its CA with `readFileSync(caPem)` — no encoding, so a
// BUFFER. Every test above passes a utf8 string, so the whole salvage path was
// exercised only with the type the shipped caller never sends. Measured in a
// live launcher run: `t.endsWith is not a function`, caught by the outer catch,
// reported as "could not evaluate ... using our own CA only" — the peer's CA
// dropped by the very function written to keep it, with all 43 tests green.
// A trust dir holding ONLY our own CA has nothing to rebuild FROM, and salvage
// must say so rather than hand back our CA wearing a rebuild's name.
//
// It used to. A `dupes` counter let that case through, reasoning that returning
// our CA beat returning nothing. Measured, it is the opposite: with a healthy
// merge on disk and an unserveable leaf, the rebuild loads 1 CA while `null`
// sends the launcher back to a merge that loads 2. Never better, sometimes a
// certificate worse.
test("ca-trust: salvage returns null when the trust dir holds only our own CA", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "ccf.pem"), ours);
    const out = scratchDir("ca-only-ours-");
    let n = 0;
    const mk = () => salvageBundle(trustDir, ours, leafOf(dir),
      (text) => { const p = join(out, `o${++n}.pem`); writeFileSync(p, text); return p; });
    assert.equal(mk(), null,
      "a dir with nothing but our own CA has nothing to rebuild from — returning " +
      "our CA alone costs the caller a merge it could have kept");
    // CONTROL: add one real publisher and the same call must rebuild, so the
    // null above is about having nothing to salvage and not about refusing
    // everything.
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem"), "utf8"));
    const got = mk();
    assert.ok(got, "control: one peer is enough to rebuild");
    const blocks = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(blocks, 2, "control: peer + ours");
  });
});

test("ca-trust: salvage keeps its rebuild when the final probe cannot answer", () => {
  // The gate below the loop reads `=== false`, and the twenty lines of comment
  // above it argue that `null` must be KEPT here while the launcher narrows on
  // the same value. Nothing measured the distinction: tightening the gate to
  // `!== true` left the whole suite green, so the sentence was documentation of
  // an intention rather than of the code.
  //
  // The two probes are independent — the keep rule runs `verifiesOurLeaf`, the
  // gate runs `carriesOurCA` — so the seam blinds only the gate and every
  // candidate is still judged normally. That is the state the comment describes:
  // a rebuild assembled from files that WERE judged, refused at the last step by
  // a question nobody could ask.
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "ccf.pem"), ours);
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem"), "utf8"));
    const out = scratchDir("ca-gate-null-");
    let n = 0;
    const mk = () => salvageBundle(trustDir, ours, leafOf(dir),
      (text) => { const p = join(out, `g${++n}.pem`); writeFileSync(p, text); return p; });
    // CONTROL: with the probe answering, this dir rebuilds. Without it the
    // assertion below cannot tell "kept on null" from "nothing to rebuild".
    const answered = mk();
    assert.ok(answered, "control: peer + ours rebuilds when the probe answers");
    const saved = process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;
    process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE = "1";
    try {
      const got = mk();
      assert.ok(got,
        "the gate discarded a rebuild on a probe that never ran — that drops " +
        "every surviving publisher for an answer nobody got, which is the " +
        "narrowing this module's tri-state exists to prevent");
      const blocks = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
      assert.equal(blocks, 2, "the kept rebuild is still peer + ours");
    } finally {
      if (saved === undefined) delete process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;
      else process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE = saved;
    }
  });
});

test("ca-trust: salvage accepts our CA as a Buffer, the way the launcher reads it", () => {
  withCA({}, (dir) => {
    ensureCA();
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "ccf.pem"), readFileSync(join(dir, "ca.pem")));
    // A PEER file too, so the dir has something to rebuild FROM. With only our
    // own CA present every candidate is skipped as a duplicate, `kept` is empty
    // and salvage correctly returns null — which would make this test pass or
    // fail on the dedupe rather than on the Buffer conversion it is named for.
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem")));
    const out = scratchDir("ca-buf-");
    let n = 0;
    const got = salvageBundle(trustDir, readFileSync(join(dir, "ca.pem")), leafOf(dir),
      (text) => { const p = join(out, `b${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(got, "salvage must handle a Buffer CA — the launcher passes one");
    assert.equal(bundleUsable(got, leafOf(dir)).ok, true, "and the rebuild must verify");
  });
});

// The probe inherits the operator's environment, and two variables in it can
// make the answer be about something other than the bundle.
//
// NODE_TLS_REJECT_UNAUTHORIZED=0 disables peer verification in the child, so
// EVERY bundle completes the handshake and the guard accepts unconditionally —
// silently, with no warning, on exactly the corporate-MITM machines this
// feature exists for. The predicate this replaced was immune because it parsed
// rather than connected, so this is a regression the rewrite introduced.

// The leaf's SAN is the UPSTREAM host (forward-proxy.mjs `mitmHosts`), so a
// probe that always requests api.anthropic.com fails the name check on any host
// launched with --proxy-upstream — refusing a perfectly good bundle on every
// launch, which is the loss this whole path exists to prevent. The probe host
// must come from the same place the SAN does.
test("ca-trust: the probe follows the upstream host, not a hardcoded one", () => {
  withCA({ CACHE_FIX_PROXY_UPSTREAM: "https://api.example.internal" }, (dir) => {
    const r = ensureCA();
    const san = new X509Certificate(r.cert).subjectAltName || "";
    assert.match(san, /api\.example\.internal/, "premise: the leaf covers the configured upstream");
    // The bundle is healthy; only a wrong probe host can refuse it.
    const good = join(scratchDir("ca-host-"), "b.pem");
    writeFileSync(good, readFileSync(join(dir, "ca.pem"), "utf8"));
    const wrong = { keyPath: join(dir, "leaf.key"), certPath: join(dir, "leaf.pem"),
                    host: "api.anthropic.com" };
    assert.equal(bundleUsable(good, wrong).ok, false,
      "premise: the hardcoded host really does refuse a healthy bundle here");
    const right = { ...wrong, host: "api.example.internal" };
    assert.equal(bundleUsable(good, right).ok, true,
      "with the upstream's own host the same bundle is accepted");
  });
});

// A mismatched leaf.key/leaf.pem pair is a LOCAL fault, not an unanswerable
// question about the bundle. forward-proxy.mjs documents a real two-rename
// window where key and cert come from different generations, so this is a state
// the launcher can genuinely be in. Reporting it as "the CA loader could not be
// consulted" misattributes our own broken key material to the loader, and the
// reason string is what an operator reads first.
test("ca-trust: a broken local leaf pair says so, not 'could not consult the loader'", () => {
  withCA({}, (dir) => {
    ensureCA();
    // Same cert, a key that does not match it.
    const bad = scratchDir("ca-leafmix-");
    writeFileSync(join(bad, "leaf.pem"), readFileSync(join(dir, "leaf.pem")));
    writeFileSync(join(bad, "leaf.key"),
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
        .export({ type: "pkcs8", format: "pem" }));
    const v = bundleUsable(join(dir, "ca.pem"),
      { keyPath: join(bad, "leaf.key"), certPath: join(bad, "leaf.pem"), host: "api.anthropic.com" });
    assert.equal(v.unknown, true, "still unknown — we could not ask");
    assert.match(v.reason, /leaf|local/i,
      `the reason must name OUR fault, got: ${v.reason}`);
  });
});

// A publisher file not ending in a newline fuses its last marker to the next
// file's first one on concatenation — `-----END X----------BEGIN Y-----`, which
// is the overlapping-marker shape the loader reads as zero certificates. Salvage
// normalises every file it keeps; without that it REBUILDS the damage it was
// invoked to repair, and nothing killed the missing guard before this test.
//
// Asserted on the OUTPUT TEXT rather than through a verdict: the fusion is a
// property of how the pieces were joined, and a verdict can hide it (our CA is
// last, so the merge still verifies while an earlier publisher is destroyed).
test("ca-trust: salvage does not fuse markers when a publisher lacks a trailing newline", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "a.pem"), ours.replace(/\n+$/, ""));   // no trailing newline
    writeFileSync(join(trustDir, "b.pem"), ours);
    const out = scratchDir("ca-fuse-");
    let n = 0;
    const seen = [];
    salvageBundle(trustDir, ours, leafOf(dir),
      (text) => { seen.push(text); const p = join(out, `b${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(seen.length > 0, "premise: salvage assembled at least one candidate");
    for (const text of seen) {
      assert.ok(!/-----END [^\n]*-----[^\n]*-----BEGIN /.test(text),
        "salvage fused two markers onto one line — the damage it exists to repair");
    }
  });
});

// `verifiesOurLeaf` answers true / false / null, and the salvage loop must not
// treat null (could not ask) as false (broken). A transient probe failure on ONE
// healthy publisher otherwise drops that publisher's CA from the rebuild — and
// the rebuild still verifies, so nothing anywhere reports the loss. Same defect
// as collapsing `unknown` into a refusal, one level down.
//
// Driven through a probe that CANNOT answer for any file (a leaf key that does
// not exist), so every candidate is unjudgeable and every one must be KEPT.
//
// This test used to assert `null` here, on the reasoning that a bundle nobody
// could judge should not be handed over. That reasoning ignored what the caller
// does with `null`: `salvaged || caPem` narrows the session to our own CA
// alone. Measured on this fixture — rebuild 3 CAs, `null` 1 CA, and the rebuild
// verifies. So `null` was the LOSSY answer, and it fired precisely when the
// probe was broken for everything, i.e. when nothing was wrong with the files.
test("ca-trust: salvage does not mistake 'could not ask' for 'broken'", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem"), "utf8"));
    writeFileSync(join(trustDir, "b-ccf.pem"), ours);
    const out = scratchDir("ca-unk-");
    let n = 0;
    const unanswerable = { keyPath: join(dir, "no-such.key"), certPath: join(dir, "leaf.pem"),
                           host: "api.anthropic.com" };
    const got = salvageBundle(trustDir, ours, unanswerable,
      (text) => { const p = join(out, `u${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(n > 0, "premise: the probe was actually attempted");
    assert.ok(got, "an unanswerable probe must keep every publisher, not narrow to our CA alone");
    const kept = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(kept, 2, `expected the peer publisher plus our CA, got ${kept} blocks`);   // the ccf publisher IS our CA
  });
});

// NOT COVERED, deliberately recorded rather than left as a silent gap: the
// final re-check in `salvageBundle` (`return bundleUsable(path, leaf).ok ? ...`)
// has no test that dies when it is removed. Three attempts failed and the third
// explains the other two.
//
// For the re-check to matter, salvage must KEEP a file that breaks the merge.
// The keep rule admits `true` and `null`, so that needs a file whose probe
// answers `null` — and `null` is not a per-file condition. It means the probe
// could not run at all: no leaf to serve, no interpreter, a kill. Those apply
// to every candidate at once, so either nothing is kept (and salvage returns
// null before the re-check) or everything is, and a rebuild of everything
// reproduces the bundle we could not judge — which is the intended answer for
// "we could not ask", not a defect the re-check should catch.
//
// Measured while trying: a genuine breaker
// (`-----BEGIN PUBLIC KEY----------BEGIN CERTIFICATE-----`, verified to load 0
// certificates beside our CA) is answered `false` and dropped by the loop, so
// the re-check never sees it. Files that pass pairwise still pass concatenated
// here, because `nl()` normalises the joint that would otherwise fuse.
//
// So the re-check is a backstop for a case this code cannot currently produce.
// It stays because the keep rule is the thing most likely to be widened by the
// next person, and widening it is exactly what makes the case reachable. A test
// would need a probe that fails for ONE file and not the others — that is a
// seam this module does not have, and inventing one to test a backstop is worse
// than recording why the backstop is unreachable today.

// NODE_OPTIONS can `--require` a module that writes to stdout before our
// sentinel. Left in the probe's environment it forges an accept: the preload
// prints `CATRUST-OK 1`, the regex matches it, and a bundle whose true verdict
// is refuse is accepted. Its sibling NODE_TLS_REJECT_UNAUTHORIZED is covered
// above; this one was not, and both are one line in the same object.

// `verifiesOurLeaf` answers FOUR values — true / false / null / "local" — and
// the keep rule admits two of them by name. `"local"` matches neither arm, so
// it falls through with `false` and the publisher is DROPPED.
//
// `"local"` is an unknown, not a refusal: it means our own leaf key/cert pair
// does not serve (forward-proxy.mjs documents a two-rename window where the two
// come from different generations), so the probe never reached a handshake and
// says nothing about the file it was handed. Dropping on it discards every
// publisher on a host whose bundle is perfect, which is the loss this function
// exists to prevent — and it is the same defect as collapsing `unknown` into a
// refusal, one level down, on the value this diff added.
test("ca-trust: salvage keeps publishers when the probe cannot serve our own leaf", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem"), "utf8"));
    writeFileSync(join(trustDir, "b-ccf.pem"), ours);
    // An ABSENT leaf key: readFileSync throws inside the probe before listen,
    // so it reports `E` and verifiesOurLeaf returns "local". Measured, and the
    // distinction matters: a key that exists but belongs to a different pair
    // reads `ok:false`, NOT "local" — the probe reaches a handshake and the
    // handshake genuinely fails. Only a key the probe cannot read at all
    // produces the fourth value.
    const unserveable = { keyPath: join(dir, "no-such.key"), certPath: join(dir, "leaf.pem"),
                          host: "api.anthropic.com" };
    assert.equal(bundleUsable(join(dir, "ca.pem"), unserveable).unknown, true,
      "premise: an unserveable leaf must read as unknown, not as a verdict");

    const out = scratchDir("ca-local-");
    let n = 0;
    const got = salvageBundle(trustDir, ours, unserveable,
      (text) => { const p = join(out, `l${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(n > 0, "premise: the probe was actually attempted");
    assert.ok(got, "an unserveable leaf must not drop every publisher — it is an unknown, not a refusal");
    const kept = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(kept, 2, `expected the peer publisher plus our CA, got ${kept} blocks`);   // the ccf publisher IS our CA
  });
});

// The probe's request goes to 127.0.0.1, to a server it started itself, so it
// looks unproxyable. It is not: node >=24 honours the *_PROXY family under
// NODE_USE_ENV_PROXY=1, sends the CONNECT to the operator's proxy, and the
// handshake then terminates SOMEWHERE ELSE. The verdict becomes a statement
// about the wrong peer.
//
// Measured on this box before the fix, healthy bundle, a listener on the proxy
// port: `{ok:false}` and one CONNECT arriving at that listener. A good bundle
// refused, and the caller narrows the session to our CA alone — on exactly the
// corporate machines that set these variables.
//
// This is the THIRD variable in a list that was written as two. `NO_PROXY: "*"`
// as well as the empty proxy vars, because "no proxy for anything" is a
// statement the child cannot misread, while an empty HTTPS_PROXY relies on
// every future reader treating "" as unset.
//
// SYNCHRONOUS on purpose. `withCA` sets CACHE_FIX_CA_DIR on the shared
// process.env, so an async test yields the interpreter between its own
// assertions and a sibling test's withCA repoints the dir underneath it —
// measured: this case passed alone and failed the premise inside the full file,
// on both env-mutating siblings. The listener therefore has to be started with
// a blocking handshake rather than awaited.
test("ca-trust: the operator's environment cannot forge either probe's answer", () => {
  // Both probes run in a CHILD, and the parent's environment is what an operator
  // controls. Three variables can each turn a refusal into an accept, and the
  // guard is only worth having if none of them reach the child.
  //
  // One test, not three, because the three were the same fourteen lines with a
  // different variable name: build a file the probe REFUSES, assert that premise,
  // set the variable, assert the answer did not move. Written as a table so a
  // fourth variable is a row rather than another copy — and so the premise
  // assertion, which is what makes each row non-vacuous, cannot be forgotten in
  // one copy and kept in the others.
  withCA({}, (dir) => {
    ensureCA();
    const scratch = scratchDir("ca-env-");
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    // Refused by BOTH probes: node loads nothing of ours from it.
    const stale = join(scratch, "stale.pem");
    writeFileSync(stale, "-----BEGIN CERTIFICATE-----\nc3RhbGU=\n-----END CERTIFICATE-----\n");

    // A preload that prints each probe's own success marker. If the child ever
    // inherited NODE_OPTIONS, this would be read as the probe's answer.
    const forgeUsable = join(scratch, "forge-usable.cjs");
    writeFileSync(forgeUsable, 'process.stdout.write("CATRUST-OK 1");\n');
    const forgeCarries = join(scratch, "forge-carries.cjs");
    writeFileSync(forgeCarries,
      `process.stdout.write("CATRUST-C " + JSON.stringify([${JSON.stringify(ours)}]));\n`);

    const ask = {
      bundleUsable: () => bundleUsable(stale, leafOf(dir)).ok,
      carriesOurCA: () => carriesOurCA(stale, ours),
    };
    const rows = [
      ["NODE_TLS_REJECT_UNAUTHORIZED", "0", "bundleUsable"],
      ["NODE_OPTIONS", `--require ${forgeUsable}`, "bundleUsable"],
      ["NODE_OPTIONS", `--require ${forgeCarries}`, "carriesOurCA"],
    ];
    for (const [key, value, probe] of rows) {
      assert.equal(ask[probe](), false,
        `premise: ${probe} must REFUSE this file before ${key} is set, or the row proves nothing`);
      const saved = process.env[key];
      process.env[key] = value;
      try {
        assert.equal(ask[probe](), false,
          `${key}=${value} in the parent reached the child and moved ${probe}'s answer`);
      } finally {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
      }
    }
  });
});

test("ca-trust: the operator's proxy env cannot redirect the probe's own handshake", (t) => {
  const keys = ["NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY",
                "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    withCA({}, (dir) => {
      ensureCA();
      const healthy = join(dir, "ca.pem");
      assert.equal(bundleUsable(healthy, leafOf(dir)).ok, true,
        "premise: our own CA verifies our own leaf");

      // A proxy URL that CANNOT be reached. If the probe honours it, the
      // CONNECT fails and the verdict flips to `ok:false` — the false-reject
      // half of the defect, and the half that fires on every corporate machine.
      // A dead port rather than a live fake listener because a listener is
      // async and this test must stay synchronous: `withCA` mutates the shared
      // process.env, and an await here lets a sibling test repoint
      // CACHE_FIX_CA_DIR mid-assertion (measured — the premise above failed
      // inside the full file and passed alone).
      for (const k of keys) delete process.env[k];
      // A LIVE listener, in a child so this test stays synchronous. A dead port
      // is indistinguishable from no proxy at all — measured, both give
      // ECONNREFUSED — so pointing at one would leave the env inert and the
      // assertion below vacuous.
      // The port arrives via a FILE, not stdout: this test is synchronous, so the
      // parent's event loop never runs to drain a pipe while it polls. Measured
      // — the stdout version reported "must report a port" forever.
      const portFile = join(scratchDir("ca-px-"), "port");
      const px = spawn(process.execPath, ["-e",
        `const net=require("node:net"),fs=require("node:fs");
         const s=net.createServer(c=>{c.on("error",()=>{});c.destroy()});
         s.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[1],String(s.address().port)));`,
        portFile], { stdio: "ignore" });
      let port = 0;
      for (let i = 0; i < 200 && !port; i++) {
        spawnSync(process.execPath, ["-e", "setTimeout(()=>{},25)"], { timeout: 5_000 });
        try { port = Number(readFileSync(portFile, "utf8")); } catch { /* not yet */ }
      }
      assert.ok(port > 0, "premise: the fake proxy must report a port");
      // EVERY variable set, so removing ANY ONE clear from the probe env is
      // visible. The previous form set only NODE_USE_ENV_PROXY + two of the
      // family, so seven individual clears could be deleted with the suite
      // still green — the exact "list written as two when it needed three"
      // shape this fix was for, one round later.
      const url = `http://127.0.0.1:${port}`;
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "ALL_PROXY", "all_proxy"]) process.env[k] = url;
      process.env.NODE_USE_ENV_PROXY = "1";

      // POSITIVE CONTROL, and it is the whole reason this test is trustworthy.
      // The assertion below is a NEGATIVE — "the env did not reach the probe" —
      // and a negative from an instrument never shown capable of a positive is
      // not a measurement.
      //
      // So plant the state first: a child that DOES honour this env must fail
      // to reach a dead proxy port. Reachable means the env is inert here — an
      // ambient NO_PROXY exempting loopback, or a runtime with no
      // NODE_USE_ENV_PROXY at all (it arrived in 22; `engines` allows >=18) —
      // and the assertion below would then pass against unfixed code.
      const control = spawnSync(process.execPath, ["-e",
        'require("node:https").get({host:"127.0.0.1",port:44599,path:"/"},'
        + '()=>console.log("REACHED")).on("error",e=>console.log("ERR "+e.code))'],
        { env: process.env, encoding: "utf8", timeout: 15_000 });
      // NOT ECONNREFUSED: that is what a child gets with no proxy env at all, so
      // it cannot distinguish "routed and the proxy refused" from "never routed"
      // — measured, a dead proxy port and an empty env give the identical
      // string. Reaching a live listener that hangs up yields ECONNRESET (or a
      // tunnel error), which only happens if the env WAS honoured.
      try {
        // Skip, not fail: an unplantable control means this runtime cannot host
        // the measurement, which is not the defect under test.
        if (/REACHED|ECONNREFUSED/.test(control.stdout || "")) {
          t.skip(`this runtime does not route a child through proxy env (${process.version}), ` +
                 `so the control cannot be planted; got ${JSON.stringify(control.stdout)}`);
          return;
        }
        assert.equal(bundleUsable(healthy, leafOf(dir)).ok, true,
          "the operator's proxy env reached the probe and changed its verdict");
      } finally { px.kill("SIGTERM"); }
    });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// Per-probe timeouts STACK. Each `verifiesOurLeaf` caps at 5 s, so without a
// budget N wedged publishers is (N+1)x5 s — measured with the deadline check
// removed: 30.1 s at five publishers, 60.3 s at eleven, against 25.1 s with the
// budget in place. Spent AFTER the proxy is forked and BEFORE claude starts, so
// the launcher looks hung.
//
// The budget's answer when it expires is the same as the keep rule's answer to
// an unjudgeable file: keep it. Refusing instead would narrow trust because we
// ran out of time, which is the failure this whole path exists to prevent.
//
// Driven with an unreachable interpreter so every probe burns its full timeout:
// the budget must cut in and the rebuild must still carry every publisher.
test("ca-trust: salvage stops probing at a budget and keeps what it did not judge", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    for (const n of ["a", "b", "c", "d"]) {
      writeFileSync(join(trustDir, `${n}.pem`), n === "d" ? ours : peer);
    }
    const out = scratchDir("ca-budget-");
    let n = 0;
    const started = Date.now();
    const got = salvageBundle(trustDir, ours, leafOf(dir),
      (text) => { const p = join(out, `t${++n}.pem`); writeFileSync(p, text); return p; });
    const elapsed = Date.now() - started;
    assert.ok(got, "a healthy trust dir must still rebuild");
    const blocks = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(blocks, 4, `expected three distinct publishers plus our CA, got ${blocks}`);
    // The budget must not fire on a HEALTHY dir — that would make it a
    // correctness hazard rather than a hang guard. Four probes at ~43 ms each
    // is two orders of magnitude under the 20 s budget.
    assert.ok(elapsed < 20_000,
      `a healthy four-publisher salvage took ${elapsed} ms, at or past the budget`);

    // Now the EXPIRED path, which is the half that has no cover otherwise: a
    // zero budget means every candidate goes unprobed. Every one must still be
    // KEPT — running out of time is "could not ask", not "broken".
    process.env.CACHE_FIX_CA_SALVAGE_BUDGET_MS = "1";
    try {
      let m = 0;
      const probed = [];
      const cut = salvageBundle(trustDir, ours, leafOf(dir),
        (text) => { probed.push(1); const p = join(out, `x${++m}.pem`); writeFileSync(p, text); return p; });
      assert.ok(cut, "an expired budget must still yield a bundle");
      const n2 = (readFileSync(cut, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
      // FIVE, not four: an expired budget skips the probe, and the dedupe lives
      // on the probed path, so an unprobed candidate that happens to be our CA
      // is kept and then appended again. Keeping a duplicate is the right
      // direction when we could not ask — node loads duplicates harmlessly, and
      // dropping a file we never judged is the loss this path exists to prevent.
      assert.equal(n2, 5, `an expired budget must keep every publisher, got ${n2}`);
      // ...and it must have stopped SPAWNING. Four candidates plus the rebuild
      // is five writeTmp calls when probing; with the budget spent it is one.
      assert.ok(probed.length < 5,
        `the budget expired but ${probed.length} candidate probes still ran`);
    } finally {
      delete process.env.CACHE_FIX_CA_SALVAGE_BUDGET_MS;
    }
  });
});

// The keep rule and the re-check are each correct and COMPOSE into the failure
// both were written to prevent. When the probe cannot answer for any candidate,
// the keep rule keeps everything — including a genuinely fatal file — and the
// re-check then also answers `unknown`, so `.ok === false` is false and the
// broken rebuild is RETURNED.
//
// Measured before the fix: salvage handed back a bundle node loads 0 CAs from,
// while the caller's own fallback loads 1. The session distrusts the very proxy
// it is routed through, and stderr says "rebuilt from the publishers that work".
//
// The two triggers are not independent — a torn publisher in ca-trust.d is
// exactly what produces a torn merge — so this is not a hypothetical pairing.
test("ca-trust: salvage refuses to hand back an unjudged rebuild of a merge it could not fault", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    // Sorts first, and is fatal to the merge: overlapping openers take the whole
    // load down rather than being skipped.
    writeFileSync(join(trustDir, "a-bad.pem"),
      "-----BEGIN PUBLIC KEY----------BEGIN CERTIFICATE-----\nAAAA\n-----END PUBLIC KEY-----\n");
    writeFileSync(join(trustDir, "b-ccf.pem"), ours);
    const out = scratchDir("ca-compose-");
    let n = 0;
    // Nothing can be judged: our own leaf cannot be served.
    const unserveable = { keyPath: join(dir, "leaf.key"), certPath: join(dir, "no-such.pem"),
                          host: "api.anthropic.com" };
    const got = salvageBundle(trustDir, ours, unserveable,
      (text) => { const p = join(out, `c${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(n > 0, "premise: the probe was actually attempted");
    assert.equal(got, null,
      "salvage returned a rebuild nothing judged, of a merge it could not fault — the caller's fallback is better");
  });
});

// `carriesOurCA` spawns a child and reads a sentinel off its stdout, so a
// NODE_OPTIONS preload can write the sentinel first and forge the answer. The
// forgery surface is larger than the count it replaced: the payload is now the
// LIST of loaded certificates, so a preload that echoes our own CA back claims
// a bundle carries it when node loaded nothing of the sort — which is precisely
// how a rebuild the session cannot verify would get past this guard.
//
// The sibling handshake probe clears NODE_OPTIONS for the same reason and has a
// test; the predecessor of this one cleared it with no test, and the mutation
// survived a full suite.

// THREE ANSWERS, NEVER TWO — the same contract `bundleUsable` already keeps,
// and the reason this probe needed it too.
//
// `carriesOurCA` used to collapse "could not ask" into "yes". Read as an answer
// that is right in one direction only: at a gate reached BECAUSE the bundle was
// already refused, "could not ask" widens onto a file measured unusable. On any
// runtime before v22.15 — most of what `engines: >=18` promises — that was not
// an edge case but every launch with a stale merge:
//
//   merge verdict {ok:false}, merge carries none of ours, our own CA verifies
//   node 24        -> carriesOurCA false -> our CA        (correct)
//   pre-v22.15     -> carriesOurCA TRUE  -> THE MERGE     (R1 violated)
//
// So it returns `true` / `false` / `null`, and each call site says out loud what
// it does with `null` rather than inheriting one global guess.
test("ca-trust: the CA probe answers 'could not ask' rather than guessing yes",
     { skip: canCountCAs ? false : "runtime has no tls.getCACertificates, so every answer here is already null" }, () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const bundle = join(scratchDir("ca-tri-"), "ours.pem");
    writeFileSync(bundle, ours);
    // Positive and negative control first: an instrument that cannot produce a
    // true and a false has not shown it can produce anything.
    assert.equal(carriesOurCA(bundle, ours), true, "control: our CA is in this file");
    assert.equal(carriesOurCA(join(dir, "leaf.pem"), ours), false,
      "control: our CA is not in the leaf");
    // A MISSING file is not an unanswerable probe — node runs fine and warns
    // `Ignoring extra certs`, which is a real `false`. Worth asserting, because
    // that was this test's first premise and it was wrong: the two failures look
    // alike from outside and mean opposite things.
    assert.equal(carriesOurCA(join(dir, "no-such-file.pem"), ours), false,
      "a file node refuses outright is a measured no, not an unanswerable probe");
    // The genuinely unanswerable case reaches the same branch a pre-v22.15
    // runtime and a truncated stdout do. Driven through the seam, because the
    // alternatives are a runtime this box does not have and a 626-certificate
    // bundle — and a branch no test can reach is not a guarded branch.
    process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE = "1";
    try {
      assert.equal(carriesOurCA(bundle, ours), null,
        "a probe that could not answer must say so, not answer yes");
    } finally {
      delete process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;
    }
    // The other two doors to the same answer, driven rather than reasoned
    // about. Each was mutated to fail open and left the whole suite green, so
    // neither was guarded by the seam above — one seam does not cover three
    // paths just because they return the same value.
    //
    // 1. The child never ran. `NODE_OPTIONS` is cleared inside the probe, so it
    //    cannot be used here; a bad execPath is the honest way to break the
    //    spawn itself.
    const savedExec = process.execPath;
    try {
      Object.defineProperty(process, "execPath",
        { value: join(dir, "no-such-node"), configurable: true });
      assert.equal(carriesOurCA(bundle, ours), null,
        "a spawn that failed is not evidence the bundle carries our CA");
    } finally {
      Object.defineProperty(process, "execPath", { value: savedExec, configurable: true });
    }
    // A THIRD case used to live here: the probe's stdout buffer overflowing past
    // ~626 certificates, driven through a `maxBuffer` seam. It is gone because
    // the payload is gone — the child now returns one token instead of the whole
    // certificate list, so there is nothing to truncate at any bundle size. A
    // branch removed by design needs no test; keeping the seam would have meant
    // keeping the failure mode it existed to reach.
  });
});

// THE LAZY LOAD, which made the stderr sniff dead code on the exact runtimes it
// was reordered to serve.
//
// node's extras load is lazy on newer runtimes: it happens when the trust store
// is first consulted. The child consulted it only inside `getCACertificates`, so
// on a host WITHOUT that API it answered "cannot tell" having never touched the
// store — and the warning that tells us the real client would discard the file
// was never emitted. Measured on real binaries, same file, same bundle, only the
// interpreter differing:
//
//   v18.20.8 / v20.19.0 / v22.6.0   API absent, WARNS     (eager load)
//   v22.7.0 … v22.14.x              API absent, SILENT    <- blind
//   v22.15.0 / v24.11.1             API present, WARNS
//
// The launcher reads a missing answer as "keep the merge", so that whole window
// shipped a bundle the client discards entirely, silently. `engines: >=18`
// promises those hosts.
//
// The seam hides the API, which is what a pre-v22.15 host presents. It must NOT
// also skip the forced load: a first attempt did, and that simulates the code
// WITHOUT the fix, so this test asserted against a child that did not have it
// and failed while the shipped code was correct.
test("ca-trust: the probe still sees a client-fatal bundle when it cannot count", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    const scratch = scratchDir("ca-lazy-");
    // The file must END mid-base64 with NO trailing newline. That is the trigger,
    // and it is narrower than it looks: four other shapes were measured against
    // this exact pair and node RECOVERED from every one — a space before the END
    // marker, the END line removed, a body character dropped, and the peer cut in
    // half. A byte-count truncation leaves complete DER often enough that a
    // fixture built that way asserts a state it cannot create, which is why the
    // first version of this test passed standalone and failed in-suite.
    const split = join(scratch, "split.pem");
    writeFileSync(split, ours + peer.trimEnd().slice(0, -40));
    const clean = join(scratch, "clean.pem");
    writeFileSync(clean, ours + peer);

    const saved = process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;
    process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE = "1";
    try {
      // The whole point: counting is impossible here, and the damage must STILL
      // be reported, because the client's verdict does not depend on counting.
      assert.equal(carriesOurCA(split, ours), false,
        "a runtime that cannot count must still refuse a bundle the client discards");
      // CONTROL, in the same setting: a healthy bundle under the same runtime
      // must answer `null` — "could not ask" — not `false`. Without this the
      // assertion above is satisfied by a probe that refuses everything.
      assert.equal(carriesOurCA(clean, ours), null,
        "control: a healthy bundle on a runtime that cannot count is unknown, not refused");
    } finally {
      if (saved === undefined) delete process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;
      else process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE = saved;
    }
  });
});

// THE HAPPY PATH HAD THE SAME HOLE, and it was found by applying to this file
// the error another reviewer had just caught in their own: a property proved of
// ONE function reported as a property of the pipeline.
//
// Every measurement about the loaded-certificate check went through the REFUSED
// branch. The branch that runs first — the merge verified, hand it over — asked
// only whether the handshake succeeds, which is a node question:
//
//   bundle                     handshake      loaded-cert check
//   healthy (control)          ok, HANDED     carries ours
//   ours, THEN a fatal block   ok, HANDED     DOES NOT carry ours
//   torn ahead of ours (ctrl)  not ok         does not carry ours
//
// Row 2 ships. node truncates at the damage and keeps our CA, so the handshake
// succeeds; the real client discards the entire file, and a discarded file also
// takes down CAs supplied through `SSL_CERT_FILE` or `SSL_CERT_DIR` — measured,
// two independent sources. So the happy path could hand `claude` a bundle that
// leaves it trusting nothing at all.
test("ca-trust: a bundle that verifies our leaf is still refused when the client would discard it",
     { skip: canCountCAs ? false : "runtime has no tls.getCACertificates, so every answer here is already null" }, () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    const scratch = scratchDir("ca-happy-");
    const leaf = leafOf(dir);

    // Our CA first, damage after: the handshake sees ours, the client sees none.
    const split = join(scratch, "split.pem");
    writeFileSync(split, ours + peer.slice(0, peer.length - 120));
    // The premise, stated as a measurement: this file really does pass the
    // handshake. If that ever stops being true the assertion below passes for
    // the wrong reason.
    assert.equal(bundleUsable(split, leaf).ok, true,
      "premise: node verifies our leaf with this bundle");
    assert.equal(carriesOurCA(split, ours), false,
      "the real client discards this file, so a passing handshake is not enough");

    // CONTROL: undamaged, and both must accept it — otherwise the assertion
    // above is met by a check that refuses everything.
    const clean = join(scratch, "clean.pem");
    writeFileSync(clean, ours + peer);
    assert.equal(bundleUsable(clean, leaf).ok, true, "control: healthy bundle verifies");
    assert.equal(carriesOurCA(clean, ours), true, "control: healthy bundle is not refused");
  });
});

// THE CLIENT IS NOT NODE, and this is the one shape where that changes the
// answer. Since CC 2.1.113 `claude` is a Bun binary linked against BoringSSL:
//
//   our CA, then a fatal block   node loads 1 (ours)   client DISCARDS THE FILE
//
// node truncates and keeps what it read before the damage; BoringSSL is
// all-or-nothing. So "node loaded ours" was true of a file the session gets
// nothing from — it would launch trusting no extras at all, including the proxy
// it is routed through.
//
// Measured against the shipped binary (2.1.220) over a local TLS server, 16
// bundle shapes, both controls live — the original ten plus six built to break
// the signal in the UNSAFE direction (node silent, client discards). The tell node gives us is its own stderr:
// it warns `Ignoring extra certs ... load failed` for exactly the files
// BoringSSL discards, and stays silent for exactly the ones it accepts —
// including three where a marker COUNT got the answer wrong.
test("ca-trust: a bundle the real client would discard is refused, even when node keeps part of it",
     { skip: canCountCAs ? false : "runtime has no tls.getCACertificates, so every answer here is already null" }, () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const scratch = scratchDir("ca-boring-");
    // Our CA FIRST, damage after: node keeps ours, the client keeps nothing.
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    const split = join(scratch, "split.pem");
    writeFileSync(split, ours + peer.slice(0, peer.length - 120));
    // The premise, asked of node directly: it really does load our CA here. If
    // this ever stops being true the test below passes for the wrong reason.
    const loaded = spawnSync(process.execPath,
      ["-e", 'process.stdout.write(JSON.stringify(require("node:tls").getCACertificates("extra")))'],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: split, NODE_OPTIONS: "" }, encoding: "utf8" }).stdout;
    const norm = (t) => String(t).replace(/\s+/g, "");
    assert.ok(JSON.parse(loaded).some((p) => norm(p) === norm(ours)),
      "premise: node loads our CA from this file despite the damage");
    assert.equal(carriesOurCA(split, ours), false,
      "node kept our CA from before the damage, but the real client discards the whole file");
    // CONTROL: the same two certificates, undamaged, must still be accepted —
    // otherwise the assertion above is satisfied by a guard that refuses
    // everything.
    const clean = join(scratch, "clean.pem");
    writeFileSync(clean, ours + peer);
    assert.equal(carriesOurCA(clean, ours), true,
      "control: an undamaged bundle carrying our CA must still be accepted");
  });
});

// The rebuild's final guard used to be `loadsNothing`, and a comment here
// argued the `bundleUsable` re-check after it was unreachable. That argument was
// wrong, and it was wrong in the way a shape argument usually is — it reasoned
// about which files the keep rule DROPS and never about what node does with the
// ones it keeps:
//
//   "every rebuild ends with `nl(ourText)` appended, so a rebuild that loads
//    anything at all loads OUR CA"
//
// False on the runtime. node's extras loader stops at the first fatal block and
// KEEPS what it read before it. So a publisher that is healthy-then-damaged
// truncates the load ahead of our appended CA:
//
//   good peer + fused corporate tail + nl(ourText)  ->  loaded 1, ours NOT among it
//   Warning: Ignoring extra certs ... error:04800066:PEM routines::bad end line
//
// `loadsNothing` is FALSE there (one certificate did load), so counting cannot
// see it. Under an `unknown` verdict the re-check is disabled by design
// (`.ok === false` is false of `{unknown:true}`), so nothing caught it either:
// the launcher handed claude a bundle trusting a foreign CA and not the proxy
// it was routed through, while stderr said "rebuilt from the publishers that
// work".
//
// The guard that replaces both is the round-5 sentence made executable: "loads
// something" and "loads OURS" are different questions, and only the second one
// matters. `carriesOurCA` asks node which certificates it loaded and compares
// them against our own — no handshake, so it still answers when the leaf cannot
// be served, which is exactly the door this failure came through.
// THE KEEP RULE HAS TO KNOW ABOUT THE FOURTH ANSWER, and it did not.
//
// `verifiesOurLeaf` gained `"discarded"` — node verified our leaf AND warned it
// dropped the file's extras, which is the shape the real client discards
// entirely. The keep rule tests `answer !== false`, and its own comment defends
// that as future-proof: "this function has FOUR return values and the version
// that named two of them silently dropped the third. Any future unknown lands on
// the safe side by default." But `discarded` is not an unknown. It is a MEASURED
// refusal, and `!== false` keeps it.
//
// The cost is not R1 — the final gate still refuses the poisoned rebuild, so
// nothing unverifiable reaches `claude`. It is R2, and it inverts the severity
// ordering: a WHOLLY torn publisher answers `false`, is dropped, and the rebuild
// survives; a client-fatal one is kept and takes every healthy publisher down
// with it. The more surgically damaged file causes the worse outcome. Measured:
//
//   two healthy corp roots                  rebuild, 3 CAs
//   healthy + WHOLLY torn publisher         rebuild, 2 CAs   (torn dropped)
//   healthy + (our CA copy)+(fatal block)   NULL -> our CA alone, 1 CA
test("ca-trust: salvage drops a publisher the client would discard, not just a torn one", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const peer = readFileSync(join(dir, "leaf.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const out = scratchDir("ca-fourth-");
    const build = (poison) => {
      rmSync(trustDir, { recursive: true, force: true });
      mkdirSync(trustDir, { recursive: true });
      writeFileSync(join(trustDir, "a-peer.pem"), peer);      // healthy publisher
      writeFileSync(join(trustDir, "ccf.pem"), ours);
      if (poison) writeFileSync(join(trustDir, "z-poison.pem"), poison);
      let n = 0;
      return salvageBundle(trustDir, ours, leafOf(dir),
        (t) => { const p = join(out, `f${Math.random().toString(36).slice(2)}${n++}.pem`); writeFileSync(p, t); return p; });
    };
    const blocks = (p) => (readFileSync(p, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;

    // CONTROL: no poison at all — the rebuild must carry the peer and ours.
    const clean = build(null);
    assert.ok(clean, "control: a healthy trust dir must rebuild");
    assert.equal(blocks(clean), 2, "control: peer + ours");

    // CONTROL: a WHOLLY torn publisher answers `false` and is dropped, so the
    // rebuild survives. Without this row the assertion below could be satisfied
    // by a salvage that drops everything damaged-looking.
    const torn = build(peer.trimEnd().slice(0, -40));
    assert.ok(torn, "control: a wholly torn publisher must be dropped, not fatal");
    assert.equal(blocks(torn), 2, "control: the torn file is dropped and the rest survives");

    // THE CASE: a publisher that is (a copy of our CA) + (a fatal block). node
    // verifies our leaf with it — so the probe answers `discarded`, not `false`
    // — while the real client discards the whole file.
    const got = build(ours + peer.trimEnd().slice(0, -40));
    assert.ok(got,
      "a publisher the client would discard was KEPT, poisoning the rebuild — " +
      "one bad publisher cost every good one");
    assert.equal(blocks(got), 2,
      "the poisoned publisher must be dropped and the healthy ones kept");
  });
});

test("ca-trust: salvage refuses a rebuild node loads that does not carry OUR CA", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    // A healthy block followed by a truncated one, in ONE file. The healthy half
    // is what node keeps; the damage is what stops it before our CA. A wholly
    // torn file would not reproduce this — the load would reach nothing at all
    // and `loadsNothing` would catch it, which is the case already covered.
    const healthy = readFileSync(join(dir, "leaf.pem"), "utf8");
    writeFileSync(join(trustDir, "a-peer.pem"), healthy + ours.slice(0, ours.length - 120));
    const out = scratchDir("ca-carries-");
    let n = 0;
    // `unknown` for everything: our own leaf cannot be served, so the keep rule
    // keeps the damaged file and the re-check cannot fault the rebuild.
    const unserveable = { keyPath: join(dir, "leaf.key"), certPath: join(dir, "no-such.pem"),
                          host: "api.anthropic.com" };
    const got = salvageBundle(trustDir, ours, unserveable,
      (text) => { const p = join(out, `c${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(n > 0, "premise: a rebuild was actually assembled");
    assert.equal(got, null,
      "salvage returned a rebuild node loads certificates from, none of them ours — " +
      "the session would distrust the proxy it is routed through");
  });
});

// The CONTROL for the test above, and it is not optional: a fixture that never
// salvages anything would pass that assertion while measuring nothing. A healthy
// publisher under the SAME unjudgeable conditions must still produce a rebuild,
// and that rebuild must carry our CA.
test("ca-trust: …and still rebuilds from a healthy publisher it cannot judge", () => {
  withCA({}, (dir) => {
    ensureCA();
    const ours = readFileSync(join(dir, "ca.pem"), "utf8");
    const trustDir = join(dir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, "a-peer.pem"), readFileSync(join(dir, "leaf.pem"), "utf8"));
    const out = scratchDir("ca-carries-ok-");
    let n = 0;
    const unserveable = { keyPath: join(dir, "leaf.key"), certPath: join(dir, "no-such.pem"),
                          host: "api.anthropic.com" };
    const got = salvageBundle(trustDir, ours, unserveable,
      (text) => { const p = join(out, `k${++n}.pem`); writeFileSync(p, text); return p; });
    assert.ok(got, "a healthy publisher must still rebuild when nothing can be judged");
    const blocks = (readFileSync(got, "utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert.equal(blocks, 2, `expected the peer plus our CA, got ${blocks}`);
  });
});

// --- subsumes: may we overwrite a trust file the operator already set? ------
//
// The launcher points SSL_CERT_FILE / REQUESTS_CA_BUNDLE at our merged bundle so
// a session's python clients can verify the MITM we put in front of them. Those
// two vars name ONE file each, so pointing them at ours discards whatever they
// named before. On this operator's fleet that is provably lossless — the file
// they named is the same corp store our builder concatenates first — but this is
// a public fork and nothing in the repo can assume that. So we prove it per-run
// instead of assuming it: replace only when every certificate the old file
// carried is also in ours.
const bundleOf = (dir, name, pems) => {
  const p = join(dir, name);
  writeFileSync(p, pems.join(""));
  return p;
};
// Two unrelated roots, minted the way the proxy mints its own.
const twoRoots = () => {
  let a, b;
  withCA({}, (dir) => { ensureCA(); a = readFileSync(join(dir, "ca.pem"), "utf8"); });
  withCA({}, (dir) => { ensureCA(); b = readFileSync(join(dir, "ca.pem"), "utf8"); });
  assert.notEqual(a, b, "premise: the two fixtures must be different roots");
  return [a, b];
};

test("subsumes: says yes when ours carries everything the old file did", () => {
  const d = scratchDir("subsumes-");
  const [ours, theirs] = twoRoots();
  const bundle = bundleOf(d, "ca-trust.pem", [theirs, ours]);
  const existing = bundleOf(d, "corp.pem", [theirs]);
  assert.equal(subsumes(bundle, existing).ok, true);
});

test("subsumes: says NO when the old file carries a root ours does not — the trust-narrowing case", () => {
  const d = scratchDir("subsumes-");
  const [ours, theirs] = twoRoots();
  const bundle = bundleOf(d, "ca-trust.pem", [ours]);
  const existing = bundleOf(d, "corp.pem", [theirs]);
  const r = subsumes(bundle, existing);
  assert.equal(r.ok, false);
  assert.match(r.reason, /1 /, `reason should count what would be lost, got: ${r.reason}`);
});

test("subsumes: says yes when there was no old file to lose", () => {
  const d = scratchDir("subsumes-");
  const [ours] = twoRoots();
  assert.equal(subsumes(bundleOf(d, "ca-trust.pem", [ours]), join(d, "absent.pem")).ok, true);
  assert.equal(subsumes(bundleOf(d, "ca-trust.pem", [ours]), undefined).ok, true);
});

test("subsumes: says NO on a WELL-FORMED block whose body is not a certificate", () => {
  // Distinct from the truncated case above, and the mutation table is why it
  // exists: a BEGIN with no END is caught by the marker-count guard before the
  // parse ever runs, so the parse-failure arm had no test reaching it and a
  // mutant that made it fail open survived the whole subsumes table. This block
  // has both markers and a body X509Certificate rejects, which is the only
  // shape that lands there.
  const d = scratchDir("subsumes-");
  const [ours] = twoRoots();
  const garbage = join(d, "garbage.pem");
  writeFileSync(garbage, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n");
  const r = subsumes(bundleOf(d, "ca-trust.pem", [ours]), garbage);
  assert.equal(r.ok, false, `a block that does not parse must refuse, got: ${JSON.stringify(r)}`);
  assert.match(r.reason, /cannot parse/, `reason should name the parse failure, got: ${r.reason}`);
});

test("subsumes: says NO when the old file cannot be parsed, rather than guessing", () => {
  // Unreadable is not the same as empty. We cannot show no loss, so we must
  // not claim it — the whole point of the check is to refuse silent narrowing.
  const d = scratchDir("subsumes-");
  const [ours] = twoRoots();
  const torn = join(d, "torn.pem");
  writeFileSync(torn, "-----BEGIN CERTIFICATE-----\ntruncated\n");
  assert.equal(subsumes(bundleOf(d, "ca-trust.pem", [ours]), torn).ok, false);
});
