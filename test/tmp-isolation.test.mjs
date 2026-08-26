// What file-tmpdir.mjs sells, measured through a real process boundary rather
// than read off its source.
//
// The property is not "the file cleans up after itself". It is that the scratch
// of the process AND of everything it spawns lands somewhere private that is
// gone when the process exits — the launcher writes its port record under its
// own os.tmpdir(), and on a box that is also RUNNING the product that record is
// named after a port a live holder may be serving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "file-tmpdir.mjs");
// The grandchild is the point: the launcher is a CHILD and reads its own
// os.tmpdir(), so a redirection that does not cross the boundary isolates
// nothing. Both markers are checked by the probe before it exits, because an
// empty directory proves nothing if neither was ever written.
const KID = 'require("node:fs").writeFileSync(require("node:path").join(require("node:os").tmpdir(), "kids"), "")';
const PROBE = `
import ${JSON.stringify(MODULE)};
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
writeFileSync(join(tmpdir(), "mine"), "");
spawnSync(process.execPath, ["-e", ${JSON.stringify(KID)}]);
for (const m of ["mine", "kids"]) {
  if (!existsSync(join(tmpdir(), m))) { console.error("marker never written: " + m); process.exit(3); }
}`;

test("a process that imports it leaves the tmpdir it inherited empty", () => {
  const outer = mkdtempSync(join(tmpdir(), "ccf-tmpiso-"));
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE],
                        // Every key, for the reason the case below measures: on
                        // Windows os.tmpdir() would ignore TMPDIR and this would
                        // pass without the redirection ever being exercised.
                        { env: { ...process.env, TMPDIR: outer, TMP: outer, TEMP: outer },
                          encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0,
      `the probe never got far enough to measure anything: ${r.error ?? ""} ${r.stderr}`);
    // Red both ways: with no redirection the markers land here, and with no
    // cleanup the private dir stays here holding them.
    assert.deepEqual(readdirSync(outer), [],
      "the process left scratch in the tmpdir it inherited — on a developer's box " +
      "that is the shared /tmp, where the launcher's records are named after ports " +
      "a live proxy may be serving");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("it redirects every key os.tmpdir() reads, not just this platform's", () => {
  // os.tmpdir() reads TMPDIR on POSIX and TEMP then TMP on Windows. Setting only
  // the one THIS platform happens to read leaves a Windows run writing to the
  // shared root -- and the case above still passes there, because the inherited
  // directory is empty for never having been used rather than for being isolated.
  // That is the shape the brief calls out: a green suite proving the wrong path.
  const PROBE_KEYS = `
import ${JSON.stringify(MODULE)};
import { tmpdir } from "node:os";
const priv = tmpdir();
const bad = ["TMPDIR", "TMP", "TEMP"].filter((k) => process.env[k] !== priv);
if (bad.length) { console.error("still on the inherited root: " + bad.join(",")); process.exit(4); }
`;
  const outer = mkdtempSync(join(tmpdir(), "ccf-tmpkeys-"));
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_KEYS],
                        { env: { ...process.env, TMPDIR: outer, TMP: outer, TEMP: outer },
                          encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0,
      `a key os.tmpdir() can read was left on the inherited root: ${r.stderr.trim()}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
