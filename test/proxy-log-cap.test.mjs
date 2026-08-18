// A DEFAULT INSTALL MUST NOT GROW A FILE FOREVER.
//
// templates/com.cnighswonger.cache-fix-proxy.plist.template sends both streams
// to files:
//     StandardOutPath   {LOG_DIR}/cache-fix-proxy.log
//     StandardErrorPath {LOG_DIR}/cache-fix-proxy.err
// launchd opens them append-only and nothing in this repo ever truncated them.
// Measured on this fleet: 8.3 MB over 37 days on one Mac (~224 KB/day), 968 KB
// over 47 days on another. The rate tracks traffic, so the bound is the disk.
//
// systemd is not exposed — its unit sets no Standard* at all, so output goes to
// journald, which the system already caps. This is the macOS path, and it is
// the DEFAULT one rather than a debug opt-in.
//
// THE CAP HAS TO WORK THROUGH fd 2 ALONE. launchd hands over a descriptor and
// not a path, and there is no portable way back (Linux has /proc/self/fd,
// macOS needs fcntl F_GETPATH, which node does not expose). Measured:
//     fstatSync(2)      works — size
//     readSync(2, ...)  EBADF: the fd is write-only (O_WRONLY|O_APPEND)
//     ftruncateSync(2)  works, and later writes land at 0
// So a tail cannot be preserved and the cap is a truncate. It keeps the NEWEST
// lines, which is the half worth keeping.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";

const serverPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "proxy", "server.mjs");

describe("log cap", () => {
  it("truncates its own log when it is over the cap, and says so", async () => {
    const { capOwnLog } = await import("../proxy/server.mjs");
    assert.equal(typeof capOwnLog, "function",
      "capOwnLog is not exported — a default install has nothing bounding its log");
    const dir = mkdtempSync(join(tmpdir(), "ccf-logcap-"));
    const path = join(dir, "cache-fix-proxy.err");
    try {
      writeFileSync(path, "x".repeat(200_000));
      const fd = openSync(path, "a");
      try {
        assert.equal(capOwnLog(fd, 100_000), true, "an oversized log was left alone");
        const after = fstatSync(fd).size;
        assert.ok(after < 100_000, `still ${after} bytes after the cap`);
        // AND IT MUST SAY WHY. A log that silently loses its history reads as a
        // log that was never written — the misreading this repo has now been
        // bitten by from both directions.
        assert.match(readFileSync(path, "utf8"), /cache-fix.*truncated/i,
          "the truncation left no line explaining itself");
      } finally { closeSync(fd); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves a log under the cap alone", async () => {
    const { capOwnLog } = await import("../proxy/server.mjs");
    const dir = mkdtempSync(join(tmpdir(), "ccf-logcap2-"));
    const path = join(dir, "small.err");
    try {
      writeFileSync(path, "y".repeat(1_000));
      const fd = openSync(path, "a");
      try {
        // PREMISE FIRST, or "returned false" proves nothing about which reason.
        assert.equal(fstatSync(fd).size, 1_000, "premise: the fixture is not the size it claims");
        assert.equal(capOwnLog(fd, 100_000), false, "a small log was truncated");
        assert.equal(fstatSync(fd).size, 1_000, "a small log lost content anyway");
      } finally { closeSync(fd); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("actually runs it at startup — the function alone bounds nothing", async () => {
    // MEASURED WITHOUT THIS CASE: commenting out the capOwnLog() call left the
    // unit cases above entirely green while a 5 MB log stayed 5 MB. A helper
    // nothing invokes is the same as no helper.
    const dir = mkdtempSync(join(tmpdir(), "ccf-logcap3-"));
    const errPath = join(dir, "boot.err");
    let proc = null;
    try {
      writeFileSync(errPath, "z".repeat(5_000_000));
      const port = await new Promise((r) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => r(p)); });
      });
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                    CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_HOLD_PORT",
                       "CACHE_FIX_HELD_PORT"]) delete env[k];
      const errFd = openSync(errPath, "a");
      proc = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "ignore", errFd] });
      closeSync(errFd);
      await new Promise((r) => setTimeout(r, 3_000));
      const after = statSync(errPath).size;
      assert.ok(after < 1_000_000,
        `the proxy started on a 5 MB log and left it at ${after} bytes — capOwnLog is ` +
        `not wired into startup, so nothing bounds a default install`);
    } finally {
      if (proc) { try { proc.kill("SIGKILL"); } catch { } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
