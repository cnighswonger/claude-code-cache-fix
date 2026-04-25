import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  renderSystemdTemplate,
  renderLaunchdTemplate,
  getPaths,
  installSystemd,
  installLaunchd,
  uninstallSystemd,
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

// --- Platform detection ---

test("getPaths: linux returns systemd shape", () => {
  const p = getPaths("linux");
  assert.equal(p.kind, "systemd");
  assert.ok(p.configDir.endsWith(".config/systemd/user"));
  assert.equal(p.configFile, "cache-fix-proxy.service");
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

test("installSystemd: refuses overwrite without force", async () => {
  const dir = await newTmp();
  try {
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service" };
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
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service" };
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
    const paths = { kind: "systemd", configDir: dir, configFile: "cache-fix-proxy.service" };
    const r = await uninstallSystemd({ paths });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-installed");
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
