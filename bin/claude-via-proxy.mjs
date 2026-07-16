#!/usr/bin/env node

import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");

const args = process.argv.slice(2);
const SUBCOMMAND = args[0];

// Subcommand dispatch (must come before the wrapper-arg parser so subcommand
// names don't get treated as claude args). Returns null when no subcommand
// matched, signaling fall-through to wrapper mode below.
async function dispatch() {
  if (SUBCOMMAND === "server") {
    return new Promise((resolveP) => {
      const serverProc = spawn(process.execPath, [SERVER_PATH, ...args.slice(1)], {
        stdio: "inherit",
        env: process.env,
      });
      // Forward termination to the child so a supervisor killing THIS launcher
      // doesn't leak the actual server process. Without this, `kill <launcher>`
      // leaves the listening child orphaned (it reparents to init and keeps the
      // port bound). Each handler is idempotent; the child's exit resolves us.
      const forward = (sig) => { try { serverProc.kill(sig); } catch {} };
      const onSIGTERM = () => forward("SIGTERM");
      const onSIGINT = () => forward("SIGINT");
      process.on("SIGTERM", onSIGTERM);
      process.on("SIGINT", onSIGINT);
      serverProc.on("close", (code) => {
        process.off("SIGTERM", onSIGTERM);
        process.off("SIGINT", onSIGINT);
        resolveP(code ?? 0);
      });
      serverProc.on("error", (err) => {
        process.stderr.write(`Failed to start proxy server: ${err.message}\n`);
        resolveP(1);
      });
    });
  }
  if (SUBCOMMAND === "install-service") {
    const force = args.includes("--force");
    const { install } = await import("./install-service.mjs");
    return install({ force });
  }
  if (SUBCOMMAND === "uninstall-service") {
    const { uninstall } = await import("./install-service.mjs");
    return uninstall();
  }
  if (SUBCOMMAND === "--help" || SUBCOMMAND === "-h" || SUBCOMMAND === "help") {
    process.stdout.write(
      "Usage: cache-fix-proxy [subcommand] [args]\n\n" +
        "Subcommands:\n" +
        "  (no subcommand)        Spawn the proxy + launch claude with ANTHROPIC_BASE_URL set.\n" +
        "                         Pass any claude args after optional --proxy-port / --proxy-upstream.\n" +
        "  server                 Run just the proxy in the foreground (for systemd/launchd ExecStart).\n" +
        "  install-service        Install a systemd user service (Linux) or launchd agent (macOS).\n" +
        "                         Pass --force to overwrite an existing config.\n" +
        "  uninstall-service      Stop, disable, and remove the installed service.\n" +
        "  help                   Show this help.\n\n" +
        "Wrapper-mode flags:\n" +
        "  --proxy-port <N>       Port for the spawned proxy (default 9801)\n" +
        "  --proxy-upstream <URL> Upstream URL the proxy forwards to (default api.anthropic.com)\n" +
        "  --remote-control       Run in forward-proxy mode: spawn the proxy with\n" +
        "                         CACHE_FIX_FORWARD_PROXY=on and wire claude via\n" +
        "                         HTTPS_PROXY + the proxy's MITM CA instead of\n" +
        "                         ANTHROPIC_BASE_URL, so Claude Code stays first-party\n" +
        "                         and Remote Control / mobile session visibility keeps\n" +
        "                         working (CC >= 2.1.196 disables it when\n" +
        "                         ANTHROPIC_BASE_URL is set).\n" +
        "\nEnvironment:\n" +
        "  CACHE_FIX_PROXY_PORT     Port for the proxy server\n" +
        "  CACHE_FIX_PROXY_UPSTREAM Upstream URL\n" +
        "  CACHE_FIX_DEBUG=1        Verbose proxy logging\n" +
        "  CACHE_FIX_HOT_RELOAD=on  Enable in-process extension hot-reload (off by default; see #196)\n" +
        "  CACHE_FIX_CLAUDE_CMD     Override the `claude` command for the wrapper\n" +
        "\nNotes on --remote-control:\n" +
        "  Remote Control performs a trusted-device enrollment handshake on first\n" +
        "  connect. That step is Claude Code's own, runs upstream, and can need a\n" +
        "  few retries — especially on a freshly launched or auto-resumed session,\n" +
        "  or when the Anthropic API is degraded. A failure prints \"device\n" +
        "  enrollment didn't complete... run /remote-control again\"; re-running RC\n" +
        "  is the intended fix and normally succeeds within a few attempts. This is\n" +
        "  enrollment flakiness, NOT a forward-proxy failure — the proxy relays the\n" +
        "  enrollment traffic unchanged (check the proxy journal for passthrough\n" +
        "  errors to rule the proxy in or out).\n",
    );
    return 0;
  }
  return null;
}

const subcommandExit = await dispatch();
if (subcommandExit !== null) process.exit(subcommandExit);

// No subcommand matched → wrapper mode (back-compat with v3.0.x behavior).
let proxyPort = 9801;
let proxyUpstream = undefined;
let remoteControl = false;
const claudeArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--proxy-port" && args[i + 1]) {
    proxyPort = parseInt(args[++i], 10);
  } else if (args[i] === "--proxy-upstream" && args[i + 1]) {
    proxyUpstream = args[++i];
  } else if (args[i] === "--remote-control") {
    remoteControl = true;
  } else {
    claudeArgs.push(args[i]);
  }
}

const proxyEnv = { ...process.env, CACHE_FIX_PROXY_PORT: String(proxyPort) };
if (proxyUpstream) proxyEnv.CACHE_FIX_PROXY_UPSTREAM = proxyUpstream;
// Forward-proxy mode: the spawned proxy must attach the CONNECT/MITM handler,
// or the HTTPS_PROXY wiring below would tunnel to a proxy that only speaks
// reverse-proxy and never terminates TLS for the upstream host.
if (remoteControl) proxyEnv.CACHE_FIX_FORWARD_PROXY = "on";

const proxyProc = fork(SERVER_PATH, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: proxyEnv,
});

let claudeProc = null;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  if (claudeProc && !claudeProc.killed) claudeProc.kill("SIGTERM");
  if (proxyProc && !proxyProc.killed) proxyProc.kill("SIGTERM");
}

proxyProc.on("exit", (code) => {
  if (!exiting) {
    process.stderr.write(`proxy exited unexpectedly (code ${code})\n`);
    cleanup();
    process.exit(1);
  }
});

proxyProc.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function waitForReady() {
  return new Promise((resolve, reject) => {
    let output = "";
    proxyProc.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on ([\d.]+):(\d+)/);
      if (match) resolve(parseInt(match[2], 10));
    });
    proxyProc.on("exit", (code) => {
      reject(new Error(`Proxy exited (code ${code}) before ready`));
    });
    setTimeout(() => reject(new Error("Proxy failed to start within 10s")), 10000);
  });
}

let actualPort;
try {
  actualPort = await waitForReady();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  cleanup();
  process.exit(1);
}

let claudeEnv;
if (remoteControl) {
  // Forward-proxy wiring. Leave ANTHROPIC_BASE_URL UNSET (that is exactly what
  // keeps Remote Control enabled) and route claude through the proxy as an
  // HTTPS proxy, trusting the MITM CA it generated on startup. CA path mirrors
  // the proxy's config.caDir: ${CLAUDE_CONFIG_DIR||~/.claude}/cache-fix-ca.
  const caRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const caPem = join(caRoot, "cache-fix-ca", "ca.pem");
  if (!existsSync(caPem)) {
    process.stderr.write(
      `--remote-control: proxy MITM CA not found at ${caPem}. The proxy should ` +
        `generate it on startup in forward-proxy mode; check for an openssl ` +
        `failure in the proxy output above.\n`,
    );
    cleanup();
    process.exit(1);
  }
  const proxyUrl = `http://127.0.0.1:${actualPort}`;
  claudeEnv = { ...process.env };
  delete claudeEnv.ANTHROPIC_BASE_URL;
  claudeEnv.HTTPS_PROXY = proxyUrl;
  claudeEnv.https_proxy = proxyUrl;
  claudeEnv.NODE_EXTRA_CA_CERTS = caPem;
} else {
  claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${actualPort}`,
  };
}

const spawnOpts = { stdio: ["inherit", "pipe", "pipe"], env: claudeEnv };
if (process.env.CACHE_FIX_CLAUDE_CMD) {
  const parts = process.env.CACHE_FIX_CLAUDE_CMD.split(" ");
  claudeProc = spawn(parts[0], [...parts.slice(1), ...claudeArgs], spawnOpts);
} else {
  claudeProc = spawn("claude", claudeArgs, spawnOpts);
}

claudeProc.stdout.on("data", (chunk) => process.stdout.write(chunk));
claudeProc.stderr.on("data", (chunk) => process.stderr.write(chunk));

claudeProc.on("error", (err) => {
  if (err.code === "ENOENT") {
    process.stderr.write("Error: 'claude' command not found. Is Claude Code installed?\n");
  } else {
    process.stderr.write(`Failed to start claude: ${err.message}\n`);
  }
  cleanup();
  process.exit(1);
});

claudeProc.on("close", (code) => {
  const exitCode = code ?? 0;
  cleanup();
  process.exit(exitCode);
});

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
