#!/usr/bin/env node

import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
        "                         ANTHROPIC_BASE_URL is set). Also adds localhost to\n" +
        "                         NO_PROXY so local HTTP MCP servers / services bypass\n" +
        "                         the proxy (any existing NO_PROXY is preserved).\n" +
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
        "  errors to rule the proxy in or out).\n" +
        "\n" +
        "  Enabling RC on an already-warm session costs ONE prompt-cache rebuild:\n" +
        "  enrollment adds an RC anthropic-beta (and X-Trusted-Device-Token) to\n" +
        "  outbound requests, and Anthropic keys the prompt cache partly on the beta\n" +
        "  set, so the first post-/rc request rebuilds the prefix under the new\n" +
        "  namespace. It re-warms on the very next turn (measured: 13.9% -> 98.2%\n" +
        "  hit rate one turn later). To avoid paying it mid-session, launch with\n" +
        "  --remote-control from the start so the beta is present from request one.\n",
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
  // HTTPS proxy, trusting the MITM CA it generated on startup. Resolve the CA
  // dir from the SAME inputs as the proxy's config.caDir, in the same order:
  // CACHE_FIX_CA_DIR wins, else ${CLAUDE_CONFIG_DIR||~/.claude}/cache-fix-ca.
  // (Reading only CLAUDE_CONFIG_DIR here would ignore a CACHE_FIX_CA_DIR
  // override and point claude at the wrong — or absent — CA than the one the
  // spawned proxy actually generated.)
  const caDir = process.env.CACHE_FIX_CA_DIR ||
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cache-fix-ca");
  const caPem = join(caDir, "ca.pem");
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
  // Publish our MITM CA where other components can find it. NODE_EXTRA_CA_CERTS
  // takes ONE file, so whoever assigns it last wins and every other CA is
  // silently untrusted — measured 2026-07-30 against cswap's pin proxy, which
  // also MITMs api.anthropic.com and also set the var, breaking Remote Control
  // inbound on the work Mac. The fix is a directory each component publishes its
  // own file into, so a bundle can be built from all of them.
  //
  // We write EXACTLY ONE path, ca-trust.d/ccf.pem, and never a sibling's.
  // Rewritten every launch, not once: the proxy regenerates its CA whenever
  // caDir is wiped, and a stale pem would advertise a key nothing signs with.
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const caTrustDir = process.env.CACHE_FIX_CA_TRUST_DIR || join(configDir, "ca-trust.d");
  try {
    mkdirSync(caTrustDir, { recursive: true });
    const ours = readFileSync(caPem);
    const dst = join(caTrustDir, "ccf.pem");
    // Byte-compare skip so a bundle builder keying on mtime is not woken by a
    // launch that changed nothing.
    let same = false;
    try { same = readFileSync(dst).equals(ours); } catch { /* absent => write */ }
    if (!same) {
      // Write a temp sibling and rename() over the target: rename is atomic on
      // POSIX, so a builder reading the directory sees either the old complete
      // file or the new one, never a half. A plain writeFileSync(dst) opens with
      // O_TRUNC and leaves a torn pem visible for the duration of the write —
      // and a torn pem does not merely lose OUR CA, it can void the ENTIRE merged
      // bundle: Node's PEM reader aborts the whole extras load on an unterminated
      // block. Measured on node v24 / openssl 3.5 with a leaf signed by this CA:
      // torn entry AFTER a good one warns "bad end line" but still verifies;
      // torn entry BEFORE it fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The
      // builder concatenates sort(*.pem) and "ccf.pem" sorts first, so a torn
      // OURS lands in exactly the fatal position and takes every other component
      // CA and corporate root down with it. Temp must be in the SAME directory —
      // rename across filesystems is not atomic (and would EXDEV).
      const tmp = `${dst}.${process.pid}`;
      writeFileSync(tmp, ours);
      renameSync(tmp, dst);
    }
  } catch (e) {
    // Non-fatal: publishing is how OTHERS trust us. This session only needs its
    // own CA, so a failure to publish must not stop it.
    process.stderr.write(`cache-fix: could not publish CA to ${caTrustDir}: ${e.message}\n`);
  }
  // Read the merged bundle if something built one, so a session trusts every
  // component's CA and not only ours.
  //
  // We deliberately do NOT build it. Merging must include the ambient/corporate
  // roots, and finding those is environment-specific (a Linux host may keep them
  // in /usr/local/share/ca-certificates/*.crt and NOT in the system bundle a
  // shell points at; a Mac keeps them in the keychain). That knowledge does not
  // belong in this repo. It also keeps the writer count at one: two launchers
  // both rebuilding the bundle would race the same output. We are write-own +
  // read-merged.
  //
  // No bundle => our own CA alone, byte for byte what this did before, so a host
  // with no other MITM and no bundle builder sees no change at all.
  // Fixed name, no env override: the builder writes this exact path (it resolves
  // the config dir the same way), so a knob here could only ever point the two
  // sides at different files.
  const caTrustBundle = join(configDir, "ca-trust.pem");
  let caForClaude = caPem;
  // Accept the bundle only if OUR CA is actually in it. A bundle that exists and
  // is non-empty but predates our publish (the normal state right after a CCF
  // upgrade, or on the very first launch on a host whose builder ran earlier) is
  // WORSE than no bundle: handing it to claude makes the client distrust the very
  // proxy it is being routed through, so every request fails TLS instead of
  // merely losing some other component's CA. Size alone cannot tell the two
  // apart. readFileSync throws when absent, which is the same "use our own CA"
  // answer as an empty, stale, or unreadable bundle — one catch covers them all.
  //
  // ALSO require balanced BEGIN/END markers. Containment cannot see a tear — a
  // bundle whose EARLIER entry lost its END line still literally contains our CA
  // further down, and per the measurement at the publish path above that is the
  // FATAL ordering, leaving the session trusting nothing at all, our own proxy
  // included. So the two checks are complementary: containment catches STALE, the
  // counts catch TORN, neither sees the other's case. Counting two substrings is
  // cheaper than forking openssl and needs no new dependency.
  //
  // Both are pre-flight guards, not proof — only a handshake proves Node verifies
  // with the bundle. They exist to keep a known-bad bundle away from the client.
  try {
    const merged = readFileSync(caTrustBundle, "utf8");
    const begins = (merged.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    const ends = (merged.match(/-----END CERTIFICATE-----/g) || []).length;
    if (begins === ends && merged.includes(readFileSync(caPem, "utf8").trim())) {
      caForClaude = caTrustBundle;
    }
  } catch { /* no usable bundle => our own CA, same as before */ }
  claudeEnv.NODE_EXTRA_CA_CERTS = caForClaude;
  // Exclude localhost from the proxy. Without this, HTTPS_PROXY routes EVERY
  // connection claude makes — including to local services like HTTP/SSE-transport
  // MCP servers (e.g. an MCP on 127.0.0.1) — at the cache-fix proxy, which only
  // knows how to serve api.anthropic.com and 404s the rest. stdio-transport MCPs
  // are unaffected (they're pipes, no network), which is why only network-transport
  // local services break. Merge into any existing NO_PROXY rather than clobber it
  // (a corporate env may already set one). Set both cases to cover libs that read
  // either variable.
  const NO_PROXY_LOCAL = "127.0.0.1,localhost,::1";
  const mergeNoProxy = (existing) => {
    const parts = (existing || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const h of NO_PROXY_LOCAL.split(",")) if (!parts.includes(h)) parts.push(h);
    return parts.join(",");
  };
  const merged = mergeNoProxy(claudeEnv.NO_PROXY || claudeEnv.no_proxy);
  claudeEnv.NO_PROXY = merged;
  claudeEnv.no_proxy = merged;
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
