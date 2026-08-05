import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir, cpus } from "node:os";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import tls from "node:tls";

// The keep-the-merge branch needs a census that can say YES, and
// `tls.getCACertificates` arrived in v22.15 while `engines` allows >=18. Below
// that the census answers `null` for every healthy bundle, so the branch cannot
// fire and the two rows that assert it would fail describing a defect that is
// not there. Asked of the runtime, not of its version string.
const canCountCAs = typeof tls.getCACertificates === "function";
// The launcher's own trust question, asked the same way it asks it.
import { bundleUsable } from "../bin/ca-trust.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(__dirname, "../bin/claude-via-proxy.mjs");
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");

// Every temp dir this file makes, removed once at the end.
//
// Registered centrally rather than rmSync'd per test: forward mode mints an RSA
// CA and leaf inside each config dir, so a leak is not an empty directory, it is
// private key material. Measured before this: one `node --test` of this file
// left 38 dirs behind, and a /tmp that had accumulated 1954 of them held 432
// ca.key / leaf.key files. Per-test cleanup would also skip exactly the runs
// that matter — a failing test throws before its own rmSync — and every future
// test would have to remember. after() runs on pass and on fail.
const tempDirs = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("proxy server lifecycle", () => {
  it("starts and responds to health check", async () => {
    const proxyProc = fork(SERVER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_PROXY_BIND: "127.0.0.1" },
    });

    let port;
    await new Promise((resolve, reject) => {
      let output = "";
      proxyProc.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/:(\d+)/);
        if (match) { port = parseInt(match[1], 10); resolve(); }
      });
      proxyProc.on("error", reject);
      proxyProc.on("exit", (code) => {
        if (!port) reject(new Error(`Proxy exited (code ${code}) before ready`));
      });
      setTimeout(() => reject(new Error("Proxy startup timeout")), 10000);
    });

    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, resolve).on("error", reject);
    });
    assert.equal(res.statusCode, 200);

    proxyProc.kill("SIGTERM");
    await new Promise((resolve) => proxyProc.on("exit", resolve));
  });

  it("shuts down cleanly on SIGTERM", async () => {
    const proxyProc = fork(SERVER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_PROXY_BIND: "127.0.0.1" },
    });

    await new Promise((resolve) => {
      proxyProc.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("listening")) resolve();
      });
      setTimeout(resolve, 2000);
    });

    proxyProc.kill("SIGTERM");
    const code = await new Promise((resolve) => proxyProc.on("exit", (c) => resolve(c)));
    assert.equal(code, 0);
  });
});

function cleanEnv(overrides) {
  const env = { ...process.env };
  // Strip from the BASE, then apply overrides, so a test that deliberately sets
  // one of these still gets it. An ambient NO_PROXY on the developer's shell
  // otherwise reaches the child and the merge assertions read the host's value
  // instead of the fixture's — the lowercase-no_proxy case fails that way on any
  // machine that exports NO_PROXY.
  // CACHE_FIX_CA_PROBE_UNANSWERABLE is here for the same reason, from the other
  // direction: it is a seam ONE test sets, and a leak would make every later
  // test's CA probe answer "could not ask" — silently turning the assertions
  // that follow into measurements of the fallback rather than of the guard.
  for (const k of ["CACHE_FIX_PROXY_PORT", "CACHE_FIX_PROXY_UPSTREAM", "NO_PROXY", "no_proxy",
                   "CACHE_FIX_CA_PROBE_UNANSWERABLE"]) delete env[k];
  env.CACHE_FIX_PROXY_BIND = "127.0.0.1";
  // A config dir per invocation, by DEFAULT — not opt-in per test. Forward mode
  // publishes our CA into <config>/ca-trust.d/ccf.pem, so any test that forgot to
  // set this published a throwaway temp CA over the developer's REAL
  // ~/.claude/ca-trust.d/ccf.pem. Measured: one run of the CACHE_FIX_CA_DIR test
  // took the host's pem from 5dc414fc to 3773c611, leaving the machine's merged
  // bundle advertising a CA nothing signs with — precisely the failure this
  // feature exists to prevent. It also silently poisons the suite itself: two
  // cases were reading the host's real merged bundle instead of a fixture.
  env.CLAUDE_CONFIG_DIR = tempDir("cffcfg-");
  return { ...env, ...overrides };
}

const NODE = process.execPath;

// Fork the wrapper in forward mode, collect the child's output, resolve when it
// exits. Two ca-trust tests below run the wrapper TWICE against one config dir
// (first launch publishes our CA, second reads the bundle built from it), which
// is what makes a named helper worth it over the inline fork the older tests use.
// `close`, not `exit`: exit fires when the process is gone, close when its
// stdio has also been drained. Measured under the concurrency this file now
// runs at — an exit-resolved run came back with bytesRead=0 and
// readableEnded=false while the child had provably run and written, so the
// assertion read an empty string the child had in fact produced. One helper
// because that judgement was previously repeated at fifteen call sites, which
// is why correcting it had to touch all fifteen.
const waitClose = (p) => new Promise((res) => {
  const t = setTimeout(() => { p.kill("SIGTERM"); res(null); }, 15_000);
  p.on("close", (c) => { clearTimeout(t); res(c); });
});

async function runWrapper(script, overrides) {
  const p = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, ...overrides }),
  });
  let out = "", err = "";
  p.stdout.on("data", (c) => { out += c.toString(); });
  p.stderr.on("data", (c) => { err += c.toString(); });
  return { code: await waitClose(p), out, err };
}

// Concurrent, but BOUNDED BY CORES: each case boots a real proxy under its own
// 10s startup budget, and unbounded concurrency blew that budget on CI's 2-core
// runner — measured, "Proxy failed to start within 10s" on every node, while a
// 48-core box passed every time. Serial, the file pays the sum of the waits; at
// cpus/2 it pays close to the longest one without starving any boot.
const CONCURRENCY = Math.max(2, Math.floor(cpus().length / 2));

describe("launch wrapper (claude-via-proxy)", { concurrency: CONCURRENCY }, () => {
  it("exits with error when claude command is not found", async () => {
    const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: "/nonexistent/path/to/claude" }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.ok(code !== 0, `Wrapper should exit non-zero. stderr: ${stderr}`);
  });

  it("sets ANTHROPIC_BASE_URL and forwards to child process", async () => {
    const script = 'process.stdout.write("BASE_URL="+process.env.ANTHROPIC_BASE_URL+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}` }),
    });

    let stdout = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.ok(stdout.includes("BASE_URL=http://127.0.0.1:"), `Expected BASE_URL in output, got: ${stdout}`);
    assert.equal(code, 0);
  });

  it("propagates claude exit code", async () => {
    const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e process.exit(42)` }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 42, `Expected exit 42, got ${code}. stderr: ${stderr}`);
  });

  it("--remote-control wires forward-proxy env (BASE unset, HTTPS_PROXY + CA set)", async () => {
    // The child prints the three routing-relevant vars. Forward mode must leave
    // ANTHROPIC_BASE_URL unset (that keeps Remote Control enabled) and instead
    // route via HTTPS_PROXY + the proxy's MITM CA. The wrapper splits
    // CACHE_FIX_CLAUDE_CMD on spaces, so the script must contain none — hence
    // the "|" delimiter rather than spaces in the output string.
    const script =
      'process.stdout.write("BASE="+(process.env.ANTHROPIC_BASE_URL||"UNSET")+' +
      '"|HP="+(process.env.HTTPS_PROXY||"UNSET")+' +
      '"|CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    // Own config dir: this asserts the no-bundle fallback, so it must not read the
    // developer's real ~/.claude/ca-trust.pem. On a machine where a bundle builder
    // has run, that file exists and legitimately wins — the assertion would fail
    // for a host-state reason, not a code reason.
    const configDir = tempDir("cfftrust-");
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes("BASE=UNSET"), `ANTHROPIC_BASE_URL should be unset in forward mode, got: ${stdout}`);
    assert.match(stdout, /HP=http:\/\/127\.0\.0\.1:\d+/, `HTTPS_PROXY should point at the proxy, got: ${stdout}`);
    assert.match(stdout, /CA=\S*cache-fix-ca\/ca\.pem/, `NODE_EXTRA_CA_CERTS should point at the MITM CA, got: ${stdout}`);
  });

  it("--remote-control honors CACHE_FIX_CA_DIR (matches the proxy's CA path contract)", async () => {
    // The proxy resolves its CA dir as CACHE_FIX_CA_DIR || claudeHome()/cache-fix-ca.
    // The launcher MUST resolve NODE_EXTRA_CA_CERTS from the same input in the
    // same order, or it points claude at a different (or absent) CA than the one
    // the spawned proxy generated — a hard fail, or a silent trust mismatch when
    // a stale default CA exists. This test pins the override path exactly.
    const caDir = tempDir("cffcadir-");
    const script =
      'process.stdout.write("BASE="+(process.env.ANTHROPIC_BASE_URL||"UNSET")+' +
      '"|CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CACHE_FIX_CA_DIR: caDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // The CA must be the override path exactly, not the default ~/.claude one.
    assert.ok(
      stdout.includes(`CA=${join(caDir, "ca.pem")}`),
      `NODE_EXTRA_CA_CERTS should be the CACHE_FIX_CA_DIR override (${join(caDir, "ca.pem")}), got: ${stdout}`,
    );
  });

  // --- ca-trust.d: coexisting with another component that also MITMs ---------
  // NODE_EXTRA_CA_CERTS takes ONE file, so a plain assignment silently untrusts
  // whatever else needed trusting. Measured 2026-07-30: an account-switching pin proxy also
  // MITMs api.anthropic.com and also set this var; last writer won and broke
  // Remote Control inbound on the work Mac. The contract: each component
  // publishes ONLY its own ca-trust.d/<name>.pem, one external writer builds the
  // merged ca-trust.pem (it needs ambient corp-root discovery, which is
  // environment-specific and stays out of this repo), and we READ that bundle.
  // These four tests pin the whole contract: publish, read, isolation, fallback.

  it("--remote-control publishes its CA to ca-trust.d/ccf.pem before exec'ing claude", async () => {
    // Publishing is how OTHER components learn to trust us, and it must happen
    // before the client runs — a bundle builder that reads the dir on a cold
    // start would otherwise miss us and produce a bundle without our CA.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // The child already ran and exited, so anything on disk now was written
    // before the exec — that ordering is the point of this assertion.
    const published = join(configDir, "ca-trust.d", "ccf.pem");
    assert.ok(existsSync(published), `expected published CA at ${published}. stdout: ${stdout} stderr: ${stderr}`);
    const ours = readFileSync(join(configDir, "cache-fix-ca", "ca.pem"), "utf8");
    assert.equal(readFileSync(published, "utf8"), ours, "published pem must be our CA verbatim");
    assert.match(ours, /BEGIN CERTIFICATE/, "published pem should be a PEM certificate");
  });

  it("--remote-control points NODE_EXTRA_CA_CERTS at the merged bundle when one exists", async () => {
    // The whole reason the contract exists: with a merged bundle present we must
    // hand claude THAT, not our own CA alone, or the other component's CA is
    // untrusted for this session.
    // The bundle must be a REALISTIC builder output — i.e. it has to contain our
    // own CA, because that is what the builder concatenates from ca-trust.d. A
    // fixture without it is the stale-bundle case, which is correctly rejected
    // (see the test below). So: run once to let the proxy generate + publish our
    // CA, then build the bundle from it the way the launcher would, then re-run.
    const configDir = tempDir("cfftrust-");
    const bundle = join(configDir, "ca-trust.pem");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });

    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    // Mimic the launcher: ambient-ish preamble + every published component pem.
    writeFileSync(bundle, `# merged by the launcher\n${readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8")}`);

    const second = await runOnce();
    assert.equal(second.code, 0, `Expected exit 0, got ${second.code}. stderr: ${second.err}`);
    assert.ok(second.out.includes(`CA=${bundle}`), `NODE_EXTRA_CA_CERTS should be the merged bundle (${bundle}), got: ${second.out}`);
  });

  it("--remote-control never writes the merged bundle and never touches a sibling component's pem", async () => {
    // Single-writer invariant. Two launchers both "helpfully" rebuilding the
    // merged file race one output, and a component that rewrites a sibling's pem
    // can untrust it. So: we write exactly one path, ca-trust.d/ccf.pem.
    const configDir = tempDir("cfftrust-");
    const trustDir = join(configDir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const sibling = join(trustDir, "other-component.pem");
    const SIBLING_BYTES = "# another component's CA — must survive untouched\n";
    writeFileSync(sibling, SIBLING_BYTES);
    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.equal(readFileSync(sibling, "utf8"), SIBLING_BYTES, "sibling component's pem must be untouched");
    assert.ok(!existsSync(join(configDir, "ca-trust.pem")), "we must NOT create the merged bundle — exactly one external writer owns it");
    assert.ok(existsSync(join(trustDir, "ccf.pem")), "our own pem should still be published");
  });

  it("--remote-control hands claude a bundle node actually loads CAs from", async () => {
    // COUNT THE CERTIFICATES, do not check the path. Every other launcher test
    // here asserts WHICH file was handed over, and a mutant that accepts an
    // unjudgeable merge unconditionally satisfies all of them while handing
    // claude a bundle node loads ZERO certificates from — measured, and the
    // session then cannot verify the very proxy it is routed through.
    //
    // So the child reports what the LOADER read, not what the env says. The two
    // are different questions and only the second one has ever been asked here.
    const configDir = tempDir("cfftrust-");
    const bundle = join(configDir, "ca-trust.pem");
    // `getCACertificates` does not exist before v22.15 and `engines` says >=18,
    // so the count comes from a real handshake against a leaf our CA issued —
    // the same question the shipped probe asks, asked the same way.
    // No spaces: runWrapper splits CACHE_FIX_CLAUDE_CMD on whitespace, so a
    // script with any in it reaches node truncated (measured — `const` alone,
    // "Unexpected token <eof>"). Every sibling test is written this way for the
    // same reason.
    const script = 'process.stdout.write("N="+(require("node:tls").getCACertificates?'
      + 'require("node:tls").getCACertificates("extra").length:-1)+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });

    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    const n0 = Number(/N=(-?\d+)/.exec(first.out)?.[1]);
    if (n0 === -1) return;   // pre-v22.15: the count is unavailable, not wrong

    // A merge that is BROKEN, not stale: it carries our CA, so a
    // "does it contain us" check passes, and it is torn AHEAD of that CA, so
    // node loads nothing at all from it.
    //
    // TWO publishers, not one. With only ours in ca-trust.d, salvage rebuilding
    // and salvage being deleted outright both end at 1 certificate — the
    // fallback is our own CA, which is also the whole rebuild — so no count can
    // tell them apart. Measured: deleting the salvage call left this test green
    // until the peer was added.
    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    writeFileSync(join(configDir, "ca-trust.d", "zpeer.pem"), peer);
    writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\nQUFB\n" + ours + peer);
    // ...and the probe must be UNABLE TO JUDGE it, because `unknown` and
    // `ok:false` are different branches and only the first can see a mutant
    // that accepts unjudgeable merges. With a serveable leaf this same bundle
    // yields `{ok:false}` — measured, and that is why the first version of this
    // test killed nothing.
    //
    // A DIRECTORY at leaf.pem, not a delete and not a chmod. The proxy runs
    // ensureCA() on every launch and publishes by rename, so both of those are
    // undone inside the very run they were meant to affect — measured: after
    // `rm` the file is back, after `chmod 0` the mode reads 0600 again, and the
    // launcher lands on `{ok:false}` either way. Renaming ONTO a directory
    // fails with EISDIR, so this one survives, and the probe's own readFileSync
    // then throws — which is exactly what `unknown` means.
    const leafPem = join(configDir, "cache-fix-ca", "leaf.pem");
    rmSync(leafPem, { force: true });
    mkdirSync(leafPem);
    assert.equal(bundleUsable(bundle, {
      keyPath: join(configDir, "cache-fix-ca", "leaf.key"),
      certPath: leafPem, host: "api.anthropic.com",
    }).unknown, true, "premise: this fixture must be UNJUDGEABLE, not refused");

    const second = await runOnce();
    assert.equal(second.code, 0, `Expected exit 0, got ${second.code}. stderr: ${second.err}`);
    const n = Number(/N=(-?\d+)/.exec(second.out)?.[1]);
    // COUNT, do not test for non-zero. `n > 0` is satisfied by the bare
    // fallback (our own CA alone, 1 certificate), so it cannot tell a rebuild
    // from no rebuild — measured, it left salvage-deleted green. Both publishers
    // must survive: that is what salvage is for.
    assert.ok(n >= 2,
      `expected both publishers to survive, node loaded ${n}. stderr: ${second.err}`);
    // ...and the sentence has to name what it chose. This is the SECOND arm of
    // the message ternary; the third is asserted where the census cannot save a
    // refused merge. Both were unmeasured until a mutation swapped their two
    // strings and left the whole suite green — the value and the sentence are
    // built by separate expressions, so only an assertion per arm ties them
    // together. Round 14 was this same disagreement in the FIRST arm.
    //
    // Asserted HERE and not on the torn-ahead test, which looks like it
    // rebuilds and does not: its trust dir holds only our own CA, so salvage
    // returns null and the launcher correctly says "using our own CA only".
    // Measured — the assertion was written there first and failed.
    assert.ok(/rebuilt from the publishers that work/.test(second.err),
      `handed a rebuild but did not say so. got stderr: ${second.err}`);
  });

  it("--remote-control falls back to its own CA when no merged bundle exists (unchanged standalone behaviour)", async () => {
    // A plain CCF user with no other MITM and no bundle builder must see exactly
    // what they saw before this contract existed.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(
      stdout.includes(`CA=${join(configDir, "cache-fix-ca", "ca.pem")}`),
      `with no bundle NODE_EXTRA_CA_CERTS must be our own CA, got: ${stdout}`,
    );
  });

  it("--remote-control never leaves a truncated ccf.pem visible while publishing", async () => {
    // A torn pem is not a cosmetic problem: Node's PEM reader aborts the whole
    // extras load on an unterminated block. Measured on node v24 / openssl 3.5,
    // with a leaf signed by the CCF CA and a bundle = good.pem + torn.pem:
    //   torn AFTER  -> "Ignoring extra certs ... bad end line", verify still ok
    //   torn BEFORE -> "... ASN1 lib",  verify FAILS UNABLE_TO_VERIFY_LEAF_SIGNATURE
    // The builder concatenates sort(ca-trust.d/*.pem), so a torn OURS lands ahead
    // of any sibling that sorts later and takes every other component CA and
    // corporate root down with it. A plain
    // writeFileSync(dst) is exactly what leaves that state visible to a
    // concurrent builder, so the write must be rename-into-place.
    //
    // Distinguishing atomic from non-atomic needs a property that holds ONLY for
    // rename-into-place, and "replaces a read-only file" is not it: a read-only
    // target is also defeated by unlink-then-write, which is maximally
    // non-atomic (a reader can observe ENOENT, then zero length, then a partial
    // file). An earlier version of this test asserted exactly that and passed
    // green against `unlinkSync(dst); writeFileSync(dst, ours)` — it proved
    // nothing.
    //
    // The property that separates them is INODE STABILITY for an existing
    // reader. A builder that opened ccf.pem before the publish holds a
    // descriptor on the old inode. rename() swaps a new inode into the
    // directory entry and leaves the old one intact and fully readable until
    // that descriptor closes, so the reader still sees complete old content.
    // Any in-place rewrite — O_TRUNC or unlink-and-recreate — either truncates
    // the very bytes that reader is consuming or leaves it on a deleted inode
    // whose content is gone. So: hold a descriptor open across the launch, then
    // read it to the end.
    const configDir = tempDir("cfftrust-");
    const trustDir = join(configDir, "ca-trust.d");
    const dst = join(trustDir, "ccf.pem");
    mkdirSync(trustDir, { recursive: true });
    // A stale published file, standing in for "an existing complete file a
    // builder may be reading right now". Its content differs from our CA, so the
    // publish path must replace it rather than take the byte-compare skip.
    const STALE = "-----BEGIN CERTIFICATE-----\nc3RhbGUtcHVibGlzaGVk\n-----END CERTIFICATE-----\n";
    writeFileSync(dst, STALE);
    // The load-bearing observer: a descriptor held across the publish. Measured,
    // and counter-intuitive enough to be worth stating — the 1 ms sampler below
    // CANNOT see the O_TRUNC window for a ~1.2 KB write (100 samples over a
    // truncate+write saw only the complete file, never length 0). Only this
    // descriptor catches it, because O_TRUNC destroys the bytes under an existing
    // reader while rename leaves that inode intact. Deleting these two assertions
    // as "duplicated by the sampler" was tried and silently dropped O_TRUNC
    // detection entirely.
    const readerFd = openSync(dst, "r");
    const inodeBefore = fstatSync(readerFd).ino;
    // A builder does not hold a descriptor open across our publish — it opens
    // ca-trust.d/*.pem by NAME whenever it rebuilds. So the property that
    // actually protects it is that the NAME never resolves to anything but a
    // complete file. Sample it as fast as the runtime allows for the whole
    // launch: with rename the name is always the old or the new file; with
    // O_TRUNC or unlink-then-write it is briefly zero-length or absent. In
    // practice this catches a SLOW bad write, not a fast one (see the note
    // above) — it is the cheap wide net, the descriptor is the precise one.
    const observations = [];
    const sampler = setInterval(() => {
      try { observations.push(readFileSync(dst, "utf8")); }
      catch (e) { observations.push(`ENOENT:${e.code}`); }
    }, 1);

    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    clearInterval(sampler);
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // THE assertion. Every sample taken by name, across the whole launch, must
    // be one of the two COMPLETE states — never absent, never partial.
    //
    // Mutation-tested, and the result bounds what this test is worth:
    //   writeFileSync(dst)  [O_TRUNC]   -> FAILS   (caught)
    //   unlinkSync + writeFileSync      -> passes  (NOT caught)
    //   temp + renameSync               -> passes
    // The unlink variant's window between unlink and create is shorter than the
    // sampler's 1 ms floor, so a timing-based observer cannot see it. Hence the
    // test name: no TRUNCATED file is ever visible. Not "atomic" in general —
    // proving that would need an inotify watch for IN_DELETE-before-IN_CREATE,
    // which is not worth a dependency for a shape nothing here writes.
    const ourCa = readFileSync(join(configDir, "cache-fix-ca", "ca.pem"), "utf8");
    const bad = observations.filter((o) => o !== STALE && o !== ourCa);
    assert.deepEqual(
      bad, [],
      `every observation of ccf.pem must be a complete file (stale or ours); saw ${bad.length} bad ` +
      `of ${observations.length}: ${JSON.stringify(bad.slice(0, 3))}`,
    );
    assert.ok(observations.length > 0, "sampler must have observed the file at least once");
    // O_TRUNC destroys the bytes under this reader; rename does not. This is the
    // assertion that actually catches a truncating in-place write.
    const viaOldFd = readFileSync(readerFd, "utf8");
    closeSync(readerFd);
    assert.equal(viaOldFd, STALE,
      "a reader holding the pre-publish descriptor must still see the COMPLETE old pem");
    assert.notEqual(statSync(dst).ino, inodeBefore, "publish must swap a new inode into place");
    const pem = readFileSync(dst, "utf8");
    assert.notEqual(pem, STALE, "publish must actually replace the stale pem");
    assert.equal(pem, readFileSync(join(configDir, "cache-fix-ca", "ca.pem"), "utf8"), "published pem must be our CA verbatim");
    // No leftover temp: a builder globbing *.pem must not find a partial sibling,
    // and nothing may be left behind for the next run to trip over.
    const leftovers = readdirSync(trustDir).filter((f) => f !== "ccf.pem");
    assert.deepEqual(leftovers, [], `ca-trust.d must contain only ccf.pem, found: ${leftovers.join(", ")}`);
    // Balanced markers — the exact property whose absence voids the whole bundle.
    const begins = (pem.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    const ends = (pem.match(/-----END CERTIFICATE-----/g) || []).length;
    assert.equal(begins, ends, `published pem must have balanced BEGIN/END, got ${begins}/${ends}`);
    assert.ok(begins >= 1, "published pem must contain at least one certificate");
  });

  it("--remote-control reaps an old orphan temp but leaves a concurrent publisher's fresh one alone", async () => {
    // The reaper cannot tell an orphan from a live temp by NAME — both are
    // ccf.pem.<pid>.<uuid>. A second launcher publishing at the same moment has
    // written its temp and not yet renamed it; deleting that makes ITS
    // renameSync throw a publish failure we caused, and leaves whichever
    // launcher won first on disk rather than the current publisher's bytes.
    // Age is the only signal available: the write-to-rename window is one small
    // write to the same directory, so anything older than the gate is genuinely
    // abandoned and anything younger may be in flight.
    //
    // Both fixtures exist in the same directory across one launch, so the test
    // fails if the reaper is unconditional (fresh one dies) OR absent (old one
    // survives) — one launch, two opposite outcomes.
    const configDir = tempDir("cfftrust-");
    const trustDir = join(configDir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const stale = join(trustDir, "ccf.pem.99999.aaaaaaaa-orphan");
    const fresh = join(trustDir, "ccf.pem.99998.bbbbbbbb-inflight");
    writeFileSync(stale, "# abandoned by a kill between write and rename\n");
    writeFileSync(fresh, "# a concurrent launcher's temp, not yet renamed\n");
    // Backdate past the gate. Real time cannot be used — the gate is a minute and
    // a test may not sleep for one.
    // A sibling publisher's file, aged past the gate. Named to share the prefix
    // the sweep matches on, because that is the boundary under test.
    const peerAged = join(trustDir, "ccf.pemcorp.pem");
    writeFileSync(peerAged, "# another component's published CA\n");
    const longAgo = new Date(Date.now() - 3600_000);
    utimesSync(stale, longAgo, longAgo);
    utimesSync(peerAged, longAgo, longAgo);

    const { code, err } = await runWrapper('process.stdout.write("OK\\n")', { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);

    assert.ok(!existsSync(stale), "a temp older than the gate is abandoned and must be reaped");
    assert.ok(existsSync(fresh), "a temp younger than the gate may belong to a live publisher and must survive");
    // ...and the PUBLISHED CA must survive, which the prefix is the only thing
    // protecting. Measured with `ccf.pem.` shortened to `ccf.pem`: the sweep
    // removed ccf.pem itself — the file every other component on the machine
    // reads. Same two-literals hazard as SCRATCH_PREFIX, 50 lines earlier, and
    // this assertion is what makes the prefix boundary testable rather than
    // merely intended.
    // ...and a SIBLING publisher's file must survive. `ccf.pem` itself cannot
    // test the prefix here — the launcher republishes it in this very run, so it
    // is always younger than the 60 s gate and no prefix can reach it. A peer's
    // pem can be old, and it is what a widened prefix would eat next: measured
    // with the sweep prefix shortened by one character, an aged `ccf.pem`-named
    // file is removed, and the only reason our own survives is timing.
    assert.ok(existsSync(peerAged),
      "the orphan sweep deleted a sibling publisher's pem — the prefix is not specific enough");
  });

  it("--remote-control still reaps orphans when publishing itself fails", async () => {
    // Reaping used to share the publish try-block, so renameSync throwing jumped
    // straight past it. That made cleanup conditional on the one thing whose
    // failure creates the mess: on a host where publishing is persistently
    // broken — a root-owned ccf.pem, a read-only mount, ENOSPC — every launch
    // abandoned one full-CA temp and collected none, growing without bound in
    // the directory a bundle builder globs.
    //
    // A directory at the publish target reproduces that class of failure
    // portably: rename() onto it fails EISDIR, and unlike a permission fixture
    // it behaves the same when the suite runs as root (measured: chmod-based
    // fixtures pass vacuously in a root container, which is how CI runs).
    const configDir = tempDir("cfftrust-");
    const trustDir = join(configDir, "ca-trust.d");
    mkdirSync(join(trustDir, "ccf.pem"), { recursive: true });
    const stale = join(trustDir, "ccf.pem.99999.aaaaaaaa-orphan");
    writeFileSync(stale, "# abandoned by an earlier kill\n");
    const longAgo = new Date(Date.now() - 3600_000);
    utimesSync(stale, longAgo, longAgo);

    const { code, err } = await runWrapper('process.stdout.write("OK\\n")', { CLAUDE_CONFIG_DIR: configDir });
    // Publishing is how OTHERS trust us; this session only needs its own CA, so
    // the failure must stay non-fatal and merely visible.
    assert.equal(code, 0, `publish failure must not fail the session, got ${code}. stderr: ${err}`);
    assert.match(err, /could not publish CA/, "a publish failure must be reported, not swallowed");
    assert.ok(!existsSync(stale), "orphans must be reaped even on the launches where publishing fails");
  });

  it("--remote-control does not print the wiring banner that would undo its own coexistence", async () => {
    // The launcher relays the spawned proxy's stderr, so the server's standalone
    // `export NODE_EXTRA_CA_CERTS=<ca.pem>` advice used to appear immediately
    // after the launcher had published to ca-trust.d and adopted the merged
    // bundle. An operator following the line on screen pins the variable to our
    // CA alone for every later process, silently untrusting every other MITM —
    // the exact failure the contract exists to prevent.
    const configDir = tempDir("cfftrust-");
    const { code, err } = await runWrapper('process.stdout.write("OK\\n")', { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.doesNotMatch(err, /export NODE_EXTRA_CA_CERTS=/,
      `the launcher must not tell the operator to pin the variable; stderr: ${err}`);
    // The proxy is still in forward-proxy mode — the banner is suppressed, not
    // the feature. Without this the assertion above would also pass if the
    // launcher silently stopped starting a forward proxy at all.
    assert.match(err, /forward-proxy/, `forward-proxy must still be on; stderr: ${err}`);
  });

  it("--remote-control blames our own CA, not the bundle, when ca.pem is the unparseable one", async () => {
    // Parsing our own CA used to sit inside the bundle try-block, so a corrupt
    // or zero-byte ca.pem threw from OUR parse and was reported as
    // `ignoring <ca-trust.pem> (no start line)` — naming a file that may be
    // perfectly healthy — and then fell back to the very ca.pem that had just
    // failed to parse. The session then failed every request with
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE while the only diagnostic pointed at the
    // wrong component.
    const configDir = tempDir("cfftrust-");
    const caDir = tempDir("cffca-");
    // ca.key must be present alongside it: the proxy's reuse guard keys on
    // existsSync(ca.pem) && existsSync(ca.key), so a corrupt ca.pem with its key
    // still beside it is REUSED rather than regenerated. That is what makes this
    // state reachable at all — corrupt the pem alone and the proxy quietly mints
    // a fresh one before the launcher ever reads it, and the test would pass
    // while exercising nothing.
    writeFileSync(join(caDir, "ca.key"), "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n");
    // Truncated mid-block: exists, non-empty, and does not parse.
    writeFileSync(join(caDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\ntruncated\n");
    // A healthy bundle, present so the message cannot be excused as "absent".
    writeFileSync(join(configDir, "ca-trust.pem"),
      "-----BEGIN CERTIFICATE-----\nc3RhbGUtYnV0LXdlbGwtZm9ybWVk\n-----END CERTIFICATE-----\n");

    const { err } = await runWrapper('process.stdout.write("OK\\n")',
      { CLAUDE_CONFIG_DIR: configDir, CACHE_FIX_CA_DIR: caDir });

    assert.match(err, /our own CA at .*ca\.pem does not parse/,
      `the unparseable file must be named as ours; stderr: ${err}`);
    assert.doesNotMatch(err, /ignoring .*ca-trust\.pem/,
      `a healthy bundle must not be blamed for our own CA failing to parse; stderr: ${err}`);
  });

  it("--remote-control does not publish a ca.pem that failed to parse", async () => {
    // Blaming the right file and not consuming it (the two tests above) covered
    // what THIS session does with a corrupt ca.pem. It still published those
    // bytes: the copy into ca-trust.d/ccf.pem happens before the X509 parse, so
    // an unparseable CA was handed to every OTHER component on the machine.
    //
    // That is the worse half. Our own session degrades to node's built-in store
    // and keeps working; the bundle builder concatenates sort(*.pem) and "ccf"
    // sorts first, so a corrupt entry in the leading position aborts node's
    // whole extras load for every sibling — measured on this box, a fused
    // bundle loads 0 extra CAs and warns `bad base64 decode`. One broken file
    // here costs every other component its CA, and its corporate roots with it.
    //
    // Publishing nothing is the honest state, and it is strictly better than
    // publishing garbage: a builder that finds no ccf.pem simply builds a bundle
    // without us, which our own guard then rejects (it does not carry our CA)
    // and we fall back to our own — exactly the no-builder path that already
    // works. Any PREVIOUS good ccf.pem must survive, because it is what siblings
    // are currently trusting and a stale-but-valid CA beats none.
    const configDir = tempDir("cfftrust-");
    const caDir = tempDir("cffca-");
    // Same reuse-guard reasoning as the blame test above: the key must be
    // present or the proxy regenerates a healthy ca.pem and this exercises
    // nothing.
    writeFileSync(join(caDir, "ca.key"), "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n");
    writeFileSync(join(caDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\ntruncated\n");
    // A previously-published, well-formed entry. Whatever we do with the corrupt
    // one, this must still be here afterwards.
    const trustDir = join(configDir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const priorGood = "-----BEGIN CERTIFICATE-----\ncHJldmlvdXNseS1wdWJsaXNoZWQtb3Vycw==\n-----END CERTIFICATE-----\n";
    writeFileSync(join(trustDir, "ccf.pem"), priorGood);

    await runWrapper('process.stdout.write("OK\\n")',
      { CLAUDE_CONFIG_DIR: configDir, CACHE_FIX_CA_DIR: caDir });

    const published = readFileSync(join(trustDir, "ccf.pem"), "utf8");
    assert.doesNotMatch(published, /truncated/,
      "the unparseable ca.pem must never reach ca-trust.d — it voids every sibling's CA");
    assert.equal(published, priorGood,
      "the last known-good published CA must survive a corrupt ca.pem");
  });

  it("--remote-control does not hand claude a ca.pem that failed to parse", async () => {
    // Naming the broken file in the warning was only half the fix. caForClaude
    // still defaulted to it, so the session was wired to a PEM we had just
    // proven unreadable — the message was right and the behavior was unchanged.
    // Unset is the honest state: we have no usable CA to add, so node falls back
    // to its built-in store rather than to a file we vouch for and cannot read.
    const configDir = tempDir("cfftrust-");
    const caDir = tempDir("cffca-");
    // ca.key beside it, or the proxy regenerates and the state is unreachable.
    writeFileSync(join(caDir, "ca.key"), "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n");
    writeFileSync(join(caDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\ntruncated\n");

    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const { out } = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir, CACHE_FIX_CA_DIR: caDir });

    assert.match(out, /CA=UNSET/,
      `claude must not be pointed at an unparseable CA; got: ${out.trim()}`);
  });

  it("--remote-control ignores a merged bundle that does NOT contain our own CA", async () => {
    // The dangerous case, and worse than falling back: the bundle exists and is
    // non-empty, so a size-only gate accepts it — but it was built BEFORE we
    // published, so it lacks OUR CA. Handing claude that bundle makes it distrust
    // the very proxy it is about to be routed through: every request fails TLS
    // instead of merely losing another component's CA. A stale builder is the
    // normal state right after a CCF upgrade, so this is not a corner case.
    // (a sibling component hit the same hazard from the other side and guards
    // it identically.)
    const configDir = tempDir("cfftrust-");
    const bundle = join(configDir, "ca-trust.pem");
    // A plausible stale bundle: real PEM content, just not ours.
    writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\nc3RhbGUtYnVuZGxlLXdpdGhvdXQtb3VyLUNB\n-----END CERTIFICATE-----\n");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    const handed = (stdout.match(/CA=(.*)/) || [])[1];
    assert.ok(handed && handed !== bundle,
      `a bundle missing our CA must not be handed to claude, got: ${stdout}`);
    // The contract is that claude TRUSTS our CA, not that it was handed one
    // particular path. Asserting the path pinned an implementation detail: the
    // launcher may now rebuild from ca-trust.d instead of falling back to our
    // CA alone, which satisfies the contract and keeps every other publisher.
    // Asked the way the shipped guard asks — a handshake through
    // NODE_EXTRA_CA_CERTS — not `tls.getCACertificates`, which does not exist
    // before v22.15 while this package declares `engines: >=18`. A test using
    // that API is red on the runtimes CI runs, against an implementation that
    // deliberately avoids it for the same reason.
    assert.equal(bundleUsable(handed, {
      keyPath: join(configDir, "cache-fix-ca", "leaf.key"),
      certPath: join(configDir, "cache-fix-ca", "leaf.pem"),
      host: "api.anthropic.com",
    }).ok, true, `the launcher chose ${handed}, but node loads no CA of ours from it`);
  });

  it("--remote-control ignores a merged bundle torn AHEAD of our own entry", async () => {
    // A bundle whose earlier entry is missing its END line still literally
    // contains our CA further down, and that is the FATAL position, not the
    // benign one: measured on node v24 / openssl 3.5, an unterminated block
    // ahead of a good one takes the WHOLE extras load down (loader reads 0
    // certificates), so the session would trust nothing at all, including our
    // own proxy.
    //
    // What the launcher does about it is the point of this test. It asks the
    // loader (not a parser) and, on a refusal, REBUILDS from the ca-trust.d
    // files that individually load rather than falling back to our CA alone.
    // Both paths leave our CA trusted; they differ for every OTHER publisher,
    // which the fallback silently dropped. Measured on this fixture: the merged
    // bundle loads 0 certificates, ca-trust.d/ccf.pem alone loads 1.
    const configDir = tempDir("cfftrust-");
    const bundle = join(configDir, "ca-trust.pem");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });

    // First run publishes our CA, so the torn bundle we then build is realistic:
    // a builder that concatenated a truncated sibling ahead of our complete pem.
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const torn = "-----BEGIN CERTIFICATE-----\nc3RvbGVuLW1pZC13cml0ZQ==\n";
    writeFileSync(bundle, `${torn}${ours}`);
    // Precondition: the bundle still CONTAINS our CA verbatim, so a containment
    // test would accept it. The launcher must refuse anyway, for the reason this
    // test claims — the loader reads nothing from it — and not by accident.
    const raw = readFileSync(bundle, "utf8");
    assert.ok(raw.includes(readFileSync(join(configDir, "cache-fix-ca", "ca.pem"), "utf8").trim()),
      "fixture must still contain our CA verbatim, or this test proves nothing");

    const second = await runOnce();
    assert.equal(second.code, 0, `Expected exit 0, got ${second.code}. stderr: ${second.err}`);
    const handed = (second.out.match(/CA=(.*)/) || [])[1];
    assert.ok(handed && handed !== bundle,
      `the torn bundle must not be handed to claude, got: ${second.out}`);
    // Whatever it chose, the loader must actually load our CA from it — the
    // assertion the old expectation could not make, because it compared a path
    // instead of asking. A rebuilt bundle and our own CA both satisfy this; a
    // path that trusts nothing does not.
    // Asked the way the shipped guard asks — a handshake through
    // NODE_EXTRA_CA_CERTS — not `tls.getCACertificates`, which does not exist
    // before v22.15 while this package declares `engines: >=18`. A test using
    // that API is red on the runtimes CI runs, against an implementation that
    // deliberately avoids it for the same reason.
    assert.equal(bundleUsable(handed, {
      keyPath: join(configDir, "cache-fix-ca", "leaf.key"),
      certPath: join(configDir, "cache-fix-ca", "leaf.pem"),
      host: "api.anthropic.com",
    }).ok, true, `the launcher chose ${handed}, but node loads no CA of ours from it`);
  });

  it("--remote-control survives an unwritable TMPDIR on the salvage path", async () => {
    // This path runs at TOP LEVEL, after the proxy has been forked. A throw
    // here does not merely lose the bundle — it skips cleanup() and leaves the
    // proxy orphaned, turning "the merged bundle is broken" (recoverable, warn
    // and fall back) into "the launcher does not start". Reproduced by removing
    // the guard: exit 1, no claude, and a live proxy/server.mjs left behind.
    //
    // Salvage is reached by giving it a merge to refuse, and its temp write is
    // made to fail by pointing TMPDIR at a path that does not exist.
    const configDir = tempDir("cfftmp-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    writeFileSync(join(configDir, "ca-trust.pem"),
      "-----BEGIN PUBLIC KEY----------BEGIN CERTIFICATE-----\nAAAA\n-----END PUBLIC KEY-----\n" +
      readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8"));

    const r = await runWrapper(script, {
      CLAUDE_CONFIG_DIR: configDir,
      TMPDIR: join(configDir, "no-such-tmpdir"),
    });
    assert.equal(r.code, 0, `must not crash on an unwritable TMPDIR, got ${r.code}. stderr: ${r.err}`);
    assert.match(r.out, /CA=/, "claude must still have been launched");
    // ...and it must say so rather than silently continuing.
    assert.match(r.err, /cache-fix:/, `expected a warning, got: ${r.err}`);
  });

  it("--remote-control excludes localhost via NO_PROXY (so local HTTP MCP servers aren't misrouted)", async () => {
    // Without NO_PROXY, HTTPS_PROXY routes every connection — including to local
    // HTTP/SSE-transport MCP servers on 127.0.0.1 — at the cache-fix proxy, which
    // 404s anything that isn't api.anthropic.com. The launcher must exclude
    // localhost. The child prints both NO_PROXY and no_proxy.
    const script =
      'process.stdout.write("NP="+(process.env.NO_PROXY||"UNSET")+' +
      '"|np="+(process.env.no_proxy||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}` }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // Both NO_PROXY and no_proxy must cover localhost.
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      assert.ok(stdout.includes(host), `NO_PROXY should include ${host}, got: ${stdout}`);
    }
    assert.match(stdout, /NP=\S*127\.0\.0\.1/, `NO_PROXY should be set in forward mode, got: ${stdout}`);
    assert.match(stdout, /np=\S*127\.0\.0\.1/, `no_proxy should be set in forward mode, got: ${stdout}`);
  });

  it("--remote-control merges localhost into an existing NO_PROXY rather than clobbering it", async () => {
    const script = 'process.stdout.write("NP="+(process.env.NO_PROXY||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, NO_PROXY: "example.com" }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes("example.com"), `existing NO_PROXY entry should be preserved, got: ${stdout}`);
    assert.ok(stdout.includes("127.0.0.1"), `localhost should be merged in, got: ${stdout}`);
  });

  it("--remote-control reads a lowercase-only no_proxy and preserves it", async () => {
    // The existing value may be set under the lowercase name only; the merge
    // must read either variant, not just NO_PROXY.
    const script = 'process.stdout.write("NP="+(process.env.NO_PROXY||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, no_proxy: "corp.internal" }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes("corp.internal"), `lowercase no_proxy entry should be preserved, got: ${stdout}`);
    assert.ok(stdout.includes("127.0.0.1"), `localhost should be merged in, got: ${stdout}`);
  });

  it("--remote-control does not duplicate a localhost host already present in NO_PROXY", async () => {
    const script = 'process.stdout.write("NP="+(process.env.NO_PROXY||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, NO_PROXY: "127.0.0.1" }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await waitClose(wrapperProc);

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // 127.0.0.1 must appear exactly once, not duplicated, and localhost still added.
    const np = (stdout.match(/NP=(\S*)/) || [])[1] || "";
    const occurrences = np.split(",").filter((h) => h === "127.0.0.1").length;
    assert.equal(occurrences, 1, `127.0.0.1 should appear exactly once, got NP=${np}`);
    assert.ok(np.split(",").includes("localhost"), `localhost should be added, got NP=${np}`);
  });

  it("a plain fork of the server still gets the wiring recipe", async () => {
    // The suppression must key on the launcher, not on "someone fork()ed me".
    // Keying it on process.channel was measured suppressing the recipe for THIS
    // suite's own forks and for any supervisor's — the operator got no wiring
    // instructions plus a false claim that a launcher had wired the client.
    const caDir = tempDir("cffca-");
    const p = fork(SERVER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_CA_DIR: caDir, CACHE_FIX_PROXY_PORT: "0" }),
    });
    let err = "";
    p.stderr.on("data", (c) => { err += c.toString(); });
    // Wait for the banner, not for a constant. It is written once the server is
    // listening, so a fixed sleep only has to be longer than the slowest start —
    // and then costs that long on every run.
    const deadline = Date.now() + 15_000;
    while (!/forward-proxy: on/.test(err) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    p.kill("SIGTERM");
    await new Promise((res) => p.on("exit", res));

    assert.match(err, /export NODE_EXTRA_CA_CERTS=/,
      `a non-launcher fork must still be told how to wire; stderr: ${err}`);
    assert.doesNotMatch(err, /Client wired by the launcher/,
      `nothing wired this client, so it must not claim otherwise; stderr: ${err}`);
  });

  it("creates every temp dir through the registrar, so none outlive the run", () => {
    // A leak is invisible to every other assertion in this file — measured: with
    // the cleanup neutered the suite still reported 23 pass / 0 fail while
    // leaving 39 directories behind. So the thing to pin is not "the dirs are
    // gone" (after() has not run yet when a test executes) but "nothing bypasses
    // the registrar", which is the only way one can survive.
    //
    // Source-level on purpose: forward mode mints an RSA CA and leaf inside each
    // config dir, so a bypassed site leaks private key material, and the next
    // person to add a test is exactly who would reintroduce it.
    // Matched on the call shape taking a string literal, which the registrar
    // itself does not have (it takes `prefix`). Comment lines are skipped and
    // the pattern is assembled rather than written out, so neither this
    // assertion nor the prose above it can flag itself.
    const src = readFileSync(new URL(import.meta.url), "utf8");
    const call = new RegExp(["mkdtempSync\\(join\\(tmpdir\\(\\),", "\\s*\"[^\"]+\"\\s*\\)\\)"].join(""));
    const raw = src.split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => !line.trim().startsWith("//"))
      .filter(([, line]) => call.test(line))
      .map(([n]) => n);
    assert.deepEqual(raw, [],
      `every temp dir must go through tempDir(); raw mkdtempSync at line(s): ${raw.join(", ")}`);
    assert.ok(tempDirs.length > 0, "premise: this file does create temp dirs");
  });
  it("--remote-control reaps an old salvage scratch dir but leaves a fresh one alone", async () => {
    // One scratch dir per salvage launch, and nothing else on the machine
    // removes them — 81 had accumulated on this box while this feature was being
    // written. They are cert text, mode 0700, so this is litter rather than a
    // leak, but the sibling reaper for ccf.pem.* exists for exactly the same
    // argument and this path had none.
    //
    // The gate is a DAY, not the sibling's minute: the holder is a whole claude
    // session, not a write-to-rename window. Both fixtures live through one
    // launch, so the test fails if the reaper is unconditional (fresh one dies)
    // OR absent (old one survives).
    const configDir = tempDir("cfftrust-");
    // TMPDIR of our own: the reaper sweeps `tmpdir()`, and a test that swept the
    // real /tmp would delete scratch dirs belonging to live sessions on this
    // machine — which is precisely the thing the day-long gate exists to avoid.
    const tmp = tempDir("cffreap-");
    const old = join(tmp, "cache-fix-ca-scratch-oldoldold");
    const fresh = join(tmp, "cache-fix-ca-scratch-freshfresh");
    // A DECOY that must survive: an operator CA dir. README documents
    // `CACHE_FIX_CA_DIR=/tmp/cache-fix-ca`, so any suffixed variant lives under
    // tmpdir() with that prefix. Measured against the first version of this
    // reaper: the whole directory went, ca.key included — the private key the
    // running proxy signs leaves with. It is backdated PAST the gate, because a
    // real CA dir is old by definition and "it was too new to delete" is not a
    // property this test may lean on.
    const caDir = join(tmp, "cache-fix-ca-prod");
    mkdirSync(caDir);
    for (const f of ["ca.key", "ca.pem"]) writeFileSync(join(caDir, f), "# operator key material\n");
    for (const d of [old, fresh]) { mkdirSync(d); writeFileSync(join(d, "b1.pem"), "# scratch\n"); }
    // Straddle the gate rather than clearing it by a mile. A 30-day fixture and
    // a fresh one leave every gate from a minute to a month passing, so the
    // stated 7 days was untested — measured, `scratchAgeMs = 1 day` changed no
    // test. These sit 2 days either side of it.
    const past = (d) => new Date(Date.now() - d * 86_400_000);
    utimesSync(old, past(9), past(9));      // older than 7d: must be reaped
    utimesSync(fresh, past(5), past(5));    // younger than 7d: must survive
    utimesSync(caDir, past(30), past(30));  // old, but not ours to touch at all

    // Salvage must actually RUN, or writeTmp is never called and the reaper
    // beside it never executes: a broken merged bundle is what puts the launcher
    // on that path.
    const script = 'process.stdout.write("OK\\n")';
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir, TMPDIR: tmp });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    writeFileSync(join(configDir, "ca-trust.pem"), "-----BEGIN CERTIFICATE-----\nQUFB\n" + ours);

    const { code, err } = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir, TMPDIR: tmp });
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(!existsSync(old), "a scratch dir older than the gate is abandoned and must be reaped");
    assert.ok(existsSync(fresh), "a scratch dir younger than the gate may belong to a live session");
    assert.ok(existsSync(join(caDir, "ca.key")),
      "the reaper deleted an operator CA directory — the prefix is not specific enough");
  });

  it("--remote-control still salvages when its own leaf key cannot be read", async () => {
    // An unusable leaf.key is a probe that CANNOT BE RUN, not a verdict about
    // the bundle. Measured on the launcher: a healthy 2-CA merge on disk, the
    // block skipped, claude handed 1 CA, nothing printed — an unrunnable probe
    // narrowing trust, which is the one thing the three-outcome contract
    // forbids. Letting the block run reports `unknown` and salvages 3.
    //
    // A DIRECTORY at leaf.key, not a delete: ensureCA regenerates a deleted key
    // on the very next launch (measured), so the absent state cannot exist by
    // the time the launcher looks. This test therefore CANNOT kill a mutation
    // that restores `existsSync(probeLeaf.keyPath)` — `existsSync` on a
    // directory is true, so that guard never saw this case either. It is
    // recorded rather than hidden: the guard's removal is covered by the module
    // -level "cannot serve our own leaf" test, and what this one guards is that
    // an unreadable key still reaches salvage through the launcher.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("N="+(require("node:tls").getCACertificates?'
      + 'require("node:tls").getCACertificates("extra").length:-1)+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    const n0 = Number(/N=(-?\d+)/.exec(first.out)?.[1]);
    if (n0 === -1) return;   // pre-v22.15: the count is unavailable, not wrong

    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    writeFileSync(join(configDir, "ca-trust.d", "zpeer.pem"), peer);
    writeFileSync(join(configDir, "ca-trust.pem"), ours + peer);   // healthy merge
    // A DIRECTORY at leaf.key: ensureCA publishes by rename, so a delete is undone
    // before the launcher looks (measured). EISDIR survives, and it is also the
    // shape the old existsSync guard waved through while calling itself a check.
    const leafKey = join(configDir, "cache-fix-ca", "leaf.key");
    rmSync(leafKey, { force: true });
    mkdirSync(leafKey);

    const { code, out, err } = await runOnce();
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    const n = Number(/N=(-?\d+)/.exec(out)?.[1]);
    assert.ok(n >= 2,
      `an unrunnable probe narrowed the session to ${n} CAs from a healthy merge. stderr: ${err}`);
  });

  it("--remote-control resolves the probe host from the upstream, not a constant", async () => {
    // The leaf's SAN is the UPSTREAM host (forward-proxy.mjs `mitmHosts`), so a
    // probe that always asks for api.anthropic.com fails the name check on any
    // host launched with --proxy-upstream and refuses a perfectly good bundle
    // EVERY launch. Measured with the resolution deleted: a healthy merge, and
    // `is unusable ... using our own CA only` — every peer publisher dropped, on
    // exactly the hosts using a custom upstream.
    //
    // The module-level test covers `bundleUsable` honouring a host argument.
    // This one covers the LAUNCHER computing it, which is where the constant
    // was: mutating the launcher left all 56 green.
    const configDir = tempDir("cfftrust-");
    const UP = "https://api.example.internal";
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir, CACHE_FIX_PROXY_UPSTREAM: UP });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8"));
    const { code, out, err } = await runOnce();
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(out.includes(`CA=${bundle}`),
      `a healthy bundle was refused under --proxy-upstream, so the probe host is not following it. got: ${out} stderr: ${err}`);

    // A CHANGED upstream must also work, and this is the case that decides
    // where the host comes from. Reading it off the leaf's SAN was proposed as
    // strictly better — ask the certificate rather than re-derive the proxy's
    // own `proxyUpstream || env || default`. It is not reachable: `ensureCA`'s
    // `leafCoversAllHosts()` re-mints the leaf as soon as its SAN stops covering
    // the current upstream, so both sources agree by construction at every point
    // this code runs. Asserted here so the equivalence is a measurement rather
    // than a claim in a comment.
    const other = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir,
                                             CACHE_FIX_PROXY_UPSTREAM: "https://elsewhere.invalid" });
    assert.equal(other.code, 0, `Expected exit 0, got ${other.code}. stderr: ${other.err}`);
    assert.ok(other.out.includes(`CA=${bundle}`),
      `a healthy bundle was refused after the upstream changed, so the probe host ` +
      `and the re-minted leaf disagree. got: ${other.out} stderr: ${other.err}`);
  });

  it("--remote-control keeps a merge that carries our CA when nothing can judge it",
     { skip: canCountCAs ? false : "runtime has no tls.getCACertificates, so the census cannot vouch for any bundle" }, async () => {
    // The two rows this branch has to separate, and the question that separates
    // them. An earlier version asked "does node load ANYTHING from it":
    //
    //   merge carries OURS + a peer   loads 2   verifies our proxy: true
    //   merge carries only a peer     loads 1   verifies our proxy: FALSE
    //
    // Both load something, so that question shipped the second row to `claude`
    // and the session failed TLS against its own proxy. The answer then was to
    // narrow to our CA in BOTH rows — honest, but it costs the first row every
    // other publisher on the box: measured 2 CAs on disk, 1 handed over, and
    // the corporate root the builder exists to merge in is not in `ca-trust.d`
    // to be salvaged back.
    //
    // `carriesOurCA` asks the question that actually separates them, and it
    // needs no handshake, so it still answers here — where the handshake is
    // precisely what cannot run. Row one is kept whole; row two is narrowed by
    // the sibling test below.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    writeFileSync(join(configDir, "ca-trust.pem"), ours + peer);   // healthy, loads 2
    const trustDir = join(configDir, "ca-trust.d");
    const leafKey = join(configDir, "cache-fix-ca", "leaf.key");
    rmSync(leafKey, { force: true });
    mkdirSync(leafKey);                 // EISDIR survives ensureCA's rename
    chmodSync(trustDir, 0);             // salvage returns null
    try {
      const { code, out, err } = await runOnce();
      assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
      assert.ok(out.includes(`CA=${join(configDir, "ca-trust.pem")}`),
        `narrowed away a merge that carries our CA — every other publisher on ` +
        `the box lost for a probe that could not run. got: ${out} stderr: ${err}`);
    } finally {
      chmodSync(trustDir, 0o700);
    }
  });

  it("--remote-control keeps a merge nothing faulted, even when salvage produced a rebuild",
     { skip: canCountCAs ? false : "runtime has no tls.getCACertificates, so the census cannot vouch for any bundle" }, async () => {
    // `salvaged ||` short-circuits, so on `unknown` a rebuild pre-empted a merge
    // the launcher had POSITIVE evidence for — the census says it carries our CA
    // and nothing refused it. The rebuild can only hold what `ca-trust.d`
    // supplies, and the corporate roots the builder merged in are not there
    // (claude-via-proxy.mjs says so where the salvage call sits), so the rebuild
    // is a strict SUBSET whenever the merge carries an ambient root.
    //
    // This is the rule that deleted the `dupes` counter, applied generally
    // rather than to one instance: narrowing on an answer we did not get is R2
    // broken, and "we could not ask" is not evidence against the file.
    //
    // Measured on this box's real ambient bundle: merge 132 CAs, rebuild 2 —
    // 130 dropped with nothing refused. The fixture below uses three synthetic
    // CAs for speed; the shape is the same.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    // A publisher the trust dir HAS, so salvage produces a rebuild...
    writeFileSync(join(configDir, "ca-trust.d", "a-peer.pem"), peer);
    // ...and an ambient root it does NOT have, only in the merge.
    const corp = spawnSync("bash", ["-c",
      "d=$(mktemp -d); openssl req -x509 -newkey rsa:2048 -nodes -keyout $d/k -out $d/c " +
      "-days 3650 -subj /CN=corp-root -addext basicConstraints=critical,CA:TRUE 2>/dev/null; " +
      "cat $d/c; rm -rf $d"], { encoding: "utf8" }).stdout;
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, corp + ours + peer);
    // Make the handshake abstain: EISDIR on the leaf survives ensureCA's rename.
    const leafKey = join(configDir, "cache-fix-ca", "leaf.key");
    rmSync(leafKey, { force: true });
    mkdirSync(leafKey);
    const { code, out, err } = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(out.includes(`CA=${bundle}`),
      `handed a rebuild instead of a merge nothing faulted — the rebuild cannot ` +
      `carry the ambient roots, so this narrows trust on an answer we did not get. ` +
      `got: ${out} stderr: ${err}`);
    // The value and the sentence are computed by two different ternaries, and
    // this is the one branch where they disagreed: `salvaged` is truthy here
    // (the trust dir HAS a-peer.pem), so a message that tests it first says
    // "rebuilt" about the merge it just kept. This line is the operator's only
    // readout of what their session trusts, so a wrong answer here is worse
    // than none — the same reason the third message exists at all.
    assert.ok(/keeping it/.test(err) && !/rebuilt from/.test(err),
      `kept the merge but reported a rebuild. got stderr: ${err}`);
    // The same line is assembled from a SECOND ternary, and that one had no
    // assertion at all: swapping its arms left the whole suite green while the
    // mutant printed "is unusable ... keeping it" — one sentence calling the
    // bundle unusable and saying it is being handed over. Counting the arms of
    // the construct you are looking at is the wrong unit; count the independent
    // expressions concatenated into the OUTPUT.
    assert.ok(/could not be verified/.test(err) && !/is unusable/.test(err),
      `an unjudgeable merge was reported as definitively unusable. got stderr: ${err}`);
    // That line concatenates FOUR independent expressions and the two above pin
    // only two of them. The remaining pair — which FILE is being judged, and WHY
    // — were each mutable with the whole suite green: naming our own CA as the
    // unusable file, and pasting a constant reason over the real one. Both are
    // the round-14 disagreement (sentence vs value) at a different site.
    assert.ok(new RegExp(`cache-fix: ${bundle} `).test(err),
      `the message named a file other than the bundle it judged. got stderr: ${err}`);
    assert.ok(/\(our own leaf key\/cert pair does not serve\)/.test(err),
      `the reason does not say why the probe abstained. got stderr: ${err}`);
  });

  it("--remote-control does not let the CA census overrule a handshake REFUSAL", async () => {
    // A PROBE MAY VETO, NEVER APPROVE ALONE.
    //
    // The two probes ask different questions — "does node load our CA" and
    // "does node verify our proxy with this file" — so one answering yes is not
    // evidence for the other. The refused branch was letting the census
    // re-approve the very bundle the handshake had just refused. Measured, a
    // merge that genuinely carries our CA probed against a host the leaf does
    // not cover: handshake `NOT OK`, census `true`, launcher handed the merge.
    //
    // Driven by replacing the CA the leaf chains to. Moving the probe host with
    // `--proxy-upstream` does NOT work: `ensureCA`'s `leafCoversAllHosts()`
    // re-mints the leaf for the new host before the probe runs, so the handshake
    // succeeds and this branch is never reached — measured, and it is why the
    // first version of this test failed with the fix in place.
    //
    // A DIFFERENT CA in `ca.pem` is a definitive `not ok` (the leaf no longer
    // chains to it) while the census still answers true about the merge, because
    // the merge carries that same replacement CA.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    // An unrelated CA, written where the launcher reads OUR CA from. The leaf on
    // disk was signed by the original, so the handshake refuses definitively;
    // the merge below carries this replacement, so the census answers true.
    const caPath = join(configDir, "cache-fix-ca", "ca.pem");
    const other = spawnSync("bash", ["-c",
      "d=$(mktemp -d); openssl req -x509 -newkey rsa:2048 -nodes -keyout $d/k -out $d/c " +
      "-days 3650 -subj /CN=other -addext basicConstraints=critical,CA:TRUE 2>/dev/null; " +
      "cat $d/c; rm -rf $d"], { encoding: "utf8" }).stdout;
    writeFileSync(caPath, other);
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, other);                 // census: true, handshake: not ok
    const trustDir = join(configDir, "ca-trust.d");
    chmodSync(trustDir, 0);                       // salvage returns null
    try {
      const { code, out, err } = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
      assert.ok(!out.includes(`CA=${bundle}`),
        `the census overruled a handshake refusal — "our CA is loaded" is not ` +
        `evidence that our proxy verifies. got: ${out} stderr: ${err}`);
      // The THIRD arm: trust dir unreadable, so salvage returned null and our
      // own CA is all that is left. Asserted here rather than in a fixture of
      // its own because this test already produces exactly that state.
      assert.ok(/using our own CA only/.test(err),
        `handed our own CA but did not say so. got stderr: ${err}`);
      // ...and the OTHER arm of the definitive/unjudgeable ternary. This is a
      // real refusal, so the operator must not read "could not be verified" —
      // the two words carry opposite instructions about whether to go looking
      // for a broken bundle. Its sibling is asserted where a merge is KEPT.
      assert.ok(/is unusable/.test(err) && !/could not be verified/.test(err),
        `a definitive refusal was reported as merely unverifiable. got stderr: ${err}`);
    } finally {
      chmodSync(trustDir, 0o700);
    }
  });

  it("--remote-control never hands over a merge that does not carry our CA", async () => {
    // A STALE merge — built before we published, the normal state right after a
    // CCF upgrade — loads a corporate cert and carries none of ours. "Does node
    // load anything from it" says yes about that file, and it is the wrong
    // question: the session then fails TLS against the very proxy it is routed
    // through, while our own CA sat right there and verifies.
    //
    // Measured before this test existed: N=1 handed over, our CA absent,
    // bundleUsable on the handed file {ok:false} while the skipped caPem was
    // {ok:true}. On pre-v22.15 runtimes the same line handed over a bundle
    // loading ZERO — `engines: >=18`, so that is most of the supported range.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    // A merge carrying a real certificate that is NOT ours, and an unanswerable
    // probe so the launcher lands on the unknown branch.
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, peer);
    const trustDir = join(configDir, "ca-trust.d");
    const leafKey = join(configDir, "cache-fix-ca", "leaf.key");
    rmSync(leafKey, { force: true });
    mkdirSync(leafKey);                 // EISDIR survives ensureCA's rename
    chmodSync(trustDir, 0);             // salvage returns null
    try {
      const { code, out, err } = await runOnce();
      assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
      assert.ok(!out.includes(`CA=${bundle}`),
        `handed over a merge that carries none of our CA. got: ${out} stderr: ${err}`);
    } finally {
      chmodSync(trustDir, 0o700);
    }
  });

  it("--remote-control refuses a merge the client would discard, even when the handshake passes", async () => {
    // THE HAPPY PATH, which nine measurements about the refused path never
    // touched. `bundleUsable` verdict ok means "node verified our leaf with
    // this file" — a node question. The consumer is Bun/BoringSSL, and the two
    // disagree on one shape:
    //
    //   our CA, then a fatal block   node keeps ours   client discards the FILE
    //
    // So the merge passed the handshake gate and shipped, while the client that
    // reads it ends up trusting nothing — and a discarded file also takes down
    // CAs supplied via SSL_CERT_FILE or SSL_CERT_DIR (measured, two independent
    // sources), so this is worse than handing over our own CA alone.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    const bundle = join(configDir, "ca-trust.pem");
    // Our CA FIRST so the handshake still succeeds; damage after it, so the
    // client discards the whole file.
    writeFileSync(bundle, ours + peer.slice(0, peer.length - 120));
    const { code, out, err } = await runOnce();
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(!out.includes(`CA=${bundle}`),
      `handed over a merge the real client discards entirely — the session would ` +
      `trust nothing at all. got: ${out} stderr: ${err}`);
  });

  it("--remote-control still hands over a healthy merge (control for the case above)", async () => {
    // Without this, the assertion above is satisfied by a launcher that refuses
    // every merge — which is the failure the salvage path exists to prevent.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, ours + peer);            // undamaged
    const { code, out, err } = await runOnce();
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(out.includes(`CA=${bundle}`),
      `refused a healthy merge, so the refusal above measured nothing. got: ${out} stderr: ${err}`);
  });

  it("--remote-control does not widen onto a REFUSED merge when the probe cannot answer", async () => {
    // The keep-the-merge branch consults a probe that fails open, and this
    // branch is reached on a definitive refusal as well as on `unknown`. So on
    // any runtime that cannot answer, "could not ask" widened onto a bundle
    // already MEASURED unusable — the R1 violation the whole change exists to
    // prevent, re-entered through its own fix.
    //
    //   merge {ok:false}, carries none of ours, our own CA verifies
    //   probe answers        -> our CA        (correct)
    //   probe cannot answer  -> THE MERGE     (before this test)
    //
    // Pre-v22.15 is most of what `engines: >=18` promises, so this is not an
    // edge case there but every launch with a stale merge. Driven through the
    // seam rather than by faking a runtime: the launcher must narrow whenever
    // the probe did not answer, whatever made it unable to.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = () => runWrapper(script, { CLAUDE_CONFIG_DIR: configDir,
                                               CACHE_FIX_CA_PROBE_UNANSWERABLE: "1" });
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    // A merge carrying a real certificate that is NOT ours: definitively
    // refused, and our own CA is right there and verifies.
    const peer = readFileSync(join(configDir, "cache-fix-ca", "leaf.pem"), "utf8");
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, peer);
    const trustDir = join(configDir, "ca-trust.d");
    chmodSync(trustDir, 0);             // salvage returns null
    try {
      const { code, out, err } = await runOnce();
      assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
      assert.ok(!out.includes(`CA=${bundle}`),
        `widened onto a merge measured unusable because the probe could not answer. ` +
        `got: ${out} stderr: ${err}`);
      assert.ok(out.includes(join(configDir, "cache-fix-ca", "ca.pem")),
        `expected our own CA, got: ${out} stderr: ${err}`);
    } finally {
      chmodSync(trustDir, 0o700);
    }
  });

  it("--remote-control narrows when NEITHER probe could answer, rather than assuming the merge", async () => {
    // The census gate is `unknown && carriesOurCA(...)`, and it must require a
    // YES. Relaxing it to "did not say no" (`!== false`) reads as equivalent and
    // is not: `carriesOurCA` is TRI-state, so `null` — could not ask — then
    // widens onto a merge nobody has vouched for.
    //
    // The neighbouring seam test cannot reach this. It drives a definitive
    // REFUSAL, where `verdict.unknown` is false and `&&` short-circuits before
    // the census runs at all, so the census's own default is unmeasured there.
    // This one needs BOTH probes silent at once:
    //
    //   handshake  abstains  (EISDIR on leaf.key — ensureCA's rename cannot undo it)
    //   census     abstains  (the shipped seam, which is what a pre-v22.15 host is)
    //   merge      STALE     (a corporate root, none of ours — the state right
    //                         after an upgrade, before the builder re-merges)
    //
    // Under the relaxed gate this hands `claude` a bundle node loads NO CA of
    // ours from, so the session distrusts the very proxy it is routed through —
    // and the stderr line then claims "node loads our CA from it" about a file
    // where it demonstrably does not. Pre-v22.15 is most of what `engines: >=18`
    // promises, so this is the ordinary case there, not an edge.
    const configDir = tempDir("cfftrust-");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const first = await runWrapper(script, { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);

    // A merge that carries a real CA which is NOT ours. Not damaged — nothing
    // faults it — it is simply stale, which is why only the census can speak to
    // it and why "could not ask" must not be read as "fine".
    const corp = spawnSync("bash", ["-c",
      "d=$(mktemp -d); openssl req -x509 -newkey rsa:2048 -nodes -keyout $d/k -out $d/c " +
      "-days 3650 -subj /CN=corp-root -addext basicConstraints=critical,CA:TRUE 2>/dev/null; " +
      "cat $d/c; rm -rf $d"], { encoding: "utf8" }).stdout;
    const bundle = join(configDir, "ca-trust.pem");
    writeFileSync(bundle, corp);
    // Make the handshake abstain rather than refuse: a DIRECTORY at leaf.key
    // survives ensureCA's publish-by-rename (EISDIR), where a delete or a chmod
    // is undone inside the same run.
    const leafKey = join(configDir, "cache-fix-ca", "leaf.key");
    rmSync(leafKey, { force: true });
    mkdirSync(leafKey);

    const { code, out, err } = await runWrapper(script,
      { CLAUDE_CONFIG_DIR: configDir, CACHE_FIX_CA_PROBE_UNANSWERABLE: "1" });
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${err}`);
    assert.ok(!out.includes(`CA=${bundle}`),
      `kept a stale merge although NEITHER probe vouched for it — "could not ask" ` +
      `is not evidence the file carries our CA. got: ${out} stderr: ${err}`);
    assert.ok(out.includes(join(configDir, "cache-fix-ca", "ca.pem")),
      `expected our own CA, got: ${out} stderr: ${err}`);
    // ...and the sentence must not claim the merge was kept for a reason that
    // never held.
    assert.ok(!/keeping it/.test(err),
      `reported keeping a merge it did not keep. got stderr: ${err}`);
  });

});
