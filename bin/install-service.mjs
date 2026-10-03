// install-service / uninstall-service subcommands.
//
// Detects platform and installs an appropriate service definition for the
// cache-fix proxy:
//   - linux  → systemd user service at ~/.config/systemd/user/cache-fix-proxy.service
//   - darwin → launchd agent at ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
//   - other  → prints manual instructions and exits non-zero
//
// Pure helpers exported for tests; orchestration lives in main().

import { readFile, writeFile, mkdir, unlink, stat, chmod } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { systemdEscape, xmlEscape } from "../proxy/helpers.mjs";
import { upstreamPointsAtSelf } from "../proxy/server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "..", "templates");
const SERVER_PATH = resolve(__dirname, "..", "proxy", "server.mjs");
// The unit runs `run-service` (holds the port, supervises the proxy), not the bare proxy.
const LAUNCHER_PATH = resolve(__dirname, "claude-via-proxy.mjs");

function getDefaults() {
  const port = validatePort(process.env.CACHE_FIX_PROXY_PORT || "9801");
  // run-service drops HTTPS_PROXY/HTTP_PROXY unless CACHE_FIX_UPSTREAM_PROXY is
  // set, so the install-time hop is captured under that name (proxy/config.mjs
  // precedence) or the service dials direct. A fallback that names the
  // service's own port (a shell wired through this proxy) is no hop: the child
  // refuses it at start and run-service respawns it for ever. HTTP_PROXY is
  // not a fallback: config.mjs reads it for plain-http targets only.
  let upstreamProxy = process.env.CACHE_FIX_UPSTREAM_PROXY || "";
  if (!upstreamProxy) {
    const name = ["HTTPS_PROXY", "https_proxy"].find((k) => process.env[k]);
    upstreamProxy = process.env[name] || "";
    if (upstreamPointsAtSelf(upstreamProxy, port)) {
      process.stderr.write(
        `[install-service] warning: ${name} names this proxy's own port (${port}); not captured as the upstream hop. ` +
          `Set CACHE_FIX_UPSTREAM_PROXY to the real hop and install again.\n`,
      );
      upstreamProxy = "";
    }
  }
  return {
    port,
    upstream: process.env.CACHE_FIX_PROXY_UPSTREAM || "",
    upstreamProxy,
    noProxy: process.env.NO_PROXY || process.env.no_proxy || "",
    fallbackProxies: process.env.CACHE_FIX_FALLBACK_PROXIES || "",
    watchDeployMs: process.env.CACHE_FIX_WATCH_DEPLOY_MS || "5000",
    caFile: process.env.CACHE_FIX_PROXY_CA_FILE || "",
    rejectUnauthorized: process.env.CACHE_FIX_PROXY_REJECT_UNAUTHORIZED || "",
    debug: process.env.CACHE_FIX_DEBUG || "",
    // Hot-reload is opt-in as of v4.0.0 (#196). Capture from env at install
    // time so the operator can bake `CACHE_FIX_HOT_RELOAD=on` into the
    // generated unit/plist via `CACHE_FIX_HOT_RELOAD=on cache-fix-proxy
    // install-service`. Strict "on" match — anything else renders nothing.
    hotReload: process.env.CACHE_FIX_HOT_RELOAD === "on" ? "on" : "",
    // Forward-proxy mode (CONNECT + selective MITM) so the SERVICE runs the
    // proxy in the RC-preserving mode. Baked in at install time via
    // `CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service`. Strict "on"
    // match, same as hotReload. Note: clients still wire HTTPS_PROXY +
    // NODE_EXTRA_CA_CERTS themselves (the service only controls the proxy end).
    forwardProxy: process.env.CACHE_FIX_FORWARD_PROXY === "on" ? "on" : "",
    workingDir: resolve(__dirname, ".."),
  };
}

// Validate that a port string is a plain decimal integer in [1, 65535].
// We render this value into both a systemd Environment= line (safe) AND a
// /bin/sh -c command in the healthcheck oneshot — DANGEROUS without
// validation: shell metacharacters or quotes in a port string would let a
// hostile env var change the executed command. Throw on invalid input so
// callers report it cleanly via reportFsError.
function validatePort(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new InvalidPortError(`port must be a number or numeric string, got ${typeof raw}`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new InvalidPortError(`port must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    throw new InvalidPortError(`port must be in 1..65535 (got ${n})`);
  }
  return s;
}

class InvalidPortError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPortError";
    this.code = "EINVAL";
  }
}

function getPaths(plat = platform()) {
  if (plat === "linux") {
    return {
      kind: "systemd",
      configDir: join(homedir(), ".config", "systemd", "user"),
      configFile: "cache-fix-proxy.service",
      label: "cache-fix-proxy",
      // Healthcheck companion units (oneshot service + timer) for
      // auto-recovery if the proxy is ever stopped from any cause:
      // a crash, an external `systemctl stop`, an OOM, anything.
      // The timer runs the service every 2 minutes; the oneshot does
      // a curl /health probe and `systemctl --user start` if it fails.
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
  }
  if (plat === "darwin") {
    return {
      kind: "launchd",
      configDir: join(homedir(), "Library", "LaunchAgents"),
      configFile: "com.cnighswonger.cache-fix-proxy.plist",
      label: "com.cnighswonger.cache-fix-proxy",
      logDir: join(homedir(), "Library", "Logs"),
      // launchd's KeepAlive (SuccessfulExit=false) restarts the agent on any unclean
      // exit (a handover exits 0), so a separate healthcheck isn't needed on macOS.
    };
  }
  return { kind: "unsupported", platform: plat };
}

// The captured proxy wiring, set values only (an unset one renders no line).
const proxyEnv = (vars) => [
  ["CACHE_FIX_UPSTREAM_PROXY", vars.upstreamProxy],
  ["NO_PROXY", vars.noProxy],
  ["CACHE_FIX_FALLBACK_PROXIES", vars.fallbackProxies],
  ["CACHE_FIX_WATCH_DEPLOY_MS", vars.watchDeployMs],
].filter(([, v]) => v);

function renderSystemdTemplate(template, vars) {
  const upstreamLine = vars.upstream
    ? `Environment=CACHE_FIX_PROXY_UPSTREAM=${systemdEscape(vars.upstream)}`
    : "";
  const caFileLine = vars.caFile
    ? `Environment=CACHE_FIX_PROXY_CA_FILE=${systemdEscape(vars.caFile)}`
    : "";
  const rejectUnauthorizedLine = vars.rejectUnauthorized
    ? `Environment=CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=${systemdEscape(vars.rejectUnauthorized)}`
    : "";
  const debugLine = vars.debug
    ? `Environment=CACHE_FIX_DEBUG=${systemdEscape(vars.debug)}`
    : "";
  const hotReloadLine = vars.hotReload
    ? `Environment=CACHE_FIX_HOT_RELOAD=${vars.hotReload}`
    : "";
  const forwardProxyLine = vars.forwardProxy
    ? `Environment=CACHE_FIX_FORWARD_PROXY=${vars.forwardProxy}`
    : "";
  // Allow callers to wire a Requires= line (e.g. another service the proxy
  // chains to). Empty string by default so the unit has no extra deps.
  const requiresLine = vars.requires
    ? `Requires=${vars.requires}\nAfter=${vars.requires}`
    : "";
  const proxyEnvLines = proxyEnv(vars)
    .map(([k, v]) => `Environment=${k}=${systemdEscape(v)}`).join("\n");
  return template
    .replaceAll("{{NODE}}", vars.node)
    .replaceAll("{{LAUNCHER_PATH}}", vars.launcherPath)
    .replaceAll("{{PORT}}", vars.port)
    // A function replacement: a proxy URL's credentials may hold `$&`, `$$`.
    .replaceAll("{{PROXY_ENV_LINES}}", () => proxyEnvLines)
    .replaceAll("{{UPSTREAM_LINE}}", upstreamLine)
    .replaceAll("{{CA_FILE_LINE}}", caFileLine)
    .replaceAll("{{REJECT_UNAUTHORIZED_LINE}}", rejectUnauthorizedLine)
    .replaceAll("{{DEBUG_LINE}}", debugLine)
    .replaceAll("{{HOT_RELOAD_LINE}}", hotReloadLine)
    .replaceAll("{{FORWARD_PROXY_LINE}}", forwardProxyLine)
    .replaceAll("{{REQUIRES_LINE}}", requiresLine)
    .replaceAll("{{WORKING_DIR}}", vars.workingDir)
    // Collapse triple newlines from empty optional lines down to single blank
    .replace(/\n\n\n+/g, "\n\n");
}

function renderLaunchdTemplate(template, vars) {
  const upstreamPlist = vars.upstream
    ? `        <key>CACHE_FIX_PROXY_UPSTREAM</key>\n        <string>${xmlEscape(vars.upstream)}</string>`
    : "";
  const caFilePlist = vars.caFile
    ? `        <key>CACHE_FIX_PROXY_CA_FILE</key>\n        <string>${xmlEscape(vars.caFile)}</string>`
    : "";
  const rejectUnauthorizedPlist = vars.rejectUnauthorized
    ? `        <key>CACHE_FIX_PROXY_REJECT_UNAUTHORIZED</key>\n        <string>${xmlEscape(vars.rejectUnauthorized)}</string>`
    : "";
  const debugPlist = vars.debug
    ? `        <key>CACHE_FIX_DEBUG</key>\n        <string>${xmlEscape(vars.debug)}</string>`
    : "";
  const hotReloadPlist = vars.hotReload
    ? `        <key>CACHE_FIX_HOT_RELOAD</key>\n        <string>${vars.hotReload}</string>`
    : "";
  const forwardProxyPlist = vars.forwardProxy
    ? `        <key>CACHE_FIX_FORWARD_PROXY</key>\n        <string>${vars.forwardProxy}</string>`
    : "";
  const proxyEnvPlist = proxyEnv(vars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${xmlEscape(v)}</string>`).join("\n");
  return template
    .replaceAll("{{NODE}}", vars.node)
    .replaceAll("{{LAUNCHER_PATH}}", vars.launcherPath)
    .replaceAll("{{PORT}}", vars.port)
    .replaceAll("{{PROXY_ENV_PLIST}}", () => proxyEnvPlist)
    .replaceAll("{{UPSTREAM_PLIST}}", upstreamPlist)
    .replaceAll("{{CA_FILE_PLIST}}", caFilePlist)
    .replaceAll("{{REJECT_UNAUTHORIZED_PLIST}}", rejectUnauthorizedPlist)
    .replaceAll("{{DEBUG_PLIST}}", debugPlist)
    .replaceAll("{{HOT_RELOAD_PLIST}}", hotReloadPlist)
    .replaceAll("{{FORWARD_PROXY_PLIST}}", forwardProxyPlist)
    .replaceAll("{{WORKING_DIR}}", vars.workingDir)
    .replaceAll("{{LOG_DIR}}", vars.logDir)
    .replace(/\n\n+/g, "\n");
}

function renderHealthcheckServiceTemplate(template, vars) {
  return template.replaceAll("{{PORT}}", vars.port);
}

function renderHealthcheckTimerTemplate(template) {
  // No placeholders today, but keep the function for symmetry + future expansion.
  return template;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("close", (code) => resolveP(code ?? 0));
    p.on("error", () => resolveP(127));
  });
}

// The unit / plist carries the install-time HTTPS_PROXY, credentials included. writeFile's mode
// applies only when it creates the file, so a file --force overwrites is made 0600 BEFORE the write.
const writePrivate = async (path, text) => {
  await chmod(path, 0o600).catch((e) => { if (e.code !== "ENOENT") throw e; });
  await writeFile(path, text, { mode: 0o600 });
};

async function installSystemd({ paths, defaults, force = false } = {}) {
  paths = paths || getPaths("linux");
  defaults = defaults || getDefaults();
  const targetPath = join(paths.configDir, paths.configFile);
  if ((await fileExists(targetPath)) && !force) {
    return {
      ok: false,
      reason: "already-installed",
      path: targetPath,
      hint: "Re-run with --force to overwrite, or `cache-fix-proxy uninstall-service` first.",
    };
  }
  const template = await readFile(
    join(TEMPLATE_DIR, "cache-fix-proxy.service.template"),
    "utf-8",
  );
  const rendered = renderSystemdTemplate(template, {
    node: process.execPath,
    launcherPath: LAUNCHER_PATH,
    requires: "",
    ...defaults,
  });
  await mkdir(paths.configDir, { recursive: true });
  await writePrivate(targetPath, rendered);

  // Healthcheck companion: oneshot service + timer. Auto-recovery from any
  // proxy stop, including clean stops where Restart=on-failure does NOT fire
  // (see incident analysis: 2026-04-25 01:46:53 UTC — proxy was stopped by
  // an unidentified caller during the Anthropic outage and stayed down for
  // 10 hours because no auto-recovery existed).
  //
  // If the healthcheck install fails (template missing, write error, etc.),
  // roll back the main unit so the user isn't left in a half-installed
  // state. Without rollback the proxy unit would exist but the auto-recovery
  // story we just promised in the install message would be incomplete.
  let healthcheckPaths;
  try {
    healthcheckPaths = await installSystemdHealthcheck({ paths, defaults, force });
  } catch (err) {
    try {
      await unlink(targetPath);
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }

  return {
    ok: true,
    path: targetPath,
    healthcheck: healthcheckPaths,
  };
}

async function installSystemdHealthcheck({ paths, defaults, force = false } = {}) {
  paths = paths || getPaths("linux");
  defaults = defaults || getDefaults();
  const servicePath = join(paths.configDir, paths.healthcheckServiceFile);
  const timerPath = join(paths.configDir, paths.healthcheckTimerFile);

  // Symmetric existence check: if EITHER the service file OR the timer file
  // already exists, refuse to overwrite without force. Catches both the
  // "service exists, timer missing" and "timer exists, service missing"
  // half-states — those are the artifacts most likely to need explicit
  // operator review (e.g. a previous install crashed mid-write, or the
  // operator has hand-edited one of the two).
  const serviceExists = await fileExists(servicePath);
  const timerExists = await fileExists(timerPath);
  if ((serviceExists || timerExists) && !force) {
    const which = serviceExists && timerExists
      ? "both files"
      : serviceExists
        ? "service file"
        : "timer file";
    return {
      installed: false,
      reason: "already-installed",
      servicePath,
      timerPath,
      hint: `${which} already present. Re-run with --force to overwrite, or \`cache-fix-proxy uninstall-service\` first.`,
    };
  }

  const serviceTpl = await readFile(
    join(TEMPLATE_DIR, "cache-fix-proxy-healthcheck.service.template"),
    "utf-8",
  );
  const timerTpl = await readFile(
    join(TEMPLATE_DIR, "cache-fix-proxy-healthcheck.timer.template"),
    "utf-8",
  );
  await writeFile(servicePath, renderHealthcheckServiceTemplate(serviceTpl, { port: defaults.port }));
  await writeFile(timerPath, renderHealthcheckTimerTemplate(timerTpl));
  return { installed: true, servicePath, timerPath };
}

async function installLaunchd({ paths, defaults, force = false } = {}) {
  paths = paths || getPaths("darwin");
  defaults = defaults || getDefaults();
  const targetPath = join(paths.configDir, paths.configFile);
  if ((await fileExists(targetPath)) && !force) {
    return {
      ok: false,
      reason: "already-installed",
      path: targetPath,
      hint: "Re-run with --force to overwrite, or `cache-fix-proxy uninstall-service` first.",
    };
  }
  const template = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const rendered = renderLaunchdTemplate(template, {
    node: process.execPath,
    launcherPath: LAUNCHER_PATH,
    logDir: paths.logDir,
    ...defaults,
  });
  await mkdir(paths.configDir, { recursive: true });
  await writePrivate(targetPath, rendered);
  return { ok: true, path: targetPath };
}

async function uninstallSystemd({ paths } = {}) {
  paths = paths || getPaths("linux");
  const targetPath = join(paths.configDir, paths.configFile);
  if (!(await fileExists(targetPath))) {
    return { ok: false, reason: "not-installed", path: targetPath };
  }
  await unlink(targetPath);
  // Also remove the healthcheck companion if it exists. Best-effort —
  // missing files are not an error here.
  const healthcheckRemoved = await uninstallSystemdHealthcheck({ paths });
  return { ok: true, path: targetPath, healthcheck: healthcheckRemoved };
}

async function uninstallSystemdHealthcheck({ paths } = {}) {
  paths = paths || getPaths("linux");
  const servicePath = join(paths.configDir, paths.healthcheckServiceFile);
  const timerPath = join(paths.configDir, paths.healthcheckTimerFile);
  let removed = 0;
  for (const p of [timerPath, servicePath]) {
    if (await fileExists(p)) {
      try {
        await unlink(p);
        removed++;
      } catch {
        /* best-effort */
      }
    }
  }
  return { removed, servicePath, timerPath };
}

async function uninstallLaunchd({ paths } = {}) {
  paths = paths || getPaths("darwin");
  const targetPath = join(paths.configDir, paths.configFile);
  if (!(await fileExists(targetPath))) {
    return { ok: false, reason: "not-installed", path: targetPath };
  }
  await unlink(targetPath);
  return { ok: true, path: targetPath };
}

// A changed unit never reaches the serving lineage: start finds a holder on the
// same proxy/ and bin/ trees and exits as surplus. Only an uninstall ends the lineage.
const CHANGE_SETTINGS =
  "To change an installed service's settings, run `cache-fix-proxy uninstall-service`, then install-service " +
  "with the new settings and the steps above; the uninstall ends the running proxy, so this one cuts.\n";

async function install({ force = false, plat } = {}) {
  const paths = getPaths(plat);
  if (paths.kind === "unsupported") {
    let port, upstreamProxy;
    try {
      ({ port, upstreamProxy } = getDefaults());
    } catch (err) {
      return reportFsError("install-service", err);
    }
    // run-service exits 2 without a port, and drops an ambient HTTPS_PROXY unless the hop is named.
    // The line must run as printed: the hop only when captured, every value single-quoted for POSIX sh.
    const shq = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const hop = upstreamProxy ? ` CACHE_FIX_UPSTREAM_PROXY=${shq(upstreamProxy)}` : "";
    process.stderr.write(
      `[install-service] Unsupported platform: ${paths.platform}\n` +
        `Manual install: run \`CACHE_FIX_PROXY_PORT=${port}${hop} ${shq(process.execPath)} ${shq(LAUNCHER_PATH)} run-service\` under your platform's service manager.\n`,
    );
    return 1;
  }
  // run-service finds the process holding its port with lsof; without it a
  // takeover exits 0 and `start` silently does nothing.
  if (spawnSync("lsof", ["-v"], { stdio: "ignore", timeout: 5000 }).error) {
    process.stderr.write(
      "[install-service] warning: lsof could not be run (is it on PATH?); run-service needs it to " +
        "find the process holding its port, so install lsof or a takeover will do nothing.\n",
    );
  }
  if (paths.kind === "systemd") {
    let r;
    try {
      r = await installSystemd({ paths, force });
    } catch (err) {
      return reportFsError("install-service", err);
    }
    if (!r.ok) {
      process.stderr.write(`[install-service] ${r.reason}: ${r.path}\n`);
      if (r.hint) process.stderr.write(`  ${r.hint}\n`);
      return 1;
    }
    const hcLines =
      r.healthcheck?.installed
        ? `Wrote healthcheck companion: ${r.healthcheck.servicePath}\n` +
          `Wrote healthcheck timer:     ${r.healthcheck.timerPath}\n\n`
        : r.healthcheck?.reason === "already-installed"
          ? `Healthcheck companion already installed (use --force to overwrite).\n\n`
          : "";
    process.stdout.write(
      `Wrote systemd unit: ${r.path}\n` +
        hcLines +
        `Next steps:\n` +
        `  systemctl --user daemon-reload\n` +
        `  systemctl --user enable --now cache-fix-proxy\n` +
        `  systemctl --user enable --now cache-fix-proxy-healthcheck.timer  # auto-recovery if proxy is ever stopped\n` +
        `  loginctl enable-linger ${process.env.USER || "<your-user>"}      # optional: start on boot vs login\n\n` +
        `After a package update, hand over instead of restarting (a handover keeps the port accepting throughout; a restart refuses connections for a moment):\n` +
        `  systemctl --user reload cache-fix-proxy || systemctl --user start cache-fix-proxy\n` +
        `Why both: after the first reload the serving holder is a successor the unit no longer tracks, so reload alone works once; start hands over to it, or does nothing when the proxy/ and bin/ trees are the same.\n` +
        CHANGE_SETTINGS +
        `Needs lsof on PATH: run-service uses it to find the process holding the port.\n`,
    );
    return 0;
  }
  if (paths.kind === "launchd") {
    let r;
    try {
      r = await installLaunchd({ paths, force });
    } catch (err) {
      return reportFsError("install-service", err);
    }
    if (!r.ok) {
      process.stderr.write(`[install-service] ${r.reason}: ${r.path}\n`);
      if (r.hint) process.stderr.write(`  ${r.hint}\n`);
      return 1;
    }
    process.stdout.write(
      `Wrote launchd plist: ${r.path}\n\n` +
        `Next steps:\n` +
        `  launchctl bootstrap gui/$(id -u) ${r.path}\n` +
        `  launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy\n` +
        `  launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy\n\n` +
        `After a package update, hand over instead of restarting (a handover keeps the port accepting throughout; a restart refuses connections for a moment):\n` +
        `  launchctl kill SIGUSR2 gui/$(id -u)/com.cnighswonger.cache-fix-proxy || launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy\n` +
        `Why both: after the first handover the serving holder is a successor the job no longer tracks, so the signal works once; kickstart (no -k) hands over to it, or does nothing when the proxy/ and bin/ trees are the same.\n` +
        CHANGE_SETTINGS +
        `Needs lsof on PATH: run-service uses it to find the process holding the port.\n`,
    );
    return 0;
  }
  return 1;
}

// Translate raw fs / validation errors into operator-friendly one-liners.
// Returns the exit code so callers can pass it straight back.
function reportFsError(prefix, err) {
  const code = err?.code ?? "";
  let hint = "";
  if (err?.name === "InvalidPortError") hint = err.message;
  else if (code === "ENOENT") hint = "file or directory not found";
  else if (code === "EACCES" || code === "EPERM") hint = "permission denied";
  else if (code === "ENOSPC") hint = "no space left on device";
  else hint = err?.message || String(err);
  process.stderr.write(`[${prefix}] ${hint}${err?.path ? `: ${err.path}` : ""}\n`);
  return 1;
}

// Any address: the bind is set by the unit, a drop-in or the manager's environment, and only the
// command line says whose a listener is. One whose ps cannot be read is skipped.
const OURS = /\brun-service\b|proxy\/server\.mjs|gap-relay\.mjs/;
const listeners = (port) => {
  const r = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
  const ours = (pid) => OURS.test(spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf-8", timeout: 5000 }).stdout || "");
  return { error: r.error, pids: (r.stdout || "").split("\n").filter(Boolean).filter(ours) };
};

// SIGHUP every process of ours listening on the installed unit's port. After the first
// reload the serving lineage is a detached successor the supervisor no longer
// tracks (launchd: the job has no PID), so only the port finds it. The holder,
// the proxy child and a standby all hold that socket and all release on SIGHUP;
// stop's SIGTERM would leave a standby carrying it. The holder keeps the socket
// while its child drains, and a reinstall started inside that window exits as
// surplus and leaves nothing serving, so wait (up to drainMs) until none of ours holds the port.
async function endLineage(paths, drainMs) {
  const unitText = await readFile(join(paths.configDir, paths.configFile), "utf-8").catch(() => null);
  if (unitText === null) return; // nothing installed, nothing to signal
  const port = /CACHE_FIX_PROXY_PORT(?:=|<\/key>\s*<string>)(\d+)/.exec(unitText)?.[1] ?? "9801"; // the proxy's default, not getDefaults(): it throws on a bad env
  let { error, pids } = listeners(port);
  if (error) {
    const lead = `[uninstall-service] warning: lsof could not be run (is it on PATH?), so the proxy on port ${port} could not be found; `;
    if (paths.kind === "systemd") {
      process.stderr.write(lead + "the unit's processes are asked to release by SIGHUP instead, and without lsof nothing waits for the port to free.\n");
      await runCmd("systemctl", ["--user", "kill", "-s", "HUP", "cache-fix-proxy"]);
    } else {
      process.stderr.write(lead + "the port may stay held.\n");
    }
    return;
  }
  for (const pid of pids) {
    try { process.kill(Number(pid), "SIGHUP"); } catch { /* already gone */ }
  }
  for (const deadline = Date.now() + drainMs; pids.length && Date.now() < deadline;) {
    await sleep(100);
    const r = listeners(port);
    if (!r.error) pids = r.pids; // a failed listing (its 5 s timeout) leaves the port counted as held
  }
  if (pids.length) {
    process.stderr.write(`[uninstall-service] warning: port ${port} is still held by pid ${pids.join(", ")} after ${drainMs / 1000} s; continuing.\n`);
  }
}

async function uninstall({ plat, drainMs = 10000 } = {}) {
  const paths = getPaths(plat);
  if (paths.kind === "unsupported") {
    process.stderr.write(`[uninstall-service] Unsupported platform: ${paths.platform}\n`);
    return 1;
  }
  if (paths.kind === "systemd") {
    // Best-effort stop + disable for the healthcheck companion FIRST so it
    // doesn't immediately restart the proxy we're about to stop.
    await runCmd("systemctl", ["--user", "stop", "cache-fix-proxy-healthcheck.timer"]);
    await runCmd("systemctl", ["--user", "disable", "cache-fix-proxy-healthcheck.timer"]);
    await endLineage(paths, drainMs);
    // Then stop + disable the main service.
    await runCmd("systemctl", ["--user", "stop", "cache-fix-proxy"]);
    await runCmd("systemctl", ["--user", "disable", "cache-fix-proxy"]);
    let r;
    try {
      r = await uninstallSystemd({ paths });
    } catch (err) {
      return reportFsError("uninstall-service", err);
    }
    if (!r.ok) {
      process.stderr.write(`[uninstall-service] ${r.reason}: ${r.path}\n`);
      return 1;
    }
    await runCmd("systemctl", ["--user", "daemon-reload"]);
    const hcMsg =
      r.healthcheck?.removed > 0
        ? ` (+ ${r.healthcheck.removed} healthcheck file${r.healthcheck.removed === 1 ? "" : "s"})`
        : "";
    process.stdout.write(`Removed: ${r.path}${hcMsg}\n`);
    return 0;
  }
  if (paths.kind === "launchd") {
    const targetPath = join(paths.configDir, paths.configFile);
    await endLineage(paths, drainMs);
    await runCmd("launchctl", ["bootout", `gui/${process.getuid()}`, targetPath]);
    let r;
    try {
      r = await uninstallLaunchd({ paths });
    } catch (err) {
      return reportFsError("uninstall-service", err);
    }
    if (!r.ok) {
      process.stderr.write(`[uninstall-service] ${r.reason}: ${r.path}\n`);
      return 1;
    }
    process.stdout.write(`Removed: ${r.path}\n`);
    return 0;
  }
  return 1;
}

export {
  // Pure helpers (test surface)
  renderSystemdTemplate,
  renderLaunchdTemplate,
  renderHealthcheckServiceTemplate,
  renderHealthcheckTimerTemplate,
  getPaths,
  getDefaults,
  validatePort,
  InvalidPortError,
  installSystemd,
  installSystemdHealthcheck,
  installLaunchd,
  uninstallSystemd,
  uninstallSystemdHealthcheck,
  uninstallLaunchd,
  // Orchestration
  install,
  uninstall,
  TEMPLATE_DIR,
  SERVER_PATH,
};
