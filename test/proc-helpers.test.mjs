// proc-helpers — the ownership predicate, which is the whole safety property of
// this branch and had no test of its own until it shipped red.
//
// DEFINITION, written before the assertions. killOurs() exists to answer one
// question: may this process signal that pid? It must answer YES for processes
// this suite owns and NO for everything else, and BOTH directions are load
// bearing:
//
//   a NO that should be YES is a guard firing on legitimate work. That is not
//   a safe failure — it trains the `catch {}` around killOurs() that the guard
//   itself forbids, and it is what happened: five reds in CI run 32409699496,
//   every one of them refusing to signal a fake proxy the case had spawned
//   itself moments earlier.
//
//   a YES that should be NO is the original outage: SIGKILL to `systemd --user`
//   tears down the session cgroup, SIGTERM to it starts exit.target. Four
//   desktops on 2026-08-20, one more on 2026-08-22.
//
// So the arms come in pairs and the negatives are not decoration. The one that
// carries the most weight is "a DIFFERENT runner's stand-in": it has the exact
// shape of one of ours and must still be refused, which is what separates
// ownership evidence from a name that merely looks familiar. Without it, a bare
// `scratch-fake-server-` match would pass every other arm here.
//
// The first case is the real command line from that CI run, with this process's
// pid substituted for the runner's — a case known to carry the property, taken
// from the failure rather than constructed to pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOurs, OURS } from "./proc-helpers.mjs";

const P = process.pid;

const CASES = [
  [`/opt/hostedtoolcache/node/22.23.2/x64/bin/node /tmp/ccf-fake-proxy-${P}-3-PDRL3r/scratch-fake-server-${P}-3.mjs`,
   true, "our own fake proxy — the command line behind all five CI reds"],
  [`/usr/bin/node /home/x/repo/bin/scratch-launcher-${P}-3.mjs`,
   true, "our own launcher stand-in (matched before only by accident of living in bin/)"],
  [`/usr/bin/node /home/x/repo/proxy/server.mjs`,
   true, "the real proxy — OURS, and this must not have changed"],
  [`/usr/bin/node /home/x/repo/bin/gap-relay.mjs`,
   true, "a real bin/ helper — OURS, unchanged"],
  [`/usr/bin/node /tmp/ccf-fake-proxy-${P + 1}-3-xx/scratch-fake-server-${P + 1}-3.mjs`,
   false, "a DIFFERENT runner's stand-in — same shape, not ours"],
  [`/usr/lib/systemd/systemd --user`,
   false, "systemd --user — the process whose death takes the desktop with it"],
  [`/usr/bin/node /home/x/other/tools/harvest.mjs`,
   false, "an unrelated node process"],
  [`node`,
   false, "a bare interpreter claims nothing"],
];

test("the ownership predicate admits ours and refuses everything else", () => {
  for (const [cmd, want, why] of CASES) {
    assert.equal(isOurs(cmd), want, `${why}\n  command: ${cmd}`);
  }
});

test("the stand-in claim is keyed to THIS process, not to the name", () => {
  // The same file name under another runner's pid must not be claimable — this
  // is the property that makes the widening ownership evidence rather than a
  // softer pattern. Stated separately from the table so it cannot be lost in a
  // future edit that "simplifies" the list.
  const mine = `/usr/bin/node /tmp/d/scratch-fake-server-${P}-1.mjs`;
  const theirs = `/usr/bin/node /tmp/d/scratch-fake-server-${P + 1}-1.mjs`;
  assert.equal(isOurs(mine), true, "our own stand-in must be claimable");
  assert.equal(isOurs(theirs), false, "another runner's stand-in must not be");
  assert.notEqual(isOurs(mine), isOurs(theirs),
    "the two must DIFFER — equal answers here mean the pid is not being read");
});

test("OURS itself is unchanged: it still refuses what it always refused", () => {
  // isOurs() is a union, so a regression that widened OURS would be invisible
  // in the table above. Assert on OURS directly.
  assert.equal(OURS.test("/usr/lib/systemd/systemd --user"), false);
  assert.equal(OURS.test(`/usr/bin/node /tmp/d/scratch-fake-server-${P}-1.mjs`), false,
    "the stand-in must be admitted by the stand-in clause, never by OURS");
  assert.equal(OURS.test("/usr/bin/node /home/x/repo/proxy/server.mjs"), true);
});
