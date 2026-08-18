// A LOST LOG READER MUST NOT WEDGE THE PROXY.
//
// Measured outage 2026-08-13 on a live 9901: a leftover `... | tee file` wrapper
// was killed, which removed the ONLY READER of the pipe the proxy holds as
// stdout/stderr. The next stderr write raised EPIPE, and because that arrives as
// an asynchronous 'error' event on the stream — not a synchronous throw — it
// became an uncaughtException. The self-heal handler then formatted err.stack
// and wrote it to the SAME broken stderr, which raised EPIPE again. `sample`
// caught the loop verbatim:
//
//   TriggerUncaughtException -> MessageHandler::ReportMessage
//     -> ErrorStackGetter -> GetFormattedStack -> FormatStackTrace
//       -> node::PrepareStackTraceCallback -> v8::Function::Call -> ...
//
// 100% CPU for 22 minutes of CPU time, 18 connections accepted and none
// answered, while /health still returned 200. The mechanism that exists to keep
// the proxy up is what took it down.
//
// The existing say() helper does not cover this: try/catch around .write()
// catches a synchronous throw, and an EPIPE on a pipe is not one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { freePort } from "./proc-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, "fixtures", "stdio-epipe-child.mjs");

// Cumulative CPU seconds. A wedged proxy spins; a healthy one is ~0. Parsed for
// both shapes `ps` uses: MM:SS.ss (macOS) and MM:SS / HH:MM:SS (Linux).
function cpuSeconds(pid) {
  let t;
  try {
    t = execFileSync("ps", ["-p", String(pid), "-o", "time="],
                     { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const get = (port, path) => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path, timeout: 3000 },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  req.on("error", (e) => resolve(e.code || "error"));
});

describe("stdio EPIPE", () => {
  it("keeps serving after its stdout/stderr reader goes away", async () => {
    const port = await freePort();
    const env = { ...process.env };
    // An ambient proxy would send this test's own request somewhere real.
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete env[k];

    const child = spawn(process.execPath, [childPath, String(port)],
                        { env, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error("child never reported listening")), 20_000);
        child.stdout.on("data", (d) => {
          if (/listening/.test(String(d))) { clearTimeout(to); res(); }
        });
        child.on("error", rej);
        child.on("exit", (c) => rej(new Error(`child exited early, code=${c}`)));
      });

      // PRECONDITION, asserted rather than assumed: it must be serving BEFORE
      // the pipe breaks, or a later failure says nothing about this defect.
      assert.notEqual(await get(port, "/health"), "timeout",
                      "premise: the proxy must answer before the reader is removed");

      // Remove the only reader of the child's stdout and stderr. This is the
      // production event (a killed `tee`), not a simulation of it.
      child.stdout.destroy();
      child.stderr.destroy();

      // Now raise an uncaught exception from a check-phase callback, which is
      // where the real one came from.
      child.stdin.write("throw\n");

      // Give the loop a chance to establish itself. In the RED state the child
      // is pegged at 100% CPU by now.
      await new Promise((r) => setTimeout(r, 1500));
      const cpuBefore = cpuSeconds(child.pid);

      // THE ASSERTION THAT MATTERS: it still answers.
      assert.equal(await get(port, "/health"), 200,
                   "the proxy must still serve after losing its log reader");

      await new Promise((r) => setTimeout(r, 1500));
      const cpuAfter = cpuSeconds(child.pid);
      if (cpuBefore !== null && cpuAfter !== null) {
        assert.ok(cpuAfter - cpuBefore < 0.5,
          `the proxy must not spin: burned ${(cpuAfter - cpuBefore).toFixed(2)}s of CPU in 1.5s wall`);
      }
    } finally {
      child.kill("SIGKILL");
    }
  });
});
