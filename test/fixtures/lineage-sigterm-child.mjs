// Child for orphan-lineage-sweep-harness.test.mjs's SIGTERM case. Arms a
// lineage exactly as a real test file does, spawns the relative-path
// `proxy/server.mjs` OURS is supposed to recognise, then idles so the parent
// can SIGTERM it — the shape the file children in shutdown-exit-code.test.mjs
// and proxy-integration.test.mjs actually run under.
import { spawn } from "node:child_process";
import { HOP_ENV, armLineage, stamped } from "../proc-helpers.mjs";

// Bare `node --test` (no path arguments, what `npm test` runs) auto-discovers
// EVERY .mjs under a directory named `test`, `fixtures/` included, and runs
// each as its own independent test file with no default timeout
// (`--test-timeout=0`). Run that way this file is never spawned by our own
// test and so never SIGTERMed — measured: it hung the whole suite forever.
// LINEAGE_SIGTERM_DRIVE is the marker only the real test sets; its absence
// means "auto-discovered", so exit immediately rather than idle.
if (!process.env.LINEAGE_SIGTERM_DRIVE) process.exit(0);

const marker = armLineage("lineage-sigterm-child");

const env = { ...process.env, CACHE_FIX_PROXY_PORT: "0" };
for (const k of HOP_ENV) delete env[k];
const grandchild = spawn(process.execPath, ["proxy/server.mjs"], {
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

// Poll rather than trust spawn() timing: the parent needs the grandchild's
// pid to already satisfy OURS+marker before it signals readiness, or a
// SIGTERM sent too early races the exec() that makes cmdOf() match.
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  if (stamped(marker).includes(String(grandchild.pid))) break;
  await new Promise((r) => setTimeout(r, 25));
}

process.stdout.write(`MARKER:${marker}\nPID:${grandchild.pid}\n`);

// Idle until the parent's SIGTERM arrives; armLineage()'s own backstop is
// what is under test.
await new Promise(() => {});
