// A private TMPDIR for the importing test file — `import "./file-tmpdir.mjs";`,
// for side effect, first among its imports.
//
// The ENV VAR rather than a path threaded through each spawn: the launcher
// writes `cache-fix-proxy-<port>.sha256` and its scratch CA under its OWN
// os.tmpdir(), so the isolation only reaches it by being inherited. node:test
// gives each FILE its own process, so one dir per file falls out of that.
//
// `exit`, not after(): it runs after every hook, so it cannot delete the dir
// out from under a sweep that reaps ports once the cases are done, and it is
// armed before the importing file's body runs rather than at the end of it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE_TMP = mkdtempSync(join(tmpdir(), "ccf-test-"));
// ALL THREE, because os.tmpdir() reads a DIFFERENT one first per platform:
// TMPDIR || TMP || TEMP on POSIX, TEMP || TMP on Windows. Setting only the key
// this platform happens to read first leaves a run on another platform writing
// to the shared root.
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = FILE_TMP;
process.on("exit", () => {
  try { rmSync(FILE_TMP, { recursive: true, force: true }); } catch { /* already gone */ }
});
