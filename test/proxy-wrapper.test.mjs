import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(__dirname, "../bin/claude-via-proxy.mjs");
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");

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
  for (const k of ["CACHE_FIX_PROXY_PORT", "CACHE_FIX_PROXY_UPSTREAM", "NO_PROXY", "no_proxy"]) delete env[k];
  env.CACHE_FIX_PROXY_BIND = "127.0.0.1";
  return { ...env, ...overrides };
}

const NODE = process.execPath;

describe("launch wrapper (claude-via-proxy)", { concurrency: 1 }, () => {
  it("exits with error when claude command is not found", async () => {
    const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: "/nonexistent/path/to/claude" }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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
    const caDir = mkdtempSync(join(tmpdir(), "cffcadir-"));
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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // The CA must be the override path exactly, not the default ~/.claude one.
    assert.ok(
      stdout.includes(`CA=${join(caDir, "ca.pem")}`),
      `NODE_EXTRA_CA_CERTS should be the CACHE_FIX_CA_DIR override (${join(caDir, "ca.pem")}), got: ${stdout}`,
    );
  });

  // --- ca-trust.d: coexisting with another component that also MITMs ---------
  // NODE_EXTRA_CA_CERTS takes ONE file, so a plain assignment silently untrusts
  // whatever else needed trusting. Measured 2026-07-30: cswap's pin proxy also
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
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const bundle = join(configDir, "ca-trust.pem");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = async () => {
      const p = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
      });
      let out = "", err = "";
      p.stdout.on("data", (c) => { out += c.toString(); });
      p.stderr.on("data", (c) => { err += c.toString(); });
      const c = await new Promise((res) => {
        p.on("exit", res);
        setTimeout(() => { p.kill("SIGTERM"); res(null); }, 15000);
      });
      return { code: c, out, err };
    };

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
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const trustDir = join(configDir, "ca-trust.d");
    mkdirSync(trustDir, { recursive: true });
    const sibling = join(trustDir, "cswap-pin.pem");
    const SIBLING_BYTES = "# another component's CA — must survive untouched\n";
    writeFileSync(sibling, SIBLING_BYTES);
    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.equal(readFileSync(sibling, "utf8"), SIBLING_BYTES, "sibling component's pem must be untouched");
    assert.ok(!existsSync(join(configDir, "ca-trust.pem")), "we must NOT create the merged bundle — exactly one external writer owns it");
    assert.ok(existsSync(join(trustDir, "ccf.pem")), "our own pem should still be published");
  });

  it("--remote-control falls back to its own CA when no merged bundle exists (unchanged standalone behaviour)", async () => {
    // A plain CCF user with no other MITM and no bundle builder must see exactly
    // what they saw before this contract existed.
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stdout = "";
    let stderr = "";
    wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(
      stdout.includes(`CA=${join(configDir, "cache-fix-ca", "ca.pem")}`),
      `with no bundle NODE_EXTRA_CA_CERTS must be our own CA, got: ${stdout}`,
    );
  });

  it("--remote-control publishes atomically (a reader never sees a torn ccf.pem)", async () => {
    // A torn pem is not a cosmetic problem: Node's PEM reader aborts the whole
    // extras load on an unterminated block. Measured on node v24 / openssl 3.5,
    // with a leaf signed by the CCF CA and a bundle = good.pem + torn.pem:
    //   torn AFTER  -> "Ignoring extra certs ... bad end line", verify still ok
    //   torn BEFORE -> "... ASN1 lib",  verify FAILS UNABLE_TO_VERIFY_LEAF_SIGNATURE
    // The builder concatenates sort(ca-trust.d/*.pem), and "ccf.pem" sorts before
    // "cswap-pin.pem", so a torn OURS lands in the fatal position and takes every
    // other component CA and corporate root down with it. A plain
    // writeFileSync(dst) is exactly what leaves that state visible to a
    // concurrent builder, so the write must be rename-into-place.
    //
    // Distinguishing atomic from non-atomic needs a property that only holds for
    // rename-into-place: an EXISTING published file must never be observed
    // truncated or partially rewritten. writeFileSync(dst) opens the target with
    // O_TRUNC, so the moment it starts the reader can see a zero-length or
    // half-written ccf.pem; rename() swaps a complete file in one step and the
    // old complete file stays readable until it does. We pin that by making the
    // target unwritable-in-place but the DIRECTORY writable: a truncating write
    // then fails outright, while rename still succeeds. That asymmetry is the
    // mechanism, not an incidental detail.
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const trustDir = join(configDir, "ca-trust.d");
    const dst = join(trustDir, "ccf.pem");
    mkdirSync(trustDir, { recursive: true });
    // A stale published file, read-only, standing in for "an existing complete
    // file a builder may be reading right now". Its content differs from our CA,
    // so the publish path must replace it rather than take the byte-compare skip.
    const STALE = "-----BEGIN CERTIFICATE-----\nc3RhbGUtcHVibGlzaGVk\n-----END CERTIFICATE-----\n";
    writeFileSync(dst, STALE);
    chmodSync(dst, 0o444);

    const script = 'process.stdout.write("OK\\n")';
    const wrapperProc = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // rename() replaces a read-only target (the directory grants permission);
    // a truncating in-place write cannot, and would leave the stale bytes.
    const pem = readFileSync(dst, "utf8");
    assert.notEqual(pem, STALE, "publish must replace an existing read-only pem (rename), not fail to overwrite it in place");
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

  it("--remote-control ignores a merged bundle that does NOT contain our own CA", async () => {
    // The dangerous case, and worse than falling back: the bundle exists and is
    // non-empty, so a size-only gate accepts it — but it was built BEFORE we
    // published, so it lacks OUR CA. Handing claude that bundle makes it distrust
    // the very proxy it is about to be routed through: every request fails TLS
    // instead of merely losing another component's CA. A stale builder is the
    // normal state right after a CCF upgrade, so this is not a corner case.
    // (cswap hit the same hazard from the other side and guards it identically.)
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(
      stdout.includes(`CA=${join(configDir, "cache-fix-ca", "ca.pem")}`),
      `a bundle missing our CA must be ignored in favour of our own CA, got: ${stdout}`,
    );
  });

  it("--remote-control ignores a merged bundle torn AHEAD of our own entry", async () => {
    // The case containment CANNOT see. A bundle whose earlier entry is missing its
    // END line still literally contains our CA further down, so the "is our CA in
    // there" gate accepts it — and that is the FATAL position, not the benign one:
    // measured here on node v24 / openssl 3.5, an unterminated block ahead of a
    // good one fails the handshake outright (UNABLE_TO_VERIFY_LEAF_SIGNATURE),
    // whereas one after it merely warns. So the session would be handed a bundle
    // that trusts nothing at all, including our own proxy.
    //
    // Counting BEGIN vs END markers catches exactly this and nothing else; the
    // containment check catches the stale bundle and cannot see a tear. Both are
    // needed, neither subsumes the other (independently reproduced by cswap, whose
    // pin proxy is both producer and consumer of the same directory).
    //
    // Reader beware: this is a cheap pre-flight guard, not proof. Balanced markers
    // and containment together still do not prove Node verifies with the result —
    // only a handshake does. They are here to keep a KNOWN-bad bundle from ever
    // reaching the client.
    const configDir = mkdtempSync(join(tmpdir(), "cfftrust-"));
    const bundle = join(configDir, "ca-trust.pem");
    const script = 'process.stdout.write("CA="+(process.env.NODE_EXTRA_CA_CERTS||"UNSET")+"\\n")';
    const runOnce = async () => {
      const p = fork(WRAPPER_PATH, ["--remote-control", "--proxy-port", "0"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: cleanEnv({ CACHE_FIX_CLAUDE_CMD: `${NODE} -e ${script}`, CLAUDE_CONFIG_DIR: configDir }),
      });
      let out = "", err = "";
      p.stdout.on("data", (c) => { out += c.toString(); });
      p.stderr.on("data", (c) => { err += c.toString(); });
      const c = await new Promise((res) => {
        p.on("exit", res);
        setTimeout(() => { p.kill("SIGTERM"); res(null); }, 15000);
      });
      return { code: c, out, err };
    };

    // First run publishes our CA, so the torn bundle we then build is realistic:
    // a builder that concatenated a truncated sibling ahead of our complete pem.
    const first = await runOnce();
    assert.equal(first.code, 0, `first run should exit 0, got ${first.code}. stderr: ${first.err}`);
    const ours = readFileSync(join(configDir, "ca-trust.d", "ccf.pem"), "utf8");
    const torn = "-----BEGIN CERTIFICATE-----\nc3RvbGVuLW1pZC13cml0ZQ==\n";
    writeFileSync(bundle, `${torn}${ours}`);
    // Precondition: containment alone WOULD accept this, so the test can only pass
    // for the reason it claims — the marker counts, not some other rejection.
    const raw = readFileSync(bundle, "utf8");
    assert.ok(raw.includes(readFileSync(join(configDir, "cache-fix-ca", "ca.pem"), "utf8").trim()),
      "fixture must still contain our CA verbatim, or this test proves nothing about the marker check");
    assert.notEqual(
      (raw.match(/-----BEGIN CERTIFICATE-----/g) || []).length,
      (raw.match(/-----END CERTIFICATE-----/g) || []).length,
      "fixture must be marker-unbalanced",
    );

    const second = await runOnce();
    assert.equal(second.code, 0, `Expected exit 0, got ${second.code}. stderr: ${second.err}`);
    assert.ok(
      second.out.includes(`CA=${join(configDir, "cache-fix-ca", "ca.pem")}`),
      `a torn bundle must be ignored in favour of our own CA, got: ${second.out}`,
    );
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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

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

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    // 127.0.0.1 must appear exactly once, not duplicated, and localhost still added.
    const np = (stdout.match(/NP=(\S*)/) || [])[1] || "";
    const occurrences = np.split(",").filter((h) => h === "127.0.0.1").length;
    assert.equal(occurrences, 1, `127.0.0.1 should appear exactly once, got NP=${np}`);
    assert.ok(np.split(",").includes("localhost"), `localhost should be added, got NP=${np}`);
  });
});
