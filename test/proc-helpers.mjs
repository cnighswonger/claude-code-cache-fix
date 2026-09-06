// Process and port helpers shared by every test file that signals a pid or
// needs an unused port.
//
// One copy, because the four hand-rolled ones cost a test whose entire job was
// to keep them in sync: `no test file signals a pid it knows only by port` in
// suite-collection.test.mjs pinned the OURS expression in each file and checked
// there was exactly one lsof call in each. That guard is deleted with this
// module — a shared definition cannot drift, so there is nothing left to police.
// The drift was already starting: `listeners` was byte-identical in three files
// and an arrow function in a fourth, and freePort had three different shapes.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";

// NEVER SIGNAL A PID WE KNOW ONLY BY PORT. freePort() binds 0, reads the number
// and CLOSES, so the OS can hand it to a NEIGHBOURING TEST FILE — node:test runs
// files concurrently and several of them listen in-process. Every caller signals
// or counts what listeners() returns, so an unfiltered answer kills another
// runner: measured, and it is CI run 32087202771.
//
// The predicate is the COMMAND LINE, and it was got wrong twice before landing
// here: matching `node` alone claims every node process on the box, and matching
// a bare filename claims a test file that happens to be named for one of ours.
// A path segment of `bin/` or `proxy/` ending in `.mjs` is what only our
// binaries have.
export const OURS = /\/(?:bin|proxy)\/[\w.-]+\.mjs\b/;

// AND THE SUITE'S OWN STAND-INS, which that predicate cannot see. Cases here
// write a fake proxy into a fresh temp dir and run it — a real process, ours by
// construction, whose path contains neither `bin/` nor `proxy/`. The launcher
// stand-in escaped only by accident of LOCATION: its copy lands in `bin/`, so it
// matched, while its server did not. Measured as five reds in CI run
// 32409699496, every one of them killOurs() refusing to signal a fake proxy the
// case had spawned itself moments earlier — a guard firing on legitimate work,
// which is the failure that trains the `catch {}` this guard forbids.
//
// The evidence here is STRONGER than a path segment, not weaker, which is what
// makes this a widening rather than a softening. Stand-in names are built from
// `${process.pid}-${++fakeSeq}` (proxy-held-port.test.mjs), so a command line
// carrying OUR pid inside a filename WE generated cannot belong to a stranger.
// A bare `scratch-fake-server-` match could, and is deliberately not what this
// does. Rebuilt per call rather than frozen at import, so a forked runner cannot
// inherit its parent's claim.
//
// Scope, so the next reader does not widen further by analogy: this reaches
// killOurs() ONLY. listeners() and ours() answer "which PROXY holds this port",
// where a stand-in is not wanted, and every case needing its own stand-in
// already finds it from the launcher it spawned.
const scratchOurs = () =>
  new RegExp(`\\bscratch-(?:launcher|fake-server)-${process.pid}-\\d+\\.mjs\\b`);

/** Is this command line one of ours — our binaries, or our own stand-ins? */
export function isOurs(cmd) {
  return OURS.test(cmd) || scratchOurs().test(cmd);
}

// The command line of a pid, or "" if it is gone. Every case has to tell a
// holder from a proxy from a standby relay, and they are only distinguishable
// by what they are running.
export const cmdOf = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); }
  catch { return ""; }
};

// Whoever is LISTENING on a port, by port rather than by parentage. The
// self-heal spawns a DETACHED successor, so it is nobody's child and `pgrep -P`
// cannot see it — the only durable handle on it is the address it took.
//
// Filtered HERE and not at the call sites, because it already existed at some of
// them and the rest never got it.
export function listeners(port) {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean)
      .filter((p) => OURS.test(cmdOf(p)));
  } catch { return []; }
}

// EVERY FIXTURE ON A PORT, LISTENING OR NOT.
//
// listeners() is `lsof -sTCP:LISTEN`, so it finds a process only while it HOLDS
// THE LISTEN. The standby's whole job is to hand the listen on and keep carrying
// the address, so after a handover it is a live process no sweep can see.
// Measured, two orphans side by side:
//   pid=2404217 ppid=1 port=45855  lsof-sees-it=0   bin/gap-relay.mjs
//   pid=2406768 ppid=1 port=41031  lsof-sees-it=1   bin/gap-relay.mjs
// The invisible ones accumulate — ten at once here, the oldest 788 s, across
// files and runs — and they hold ports and CPU that the NEXT file's readiness
// assertions then time out on. Every "node 20 flake" on this branch has had that
// shape, including a runner found at 414 s with zero CPU, wedged rather than slow.
//
// THE PORT A FIXTURE WAS GIVEN IS IN ITS ENVIRONMENT AND STAYS THERE. That is
// the identifier that survives handing the listen on. Both markers are read
// because the trio does not agree on one: measured on a live trio,
//   claude-via-proxy.mjs  CACHE_FIX_PROXY_PORT=<port>   (no HELD_PORT)
//   gap-relay.mjs         both
//   proxy/server.mjs      CACHE_FIX_HELD_PORT=<port>, PROXY_PORT=0
//
// Still filtered by OURS, for the same reason listeners() is: a port number is
// not ownership, and freePort() hands the same number to neighbouring files.
export function ours(port) {
  const want = new RegExp(`CACHE_FIX_(?:HELD|PROXY)_PORT=${Number(port)}(?:\\s|$)`);
  const out = [];
  try {
    // Linux: /proc is authoritative and needs no shell-out.
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let env = "";
      try { env = readFileSync(`/proc/${pid}/environ`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (want.test(env) && OURS.test(cmdOf(pid))) out.push(pid);
    }
    return out;
  } catch { /* no /proc: ask ps below */ }
  try {
    // macOS: `ps -wwE` prints the environment after the command. Verified there.
    const rows = execFileSync("ps", ["-wwEo", "pid=,command="],
                              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of rows.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && want.test(m[2]) && OURS.test(m[2])) out.push(m[1]);
    }
  } catch { /* no ps either: the caller falls back to listeners() */ }
  return out;
}

// A port nobody is listening on RIGHT NOW. It is released before the caller
// uses it — see the OURS note above for what that costs and how it is bounded.
export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// EVERY variable that can give a child an outbound hop, in one list because six
// fixtures scrub it and a per-fixture copy is how one gets missed. It was: five
// of them dropped the four *_PROXY names and none dropped the two CACHE_FIX
// ones, which the relay reads FIRST (bin/gap-relay.mjs) — so a maintainer behind
// a corp proxy ran the suite, the relay carried to it, and its host:port went
// into the 503 body that a failure message now prints. This repo is public and
// that is the hostname-port class its hygiene rule bans.
export const HOP_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                        "ALL_PROXY", "all_proxy",
                        "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_REQUIRE_HOP",
                        "CACHE_FIX_FALLBACK_PROXIES"];

// THE ONLY WAY THIS SUITE MAY SIGNAL A PID IT DID NOT SPAWN.
//
// A raw `process.kill(n, "SIGKILL")` over a pid list is one bad list away from
// killing something that is not ours, and the machine gives no second chance:
// a run here SIGKILLed `systemd --user`, which made PID 1 tear down the whole
// session cgroup — every editor, browser and terminal on the desktop, four
// times in one afternoon. The kernel audit record named the sender as this
// suite's own runner; which call site passed the pid is STILL UNKNOWN, and
// that is exactly why the check belongs at the choke point rather than at the
// site someone suspects.
//
// THROWS rather than skipping, because a silent skip would have hidden this
// for another four collapses. The throw carries the pid and its command line,
// so the next occurrence is a red test naming the offender instead of a lost
// desktop. `child.kill()` on a handle this process spawned is unaffected — it
// cannot name a stranger — and needs no guard.
export function killOurs(pid, signal = "SIGKILL") {
  const n = Number(pid);
  // NEGATIVE FIRST, or this branch is unreachable: every negative also fails
  // `n <= 1`, so ordering it second made it dead code that read as a guard.
  // Caught by the two-sided probe that proved this function, not by review.
  if (Number.isInteger(n) && n < 0) {
    throw new Error(`refusing to signal ${n}: a negative pid is a process-GROUP kill, ` +
                    `and the group id is not ours to assume. Signal the members.`);
  }
  if (!Number.isInteger(n) || n <= 1) {
    throw new Error(`refusing to signal pid ${JSON.stringify(pid)}: ` +
                    `not a pid. Number("") and Number(undefined) are both 0, and ` +
                    `process.kill(0, …) signals this runner's entire process group.`);
  }
  // GONE IS NOT AN OFFENCE. A cleanup sweep races the processes it reaps, so
  // an empty command line means the pid died on its own — return false and let
  // the loop continue. Throwing here would make every ordinary sweep red and
  // train the `catch {}` that silences the real case below.
  const cmd = cmdOf(n).trim();
  if (!cmd) return false;
  // ALIVE AND NOT OURS IS THE DEFECT, and it is LOUD by design: a silent skip
  // is what let this run four times before anyone knew where it came from.
  if (!isOurs(cmd)) {
    throw new Error(`refusing to ${signal} pid ${n}: it is alive and its command ` +
                    `line is not one of ours.\n` +
                    `  command: ${cmd}\n` +
                    `  ours:    ${OURS}\n` +
                    `  or our own stand-ins: ${scratchOurs()}\n` +
                    `This is the guard that exists because this suite SIGKILLed the ` +
                    `session manager and took the desktop down with it. Filter the ` +
                    `pid at its source; do not catch this.`);
  }
  process.kill(n, signal);
  return true;
}

// THE CLEANUP SET: everything on this port, listening or not. listeners() alone
// misses a standby that has handed its listen on — measured, ten such orphans at
// once, the oldest 788 s, accumulating across files and runs until a later
// file's readiness assertion times out on the CPU and ports they hold. See
// ours() for the mechanism and the two markers it reads.
export const onPort = (port) => [...new Set([...listeners(port), ...ours(port)])];
