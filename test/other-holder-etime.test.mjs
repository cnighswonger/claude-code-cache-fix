// otherHolderOn asks `ps` how long a candidate holder has been alive. GNU ps
// answers `etimes=` in seconds; BSD ps (macOS) has no `etimes`, so the probe
// failed there and the surplus rule never fired. `etime=` exists on both and
// prints `[[dd-]hh:]mm:ss`.
//
// otherHolderOn is lifted from the launcher source, the way
// proxy-held-port.test.mjs lifts it, because the launcher runs on import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs"), "utf8");
const rule = /function otherHolderOn[\s\S]*?\n}/.exec(launcher)?.[0];

// What the rule answers for a `ps` that prints `age`, in a launcher that has
// been up `uptime` seconds. Only the pid, the age and the ps arguments matter
// here; the code-identity and probe helpers are answered, not exercised.
function decide(age, uptime, psArgs = []) {
  const probe = (cmd, args) => {
    if (cmd === "lsof") return "4242\n";
    psArgs.push(...args);
    return `${age} node /usr/local/bin/cache-fix-proxy run-service\n`;
  };
  // eslint-disable-next-line no-new-func
  return Function("probe", "lsofAddr", "warn", "runningOurCode", "warnUncomparable", "process",
    `${rule}\nreturn otherHolderOn(9901);`)(
    probe, () => "127.0.0.1", () => {}, () => true, () => {}, { pid: process.pid, uptime: () => uptime });
}

test("otherHolderOn: reads BSD and GNU etime, so an older run-service is found on macOS too", () => {
  assert.ok(rule, "otherHolderOn is gone from the launcher");
  const args = [];
  assert.equal(decide("02:00", 100, args), 4242, "mm:ss, older than us");
  assert.ok(args.includes("etime=,command="), `ps was asked for ${args.join(" ")}, not etime`);
  assert.equal(decide("00:05", 100), 0, "mm:ss, younger than us: not surplus");
  assert.equal(decide("01:00:00", 100), 4242, "hh:mm:ss");
  assert.equal(decide("2-03:04:05", 100), 4242, "dd-hh:mm:ss");
  assert.equal(decide("999999", 100), 4242, "a bare seconds count still reads (the long-standing fake)");
  assert.equal(decide("n/a", 100), 0, "unreadable age is skipped, not guessed");
});
