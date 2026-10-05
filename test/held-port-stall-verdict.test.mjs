import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hit, verdict } from "./proc-helpers.mjs";

// A stalled runner is not a hung connection. When the runner's loop is blocked
// past the 3s clock of proxy-held-port's "serves every concurrent request", every
// timer fires ahead of the poll phase that would read the replies already on the
// sockets. Measured: "200 of 200 concurrent requests were not served: HUNG".
// The healthy server is in ANOTHER process, since one in this loop would stall too.
//
// ITS OWN FILE, ON PURPOSE: the check blocks the loop deliberately, and node runs
// each file in its own process. Inside proxy-held-port it left "fails loudly when
// the bind address can never work" with an empty stderr: red in 4 of 4 file-alone
// runs with the check present, 0 of 5 without it.
it("does not read a reply that arrived during a runner stall as HUNG", { timeout: 30_000 }, async () => {
  const N = 20, dir = mkdtempSync(join(tmpdir(), "stall-")), marker = join(dir, "answered");
  // The child writes the marker once its Nth reply is flushed, so the stall below
  // ends on that fact and not on a clock a cold child on a loaded host can miss.
  const srv = spawn(process.execPath, ["-e",
    `let n = 0;
     const s = require("http").createServer((q, r) => {
       r.on("finish", () => { if (++n === ${N}) require("fs").writeFileSync(process.argv[1], ""); });
       r.end("ok");
     });
     s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
     process.stdin.on("end", () => process.exit()).resume();`, marker],   // EOF: the runner is gone
  { stdio: ["pipe", "pipe", "inherit"] });
  try {
    const port = Number(await new Promise((res, rej) => {
      srv.on("error", rej);
      srv.on("exit", (c) => rej(new Error(`the server exited (${c}) before printing its port`)));
      srv.stdout.once("data", res);
    }));
    const reqs = Array.from({ length: N }, () => hit(port));
    const out = reqs.map((r) => verdict(r, 250));
    await Promise.all(reqs.map((r) => once(r, "finish")));   // every request is out
    // Stall until every reply is flushed AND twice the 250ms clock has passed, so
    // every timer is due ahead of the poll phase that reads the replies.
    const t0 = Date.now(), nap = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(marker) || Date.now() - t0 < 500) {
      assert.ok(Date.now() - t0 < 10_000, `the server did not answer ${N} requests within 10s`);
      Atomics.wait(nap, 0, 0, 20);
    }
    assert.deepEqual([...new Set(await Promise.all(out))], ["ok"], "every reply was already on its socket");
  } finally {
    srv.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
