// The proxy clears the auto-update record IT caused, and nothing else.
//
// Claude Code writes .last-update-result.json when an update poll fails and
// never rewrites it on a later success, so a poll that lands while this proxy
// is restarting pins "Auto-update failed" on the status line for good. We made
// that miss, so we clear it — but only when it is provably a fossil.
//
// Driven as a real process, not by importing the function: the sweep is armed
// from the script-entry path and reads its inputs from the environment, so an
// in-process call would test neither.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exitWithin } from "./child-deadline.mjs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs");
const DELAY_MS = 300;

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// A stand-in release channel, so the test never depends on the network or on
// what the real channel happens to say today.
async function withChannel(version, fn) {
  const srv = http.createServer((_q, r) => { r.writeHead(200); r.end(version); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // RETURN the callback's value: without this every caller got undefined and
  // each assertion compared undefined to a boolean — four failures that said
  // nothing about the code under test.
  try { return await fn(srv.address().port); } finally { srv.close(); }
}

// Run the proxy against a sandboxed config dir and HOME, wait past the sweep,
// and report whether the record survived.
async function sweepLeaves({ record, diskVersion, channelVersion, sweep }) {
  const cfg = mkdtempSync(join(tmpdir(), "ccf-sweep-"));
  const home = mkdtempSync(join(tmpdir(), "ccf-home-"));
  const result = join(cfg, ".last-update-result.json");
  writeFileSync(result, JSON.stringify(record));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(`/nonexistent/versions/${diskVersion}`, join(home, ".local", "bin", "claude"));

  // BOTH DIRS GO, always. mkdtemp NEVER cleans up after itself, and this
  // fixture makes two per call — measured on this box: 950 of them from one
  // afternoon's runs and 831 from earlier sessions, 1,781 directories in a
  // shared /tmp. Small on disk, but it is exactly the "test leftovers" class
  // this repo has been bitten by, and nothing was ever going to remove them.
  try {
  return await withChannel(channelVersion, async (channelPort) => {
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: cfg,
      CACHE_FIX_PROXY_PORT: String(await freePort()),
      CACHE_FIX_UPDATE_SWEEP_DELAY_MS: String(DELAY_MS),
      // Point the channel probe at the stand-in. It goes through the proxy's
      // own egress agent, so an http upstream is what an https URL would be.
      CACHE_FIX_UPDATE_CHANNEL_URL: `http://127.0.0.1:${channelPort}/latest`,
      ...(sweep === undefined ? {} : { CACHE_FIX_UPDATE_SWEEP: sweep }),
    };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "LISTEN_FDS"]) delete env[k];
    const proc = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      // Gate on the proxy SAYING it is up, because the sweep timer is armed
      // right after that line — a blind sleep from spawn has to cover boot as
      // well, and pays for the slowest box on every run.
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error("proxy never reported listening")), 15_000);
        proc.stdout.on("data", (d) => { if (/listening/.test(String(d))) { clearTimeout(to); res(); } });
        proc.on("exit", (c) => rej(new Error(`proxy exited ${c} before listening`)));
      });
      await new Promise((r) => setTimeout(r, DELAY_MS + 700));
      return existsSync(result);
    } finally {
      proc.kill("SIGKILL");
      await exitWithin(proc, 20_000, "the proxy never exited after SIGKILL");
    }
  });
  } finally {
    for (const d of [cfg, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { } }
  }
}

// Concurrent: each case owns its own HOME, config dir, port and channel, so
// they share nothing. Serial, the four fixed waits add up instead of overlap.
describe("auto-update fossil sweep", { concurrency: true }, () => {
  // The case the sweep exists for: the record says failed, and the version on
  // disk already equals the channel's, so there was nothing to install.
  it("clears a record whose failure had nothing to install", async () => {
    const survived = await sweepLeaves({
      record: { outcome: "failed", status: "install_failed" },
      diskVersion: "2.1.222",
      channelVersion: "2.1.222",
    });
    assert.equal(survived, false, "a provable fossil was left behind");
  });

  // The control that matters more than the case above: a real pending update
  // must stay visible. Same record, only the versions differ.
  it("leaves a record whose update is genuinely behind", async () => {
    const survived = await sweepLeaves({
      record: { outcome: "failed", status: "install_failed" },
      diskVersion: "1.0.0",
      channelVersion: "2.1.222",
    });
    assert.equal(survived, true, "a real pending update was swept away");
  });

  // Not ours to touch.
  it("leaves a record that did not fail", async () => {
    const survived = await sweepLeaves({
      record: { outcome: "success" },
      diskVersion: "2.1.222",
      channelVersion: "2.1.222",
    });
    assert.equal(survived, true, "a success record was removed");
  });

  it("does nothing when switched off", async () => {
    const survived = await sweepLeaves({
      record: { outcome: "failed", status: "install_failed" },
      diskVersion: "2.1.222",
      channelVersion: "2.1.222",
      sweep: "off",
    });
    assert.equal(survived, true, "CACHE_FIX_UPDATE_SWEEP=off did not switch it off");
  });

  // A MALFORMED CHANNEL URL MUST NOT KILL THE PROXY. `new URL()` throws, and it
  // is called inside an async setTimeout callback — so the throw becomes an
  // unhandledRejection rather than a caught error. In FORWARD mode installSelfHeal
  // swallows those; in REVERSE mode nothing does, and Node >=15 terminates the
  // process. This fixture is reverse mode (no CACHE_FIX_FORWARD_PROXY), which is
  // the half that dies.
  //
  // The proxy is the process every live session dials, so a typo in one env var
  // taking it down ~25s after boot is the whole goal failing on a config slip.
  //
  // Asserted on the PROCESS BEING ALIVE past the sweep, not on the sweep's
  // result: the sweep legitimately does nothing here, and "did nothing" is what
  // a dead process looks like too.
  it("survives a malformed update-channel URL instead of dying to an unhandled rejection", async () => {
    // THE FULL PRECONDITION, or this case tests nothing. The parse sits behind
    // four early returns: sweep not off, a readable .last-update-result.json,
    // its outcome === "failed", and a resolvable ~/.local/bin/claude symlink.
    // Measured: without the record the sweep returns at the first catch, the URL
    // is never parsed, and removing the guard leaves this GREEN — the fixture
    // agreed with itself. Same fossil + symlink setup sweepLeaves uses.
    const cfg = mkdtempSync(join(tmpdir(), "ccf-badurl-cfg-"));
    const home = mkdtempSync(join(tmpdir(), "ccf-badurl-home-"));
    writeFileSync(join(cfg, ".last-update-result.json"),
                  JSON.stringify({ outcome: "failed", status: "install_failed" }));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync("/nonexistent/versions/2.1.222", join(home, ".local", "bin", "claude"));
    const env = { ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: cfg,
      CACHE_FIX_PROXY_PORT: String(await freePort()),
      CACHE_FIX_UPDATE_SWEEP_DELAY_MS: String(DELAY_MS),
      CACHE_FIX_UPDATE_CHANNEL_URL: "not a url at all",
    };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "LISTEN_FDS", "CACHE_FIX_FORWARD_PROXY"]) delete env[k];
    const proc = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let died = null;
    proc.on("exit", (c, s) => { died = `exit=${c} signal=${s}`; });
    try {
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error("proxy never reported listening")), 15_000);
        proc.stdout.on("data", (d) => { if (/listening/.test(String(d))) { clearTimeout(to); res(); } });
        proc.on("exit", (c) => rej(new Error(`proxy exited ${c} before listening`)));
      });
      // Past the moment the timer fires, with room for the rejection to land.
      await new Promise((r) => setTimeout(r, DELAY_MS + 1_500));
      assert.equal(died, null,
        `the proxy died after the update sweep fired (${died}) — an unparseable ` +
        `CACHE_FIX_UPDATE_CHANNEL_URL threw inside an async timer, and in reverse ` +
        `mode nothing catches it, so every session on this address is stranded`);
    } finally {
      proc.kill("SIGKILL");
      await exitWithin(proc, 20_000, "the proxy never exited after SIGKILL");
      for (const d of [cfg, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { } }
    }
  });
});
