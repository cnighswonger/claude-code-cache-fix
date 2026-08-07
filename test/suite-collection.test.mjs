import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));

// A GREEN RUN MUST MEAN THE CASES RAN, not that the ones which ran passed.
//
// Two incidents, one shape. Here: "1571 pass" was read off a per-file summary
// while one case failed 5 of 5 runs on two machines. On cswap's pin: 82 cases
// across 57 classes had NEVER EXECUTED — no driver collected them, nothing
// warned, and `60 passed` printed exactly as it would have if they ran. Both
// times a reporting layer stood between the runner and the truth, and both
// times the layer was believed.
//
// node:test does surface a missing file in its `tests` count — measured, hiding
// one file took the total from 1572 to 1567. That only helps if something reads
// the number, which is the part that failed. So this reads it.
//
// Deliberately NOT part of any helper or fixture in this suite: a guard that can
// go quiet the same way the thing it guards went quiet is not a guard.
test("every test file is reachable by the runner", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(files.length > 0, "no test files found — the glob or the directory moved");

  // A file the runner cannot parse contributes ZERO cases and still leaves the
  // suite green, because node:test reports per-file failures separately from
  // the pass count. Assert each one at least declares something.
  const empty = [];
  for (const f of files) {
    const src = readFileSync(join(testDir, f), "utf8");
    if (!/\b(it|test)\s*\(/.test(src)) empty.push(f);
  }
  assert.deepEqual(empty, [],
    `these files declare no cases, so they contribute nothing and cannot fail: ${empty.join(", ")}`);
});

// The count the runner reports must not silently fall below what the source
// declares. Executed EXCEEDING declared is normal and fine — cases generated in
// a loop are declared once and run many times. Executed BELOW declared is the
// failure mode: a file that failed to load, a describe that threw during
// collection, a case guarded behind a condition nobody meant to be false.
//
// Static, because the alternative is parsing the runner's own summary from
// inside a run it is producing.
test("no test file declares cases behind a collection-time condition", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  const conditional = [];
  for (const f of files) {
    const src = readFileSync(join(testDir, f), "utf8");
    // `if (...) it(...)` / `if (...) test(...)` at statement level: the case
    // exists in the source but may never be collected, and the summary cannot
    // tell that apart from a case that ran.
    if (/^\s*if\s*\([^)]*\)\s*(it|test)\s*\(/m.test(src)) conditional.push(f);
  }
  assert.deepEqual(conditional, [],
    `these files gate a case on a runtime condition, so a green run cannot prove ` +
    `it was collected: ${conditional.join(", ")}. Use a skip with a reason instead, ` +
    `which the runner reports.`);
});

// A WAIT WITH NO DEADLINE CANNOT FAIL — it hangs, and `node --test` has no
// default test timeout, so the case never reports, the file never finishes, and
// the job idles to the runner's cap with every check still "in progress".
// Measured on runs 31018228595 and 31033461473: node 22 finished in 39 s while
// 18 and 20 sat in_progress past 80 minutes, and nothing anywhere said "failed".
//
// Static and mechanical, because judgement is what failed here: the same shape
// was fixed in one file, then found in three more, then in a fifth after that.
// Three sweeps by hand missed it three times.
test("no test awaits a child's exit without a deadline", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  const bare = [];
  for (const f of files) {
    const src = readFileSync(join(testDir, f), "utf8");
    for (const line of src.split("\n")) {
      // Skip comments, or this guard flags the sentence describing itself.
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      // `await new Promise(... .on("exit" ...))` with nothing racing it. A
      // bounded one reads `await withDeadline(`/`await exitWithin(` instead, and
      // a `Promise.race` puts the timer on the following lines.
      // `.*?` and not `[^)]*`: the callback's own parameter list contains a
      // `)`, so a negated-paren class stops before reaching `.on("exit"` and
      // the guard silently matches nothing. Mutation-checked — the first
      // version passed with the defect reintroduced.
      if (/await\s+new\s+Promise\s*\(.*?\.on\(\s*["']exit["']/.test(line)) {
        bare.push(`${f}: ${line.trim().slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(bare, [],
    `these await a child's exit with no deadline, so a child that never exits ` +
    `hangs the whole run instead of failing: ${bare.join(" | ")}. ` +
    `Use exitWithin()/withDeadline() from ./child-deadline.mjs.`);
});

// A TEST THAT KILLS A HOLDER MUST REAP WHAT THE SELF-HEAL PUTS BACK.
//
// The product's whole point is that a proxy whose holder dies spawns a DETACHED
// replacement on the advertised port. That replacement is ppid 1, so `pgrep -P`
// cannot see it, and a reaper written the obvious way is blind to exactly the
// process it must kill. Measured: the suite leaked a holder+proxy pair on every
// run, rc=0 the whole time, and on a CI runner the leftover holds the job's
// stdout pipe — run 31040510248 froze at updated_at 19:40:46 for 30 minutes
// while other branches went green.
//
// Killing by port alone loses the race: the survivors after a 20 s sweep were
// 37 s and 17 s old, i.e. born during the sweep and again after it, because a
// holder whose listener dies simply starts another. The HOLDER has to go first.
//
// Static, because the reaper is cleanup code — nothing fails when it is deleted,
// which is how it would come back. cswap's pin had the same two halves as
// comments that could not fail, and pinned them as assertions for this reason.
test("a test that SIGKILLs a holder reaps the successor, holder first", () => {
  const src = readFileSync(join(testDir, "proxy-held-port.test.mjs"), "utf8");
  const orphan = /it\("leaves no orphan when the holder is killed outright"[\s\S]*?\n    \}\);/.exec(src)?.[0];
  assert.ok(orphan, "the orphan case moved — this no longer guards anything");

  assert.match(orphan, /listeners\(port\)/,
    "the successor is reaped by parentage, but it is detached (ppid 1) and " +
    "`pgrep -P` cannot see it — only the port it took is a durable handle");
  assert.match(orphan, /"ppid="/,
    "nothing looks up the listener's parent, so the reaper kills a listener " +
    "that a live holder immediately replaces");
});

// A FAILURE MESSAGE IS PUBLISHED OUTPUT. proxy-held-port's probes append the
// 503 body to what they assert on, and the gap relay's 503 body carries the hop
// it would forward to — so an env var that gives a child a hop and is not
// scrubbed puts a corp proxy's host:port into a red run that someone pastes
// into a public issue. That is the hostname-port class this repo's hygiene rule
// bans, and it reaches CI logs, not just terminals.
//
// Static and by pattern, because the failure mode is ADDING a var: the relay
// learns a new one, six fixtures keep scrubbing the old five, and nothing is
// red. Matching PROX rather than PROXY is not pedantry — CACHE_FIX_FALLBACK_
// PROXIES has no "PROXY" in it, and a PROXY-shaped grep missed exactly that one
// while this was being written.
test("every hop-bearing env the relay reads is scrubbed by the fixtures", () => {
  const relay = readFileSync(join(testDir, "..", "bin", "gap-relay.mjs"), "utf8");
  const reads = [...new Set([...relay.matchAll(/process\.env\.([A-Za-z_]*[Pp][Rr][Oo][Xx][A-Za-z_]*)/g)]
    .map((m) => m[1]))];
  assert.ok(reads.length >= 3, `expected the relay to read several hop vars, found ${reads.length}`);

  const src = readFileSync(join(testDir, "proxy-held-port.test.mjs"), "utf8");
  const list = /const HOP_ENV = \[([\s\S]*?)\];/.exec(src)?.[1];
  assert.ok(list, "HOP_ENV moved — the fixtures' scrub list is no longer readable from here");
  const scrubbed = new Set([...list.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]));

  for (const v of reads) {
    assert.ok(scrubbed.has(v),
      `bin/gap-relay.mjs reads ${v} but HOP_ENV does not scrub it: a machine ` +
      `with it set publishes that hop's host:port in a failing assertion`);
  }

  // And the fixtures must go through the shared list, or the next var added to
  // it reaches only the sites someone remembered.
  assert.equal(/for \(const k of \["HTTPS_PROXY"/.test(src), false,
    "a fixture still scrubs a hand-written proxy list instead of ...HOP_ENV");
});

// A PROBE THAT DROPS THE STATUS BODY COSTS AN INVESTIGATION. /health has two
// 503 authors — the relay carrying an address with no proxy behind it, and a
// proxy reporting failed extensions — and the code alone names neither. CI run
// 31137828018 failed node 18 with "cut 6 connection(s) ... ERR:503", did not
// reproduce in 9 local runs, and the log was the only witness.
//
// Static, because the way it comes back is COPYING: proxy-held-port carries
// several byte-identical probe closures, and the first fix reached three of
// them while two kept returning a bare code. A fourth copy is one paste away.
test("every /health probe carries the body it failed with", () => {
  const src = readFileSync(join(testDir, "proxy-held-port.test.mjs"), "utf8");
  const bare = [...src.matchAll(/`ERR:\$\{[qr]\.statusCode\}`/g)];
  assert.equal(bare.length, 0,
    `${bare.length} probe(s) return a bare ERR:<code>; append the body ` +
    "(`ERR:${r.statusCode} ${b.slice(0, 160)}`) or a red run cannot say which " +
    "of the two 503 authors answered");
});

// A SOCKET MAY BE ENDED ONCE, AND A data HANDLER RUNS PER READ. Calling end()
// or write() on the socket from inside its own data handler is therefore a bet
// that no second read arrives, and whether one does is pure timing: how the
// peer's writes are coalesced, how loaded the box is, which libuv version.
//
// CI node 22 collected on that bet (run 31146142838): "write after end",
// ERR_STREAM_WRITE_AFTER_END, uncaughtException, while 18 and 20 passed and no
// local run of the case ever split the reads. Reproduced away from the suite
// with a 1KiB drip writer — unguarded: UNCAUGHT ERR_STREAM_WRITE_AFTER_END,
// guarded: end() once, clean.
//
// Static and by SHAPE, because the way it returns is a paste. When this was
// written the tree held exactly two of these; one had just cost a red CI and
// the other, `s.on("data", () => s.end("pong"))`, was still live and had simply
// not been unlucky yet.
//
// Matched on the receiver, not on the word: `r.on("end", …)` one line below a
// data handler REGISTERS a listener and calls nothing — a looser pattern
// counted 18 sites, all but one of them that false shape, and a guard that
// crying wolf 17 times out of 18 is a guard somebody deletes.
test("no test ends a socket from inside its own data handler, unguarded", () => {
  const pat = /(\w+)\.on\(\s*"data"\s*,\s*(?:async\s*)?\(?[^)]*\)?\s*=>\s*/g;
  const bad = [];
  // This file is skipped because it CONTAINS the pattern as data — it matched
  // itself on the first run, which is the shape of every static check that
  // reads the directory it lives in.
  for (const f of readdirSync(testDir).filter((n) => n.endsWith(".mjs") && n !== "suite-collection.test.mjs")) {
    const src = readFileSync(join(testDir, f), "utf8");
    for (const m of src.matchAll(pat)) {
      const obj = m[1];
      let depth = 0, i = m.index + m[0].length, end = src.length;
      while (i < src.length) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") { if (depth === 0) { end = i; break; } depth--; }
        i++;
      }
      const body = src.slice(m.index + m[0].length, end);
      if (!new RegExp(`\\b${obj}\\.(end|write)\\s*\\(`).test(body)) continue;
      if (/\bif\s*\(\s*!\w+/.test(body)) continue;          // answer-once guard present
      bad.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bad, [],
    `these end/write on the socket from inside its own data handler with no ` +
    `answer-once guard, so a second read throws ERR_STREAM_WRITE_AFTER_END: ` +
    `${bad.join(", ")}`);
});
