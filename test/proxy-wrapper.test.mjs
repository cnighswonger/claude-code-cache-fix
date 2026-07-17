import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
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
  const env = { ...process.env, ...overrides };
  delete env.CACHE_FIX_PROXY_PORT;
  delete env.CACHE_FIX_PROXY_UPSTREAM;
  env.CACHE_FIX_PROXY_BIND = "127.0.0.1";
  return env;
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
});
