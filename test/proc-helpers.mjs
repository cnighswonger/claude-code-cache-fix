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
