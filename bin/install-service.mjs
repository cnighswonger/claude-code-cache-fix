// install-service / uninstall-service subcommands.
//
// Detects platform and installs an appropriate service definition for the
// cache-fix proxy:
//   - linux  → systemd user service at ~/.config/systemd/user/cache-fix-proxy.service
//   - darwin → launchd agent at ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
//   - other  → prints manual instructions and exits non-zero
//
// Pure helpers exported for tests; orchestration lives in main().

import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "..", "templates");
const SERVER_PATH = resolve(__dirname, "..", "proxy", "server.mjs");

function getDefaults() {
  return {
    port: process.env.CACHE_FIX_PROXY_PORT || "9801",
    upstream: process.env.CACHE_FIX_PROXY_UPSTREAM || "",
    debug: process.env.CACHE_FIX_DEBUG || "",
    workingDir: resolve(__dirname, ".."),
  };
}

function getPaths(plat = platform()) {
  if (plat === "linux") {
    return {
      kind: "systemd",
      configDir: join(homedir(), ".config", "systemd", "user"),
      configFile: "cache-fix-proxy.service",
      label: "cache-fix-proxy",
    };
  }
  if (plat === "darwin") {
    return {
      kind: "launchd",
      configDir: join(homedir(), "Library", "LaunchAgents"),
      configFile: "com.cnighswonger.cache-fix-proxy.plist",
      label: "com.cnighswonger.cache-fix-proxy",
      logDir: join(homedir(), "Library", "Logs"),
    };
  }
  return { kind: "unsupported", platform: plat };
}

function renderSystemdTemplate(template, vars) {
  const upstreamLine = vars.upstream
    ? `Environment=CACHE_FIX_PROXY_UPSTREAM=${vars.upstream}`
    : "";
  const debugLine = vars.debug
    ? `Environment=CACHE_FIX_DEBUG=${vars.debug}`
    : "";
  // Allow callers to wire a Requires= line (e.g. another service the proxy
  // chains to). Empty string by default so the unit has no extra deps.
  const requiresLine = vars.requires
    ? `Requires=${vars.requires}\nAfter=${vars.requires}`
    : "";
  return template
    .replaceAll("{{NODE}}", vars.node)
    .replaceAll("{{SERVER_PATH}}", vars.serverPath)
    .replaceAll("{{PORT}}", vars.port)
    .replaceAll("{{UPSTREAM_LINE}}", upstreamLine)
    .replaceAll("{{DEBUG_LINE}}", debugLine)
    .replaceAll("{{REQUIRES_LINE}}", requiresLine)
    .replaceAll("{{WORKING_DIR}}", vars.workingDir)
    // Collapse triple newlines from empty optional lines down to single blank
    .replace(/\n\n\n+/g, "\n\n");
}

function renderLaunchdTemplate(template, vars) {
  const upstreamPlist = vars.upstream
    ? `        <key>CACHE_FIX_PROXY_UPSTREAM</key>\n        <string>${vars.upstream}</string>`
    : "";
  const debugPlist = vars.debug
    ? `        <key>CACHE_FIX_DEBUG</key>\n        <string>${vars.debug}</string>`
    : "";
  return template
    .replaceAll("{{NODE}}", vars.node)
    .replaceAll("{{SERVER_PATH}}", vars.serverPath)
    .replaceAll("{{PORT}}", vars.port)
    .replaceAll("{{UPSTREAM_PLIST}}", upstreamPlist)
    .replaceAll("{{DEBUG_PLIST}}", debugPlist)
    .replaceAll("{{WORKING_DIR}}", vars.workingDir)
    .replaceAll("{{LOG_DIR}}", vars.logDir)
    .replace(/\n\n+/g, "\n");
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
    serverPath: SERVER_PATH,
    port: defaults.port,
    upstream: defaults.upstream,
    debug: defaults.debug,
    workingDir: defaults.workingDir,
    requires: "",
  });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(targetPath, rendered);
  return { ok: true, path: targetPath };
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
    serverPath: SERVER_PATH,
    port: defaults.port,
    upstream: defaults.upstream,
    debug: defaults.debug,
    workingDir: defaults.workingDir,
    logDir: paths.logDir,
  });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(targetPath, rendered);
  return { ok: true, path: targetPath };
}

async function uninstallSystemd({ paths } = {}) {
  paths = paths || getPaths("linux");
  const targetPath = join(paths.configDir, paths.configFile);
  if (!(await fileExists(targetPath))) {
    return { ok: false, reason: "not-installed", path: targetPath };
  }
  await unlink(targetPath);
  return { ok: true, path: targetPath };
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

async function install({ force = false } = {}) {
  const paths = getPaths();
  if (paths.kind === "unsupported") {
    process.stderr.write(
      `[install-service] Unsupported platform: ${paths.platform}\n` +
        `Manual install: run \`node ${SERVER_PATH}\` under your platform's service manager.\n`,
    );
    return 1;
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
    process.stdout.write(
      `Wrote systemd unit: ${r.path}\n\n` +
        `Next steps:\n` +
        `  systemctl --user daemon-reload\n` +
        `  systemctl --user enable --now cache-fix-proxy\n` +
        `  loginctl enable-linger ${process.env.USER || "<your-user>"}   # optional: start on boot vs login\n`,
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
        `  launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy\n`,
    );
    return 0;
  }
  return 1;
}

// Translate raw fs errors into operator-friendly one-liners. Returns the
// exit code so callers can pass it straight back.
function reportFsError(prefix, err) {
  const code = err?.code ?? "";
  let hint = "";
  if (code === "ENOENT") hint = "file or directory not found";
  else if (code === "EACCES" || code === "EPERM") hint = "permission denied";
  else if (code === "ENOSPC") hint = "no space left on device";
  else hint = err?.message || String(err);
  process.stderr.write(`[${prefix}] ${hint}${err?.path ? `: ${err.path}` : ""}\n`);
  return 1;
}

async function uninstall() {
  const paths = getPaths();
  if (paths.kind === "unsupported") {
    process.stderr.write(`[uninstall-service] Unsupported platform: ${paths.platform}\n`);
    return 1;
  }
  if (paths.kind === "systemd") {
    // Best-effort stop + disable before removing the file
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
    process.stdout.write(`Removed: ${r.path}\n`);
    return 0;
  }
  if (paths.kind === "launchd") {
    const targetPath = join(paths.configDir, paths.configFile);
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
  getPaths,
  getDefaults,
  installSystemd,
  installLaunchd,
  uninstallSystemd,
  uninstallLaunchd,
  // Orchestration
  install,
  uninstall,
  TEMPLATE_DIR,
  SERVER_PATH,
};
