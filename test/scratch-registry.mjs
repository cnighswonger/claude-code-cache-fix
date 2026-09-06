// Scratch dirs that survive the failure they exist to explain.
//
// A test body that throws never reaches its own cleanup, so every dir is
// registered here. Removal is gated on the FILE's outcome: after a green run the
// scratch is litter, after a red one it is the only record of what the case was
// looking at when it died.
//
// `process.on("exit")` and not `after()`, because the hook runs too early to
// know: measured on node 24, `process.exitCode` is `undefined` inside a
// file-level `after()` on a file that HAS a failure, and `1` by exit on the same
// file (and `undefined` at both points on a file without one).
//
// Sync removal for the same reason -- an exit handler cannot await, so a
// promise-based rm would be registered and never run.
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registered = [];

export async function scratchDir(prefix) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  registered.push(d);
  return d;
}

process.on("exit", () => {
  for (const d of registered) {
    // Named on the way out, or keeping them helps nobody: the runner's output is
    // the only place the caller will look for the path.
    if (process.exitCode) { process.stderr.write(`[scratch kept] ${d}\n`); continue; }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
