import { createServer } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, stat, chmod, copyFile, symlink } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
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
  install,
  uninstall,
  TEMPLATE_DIR,
} from "../bin/install-service.mjs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "claude-via-proxy.mjs");

async function newTmp() {
  return mkdtemp(join(tmpdir(), "install-service-test-"));
}

const sampleVars = {
  node: "/usr/local/bin/node",
  launcherPath: "/opt/cache-fix/bin/claude-via-proxy.mjs",
  port: "9801",
  upstream: "",
  caFile: "",
  rejectUnauthorized: "",
  debug: "",
  workingDir: "/opt/cache-fix",
  requires: "",
};

// --- Template rendering ---

test("renderSystemdTemplate: substitutes core fields", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  assert.ok(out.includes("ExecStart=/usr/local/bin/node /opt/cache-fix/bin/claude-via-proxy.mjs run-service"));
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_PORT=9801"));
  assert.ok(out.includes("WorkingDirectory=/opt/cache-fix"));
  assert.ok(out.includes("WantedBy=default.target"));
});

test("renderSystemdTemplate: omits empty optional Environment lines", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  assert.ok(!out.includes("CACHE_FIX_PROXY_UPSTREAM"));
  assert.ok(!out.includes("CACHE_FIX_PROXY_CA_FILE"));
  assert.ok(!out.includes("CACHE_FIX_PROXY_REJECT_UNAUTHORIZED"));
  assert.ok(!out.includes("CACHE_FIX_DEBUG"));
  // No leftover empty placeholders
  assert.ok(!out.includes("{{"));
  assert.ok(!out.includes("}}"));
});

test("renderSystemdTemplate: includes UPSTREAM, CA_FILE, REJECT_UNAUTHORIZED and DEBUG when set", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, {
    ...sampleVars,
    upstream: "http://127.0.0.1:8080",
    caFile: "/etc/ssl/ca \" file.pem", // with space and "
    rejectUnauthorized: "0",
    debug: "1",
  });
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_UPSTREAM=http://127.0.0.1:8080"));
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_CA_FILE=\"/etc/ssl/ca \\\" file.pem\""));
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0"));
  assert.ok(out.includes("Environment=CACHE_FIX_DEBUG=1"));
});

test("renderSystemdTemplate: requires line wires both Requires and After", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, { ...sampleVars, requires: "llm-relay.service" });
  assert.ok(out.includes("Requires=llm-relay.service"));
  assert.ok(out.includes("After=llm-relay.service"));
});

// PR #189 regression — bare % triggers systemd specifier expansion and
// silently drops the variable. Verified 2026-06-07 against `systemctl --user`:
// the unit line `Environment=X=a%%20b` delivers `a%20b` to the spawned
// process, while `Environment=X=a%20b` (unescaped) delivers an empty string
// after a "Failed to resolve specifiers ... Invalid slot" log entry.
test("renderSystemdTemplate: bare % in upstream URL is escaped to %% (PR #189)", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, {
    ...sampleVars,
    upstream: "http://10.0.0.1:8080/path%20with%20encoded",
  });
  assert.ok(
    out.includes("Environment=CACHE_FIX_PROXY_UPSTREAM=http://10.0.0.1:8080/path%%20with%%20encoded"),
    "bare % must be escaped to %% in the rendered Environment= line",
  );
  assert.ok(!/=http:\/\/10\.0\.0\.1:8080\/path%20/.test(out), "no unescaped %20 should appear");
});

// PR #189 regression — bare \ triggers systemd C-string unescape and
// produces a control byte. Verified 2026-06-07: `Environment=X=/path/with\backslash.pem`
// delivers /path/with<0x08>ackslash.pem to the process; the quoted form
// `Environment=X="/path/with\\backslash.pem"` delivers the literal value.
test("renderSystemdTemplate: backslash in CA file path is escaped to \\\\ (PR #189)", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, {
    ...sampleVars,
    caFile: "/etc/ssl/with\\backslash.pem",
  });
  assert.ok(
    out.includes('Environment=CACHE_FIX_PROXY_CA_FILE="/etc/ssl/with\\\\backslash.pem"'),
    "bare \\ must be escaped to \\\\ inside the quoted Environment= value",
  );
});

test("renderLaunchdTemplate: substitutes core fields and renders valid plist", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    logDir: "/Users/test/Library/Logs",
  });
  assert.ok(out.includes("<string>com.cnighswonger.cache-fix-proxy</string>"));
  assert.ok(out.includes("<string>/usr/local/bin/node</string>"));
  assert.ok(out.includes("<string>/opt/cache-fix/bin/claude-via-proxy.mjs</string>\n        <string>run-service</string>"));
  assert.ok(out.includes("<string>9801</string>"));
  assert.ok(out.includes("<string>/Users/test/Library/Logs/cache-fix-proxy.log</string>"));
  assert.ok(!out.includes("{{"));
});

test("renderLaunchdTemplate: includes UPSTREAM, CA_FILE, REJECT_UNAUTHORIZED and DEBUG when set", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    upstream: "http://127.0.0.1:8080",
    caFile: "/etc/ssl/ca & < > ' \" file.pem", // with XLM spec symbols
    rejectUnauthorized: "0",
    debug: "1",
    logDir: "/Users/test/Library/Logs",
  });
  assert.ok(out.includes("<string>com.cnighswonger.cache-fix-proxy</string>"));
  assert.ok(out.includes("<string>/usr/local/bin/node</string>"));
  assert.ok(out.includes("<string>/opt/cache-fix/bin/claude-via-proxy.mjs</string>"));
  assert.ok(out.includes("<string>9801</string>"));
  assert.ok(out.includes("<string>http://127.0.0.1:8080</string>"));
  assert.ok(out.includes("<string>/etc/ssl/ca &amp; &lt; &gt; &apos; &quot; file.pem</string>"));
  assert.ok(out.includes("<string>0</string>"));
  assert.ok(out.includes("<string>/Users/test/Library/Logs/cache-fix-proxy.log</string>"));
  assert.ok(!out.includes("{{"));
});

test("renderLaunchdTemplate: omits CACHE_FIX_PROXY_UPSTREAM/CA_FILE/REJECT_UNAUTHORIZED/DEBUG when not set", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    logDir: "/tmp/logs",
  });
  assert.ok(!out.includes("CACHE_FIX_PROXY_UPSTREAM"));
  assert.ok(!out.includes("CACHE_FIX_PROXY_CA_FILE"));
  assert.ok(!out.includes("CACHE_FIX_PROXY_REJECT_UNAUTHORIZED"));
  assert.ok(!out.includes("CACHE_FIX_DEBUG"));
});

// #196 / #198: CACHE_FIX_HOT_RELOAD env-capture rendering. install-service
// reads CACHE_FIX_HOT_RELOAD from the env at install time and bakes it into
// the generated unit/plist when set to the literal "on", omits the slot
// entirely otherwise. Matches the existing PORT/UPSTREAM/DEBUG precedent.

test("renderSystemdTemplate: omits CACHE_FIX_HOT_RELOAD when not set", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  assert.ok(!out.includes("CACHE_FIX_HOT_RELOAD"));
});

test("renderSystemdTemplate: includes CACHE_FIX_HOT_RELOAD=on when set", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, { ...sampleVars, hotReload: "on" });
  assert.ok(out.includes("Environment=CACHE_FIX_HOT_RELOAD=on"));
});

test("renderLaunchdTemplate: omits CACHE_FIX_HOT_RELOAD when not set", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, { ...sampleVars, logDir: "/tmp/logs" });
  assert.ok(!out.includes("CACHE_FIX_HOT_RELOAD"));
});

test("renderLaunchdTemplate: includes CACHE_FIX_HOT_RELOAD=on when set", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    logDir: "/tmp/logs",
    hotReload: "on",
  });
  assert.ok(out.includes("<key>CACHE_FIX_HOT_RELOAD</key>"));
  assert.ok(out.includes("<string>on</string>"));
  // Plist must remain well-formed: no stray template tags.
  assert.ok(!out.includes("{{"));
});

// --- Port validation (shell-injection guard) ---

test("validatePort: accepts valid numeric strings", () => {
  assert.equal(validatePort("9801"), "9801");
  assert.equal(validatePort("1"), "1");
  assert.equal(validatePort("65535"), "65535");
  assert.equal(validatePort(8080), "8080");
  assert.equal(validatePort("  9801  "), "9801");
});

test("validatePort: rejects shell metacharacters and other hostile input", () => {
  const hostile = [
    "9801; rm -rf ~",
    "9801'; echo pwned; '",
    "9801$(curl evil.example)",
    "9801`whoami`",
    "9801 || true",
    "9801\necho",  // embedded newline + content
    "9801 9802",
    "abc",
    "0x1eAB",
    "",
    "  ",
    "9801.0",
  ];
  for (const v of hostile) {
    assert.throws(() => validatePort(v), InvalidPortError, `should reject ${JSON.stringify(v)}`);
  }
});

test("validatePort: tolerates surrounding whitespace (env var hygiene)", () => {
  // Trailing newline / leading space from accidental shell quoting in env
  // vars is common and benign — trim before validating, accept what's left.
  assert.equal(validatePort("9801\n"), "9801");
  assert.equal(validatePort(" 9801"), "9801");
  assert.equal(validatePort("\t9801\t"), "9801");
});

test("validatePort: rejects out-of-range ports", () => {
  assert.throws(() => validatePort("0"), InvalidPortError);
  assert.throws(() => validatePort("65536"), InvalidPortError);
  assert.throws(() => validatePort("99999"), InvalidPortError);
});

test("validatePort: rejects non-string-non-number types", () => {
  assert.throws(() => validatePort(null), InvalidPortError);
  assert.throws(() => validatePort(undefined), InvalidPortError);
  assert.throws(() => validatePort({}), InvalidPortError);
  assert.throws(() => validatePort([]), InvalidPortError);
});

// --- Healthcheck template rendering ---

test("renderHealthcheckServiceTemplate: substitutes PORT", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "cache-fix-proxy-healthcheck.service.template"),
    "utf-8",
  );
  const out = renderHealthcheckServiceTemplate(tpl, { port: "9988" });
  assert.ok(out.includes("http://127.0.0.1:9988/health"));
  assert.ok(out.includes("systemctl --user start cache-fix-proxy.service"));
  assert.ok(out.includes("Type=oneshot"));
  assert.ok(!out.includes("{{"));
});

test("renderHealthcheckTimerTemplate: returns template unchanged (no placeholders today)", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "cache-fix-proxy-healthcheck.timer.template"),
    "utf-8",
  );
  const out = renderHealthcheckTimerTemplate(tpl);
  assert.equal(out, tpl);
  assert.ok(out.includes("OnUnitActiveSec=2min"));
  assert.ok(out.includes("Unit=cache-fix-proxy-healthcheck.service"));
  assert.ok(out.includes("WantedBy=timers.target"));
});

// --- Platform detection ---

test("getPaths: linux returns systemd shape", () => {
  const p = getPaths("linux");
  assert.equal(p.kind, "systemd");
  assert.ok(p.configDir.endsWith(".config/systemd/user"));
  assert.equal(p.configFile, "cache-fix-proxy.service");
  assert.equal(p.healthcheckServiceFile, "cache-fix-proxy-healthcheck.service");
  assert.equal(p.healthcheckTimerFile, "cache-fix-proxy-healthcheck.timer");
});

test("getPaths: darwin returns launchd shape", () => {
  const p = getPaths("darwin");
  assert.equal(p.kind, "launchd");
  assert.ok(p.configDir.endsWith("Library/LaunchAgents"));
  assert.equal(p.configFile, "com.cnighswonger.cache-fix-proxy.plist");
  assert.ok(p.logDir);
});

test("getPaths: unsupported platform returns kind=unsupported", () => {
  const p = getPaths("freebsd");
  assert.equal(p.kind, "unsupported");
  assert.equal(p.platform, "freebsd");
});

// --- installSystemd / uninstallSystemd round-trip ---

test("installSystemd: writes file to configDir; uninstall removes it", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r1 = await installSystemd({ paths, defaults: { port: "9999", upstream: "", caFile: "/etc/ssl/ca.pem", rejectUnauthorized: "0", debug: "", workingDir: "/tmp" } });
    assert.ok(r1.ok);
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_PORT=9999"));
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_CA_FILE=/etc/ssl/ca.pem"));
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0"));

    const r2 = await uninstallSystemd({ paths });
    assert.ok(r2.ok);
    const files = await readdir(dir);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// #196 / #198 end-to-end: installSystemd / installLaunchd must thread the
// hotReload field through to the on-disk unit / plist. Earlier rounds of
// this change tested only the renderer helpers and missed this path.

test("installSystemd: hotReload from defaults reaches the written file", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r = await installSystemd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", hotReload: "on", workingDir: "/tmp" },
    });
    assert.ok(r.ok);
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(
      onDisk.includes("Environment=CACHE_FIX_HOT_RELOAD=on"),
      "installSystemd must write the CACHE_FIX_HOT_RELOAD=on Environment= line when defaults.hotReload is 'on'",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemd: hotReload empty/unset omits the line from the written file", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r = await installSystemd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", hotReload: "", workingDir: "/tmp" },
    });
    assert.ok(r.ok);
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(
      !onDisk.includes("CACHE_FIX_HOT_RELOAD"),
      "installSystemd must NOT write a CACHE_FIX_HOT_RELOAD line when defaults.hotReload is empty",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installLaunchd: hotReload from defaults reaches the written plist", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "launchd",
      configDir: dir,
      configFile: "com.cnighswonger.cache-fix-proxy.plist",
      label: "com.cnighswonger.cache-fix-proxy",
      logDir: "/tmp/logs",
    };
    const r = await installLaunchd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", hotReload: "on", workingDir: "/tmp" },
    });
    assert.ok(r.ok);
    const onDisk = await readFile(join(dir, "com.cnighswonger.cache-fix-proxy.plist"), "utf-8");
    assert.ok(
      onDisk.includes("<key>CACHE_FIX_HOT_RELOAD</key>"),
      "installLaunchd must write the CACHE_FIX_HOT_RELOAD key into the plist when defaults.hotReload is 'on'",
    );
    assert.ok(onDisk.includes("<string>on</string>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installLaunchd: hotReload empty/unset omits the key from the written plist", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "launchd",
      configDir: dir,
      configFile: "com.cnighswonger.cache-fix-proxy.plist",
      label: "com.cnighswonger.cache-fix-proxy",
      logDir: "/tmp/logs",
    };
    const r = await installLaunchd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", hotReload: "", workingDir: "/tmp" },
    });
    assert.ok(r.ok);
    const onDisk = await readFile(join(dir, "com.cnighswonger.cache-fix-proxy.plist"), "utf-8");
    assert.ok(
      !onDisk.includes("CACHE_FIX_HOT_RELOAD"),
      "installLaunchd must NOT write a CACHE_FIX_HOT_RELOAD key when defaults.hotReload is empty",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemd: refuses overwrite without force", async () => {
  const dir = await newTmp();
  try {
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service", healthcheckServiceFile: "cache-fix-proxy-healthcheck.service", healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer" };
    await installSystemd({ paths, defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" } });
    const r2 = await installSystemd({ paths, defaults: { port: "9999", upstream: "", debug: "", workingDir: "/tmp" } });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "already-installed");
    // File should NOT be modified
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_PORT=9801"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemd: --force overwrites existing", async () => {
  const dir = await newTmp();
  try {
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service", healthcheckServiceFile: "cache-fix-proxy-healthcheck.service", healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer" };
    await installSystemd({ paths, defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" } });
    const r2 = await installSystemd({
      paths,
      defaults: { port: "9999", upstream: "", debug: "", workingDir: "/tmp" },
      force: true,
    });
    assert.ok(r2.ok);
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_PORT=9999"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The unit and plist carry the install-time HTTPS_PROXY, credentials included, and
// writeFile's mode applies only when it creates the file: --force over a 0644 one keeps 0644.
test("installSystemd / installLaunchd: the file ends 0600, fresh or --force over an existing 0644 one", { skip: platform() === "win32" }, async () => {
  const dir = await newTmp();
  try {
    const defaults = { port: "9801", upstream: "", debug: "", workingDir: "/tmp" };
    const cases = [
      [installSystemd, { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service", healthcheckServiceFile: "cache-fix-proxy-healthcheck.service", healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer" }],
      [installLaunchd, { kind: "launchd", configDir: dir, configFile: "com.cnighswonger.cache-fix-proxy.plist", logDir: dir }],
    ];
    for (const [fn, paths] of cases) {
      const target = join(dir, paths.configFile);
      assert.ok((await fn({ paths, defaults })).ok);
      assert.equal((await stat(target)).mode & 0o777, 0o600, `${paths.kind}: fresh`);
      await chmod(target, 0o644);
      assert.ok((await fn({ paths, defaults, force: true })).ok);
      assert.equal((await stat(target)).mode & 0o777, 0o600, `${paths.kind}: --force over 0644`);
      // The chmod comes BEFORE the write: a write into a read-only file succeeds only once it is 0600
      // (root writes anyway, so there the case proves nothing, and passes).
      await chmod(target, 0o444);
      assert.ok((await fn({ paths, defaults, force: true })).ok, `${paths.kind}: --force over 0444`);
      assert.equal((await stat(target)).mode & 0o777, 0o600, `${paths.kind}: --force over 0444 ends 0600`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install(): an unsupported platform's hint is a command a POSIX shell runs as printed: no hop, no clause; a captured hop, single-quoted", async () => {
  const none = { CACHE_FIX_UPSTREAM_PROXY: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, CACHE_FIX_PROXY_PORT: "9811" };
  const hint = async (env) => {
    let code;
    const err = (await withEnv({ ...none, ...env }, () =>
      capture(process.stderr, async () => { code = await install({ plat: "freebsd" }); }))).join("");
    assert.equal(code, 1);
    assert.doesNotMatch(err, /server\.mjs/);
    const cmd = /`([^`]+)`/.exec(err)[1];
    assert.doesNotMatch(cmd, /[\[\]<>]/);
    return cmd;
  };
  assert.match(await hint({}), /^CACHE_FIX_PROXY_PORT=9811 '[^']+' '[^']*claude-via-proxy\.mjs' run-service$/);
  assert.match(await hint({ HTTPS_PROXY: "http://127.0.0.1:8118" }),
    /^CACHE_FIX_PROXY_PORT=9811 CACHE_FIX_UPSTREAM_PROXY='http:\/\/127\.0\.0\.1:8118' '[^']+' '[^']*claude-via-proxy\.mjs' run-service$/);
  assert.match(await hint({ CACHE_FIX_UPSTREAM_PROXY: "http://u:p'x@h:3128" }),
    /CACHE_FIX_UPSTREAM_PROXY='http:\/\/u:p'\\''x@h:3128' /);
});

test("install(): the unsupported-platform hint runs as printed when node and the package sit under a path with a space", { skip: platform() === "win32" }, async () => {
  const dir = await newTmp();
  const realExec = process.execPath;
  try {
    const home = join(dir, "a b");
    await mkdir(join(home, "bin"), { recursive: true });
    // install-service.mjs finds the launcher beside itself and its imports one level up: a copy of it
    // under the spaced path, with the real proxy/ linked in, puts the launcher there too.
    await copyFile(join(__dirname, "..", "bin", "install-service.mjs"), join(home, "bin", "install-service.mjs"));
    await symlink(join(__dirname, "..", "proxy"), join(home, "proxy"));
    const node = join(home, "node");
    await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    process.execPath = node;
    const { install: spaced } = await import(pathToFileURL(join(home, "bin", "install-service.mjs")).href);
    const none = { CACHE_FIX_UPSTREAM_PROXY: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, CACHE_FIX_PROXY_PORT: "9811" };
    const err = (await withEnv(none, () => capture(process.stderr, () => spaced({ plat: "freebsd" })))).join("");
    const { stdout } = await execFileP("sh", ["-c", /`([^`]+)`/.exec(err)[1]]);
    assert.deepEqual(stdout.trim().split("\n"), [join(home, "bin", "claude-via-proxy.mjs"), "run-service"]);
  } finally {
    process.execPath = realExec;
    await rm(dir, { recursive: true, force: true });
  }
});

test("help: `server` is not described as what systemd/launchd run; the units run run-service", async () => {
  const { stdout } = await execFileP(process.execPath, [BIN, "help"]);
  assert.doesNotMatch(stdout, /ExecStart/);
  assert.match(stdout, /run-service {12}What install-service's unit does/);
});

test("uninstallSystemd: not-installed when file missing", async () => {
  const dir = await newTmp();
  try {
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service", healthcheckServiceFile: "cache-fix-proxy-healthcheck.service", healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer" };
    const r = await uninstallSystemd({ paths });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-installed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Healthcheck install/uninstall round-trip ---

test("installSystemdHealthcheck: writes both service and timer files", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r = await installSystemdHealthcheck({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.equal(r.installed, true);
    const svc = await readFile(join(dir, "cache-fix-proxy-healthcheck.service"), "utf-8");
    const tmr = await readFile(join(dir, "cache-fix-proxy-healthcheck.timer"), "utf-8");
    assert.ok(svc.includes("http://127.0.0.1:9801/health"));
    assert.ok(tmr.includes("OnUnitActiveSec=2min"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemdHealthcheck: refuses overwrite without force; force overwrites", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    await installSystemdHealthcheck({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    // Second install without force → refuses
    const r2 = await installSystemdHealthcheck({
      paths,
      defaults: { port: "9988", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.equal(r2.installed, false);
    assert.equal(r2.reason, "already-installed");
    const svc = await readFile(join(dir, "cache-fix-proxy-healthcheck.service"), "utf-8");
    assert.ok(svc.includes(":9801/"), "file should not have been overwritten");

    // With force → overwrites
    const r3 = await installSystemdHealthcheck({
      paths,
      defaults: { port: "9988", upstream: "", debug: "", workingDir: "/tmp" },
      force: true,
    });
    assert.equal(r3.installed, true);
    const svc2 = await readFile(join(dir, "cache-fix-proxy-healthcheck.service"), "utf-8");
    assert.ok(svc2.includes(":9988/"), "file should have been overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstallSystemdHealthcheck: removes both files; counts how many removed", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    await installSystemdHealthcheck({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    const r = await uninstallSystemdHealthcheck({ paths });
    assert.equal(r.removed, 2);
    const files = await readdir(dir);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemdHealthcheck: refuses overwrite when ONLY timer file pre-exists (asymmetric guard)", async () => {
  // Codex re-review case: service missing, timer present. v1 of the check
  // only looked at the service file and would silently overwrite the timer.
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    // Pre-create ONLY the timer file (not the service)
    await writeFile(join(dir, "cache-fix-proxy-healthcheck.timer"), "PRE_EXISTING_TIMER");
    const r = await installSystemdHealthcheck({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.equal(r.installed, false);
    assert.equal(r.reason, "already-installed");
    // Timer must NOT have been overwritten
    const onDisk = await readFile(join(dir, "cache-fix-proxy-healthcheck.timer"), "utf-8");
    assert.equal(onDisk, "PRE_EXISTING_TIMER");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemdHealthcheck: refuses overwrite when ONLY service file pre-exists (symmetric guard)", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    // Pre-create ONLY the service file
    await writeFile(join(dir, "cache-fix-proxy-healthcheck.service"), "PRE_EXISTING_SERVICE");
    const r = await installSystemdHealthcheck({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.equal(r.installed, false);
    const onDisk = await readFile(join(dir, "cache-fix-proxy-healthcheck.service"), "utf-8");
    assert.equal(onDisk, "PRE_EXISTING_SERVICE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemd: rolls back main unit if healthcheck install throws", async () => {
  // Half-install rollback: if the healthcheck pair can't be written (e.g.
  // template missing, fs error past the existence check), the main unit
  // must NOT be left on disk — otherwise the user has the proxy unit but
  // no auto-recovery, contrary to what the install message promised.
  //
  // Trigger the exception path by pointing the healthcheck filenames at
  // template files that DON'T exist on disk (the readFile inside
  // installSystemdHealthcheck will throw ENOENT).
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      // These point to template basenames that don't exist in templates/,
      // so the healthcheck readFile will throw ENOENT. (The "real" basenames
      // in install-service.mjs are hardcoded — we swap getPaths fields here
      // by giving the install fn paths whose existence check passes but
      // whose later writeFile target is unreachable. Easiest trigger: make
      // the configDir into a path that mkdir can't handle.)
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    // Force healthcheck writeFile to fail by making the eventual healthcheck
    // service path EXIST AS A DIRECTORY *after* the existence check. Trick:
    // pre-create it as a directory, AND pass force:true so the existence
    // check doesn't short-circuit to "already-installed".
    await mkdir(join(dir, "cache-fix-proxy-healthcheck.service"), { recursive: true });

    let threw = null;
    try {
      await installSystemd({
        paths,
        defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
        force: true,
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, "installSystemd must throw when healthcheck writeFile fails");
    // Main unit must NOT exist after rollback
    const files = await readdir(dir);
    assert.equal(
      files.includes("cache-fix-proxy.service"),
      false,
      `main unit must have been rolled back; remaining files: ${JSON.stringify(files)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstallSystemdHealthcheck: missing files counted as 0 removed (no error)", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r = await uninstallSystemdHealthcheck({ paths });
    assert.equal(r.removed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installSystemd: now also drops healthcheck companion alongside main unit", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    const r = await installSystemd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.ok(r.ok);
    assert.ok(r.healthcheck?.installed, "healthcheck should be installed alongside main unit");
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, [
      "cache-fix-proxy-healthcheck.service",
      "cache-fix-proxy-healthcheck.timer",
      "cache-fix-proxy.service",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstallSystemd: now also removes healthcheck companion alongside main unit", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "systemd",
      configDir: dir,
      configFile: "cache-fix-proxy.service",
      healthcheckServiceFile: "cache-fix-proxy-healthcheck.service",
      healthcheckTimerFile: "cache-fix-proxy-healthcheck.timer",
    };
    await installSystemd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    const r = await uninstallSystemd({ paths });
    assert.ok(r.ok);
    assert.equal(r.healthcheck?.removed, 2, "uninstall should remove both companion files");
    const files = await readdir(dir);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- installLaunchd / uninstallLaunchd round-trip ---

// --- CLI orchestration: end-to-end through dispatch() (Linux only) ---

test("install() CLI orchestration: --force overwrites existing service file (linux)", { skip: platform() !== "linux" }, async () => {
  const dir = await newTmp();
  const realHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    // First install: should succeed.
    const c1 = await install();
    assert.equal(c1, 0);
    const target = join(dir, ".config", "systemd", "user", "cache-fix-proxy.service");
    const before = await readFile(target, "utf-8");

    // Mutate the file so we can prove the overwrite happened, then re-install
    // without --force: should refuse.
    await writeFile(target, "MUTATED");
    const c2 = await install({ force: false });
    assert.equal(c2, 1, "second install without --force must refuse");
    assert.equal(await readFile(target, "utf-8"), "MUTATED", "file must be unchanged");

    // Re-install WITH --force: should overwrite.
    const c3 = await install({ force: true });
    assert.equal(c3, 0, "install --force must succeed");
    const after = await readFile(target, "utf-8");
    assert.notEqual(after, "MUTATED", "file must have been rewritten");
    assert.ok(after.includes("CACHE_FIX_PROXY_PORT="), "rewritten file must look like a real unit");
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Back-compat: subcommand dispatch must not eat wrapper-mode args ---

test("dispatch back-compat: --proxy-port + claude-arg passes through to wrapper mode", async () => {
  // Write a tiny intercept script so CACHE_FIX_CLAUDE_CMD can be a clean
  // `node <path>` (no embedded spaces in arg payload — the wrapper splits
  // CACHE_FIX_CLAUDE_CMD naively on whitespace).
  const dir = await newTmp();
  const interceptScript = join(dir, "intercept.mjs");
  await writeFile(
    interceptScript,
    'process.stdout.write("INTERCEPT:" + JSON.stringify({argv: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL}));\n',
  );
  // This case asserts on the URL, but the wrapper really BINDS the port, so a
  // hardcoded one fails whenever anything else on the machine already holds
  // it — observed with a local QGIS MCP server owning 9876, which turned this
  // into a red suite on an unrelated change. `--proxy-port 0` is not usable
  // here because the assertion needs the number it passed in, so take a free
  // port from the OS and use that. There is a small TOCTOU window between
  // closing the probe socket and the wrapper binding; it is far narrower than
  // a fixed port's collision surface.
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [BIN, "--proxy-port", String(port), "some-claude-arg", "--another"],
      {
        env: {
          ...process.env,
          CACHE_FIX_CLAUDE_CMD: `${process.execPath} ${interceptScript}`,
        },
        timeout: 15000,
      },
    );
    const match = stdout.match(/INTERCEPT:(\{.*\})/);
    assert.ok(match, `expected wrapper-intercept JSON in stdout; got: ${JSON.stringify(stdout)}`);
    const parsed = JSON.parse(match[1]);
    assert.deepEqual(parsed.argv, ["some-claude-arg", "--another"], "wrapper-mode args must reach the claude command");
    assert.equal(parsed.base, `http://127.0.0.1:${port}`, "ANTHROPIC_BASE_URL must reflect --proxy-port");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installLaunchd: writes plist to configDir; uninstall removes it", async () => {
  const dir = await newTmp();
  try {
    const paths = {
      kind: "launchd",
      configDir: dir,
      configFile: "com.cnighswonger.cache-fix-proxy.plist",
      logDir: "/tmp/logs",
    };
    const r1 = await installLaunchd({
      paths,
      defaults: { port: "9801", upstream: "", debug: "", workingDir: "/tmp" },
    });
    assert.ok(r1.ok);
    const onDisk = await readFile(join(dir, "com.cnighswonger.cache-fix-proxy.plist"), "utf-8");
    assert.ok(onDisk.includes("<key>Label</key>"));
    assert.ok(onDisk.includes("com.cnighswonger.cache-fix-proxy"));

    const r2 = await uninstallLaunchd({ paths });
    assert.ok(r2.ok);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- The unit starts `run-service` (the port holder), not the bare proxy ---

// Every case that reads HTTPS_PROXY / NO_PROXY sets or deletes it here: the
// project's test command exports both, so a case that trusted the ambient
// value would differ between `npm test` and a bare `node --test`.
async function withEnv(env, fn) {
  const put = (e) => { for (const [k, v] of Object.entries(e)) v === undefined ? delete process.env[k] : (process.env[k] = v); };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  put(env);
  try { return await fn(); } finally { put(prior); }
}

// What `fn` writes to `stream` (process.stdout or process.stderr), one entry per write.
async function capture(stream, fn) {
  const out = [];
  const write = stream.write;
  stream.write = (m) => { out.push(String(m)); return true; };
  try { await fn(); } finally { stream.write = write; }
  return out;
}

test("renderSystemdTemplate: stop leaves the holder's lineage, reload hands it over", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  for (const line of [
    "KillMode=process",
    "KillSignal=SIGTERM",
    "ExecReload=/bin/kill -USR2 $MAINPID",
    "Restart=on-failure",
    "RestartSec=0",
  ]) assert.ok(out.includes(`\n${line}\n`), `unit lacks ${line}`);
});

test("renderSystemdTemplate: renders the captured hop, NO_PROXY, fallbacks and watch interval; omits them when unset", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, {
    ...sampleVars,
    upstreamProxy: "http://127.0.0.1:8118",
    noProxy: "localhost,127.0.0.1",
    fallbackProxies: "http://127.0.0.1:8119",
    watchDeployMs: "5000",
  });
  assert.ok(out.includes("Environment=CACHE_FIX_UPSTREAM_PROXY=http://127.0.0.1:8118"));
  assert.ok(out.includes("Environment=NO_PROXY=localhost,127.0.0.1"));
  assert.ok(out.includes("Environment=CACHE_FIX_FALLBACK_PROXIES=http://127.0.0.1:8119"));
  assert.ok(out.includes("Environment=CACHE_FIX_WATCH_DEPLOY_MS=5000"));
  // A hop's credentials may hold `$&` or `$$`, which String.replaceAll reads as patterns.
  const dollars = "http://u:p$&$$@127.0.0.1:8118";
  assert.ok(renderSystemdTemplate(tpl, { ...sampleVars, upstreamProxy: dollars })
    .includes(`Environment=CACHE_FIX_UPSTREAM_PROXY=${dollars}\n`));
  const bare =renderSystemdTemplate(tpl, sampleVars);
  for (const k of ["CACHE_FIX_UPSTREAM_PROXY", "NO_PROXY", "CACHE_FIX_FALLBACK_PROXIES", "CACHE_FIX_WATCH_DEPLOY_MS"])
    assert.ok(!bare.includes(k), `${k} rendered with no value`);
});

test("renderLaunchdTemplate: the agent outlives its holder's launch, and carries the captured env", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"), "utf-8");
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    upstreamProxy: "http://127.0.0.1:8118",
    noProxy: "localhost",
    fallbackProxies: "http://127.0.0.1:8119",
    watchDeployMs: "5000",
    logDir: "/Users/test/Library/Logs",
  });
  assert.ok(out.includes("<key>AbandonProcessGroup</key>\n    <true/>"));
  assert.ok(out.includes("<key>CACHE_FIX_UPSTREAM_PROXY</key>\n        <string>http://127.0.0.1:8118</string>"));
  assert.ok(out.includes("<key>NO_PROXY</key>\n        <string>localhost</string>"));
  assert.ok(out.includes("<key>CACHE_FIX_FALLBACK_PROXIES</key>\n        <string>http://127.0.0.1:8119</string>"));
  assert.ok(out.includes("<key>CACHE_FIX_WATCH_DEPLOY_MS</key>\n        <string>5000</string>"));
  assert.ok(!out.includes("{{"));
});

test("getDefaults: the hop follows the proxy's own precedence; NO_PROXY, fallbacks and a 5000 ms watch are captured", async () => {
  const none = Object.fromEntries(["CACHE_FIX_UPSTREAM_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
    "NO_PROXY", "no_proxy", "CACHE_FIX_FALLBACK_PROXIES", "CACHE_FIX_WATCH_DEPLOY_MS"].map((k) => [k, undefined]));
  await withEnv({ ...none, HTTPS_PROXY: "http://127.0.0.1:8118", NO_PROXY: "localhost", CACHE_FIX_FALLBACK_PROXIES: "http://127.0.0.1:8119" }, () => {
    const d = getDefaults();
    assert.equal(d.upstreamProxy, "http://127.0.0.1:8118");
    assert.equal(d.noProxy, "localhost");
    assert.equal(d.fallbackProxies, "http://127.0.0.1:8119");
    assert.equal(d.watchDeployMs, "5000");
  });
  await withEnv({ ...none, CACHE_FIX_UPSTREAM_PROXY: "http://hop.example:3128", HTTPS_PROXY: "http://127.0.0.1:8118", CACHE_FIX_WATCH_DEPLOY_MS: "1000" }, () => {
    assert.equal(getDefaults().upstreamProxy, "http://hop.example:3128", "an explicit hop outranks HTTPS_PROXY");
    assert.equal(getDefaults().watchDeployMs, "1000");
  });
  await withEnv({ ...none, HTTP_PROXY: "http://127.0.0.1:8118" }, () => {
    assert.equal(getDefaults().upstreamProxy, "", "HTTP_PROXY alone is no hop: config.mjs reads it for plain-http targets only, not the https upstream");
  });
});

test("getDefaults: a fallback proxy variable naming the service's own port is not captured as the hop", async () => {
  const none = Object.fromEntries(["CACHE_FIX_UPSTREAM_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].map((k) => [k, undefined]));
  const self = "http://127.0.0.1:9801";
  const warned = await capture(process.stderr, async () => {
    await withEnv({ ...none, CACHE_FIX_PROXY_PORT: "9801", https_proxy: self }, () => {
      assert.equal(getDefaults().upstreamProxy, "", "a loop the child would refuse at start must not be baked in");
    });
    await withEnv({ ...none, CACHE_FIX_PROXY_PORT: "9801", CACHE_FIX_UPSTREAM_PROXY: self }, () => {
      assert.equal(getDefaults().upstreamProxy, self, "an explicit hop stays as given");
    });
    await withEnv({ ...none, CACHE_FIX_PROXY_PORT: "9801", HTTPS_PROXY: "http://127.0.0.1:8118" }, () => {
      assert.equal(getDefaults().upstreamProxy, "http://127.0.0.1:8118", "another port is a real hop");
    });
  });
  assert.equal(warned.length, 1, `one warning, got ${JSON.stringify(warned)}`);
  assert.match(warned[0], /https_proxy/);
  assert.match(warned[0], /CACHE_FIX_UPSTREAM_PROXY/);
});

// Stand-ins for BOTH service managers' CLIs, for lsof and for ps, and a process.kill
// that only logs, so a case can read the ORDER uninstall()
// issued its commands and signals in, and never reaches a real service manager
// or a real pid. Both managers, so a case whose platform branch is wrong still
// stays off the host's real one. The lsof lists the `holders` (a pid, the address it
// listens on, and the command line the ps answers with, null for a ps that fails) that the
// request's -iTCP spec reaches, for its first `lists` calls and none after (the holder
// draining; one marked `stays` is listed for ever); `noLsof` leaves it off PATH. A
// null unitText installs no unit. The result carries uninstall()'s stderr as `.stderr`.
// `failOn` makes that call of the lsof fail the way its 5 s timeout does: spawnSync's own `error`
// (here ENOBUFS, more than maxBuffer of blank lines) beside an empty list.
const LINEAGE = [
  { pid: 4242, addr: "127.0.0.1", cmd: "node /opt/pkg/bin/claude-via-proxy.mjs run-service" },
  { pid: 4243, addr: "127.0.0.1", cmd: "node /opt/pkg/proxy/server.mjs" },
];
async function uninstallCalls(plat, unitName, unitText, env = {}, { lists = 1, noLsof = false, drainMs = 300, failOn = 0, holders = LINEAGE } = {}) {
  const dir = await newTmp();
  const realKill = process.kill;
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "calls.log");
    const count = join(dir, "lsof.count");
    await mkdir(bin);
    for (const n of ["systemctl", "launchctl"]) await writeFile(join(bin, n), `#!/bin/sh\necho "${n} $*" >> "${log}"\n`, { mode: 0o755 });
    if (!noLsof) {
      await writeFile(join(bin, "lsof"),
        `#!/bin/sh\necho "lsof $*" >> "${log}"\nn=0; [ -f "${count}" ] && read n < "${count}"\nn=$((n+1)); echo $n > "${count}"\n` +
        `[ $n -eq ${failOn} ] && { head -c 2000000 /dev/zero | tr '\\0' '\\n'; exit 0; }\n` +
        `spec=; for a in "$@"; do case "$a" in -iTCP*) spec="\${a#-iTCP}";; esac; done\n` +
        holders.map((h) => `${h.stays ? "" : `[ $n -le ${lists} ] && `}case "$spec" in :*|"@${h.addr}":*) echo ${h.pid};; esac\n`).join("") +
        `exit 0\n`, { mode: 0o755 });
    }
    await writeFile(join(bin, "ps"), `#!/bin/sh\nfor a; do p=$a; done\n` +
      holders.filter((h) => h.cmd).map((h) => `[ "$p" = ${h.pid} ] && { echo '${h.cmd}'; exit 0; }\n`).join("") + `exit 1\n`, { mode: 0o755 });
    const unitDir = plat === "linux" ? join(dir, ".config", "systemd", "user") : join(dir, "Library", "LaunchAgents");
    await mkdir(unitDir, { recursive: true });
    if (unitText !== null) await writeFile(join(unitDir, unitName), unitText);
    process.kill = (pid, sig) => (appendFileSync(log, `kill ${sig} ${pid}\n`), true);
    let stderr;
    await withEnv({ HOME: dir, PATH: noLsof ? bin : `${bin}:${process.env.PATH}`, ...env }, async () => {
      stderr = await capture(process.stderr, async () => {
        assert.equal(await uninstall({ plat, drainMs }), unitText === null ? 1 : 0);
      });
    });
    return Object.assign((await readFile(log, "utf-8")).split("\n"), { stderr: stderr.join("") });
  } finally {
    process.kill = realKill;
    await rm(dir, { recursive: true, force: true });
  }
}

const idx = (calls, c) => {
  const i = calls.indexOf(c);
  assert.ok(i >= 0, `${c} missing, got:\n${calls.join("\n")}`);
  return i;
};

test("uninstall(): systemd SIGHUPs every holder of the unit's port, after the timer stops and before the unit stops", async () => {
  const calls = await uninstallCalls("linux", "cache-fix-proxy.service", "[Service]\nEnvironment=CACHE_FIX_PROXY_PORT=9877\n");
  const [timer, list, k1, k2, stop] = [
    "systemctl --user stop cache-fix-proxy-healthcheck.timer", "lsof -nP -t -iTCP:9877 -sTCP:LISTEN",
    "kill SIGHUP 4242", "kill SIGHUP 4243", "systemctl --user stop cache-fix-proxy",
  ].map((c) => idx(calls, c));
  assert.ok(timer < list && list < k1 && k1 < k2 && k2 < stop, `order wrong, got:\n${calls.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("systemctl --user kill")), "with lsof working the supervisor is not asked to kill");
});

test("uninstall(): launchd SIGHUPs every holder of the plist's port before bootout", async () => {
  const calls = await uninstallCalls("darwin", "com.cnighswonger.cache-fix-proxy.plist",
    "<key>CACHE_FIX_PROXY_PORT</key>\n        <string>9877</string>\n");
  const [list, k1, k2] = ["lsof -nP -t -iTCP:9877 -sTCP:LISTEN", "kill SIGHUP 4242", "kill SIGHUP 4243"].map((c) => idx(calls, c));
  const boot = calls.findIndex((c) => c.startsWith("launchctl bootout"));
  assert.ok(list < k1 && k1 < k2 && k2 < boot, `order wrong, got:\n${calls.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("launchctl kill")), "the job has no PID once a successor serves");
});

test("uninstall(): a unit that names no port lists the proxy's default 9801, and never reads getDefaults()", async () => {
  // getDefaults() throws on the first port, and would list 9878 for the second.
  for (const env of [{ CACHE_FIX_PROXY_PORT: "not-a-port" }, { CACHE_FIX_PROXY_PORT: "9878" }]) {
    const calls = await uninstallCalls("linux", "cache-fix-proxy.service", "", env);
    idx(calls, "lsof -nP -t -iTCP:9801 -sTCP:LISTEN");
  }
});

const SYSTEMD = ["linux", "cache-fix-proxy.service", "[Service]\nEnvironment=CACHE_FIX_PROXY_PORT=9877\n"];
const LAUNCHD = ["darwin", "com.cnighswonger.cache-fix-proxy.plist", "<key>CACHE_FIX_PROXY_PORT</key>\n        <string>9877</string>\n"];
const lsofCalls = (calls) => calls.filter((c) => c.startsWith("lsof "));
const endIdx = (calls) => calls.findIndex((c) => c === "systemctl --user stop cache-fix-proxy" || c.startsWith("launchctl bootout"));
const sighups = (calls) => calls.filter((c) => c.startsWith("kill SIGHUP "));

test("uninstall(): a process of ours is SIGHUP'd on whatever address it listens on, one per way of naming our lineage", async () => {
  // The unit names no bind, yet a bind set by a drop-in or the manager's environment reaches the proxy.
  const holders = [
    { pid: 4242, addr: "0.0.0.0", cmd: "node /opt/pkg/bin/claude-via-proxy.mjs run-service" },
    { pid: 4243, addr: "10.0.0.5", cmd: "node /opt/pkg/proxy/server.mjs" },
    { pid: 4244, addr: "::1", cmd: "node /opt/pkg/bin/gap-relay.mjs" },
  ];
  for (const [plat, name, text] of [SYSTEMD, LAUNCHD]) {
    const calls = await uninstallCalls(plat, name, text, {}, { holders });
    assert.deepEqual(sighups(calls), ["kill SIGHUP 4242", "kill SIGHUP 4243", "kill SIGHUP 4244"], `${plat}:\n${calls.join("\n")}`);
  }
});

test("uninstall(): a foreign process on the unit's port is neither SIGHUP'd nor waited for, and a pid whose ps cannot be read is skipped", async () => {
  const holders = [
    ...LINEAGE,
    { pid: 4244, addr: "10.0.0.5", cmd: "python3 -m http.server 9877", stays: true },
    { pid: 4245, addr: "127.0.0.1", cmd: null, stays: true },
  ];
  for (const [plat, name, text] of [SYSTEMD, LAUNCHD]) {
    const calls = await uninstallCalls(plat, name, text, {}, { holders });
    assert.deepEqual(sighups(calls), ["kill SIGHUP 4242", "kill SIGHUP 4243"], `${plat}:\n${calls.join("\n")}`);
    assert.doesNotMatch(calls.stderr, /still held/, `${plat}: only our own processes keep the drain waiting`);
  }
});

test("uninstall(): no unit file means nothing installed, so no lsof, no signal and no default port read", async () => {
  // A port getDefaults() throws on, and a hop that names the port it would warn on.
  for (const env of [{ CACHE_FIX_PROXY_PORT: "not-a-port" }, { CACHE_FIX_PROXY_PORT: "9879", HTTPS_PROXY: "http://127.0.0.1:9879" }]) {
    for (const [plat, name] of [SYSTEMD, LAUNCHD]) {
      const calls = await uninstallCalls(plat, name, null, env);
      assert.deepEqual(calls.filter((c) => /^(lsof|kill) /.test(c)), [], `${plat}: nothing may be listed or signalled`);
      assert.doesNotMatch(calls.stderr, /own port/);
    }
  }
});

test("uninstall(): returns only once the port is free: lsof is polled until it lists no pid, before stop/bootout", async () => {
  for (const [plat, name, text] of [SYSTEMD, LAUNCHD]) {
    const calls = await uninstallCalls(plat, name, text, {}, { lists: 2, drainMs: 5000 });
    assert.equal(lsofCalls(calls).length, 3, `${plat}: the listing, then two polls, the last empty, got:\n${calls.join("\n")}`);
    assert.equal(calls.filter((c) => c.startsWith("kill ")).length, 2, "only the first listing is signalled");
    assert.ok(calls.lastIndexOf(lsofCalls(calls)[0]) < endIdx(calls), `${plat}: the stop waits for the port`);
  }
});

test("uninstall(): an lsof that fails is not a free port: the poll goes on until a listing says so", async () => {
  for (const [plat, name, text] of [SYSTEMD, LAUNCHD]) {
    const calls = await uninstallCalls(plat, name, text, {}, { lists: 1, failOn: 2, drainMs: 5000 });
    assert.equal(lsofCalls(calls).length, 3, `${plat}: the listing, the failed poll, then the empty one, got:\n${calls.join("\n")}`);
    assert.ok(calls.lastIndexOf(lsofCalls(calls)[0]) < endIdx(calls), `${plat}: the stop waits for the port`);
  }
});

test("uninstall(): a port still held at the bound warns with the port and the pids, and the uninstall continues", async () => {
  for (const [plat, name, text] of [SYSTEMD, LAUNCHD]) {
    const calls = await uninstallCalls(plat, name, text, {}, { lists: 99999 });
    assert.ok(lsofCalls(calls).length > 2, `${plat}: polled until the bound`);
    assert.match(calls.stderr, /9877/);
    assert.match(calls.stderr, /4242/);
    assert.match(calls.stderr, /4243/);
    assert.ok(endIdx(calls) > 0, `${plat}: the uninstall continues`);
  }
});

test("uninstall(): systemd with no lsof asks the unit's cgroup to SIGHUP and warns with the port", async () => {
  const calls = await uninstallCalls(...SYSTEMD, {}, { noLsof: true });
  const [timer, kill, stop] = ["systemctl --user stop cache-fix-proxy-healthcheck.timer", "systemctl --user kill -s HUP cache-fix-proxy",
    "systemctl --user stop cache-fix-proxy"].map((c) => idx(calls, c));
  assert.ok(timer < kill && kill < stop, `order wrong, got:\n${calls.join("\n")}`);
  assert.match(calls.stderr, /lsof/);
  assert.match(calls.stderr, /9877/);
  // A reload's successor stays in the cgroup, and nothing has been sent when this is written.
  assert.doesNotMatch(calls.stderr, /outside|was sent/);
  assert.match(calls.stderr, /asked to release by SIGHUP/);
  assert.match(calls.stderr, /nothing waits for the port to free/);
});

test("uninstall(): launchd with no lsof warns that the proxy was not found and the port may stay held, and boots out", async () => {
  const calls = await uninstallCalls(...LAUNCHD, {}, { noLsof: true });
  assert.ok(calls.some((c) => c.startsWith("launchctl bootout")), "the uninstall continues");
  assert.ok(!calls.some((c) => c.startsWith("launchctl kill")), "no supervisor call reaches an untracked successor");
  assert.match(calls.stderr, /lsof/);
  assert.match(calls.stderr, /9877/);
  assert.match(calls.stderr, /held/);
});

// True on any base: a handover keeps the port accepting, a restart refuses connections for a
// moment. Nothing here may say a handover keeps an in-flight stream alive.
const CONTRAST = "a handover keeps the port accepting throughout; a restart refuses connections for a moment";

const SETTINGS_LINE = "\nTo change an installed service's settings, run `cache-fix-proxy uninstall-service`, then install-service with the new settings and the steps above; the uninstall ends the running proxy, so this one cuts.\n";

test("install-service: next steps reload, never restart; a missing lsof warns and the install continues", { skip: platform() !== "linux" }, async () => {
  const dir = await newTmp();
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    // The launcher honours CACHE_FIX_REQUIRE_HOP, so an exported one is dropped.
    const env = { ...process.env, HOME: dir, PATH: bin };
    delete env.CACHE_FIX_REQUIRE_HOP;
    const run = () => execFileP(process.execPath, [BIN, "install-service", "--force"], { env });
    const noLsof = await run();
    // After the first reload the serving holder is a successor the unit no longer
    // tracks, so a reload alone works once; `start` then hands over to it.
    assert.ok(noLsof.stdout.includes("\n  systemctl --user reload cache-fix-proxy || systemctl --user start cache-fix-proxy\n"));
    assert.doesNotMatch(noLsof.stdout, /systemctl --user restart/);
    assert.ok(noLsof.stdout.includes(CONTRAST), noLsof.stdout);
    assert.doesNotMatch(noLsof.stdout, /in-flight/);
    // A changed unit never reaches the serving lineage: only an uninstall ends it.
    assert.ok(noLsof.stdout.includes(SETTINGS_LINE));
    assert.ok(noLsof.stdout.includes("or does nothing when the proxy/ and bin/ trees are the same."));
    assert.match(noLsof.stderr, /lsof/, "no lsof on PATH must warn");
    // Control: the same install with an lsof on PATH is silent, so the warning
    // above came from the missing binary and not from anything else on stderr.
    await writeFile(join(bin, "lsof"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.doesNotMatch((await run()).stderr, /lsof/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install(): the launchd next steps update by SIGUSR2, then kickstart without -k", async () => {
  const dir = await newTmp();
  try {
    let code;
    const out = (await capture(process.stdout, () => withEnv({ HOME: dir }, async () => {
      code = await install({ force: true, plat: "darwin" });
    }))).join("");
    assert.equal(code, 0);
    const id = "gui/$(id -u)/com.cnighswonger.cache-fix-proxy";
    assert.ok(out.includes(`\n  launchctl kill SIGUSR2 ${id} || launchctl kickstart ${id}\n`), out);
    assert.doesNotMatch(out, /kickstart -k/);
    assert.ok(out.includes(CONTRAST), out);
    assert.doesNotMatch(out, /in-flight/);
    assert.ok(out.includes(SETTINGS_LINE));
    assert.ok(out.includes("or does nothing when the proxy/ and bin/ trees are the same."));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
