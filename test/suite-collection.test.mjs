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

// A LAUNCHER THAT IS SIGKILLED LEAVES A DETACHED STANDBY ON ITS PORT. It stands
// down only for a claimant's SIGHUP, so the kill reparents it to init still
// listening — measured, one per run from proxy-fingerprint-reap's spawn case,
// eight alive at once, the oldest over three hours, each one a listener in the
// band the suite's own fixtures bind from.
//
// Swept over every file rather than named, because the guard above went blind
// the moment a second file learned the same debt. Any spelling of the sweep
// counts: onPort(), listeners(), or a raw lsof -iTCP. A file that kills a
// launcher and genuinely has nothing to sweep says so with NO-STANDBY: and why
// — proxy-probe-bounded blocks in a probe before it binds, measured at three
// deadlines.
test("every test that SIGKILLs a launcher sweeps the port or says why not", () => {
  const offenders = [];
  for (const f of readdirSync(testDir).filter((n) => n.endsWith(".test.mjs"))) {
    if (f === "suite-collection.test.mjs") continue;
    const src = readFileSync(join(testDir, f), "utf8");
    if (!/claude-via-proxy\.mjs|launcherPath/.test(src)) continue;
    if (!/SIGKILL/.test(src)) continue;
    if (/onPort\(|listeners\(|process\.kill\(-/.test(src)) continue;
    if (/NO-STANDBY:/.test(src)) continue;
    offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    "these spawn a launcher and SIGKILL it without reaping what it left on the " +
    "port, and without saying why none is owed");
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

  const src = readFileSync(join(testDir, "proc-helpers.mjs"), "utf8");
  const list = /HOP_ENV = \[([\s\S]*?)\];/.exec(src)?.[1];
  assert.ok(list, "HOP_ENV moved — the fixtures' scrub list is no longer readable from here");
  const scrubbed = new Set([...list.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]));

  for (const v of reads) {
    assert.ok(scrubbed.has(v),
      `bin/gap-relay.mjs reads ${v} but HOP_ENV does not scrub it: a machine ` +
      `with it set publishes that hop's host:port in a failing assertion`);
  }

  // And the fixtures must go through the shared list, or the next var added to
  // it reaches only the sites someone remembered.
  const fixture = readFileSync(join(testDir, "proxy-held-port.test.mjs"), "utf8");
  assert.equal(/for \(const k of \["HTTPS_PROXY"/.test(fixture), false,
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

// Index of the delimiter that closes the one opening at `open`. Six copies of
// this loop had accumulated across the guards below, in two variants — braces
// only, and one that counts (), [] and {} together for a call's argument list. They are the same
// walk, and a guard whose slice is computed by a subtly different copy is a
// guard that goes quiet without anyone editing it: two of these drifted apart
// this round and each let through the defect its assertion was written for.
//
// Returns -1 when it never closes, which every caller must treat as "could not
// look" rather than "nothing found" — a slice that runs to end-of-file contains
// almost anything you might assert about.
// Comments blanked to spaces, LINE COUNT AND EVERY OTHER BYTE PRESERVED, so an
// index computed against the result still points at the same place in the
// original. Callers balance braces over this, and a `}` in prose otherwise votes
// on where a block ends — measured, a one-line comment ending in `}` shrank a
// slice enough to hide the statement its assertion forbids, and the size ceiling
// could not see it because the slice got SMALLER.
//
// Strings are copied verbatim, so a `//` or `/*` inside one is not a comment —
// and a `/*` inside a LINE comment cannot open a phantom block that runs to the
// next real `*/`, which over raw source blanked 26 lines of bin/claude-via-
// proxy.mjs and moved its brace balance from 0 to -1.
//
// The self-check below is a POSITIVE one — it asserts no comment opener survives
// — because the two conservative invariants it replaced (line count, brace
// balance) were both preserved by the failure that actually happened.
function stripComments(src) {
  // A ONE-PASS SCANNER with three states — string, regex literal, comment —
  // because each one of them can contain the others' delimiters and every
  // shortcut here has already been defeated once:
  //
  //   `"https://api.anthropic.com"` — a `//` inside a STRING. Blanking from
  //     there deleted the rest of the line, including the `}` that followed;
  //     measured on two files, the tree's brace balance moved by one.
  //   `.replace(/"/g, "")` — a quote inside a REGEX. Treating it as a string
  //     opener runs to the next quote in the file and copies everything between
  //     VERBATIM, comments included. Measured: a comment survived, and with it
  //     the pre-fix gap-relay handler passed its guard.
  //
  // Regex-vs-division is decided by what precedes the `/`: after a value
  // (identifier, `)`, `]`, literal) it is division; otherwise a literal. That is
  // the standard heuristic and it is not perfect — which is what the positive
  // self-check below is for.
  let out = "", i = 0, prev = "";
  const kept = new Set();                          // output indices copied verbatim
  const copyTo = (close, esc) => {                 // copy verbatim until `close`
    const from = out.length;
    out += src[i]; i++;
    while (i < src.length && src[i] !== close) {
      if (esc && src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
      if (close === "/" && src[i] === "[") {       // a class may hold an unescaped /
        while (i < src.length && src[i] !== "]") { out += src[i]; i++; }
      }
      out += src[i]; i++;
    }
    out += src[i] ?? ""; i++;
    for (let k = from; k < out.length; k++) kept.add(k);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { copyTo(c, true); prev = "x"; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "/" && !/[\w)\]]/.test(prev)) { copyTo("/", true); prev = "x"; continue; }
    out += c; i++;
    if (!/\s/.test(c)) prev = c;
  }
  // NO SELF-CHECK, BECAUSE NONE OF THEM COULD SEE THE FAILURE THAT HAPPENED.
  //
  // Three were tried. Line count and brace balance are both preserved when the
  // scanner mistakes code for a literal and copies a comment through verbatim —
  // not one byte moves. The third asked "did a comment opener survive", computed
  // from the scanner's own record of what it copied verbatim — and that record
  // is exactly where such a comment sits, so the check erased it before looking.
  // Measured: feeding the pre-fix scanner the shape it was written for left the
  // comment intact and every check green.
  //
  // A heuristic that cannot certify itself must not pretend to. What protects
  // the guards instead is that each one FAILS CLOSED on anything it cannot parse
  // (see the `unparsed` push in the shell-out guard) and that the two anchored
  // guards read only the two files this scanner is verified against — checked by
  // hand, line by line, against every literal in them.
  return out;
}

// `mode` is "brace" (match {} only) or "any" (match (), [] and {} together, for
// a call's argument list). Named rather than inferred from a third character in
// a pair string: that spelling silently ignored the pair it was given whenever
// the string was long enough, so a caller passing "()" would have got a walk it
// never asked for with nothing to signal it.
function closesAt(src, open, mode = "brace") {
  const opens = mode === "any" ? "([{" : "{";
  const closes = mode === "any" ? ")]}" : "}";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (opens.includes(src[i])) depth++;
    else if (closes.includes(src[i])) { if (--depth === 0) return i; }
  }
  return -1;
}

// A HANDOVER THAT DID NOT HAPPEN MUST LEAVE A HOLDER THAT STILL WORKS.
//
// The SIGUSR2 handler kills its standby, hands the port to a successor and
// exits. When the successor never starts, three things have to be true or the
// holder is left alive with no proxy, no standby, or no way to ever start one:
//
//   1. recovery exists in one place, reachable from BOTH failure modes;
//   2. the spawn's async 'error' is wired to it — EAGAIN/ENOMEM under fork
//      pressure are EMITTED, not thrown, so the try/catch cannot see them and
//      an unhandled one on a ChildProcess is an uncaughtException that kills
//      the holder outright;
//   3. recovery goes through the restart LADDER, not straight to a spawn —
//      calling spawnWhenReady() directly cancels the backoff and a deploy
//      watcher retrying SIGUSR2 then burns one immediate respawn per signal,
//      the shape measured at 51 respawns in 1.2s.
//
// STATIC, because reaching the sync catch needs spawn() to throw and node
// reports a missing executable as an 'error' EVENT — the only synchronous
// throws are option validation on values this handler computes itself. There
// is no external lever, and lifting the handler means supplying its whole
// closure. Three static guards already exist in this file for that trade.
//
// Anchored by brace-walking the recovery function and bounded by a length
// assertion: an earlier cut anchored on `lastIndexOf("catch")`, which matched
// the word inside a nearby COMMENT and widened the slice to 1,587 chars of
// unrelated code. A guard whose scope grows when its subject moves reports on
// whatever happens to be nearby.
test("a retry's error listener leaves when the bind succeeds", () => {
  const src = stripComments(readFileSync(join(testDir, "..", "bin", "claude-via-proxy.mjs"), "utf8"));

  // COUNTED, NOT WINDOWED. The first cut matched a few lines after `const again`
  // and broke the moment the fix made one of the two arrows multi-line — the
  // third time today a guard of mine was defeated by its own byte window rather
  // than by the code. Pairing the counts asks the question directly: every
  // ladder that ARMS an error listener must also arm the success handler that
  // takes it off again.
  const armed = (src.match(/holder\.on\("error", again\)/g) || []).length;
  const disarmed = (src.match(/holder\.on\("listening", settled\)/g) || []).length;

  // BOTH LADDERS. release()'s is the live one; reclaim()'s is unreachable today
  // (its `bound` guard never resets — measured), which is exactly why it must
  // not be left as a trap for whoever revives it.
  assert.equal(armed, 2,
    `expected two retry ladders arming holder.on("error", again), found ${armed} — ` +
    `they moved, and this guard no longer describes them`);

  // `again` removes itself only when it FIRES. The listen that SUCCEEDS never
  // emits 'error', so without a success handler it stays attached for the life
  // of the process — and in release() it points at a `deadline` captured 20 s
  // before the winning bind, so a later 'error' re-enters retry(), reads
  // Date.now() > deadline, prints "could not take port within 20s" and settles
  // 1 on a holder that is live and serving.
  assert.equal(disarmed, armed,
    `${armed} ladders arm an 'error' listener but only ${disarmed} remove it on the ` +
    `SUCCESS path — the winning listen leaves one attached, pointed at a deadline ` +
    `that has already passed`);
});

test("the SIGUSR2 successor is told the port it must bind", () => {
  const src = stripComments(readFileSync(join(testDir, "..", "bin", "claude-via-proxy.mjs"), "utf8"));
  const at = src.indexOf("const successor = spawn(");
  assert.ok(at > 0,
    "the successor spawn is gone or renamed — this guard no longer watches " +
    "anything, which is not the same as the defect being fixed");
  const end = closesAt(src, src.indexOf("{", src.indexOf("], {", at)));
  assert.ok(end > at, "the spawn options never close — the file did not parse as this guard assumes");
  const opts = src.slice(at, end);

  // THE SUCCESSOR IS SPAWNED AS `run-service`, AND run-service REFUSES WITHOUT
  // A PORT. Its own guard returns 2 with "run-service needs
  // CACHE_FIX_PROXY_PORT — a service must bind the port sessions were told to
  // use, and that cannot be guessed."
  //
  // A `server`-mode holder reaches this handover (dispatch routes
  // server + CACHE_FIX_HOLD_PORT=on + no LISTEN_FDS to holdPort) and does NOT
  // require that variable — the comment on run-service's guard says so:
  // "Wrapper mode keeps the default because it wires the client it launches."
  // So the successor of a `server` holder inherits no port, prints that line
  // and returns 2.
  //
  // And nothing upstream notices: node fires 'spawn' because the exec
  // SUCCEEDED, so the predecessor takes its `left = true` path, SIGHUPs its
  // child and exits — standby already closed, successor dead, nobody on the
  // address. The predecessor's own measurement of the same class is recorded
  // one screen away: "a run-service started without it took 9801 while the
  // fleet dialled 9901."
  //
  // The predecessor knows the number — it is bound to it, and publishes it as
  // holder._port two other places in this file. Passing it is the whole fix.
  assert.match(opts, /CACHE_FIX_PROXY_PORT\s*:/,
    "the successor is spawned without CACHE_FIX_PROXY_PORT. run-service refuses " +
    "without it and returns 2, and the predecessor reads a successful exec as a " +
    "successful handover — so a `server`-mode holder hands the port to a process " +
    "that dies, after closing its own standby");

  // PREMISE, or the assertion above could pass against an env block that names
  // the variable while building it from something the predecessor does not know.
  assert.match(opts, /CACHE_FIX_PROXY_PORT\s*:\s*String\(/,
    "CACHE_FIX_PROXY_PORT is present but not built from a value — the successor " +
    "needs the port this holder actually bound, not a literal or a passthrough");
});

test("a failed SIGUSR2 handover recovers, from both failure modes, through the ladder", () => {
  const src = stripComments(readFileSync(join(testDir, "..", "bin", "claude-via-proxy.mjs"), "utf8"));
  const at = src.indexOf("const handoverFailed = (why) =>");
  assert.ok(at > 0,
    "the SIGUSR2 recovery function is gone or renamed — this guard no longer " +
    "watches anything, which is not the same as the defect being fixed");
  const end = closesAt(src, src.indexOf("{", at));
  assert.ok(end > at, "handoverFailed never closes — the file did not parse the way this guard assumes");
  // MEASURED AFTER STRIPPING COMMENTS, because the question the ceiling asks is
  // "did the anchor slide into unrelated code", and prose volume has no bearing
  // on that. The raw slice here is ~1.6k chars of which most is the paragraph
  // explaining why the async door exists; the code is a dozen lines.
  const body = src.slice(at, end).replace(/\/\/[^\n]*/g, "");
  assert.ok(body.replace(/\s+/g, " ").length < 800,
    `the recovery slice is ${body.replace(/\s+/g, " ").length} chars of code — too ` +
    `wide to be this function, so a match inside it proves nothing about the ` +
    `statements this guard protects`);

  assert.match(body, /restart\s*=\s*setTimeout\s*\(/,
    "recovery calls spawnWhenReady() directly instead of re-arming the restart " +
    "timer, so a SIGUSR2 retry loop skips the backoff ladder entirely");
  // WHAT IS LEFT AFTER THE TIMER, not where the call sits on its line.
  //
  // Three revisions anchored on position and were defeated three times by the
  // same class: a lookbehind whose 40-char window swallowed `restart = null;`,
  // then `^\s*spawnWhenReady\(\);\s*$` which only sees a call alone on a line —
  // `if (bound) { restart = null; spawnWhenReady(); }` beside a decoy timer
  // passes it, and that is the natural edit ("why wait a rung when the port is
  // already ours"). Position is not the property.
  //
  // The property is: recovery hands the next spawn to the ladder and does
  // nothing else with it. So delete the timer callbacks — the one legitimate
  // home for that call — and require the remainder to contain no call at all.
  const outsideTimer = body.replace(/setTimeout\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*,[^)]*\)/g, "TIMER");
  assert.doesNotMatch(outsideTimer, /spawnWhenReady\s*\(/,
    "recovery calls spawnWhenReady() outside the restart timer — that is the " +
    "un-laddered respawn this guard exists to prevent. A proxy that cannot start " +
    "plus a deploy watcher retrying SIGUSR2 then burns one immediate respawn per " +
    "signal, the shape measured at 51 respawns in 1.2s");
  assert.match(body, /setTimeout\(/,
    "premise: recovery no longer arms a restart timer at all, so the assertion " +
    "above is checking the absence of something from an empty set");

  // The async door, outside the function: the spawn must route its 'error' here.
  const spawnAt = src.indexOf("const successor = spawn(", at);
  assert.ok(spawnAt > at, "the successor spawn moved — re-read this guard before trusting it");
  // STRIPPED FIRST, THEN WINDOWED, and bounded like the slice above. Taking 2000
  // RAW chars and stripping afterwards makes the window a function of how much
  // prose sits between the spawn and its listeners: adding the paragraph that
  // explains the spawn gate pushed the 'error' listener out of the window and
  // failed this guard for a reason that had nothing to do with the code. The
  // ceiling then catches the opposite error, an anchor that slid.
  // WINDOWED BY CONTENT, NOT BYTES. stripComments() blanks comments to spaces
  // rather than deleting them — indices must keep lining up — so a fixed byte
  // window fills with whitespace and stops short of the code it was sized for.
  // Measured: 1,200 bytes here carried 263 characters of actual content and
  // excluded both listeners, failing the assertions below for a reason that had
  // nothing to do with the source.
  const after = ((raw) => {
    let kept = "", seenChars = 0;
    for (const ch of raw) {
      kept += ch;
      if (!/\s/.test(ch)) seenChars++;
      if (seenChars >= 700) break;
    }
    return kept;
  })(src.slice(spawnAt));
  assert.ok(after.replace(/\s+/g, " ").length > 200,
    "the window after the successor spawn is empty — the anchor matched the last " +
    "thing in the file, so every assertion below would pass on nothing");
  assert.match(after, /successor\.once\(\s*["']error["']\s*,[\s\S]{0,80}?handoverFailed/,
    "the successor spawn has no 'error' listener routed to handoverFailed. " +
    "EAGAIN under fork pressure is emitted, not thrown, so it becomes an " +
    "uncaughtException and kills the holder AFTER its standby is already dead");
  // AND THE LISTENER MUST LEAD SOMEWHERE. Wiring it is not the property that
  // matters: 'error' arrives a tick after this handler's synchronous block, so
  // if departure is announced synchronously the recovery finds the holder
  // already gone and can only log. The first version of this guard asserted the
  // wiring and passed against exactly that inert shape.
  //
  // Departure must therefore sit behind 'spawn', which node emits only on a
  // successful exec.
  assert.match(after, /successor\.once\(\s*["']spawn["']\s*,[\s\S]{0,400}?settle\(0\)/,
    "settle(0) is not gated on the successor actually starting, so the holder " +
    "gives the address away on the strength of having CALLED spawn — and the " +
    "'error' listener above then has nothing left to recover into");
  // THE GATE'S OWN BODY, CUT BY BRACE BALANCE — not by a lazy regex.
  //
  // Two position-anchored attempts failed here. Slicing at the gate's index let
  // a decoy `successor.once("spawn", () => { if (false) settle(0); })` sit above
  // a synchronous departure. Replacing the gate with `[\s\S]*?\n\s*\}\);` then
  // over-matched in the other direction: on that same decoy it ran PAST the
  // one-line gate and swallowed the real `settle(0)` below it, so the remainder
  // was clean and the assertion passed on the inert shape it was written for.
  // Measured both times.
  //
  // Balance the braces from the gate's opening `{` and cut exactly that body.
  // What remains is everything the handler does regardless of whether the
  // successor started, and none of it may give the address away.
  const gateAt = after.search(/successor\.once\(\s*["']spawn["']/);
  assert.ok(gateAt >= 0, "the spawn gate is gone — the departure is no longer proof-gated");
  const gateEnd = closesAt(after, after.indexOf("{", gateAt));
  assert.ok(gateEnd > gateAt, "the spawn gate's body never closes inside the window");
  const outsideGate = after.slice(0, gateAt) + after.slice(gateEnd);
  assert.doesNotMatch(outsideGate, /settle\s*\(/,
    "the holder settles outside the spawn gate — it gives the address away on " +
    "the strength of having CALLED spawn, and the 'error' listener then has " +
    "nothing left to recover into");
  assert.match(after, /catch\s*\([\s\S]{0,40}?\)\s*\{[\s\S]{0,200}?handoverFailed/,
    "the synchronous catch no longer routes to handoverFailed");
});

// Every .mjs under bin/ and proxy/, as (path, source) pairs. Two static guards
// below walk the same tree for different questions; they had a copy each.
function productionSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(testDir, "..", dir), { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(dir, e.name)); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      // The suite writes and deletes bin/scratch-*.mjs while other files are
      // still running, so a readdir/readFile pair can straddle a delete and fail
      // these guards for a reason that is not about the tree. They are
      // also fixtures, not product — one is a 2,400-line copy of the launcher.
      if (e.name.startsWith("scratch-")) continue;
      try {
        out.push([join(dir, e.name),
                  stripComments(readFileSync(join(testDir, "..", dir, e.name), "utf8"))]);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;   // vanished mid-scan: not ours
      }
    }
  };
  for (const d of ["bin", "proxy"]) walk(d);
  return out;
}

// EVERY SHELL-OUT ONTO A USER'S MACHINE IS BOUNDED — enumerated, not sampled.
//
// PR #304 bounded eight launcher call sites behind probe(), and the commit said
// the invariant held. It did not: `execFileSync("openssl", …)` in
// proxy/forward-proxy.mjs still had no timeout, and it is the worst one to miss
// — it runs inside startProxy() BEFORE the proxy listens, while holding the CA
// lock, so a wedged openssl stalls every sibling waiting out caLockWaitMs too.
// One reviewer found it by reading. Nothing in the suite could.
//
// The behavioural test (test/proxy-probe-bounded.test.mjs) proves the launcher's
// chain is bounded by hanging lsof and ps. It cannot prove a call site nobody
// routed through probe() exists, because it only exercises the paths it drives.
// That is the gap this fills, and it is the fourth static guard in this file for
// the same reason as the other three: judgement already missed it once.
//
// Bounded means a `timeout:` in the options object. killSignal and maxBuffer are
// deliberately not required — a timeout that fires is the property that matters,
// and demanding the whole triple would fail on a site that is bounded correctly
// with different defaults.
test("every synchronous shell-out in bin/ and proxy/ carries a timeout", () => {
  const unbounded = [];
  let seen = 0;
  for (const [rel, src] of productionSources()) {
    for (const m of src.matchAll(/\b(execFileSync|execSync|spawnSync)\s*\(/g)) {
      seen++;   // productionSources() strips comments, so no prose reaches here
      // Balance from the opening paren to find this call's own arguments —
      // a fixed window would run into the next call on a dense file.
      // FAIL CLOSED: -1 means the call never balances, and a slice to
      // end-of-file would contain some `timeout:` somewhere and pass unread.
      const end = closesAt(src, m.index + m[0].length - 1, "any");
      if (end < 0) {
        unbounded.push(`${rel}:unparsed`);
        continue;
      }
      const args = src.slice(m.index, end);
      // A VALUE, not just the key. `timeout: 0` and `timeout: undefined` both
      // satisfy the key and bound nothing — node treats 0 as "no timeout".
      if (!/\btimeout\s*:\s*(?!0\b|undefined\b)[A-Za-z0-9_$]/.test(args)) {
        unbounded.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }

  // A zero here has two answers, and only one of them is good news.
  assert.ok(seen >= 4,
    `only ${seen} shell-out call sites found — the pattern stopped matching, so a ` +
    `green result means the guard is blind rather than the tree being clean`);
  assert.deepEqual(unbounded, [],
    `these shell out with no timeout, so on a machine whose process table is in ` +
    `trouble they block their caller indefinitely: ${unbounded.join(", ")}. ` +
    `Route launcher calls through probe(); give others timeout + killSignal inline.`);
});

// THE RELAY MUST NOT SURRENDER A LIVE SOCKET FOR A TRANSIENT ERROR.
//
// bin/gap-relay.mjs exists to keep an address answering when nothing else will.
// Its server-error handler used to be `process.exit(1)` for EVERY error, which
// gives the descriptor away — and the errors that reach it are exactly the ones
// where that is worst: a transient EMFILE/ENFILE at accept time happens when
// the machine is already out of file handles, i.e. when the gap this relay
// covers is most likely to be open. Node keeps a listening server listening
// through such an error, so staying is both possible and correct.
//
// STATIC, AND THE BEHAVIOURAL VERSION WAS DELETED TO PUT THIS HERE. That test
// asserted "an error arrived and the address is still served" while emitting no
// error at all: SIGURG is ignored by the process and closing the parent's own
// socket does not touch the relay's inherited descriptor. Measured — it passed
// unchanged against the pre-fix `process.exit(1)` handler, in 53 ms. Inducing a
// real accept-time EMFILE was attempted (ulimit -n 24) and is not merely
// untuned: node cannot start under that limit at all. Unproven, not impossible
// — so this guard pins the SHAPE and says plainly that it is doing so.
//
// The other half of the handler is deliberately unguarded because it cannot be
// tested: when the LISTEN fails node closes fd 3 itself (measured — a child
// given a pipe as fd 3 has no `3` in /proc/<pid>/fd, while the same spawn onto
// a real socket keeps it), so "stay alive to hold the descriptor" is not an
// option there and exiting is the honest answer.
test("gap-relay keeps the socket on an error that left it listening", () => {
  const src = stripComments(readFileSync(join(testDir, "..", "bin", "gap-relay.mjs"), "utf8"));
  const at = src.indexOf('srv.on("error"');
  assert.ok(at > 0, "the gap-relay server-error handler is gone or renamed");
  const end = closesAt(src, src.indexOf("{", src.indexOf("=>", at)));
  assert.ok(end > at, "the handler never closes — the file did not parse as this guard assumes");
  const body = src.slice(at, end).replace(/\/\/[^\n]*/g, "");
  assert.ok(body.replace(/\s+/g, " ").length < 600,
    `the handler slice is ${body.replace(/\s+/g, " ").length} chars — too wide to be it`);

  assert.match(body, /process\.exit\(/,
    "premise: the handler no longer exits at all, so this guard is checking the " +
    "wrong property — re-read it before trusting the green");
  // The exit must be conditional, and conditional on still-listening in
  // particular. An unconditional one is the pre-fix handler.
  assert.match(body, /srv\.listening/,
    "the handler does not consult srv.listening, so it treats an accept-time " +
    "error on a live socket the same as a failed listen — and exiting there " +
    "surrenders an address that was still answering");
  assert.doesNotMatch(body, /^\s*process\.exit\(\s*1\s*\)\s*;?\s*$/m,
    "the handler exits unconditionally at statement level — that is the pre-fix " +
    "shape, which gave the descriptor away on any server error at all");
  // AND THE CONDITION MUST POINT THE RIGHT WAY. Consulting srv.listening is not
  // enough: `if (held) process.exit(1)` consults it too, and inverts the rule —
  // surrender the socket while still listening, hang on when the listen failed.
  // That is the single most likely wrong edit here and it passed every other
  // assertion in this test.
  assert.match(body, /if\s*\(\s*!\s*(held|srv\.listening)\b[^)]*\)[\s\S]{0,40}?process\.exit/,
    "the exit is not gated on the NOT-listening case — an inverted condition " +
    "surrenders a live socket and keeps a process that has no descriptor left");
});

// THE SUITE MUST ASK THE MACHINE HOW BIG IT IS, AND ASK CORRECTLY.
//
// This suite spawns real launchers, holders, relays and stand-in proxies, and
// asserts on wall-clock windows — `refuses nothing when the proxy under it
// dies` allows 2 refusals in 40 across one forced kill, which is a statement
// about how fast the holder re-acquires. Oversubscribe the runner and those
// windows widen until the bounds fail, somewhere different on each run. That is
// why the failure looked like a flake: the bound is real, the load was not.
//
// TWO knobs were wrong. They are NOT the same defect and only one of them was
// red on CI — keeping that straight matters, because the fix for the loud one
// is a flag deleted from package.json and nothing else.
//
//   THE RED ONE. package.json pinned `--test-concurrency=8` — 8 test files in
//   flight no matter what the runner is. Measured on Node v20.20.2 over two
//   pinned cores, full suite, ON THE TREE AS IT STOOD (so the inner bound below
//   was also wrong, at 24): with the pin `# fail 5` in 85 s, without it
//   `# fail 0` in ~265 s, and green on every run since across Node 18, 20 and
//   24 (1890/1890/1896 passing, no `not ok`).
//
//   That pairing is what this commit removes, and it is NOT a claim that the pin
//   alone reddens a suite whose inner bound is right: re-adding only the pin to
//   the FIXED tree ran green 5 times in a row on a peer's box (91-93 s). On the
//   real runner it was red, on that box it was not, and a stochastic failure
//   needs a rate rather than a count. Treat the 5 as "the state being removed",
//   not as the pin's yield. CI's
//   Node 20 leg was red on `refuses nothing when the proxy under it dies` while
//   18 and 22 were green — same file, a different case each run. How many cores
//   that runner has is not asserted anywhere here, on purpose; see the SCOPE
//   note in proxy-held-port.test.mjs for the two attempts to pin it down that
//   did not survive checking.
//
//   THE QUIET ONE, and it was NOT what made CI red. Two files sized their inner
//   concurrency from `os.cpus().length`, which counts the machine and ignores
//   this process's CPU affinity. Nothing suggests a GitHub-hosted VM carries an
//   affinity mask (not measured — same caveat as the core count), so both calls
//   agree there and that bound was already doing its job; under a mask they
//   diverge hard and it stops bounding anything. Fixed because it is
//   wrong wherever the process is pinned, not because it was red. The
//   measurements, and what this does NOT fix, are in proxy-held-port.test.mjs
//   beside the bound itself — not repeated here.
//
// node:test already derives its file concurrency the right way, and the formula
// is exactly `availableParallelism() - 1` — measured with six files that each
// sleep 1200 ms, counting how many start together: 1 at two visible cores, 2 at
// three, 3 at four, 4 at five. Under the pin, four such files start within
// 23 ms of each other on two cores; by default they span 3786 ms end to end.
// A constant cannot know the runner.
// A PID FOUND BY PORT IS NOT A PID WE OWN.
//
// Four files here ask `lsof` who is LISTENING on a port and then signal the
// answer — SIGHUP in six places, SIGKILL in one. The port came from a freePort()
// that binds 0, reads the number and CLOSES, so it is unowned from that instant
// and the OS hands it out again: measured, two processes each taking 3000
// ephemeral ports collided on 855 of ~2400 distinct ones. node:test runs FILES
// concurrently in their own processes and several of them listen IN-PROCESS, so
// the answer can be another runner's own pid — measured, `lsof -t` returned it
// and the kill line landed, `victim exited code=null signal=SIGHUP`. The victim
// dies with `signal: 'SIGHUP'`, `error: 'test failed'` and no case failing
// inside it, which is CI run 32087202771 (proxy-forward-attach-fallback, node
// 18) to the letter.
//
// The predicate existed at three of the seven call sites, with its own measured
// comment, and the four in-test cleanups never got it. So this pins it at the
// SOURCE instead: inside each listeners(), where no later call site can forget
// it. Pinned as an exact expression for the same reason the parallelism bound
// below is — a MENTION test passes on a comment, and a per-file variant is how
// four copies drift apart.
//
// PATH SEGMENT, NOT SUBSTRING, and that difference is a real defect this caught:
// the version at those three sites was
// /claude-via-proxy|gap-relay|server\.mjs|scratch-launcher-|scratch-fake-server-/
// and `gap-relay` matches test/gap-relay-chain.test.mjs — a file in this very
// directory that listens in-process at four sites. Ours all run a script under
// bin/ or proxy/; every test file runs one under test/, and the node binary is
// not a .mjs. Validated against 10 real command lines: 10/10 for the anchored
// form, and the substring form wrong on 1 of the same 10.
// A SUCCESSOR THAT CANNOT SPEAK IS A SUCCESSOR NOBODY CAN DEBUG.
//
// When the holder dies, the proxy spawns a replacement holder DETACHED and then
// exits. That spawn used `stdio: "ignore"`, which is /dev/null on all three fds
// — so the new holder, every proxy it supervises, and every successor of a later
// handover (those inherit) are silent forever. The line immediately after the
// spawn writes "[cache-fix] holder died; started a new one" to the DYING
// process's stderr, which is exactly the wrong way round: the departing one
// reports, the arriving one cannot.
//
// MEASURED, and it is why this is a guard and not a preference: on both Macs the
// live 9901 launcher and proxy have fd1 AND fd2 on /dev/null, so the forced-close
// drain line this PR added has been written into the void there since it landed.
// On <linux-host> the same fds are /tmp/cc-restore-9901.log and the numbers are readable.
// Same code, same fleet — the difference is only which spawn started the lineage.
//
// fd2 ONLY. stdin stays closed and stdout stays discarded: the holder's stdout
// carries the child's "proxy listening" chatter, which the launcher already
// parses over a pipe, and inheriting it would duplicate that into whatever the
// operator was looking at. Errors are the half that has to survive.
//
// INHERITING A BROKEN PIPE IS SAFE HERE. proxy/server.mjs already swallows EPIPE
// and ERR_STREAM_DESTROYED on stdio rather than letting them reach
// uncaughtException, so a successor whose inherited stderr later closes keeps
// serving instead of dying with the fd.
test("the self-heal successor keeps a way to report", () => {
  const src = stripComments(readFileSync(join(testDir, "..", "proxy", "server.mjs"), "utf8"));
  // ANCHORED ON THE CALL, not on the word "stdio" anywhere in the file: this
  // must fail when the OPTIONS change, and a file-wide search is satisfied by
  // any other spawn.
  const at = src.indexOf('"claude-via-proxy.mjs"), "run-service"]');
  assert.ok(at > 0, "the self-heal spawn moved — re-anchor this guard");
  // TO THE END OF THE OPTIONS OBJECT, not a fixed character window: a comment
  // added inside the call pushed the option past a 400-char slice and the guard
  // reported "no stdio named" about a spawn that names it two lines down.
  // `.unref()` closes the call in the source and cannot appear inside it.
  const close = src.indexOf(".unref()", at);
  assert.ok(close > at, "the self-heal spawn's call no longer ends in .unref() — re-anchor this guard");
  const opts = src.slice(at, close);
  const stdio = /stdio:\s*("[^"]*"|\[[^\]]*\])/.exec(opts);
  assert.ok(stdio, "the self-heal spawn no longer names its stdio at all");
  assert.notEqual(stdio[1], '"ignore"',
    'the self-heal successor is spawned with stdio "ignore", so the holder it ' +
    'becomes — and every proxy and handover successor below it — writes every ' +
    'diagnostic, including the forced-close drain count, to /dev/null');
  // BOTH CLAIMS THE COMMENT MAKES, and only those two. A first cut asserted
  // only that the LAST fd was "inherit", which left `["ignore","inherit",
  // "inherit"]` passing — so the "stdout stays closed" half was a sentence no
  // test could kill. Pinning the whole triple instead would break on a future
  // ipc channel for no safety gain.
  const fds = stdio[1].startsWith("[")
    ? stdio[1].slice(1, -1).split(",").map((x) => x.trim().replace(/"/g, ""))
    : [stdio[1].replace(/"/g, "")];
  assert.equal(fds[2], "inherit",
    `the self-heal successor's stderr must be inherited, not discarded; got ${stdio[1]}`);
  assert.notEqual(fds[1], "inherit",
    "the successor's STDOUT is inherited, so the child's 'proxy listening' chatter " +
    "— which the launcher already parses over a pipe of its own — is duplicated " +
    `into whatever the operator was looking at; got ${stdio[1]}`);
});

// A GATE THE CHILD READS MUST BE SCRUBBED BY WHOEVER SPAWNS THE CHILD.
//
// CACHE_FIX_REQUIRE_HOP became load-bearing in bin/gap-relay.mjs: with it set,
// the relay refuses to dial direct instead of falling through. That is the
// point of the flag — but it also means an operator who exported it while
// debugging changes what every case that spawns a launcher, a relay, or a
// holder measures, and the failure looks like a broken relay rather than a
// dirty environment.
//
// Five files reach that code (they spawn claude-via-proxy.mjs, gap-relay.mjs,
// or hold a port) and exactly one of them scrubbed the flag when this was
// written. That is the same shape as the ours-only predicate and the deploy
// announce earlier on this branch: a guard added in one place, siblings left.
//
// THE ROSTER IS DERIVED, NOT LISTED. A hardcoded set of filenames goes stale
// the first time a file is renamed or a sixth one starts spawning — which is
// exactly how the misses above happened. Membership is computed from what the
// file actually does.
test("every file that spawns our binaries scrubs the hop gates", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  const spawners = files.filter((f) => {
    const src = readFileSync(join(testDir, f), "utf8");
    // Only files that also manage hop config: a spawner that never touches
    // CACHE_FIX_UPSTREAM_PROXY has no scrub list for this to belong to.
    if (!src.includes("CACHE_FIX_UPSTREAM_PROXY")) return false;
    return src.includes("claude-via-proxy.mjs")
        || src.includes("gap-relay.mjs")
        || src.includes("CACHE_FIX_HOLD_PORT");
  });
  assert.ok(spawners.length >= 5,
    `only ${spawners.length} file(s) both spawn our binaries and manage hop config — ` +
    `this guard covered 5 when written, so either a file moved or this detector broke`);
  const missing = spawners.filter((f) =>
    !readFileSync(join(testDir, f), "utf8").includes("CACHE_FIX_REQUIRE_HOP"));
  assert.deepEqual(missing, [],
    `these spawn a process that honours CACHE_FIX_REQUIRE_HOP and never scrub it, ` +
    `so an operator who exported it turns them red for a reason that is not in ` +
    `the code: ${missing.join(", ")}`);
});

// THE CHILD-READY LINE MUST PARSE FOR EVERY ADDRESS FAMILY.
//
// The launcher marks its proxy SERVED by matching the child's announcement, and
// the pattern was `[\d.]+:(\d+)` — IPv4 only. With CACHE_FIX_PROXY_BIND=::1 the
// child announces `proxy listening on ::1:9901`, nothing matches, so `served`
// stays false and the CA is never published. Every later exit then counts as a
// pre-service failure and the holder gives up after five, on a proxy that was
// serving the whole time.
//
// ASSERTED BY RUNNING THE PATTERNS, not by reading them: a regex is exactly the
// kind of thing that looks right and is not. The literals are lifted from the
// source so the guard cannot drift from what ships.
test("the launcher parses a child-ready line from any address family", () => {
  const src = readFileSync(join(testDir, "..", "bin", "claude-via-proxy.mjs"), "utf8");
  const pats = [...src.matchAll(/\/listening on[^/\n]*\/[a-z]*/g)].map((m) => m[0]);
  assert.ok(pats.length >= 2,
    `expected at least 2 child-ready patterns in the launcher, found ${pats.length} — ` +
    `either they moved or this detector broke`);
  const lines = {
    ipv4:      "proxy listening on 127.0.0.1:9901",
    wildcard:  "proxy listening on 0.0.0.0:9901",
    ipv6:      "proxy listening on ::1:9901",
    ipv6full:  "proxy listening on [::1]:9901",
  };
  const bad = [];
  for (const src2 of pats) {
    const body = src2.slice(1, src2.lastIndexOf("/"));
    const flags = src2.slice(src2.lastIndexOf("/") + 1);
    for (const [name, line] of Object.entries(lines)) {
      let re;
      try { re = new RegExp(body, flags); } catch { bad.push(`${src2} does not compile`); continue; }
      const m = re.exec(line);
      if (!m) { bad.push(`${src2} does not match ${name}: ${JSON.stringify(line)}`); continue; }
      // AND THE PORT MUST COME OUT. Matching but capturing the wrong group is
      // the failure that keeps `served` true while childPort is garbage.
      const port = m.slice(1).map(Number).filter((n) => n === 9901);
      if (!port.length) bad.push(`${src2} matched ${name} but captured no 9901: ${JSON.stringify(m.slice(1))}`);
    }
  }
  assert.deepEqual(bad, [],
    `a proxy bound to one of these announces a line the launcher cannot read, so it ` +
    `never marks the child served:\n  ${bad.join("\n  ")}`);
});

test("no test file asks lsof who holds a port", () => {
  // ASSEMBLED, so the needle never appears whole in THIS file. Spelled out, the
  // detector matched its own source and reported the guard as the violation.
  const NEEDLE = 'execFileSync("' + 'lsof"';
  // The ONE legitimate call lives in proc-helpers.mjs, which is not a .test.mjs
  // — so any hit here is a cleanup that went around listeners() and its OURS
  // filter. Four files did exactly that once, and two of them then walked UP to
  // the listener's parent and sent SIGTERM; a stranger's parent is this runner.
  //
  // This used to also pin a copy of the OURS regex in every file that had one.
  // There are no copies now: one definition cannot drift from itself, so the
  // only thing left to police is a NEW inline call.
  const helper = stripComments(readFileSync(join(testDir, "proc-helpers.mjs"), "utf8"));
  assert.ok(helper.includes(NEEDLE) && helper.split(NEEDLE).length - 1 === 1,
    "proc-helpers.mjs no longer holds the single lsof call — either it moved, in " +
    "which case this guard now polices nothing, or the detector broke");

  const bad = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => stripComments(readFileSync(join(testDir, f), "utf8")).includes(NEEDLE));
  assert.deepEqual(bad, [],
    `these files ask lsof directly instead of going through listeners(), so nothing ` +
    `filters the pid before it reaches process.kill():\n  ${bad.join("\n  ")}`);
});

test("the suite derives its parallelism from the machine", () => {
  const script = JSON.parse(readFileSync(join(testDir, "..", "package.json"), "utf8")).scripts?.test ?? "";
  // Premise. A renamed or rewritten script must not let the assertion below
  // pass by matching a string that no longer runs the suite. `--test` and not
  // `--test\b`, because \b is satisfied by the hyphen: `--test-reporter=spec
  // run-all.mjs` passed the first version of this while running nothing of the
  // sort.
  assert.match(script, /\bnode\b[^|&]*--test(?![\w-])/,
    `the test script no longer runs \`node --test\`, so this guard is reading the ` +
    `wrong string and its green means nothing: ${JSON.stringify(script)}`);
  assert.doesNotMatch(script, /--test-concurrency/,
    `the test script pins the runner's file concurrency (${JSON.stringify(script)}). ` +
    `A constant cannot know how many cores CI gave us; node:test derives it from ` +
    `availableParallelism().`);
  // Not covered, and cheaper to say than to guard: .github/workflows/test.yml
  // runs `npm test`, so this string is the whole story today. A workflow that
  // grew its own `node --test --test-concurrency=8`, or a NODE_OPTIONS, would
  // restore the failure with this test green.

  // THE SAME MISTAKE ONE LAYER IN — anchored on the RIGHT answer, not on one
  // spelling of the wrong one.
  //
  // Three scans were written before this one and every one of them was beaten.
  // Matching "concurrency" near a `cpus()` named THIS FILE, because the prose
  // above describes the defect in those words. Routing that through
  // stripComments() still named this file, because the failure messages are
  // string literals and a string literal is code. Narrowing to a declaration
  // `const X = … cpus() …` stopped the self-match and then MISSED six real
  // reintroductions — measured, one per row: the same line wrapped across lines
  // by a reformat, `export const`, an aliased `import { cpus as coreCount }`,
  // `let X;` with the assignment later, `const { length } = cpus()`, and a bare
  // `const CONCURRENCY = 8` (which the package.json half of this very test
  // forbids while that half permitted it).
  //
  // Every one of those fails the assertions below, because they ask what the
  // bound IS rather than enumerating what it must not be. The roster is
  // asserted first so a rename escapes as a LOUD failure instead of an empty
  // scan — an empty roster is the one result that would make the checks vacuous.
  //
  // And a correct bound that nothing USES is the same defect with a clean
  // declaration. Measured against this guard before the third assertion existed:
  // swapping `{ concurrency: CONCURRENCY }` for `{ concurrency: true }` or
  // `{ concurrency: 8 }` left it green while the describe went unbounded.
  const bounded = readdirSync(testDir, { recursive: true })
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => /^\s*(?:export\s+)?const\s+CONCURRENCY\b/m
      .test(readFileSync(join(testDir, f), "utf8")))
    .sort();
  assert.deepEqual(bounded, ["proxy-held-port.test.mjs", "proxy-wrapper.test.mjs"],
    `the set of files declaring a CONCURRENCY bound changed: ${bounded.join(", ") || "(none)"}. ` +
    `A new one is fine — add it here and make it derive from availableParallelism(). ` +
    `A missing one means the bound was renamed, and this guard stopped watching it.`);
  // WHAT THIS DOES NOT WATCH, said here because the test's name is broader than
  // its reach: only files declaring a CONCURRENCY bound. proxy-update-sweep
  // .test.mjs sizes its describe `{ concurrency: true }` over five cases, ALL of
  // which spawn a proxy, and never enters this roster. Left alone deliberately —
  // 8 runs, all green at ~2.1 s over two pinned cores in this worktree, so it is
  // the same shape without the failure, and widening the roster to catch it
  // would flag every cheap `concurrency: true` in the suite. An options object
  // imported from a sibling module would also escape; there is no cheap fix for
  // that and it is named here rather than guarded.
  for (const f of bounded) {
    // stripComments, because the paragraphs in those files quote `cpus().length`
    // to explain why it is wrong. Recursive and `.mjs` rather than top-level
    // `.test.mjs`: the runner collects nested files (measured, on 18 and 20),
    // and this bound is duplicated in two files, so the obvious next refactor
    // moves it to a non-test helper the old filter could not see.
    //
    // `{ recursive: true }` needs Node 18.17 while `engines` says >=18, and
    // readdirSync IGNORES an option it does not know rather than throwing
    // (measured on 18.20.8) — so on 18.0-18.16 the scan quietly stops recursing.
    // Unreachable today: both roster files are top level, and CI's `18` resolves
    // to the latest 18.x. Recorded so it is not diagnosed from scratch.
    const src = stripComments(readFileSync(join(testDir, f), "utf8"));
    // THE VALUE, not a mention of it. Two weaker versions came before, and the
    // second is why this compares a whole string instead of searching one.
    //
    // A file-wide `match(/availableParallelism\(\)/)` was first, satisfied by any
    // mention anywhere — `const NOTE = "sized by availableParallelism()";` beside
    // a bare `const CONCURRENCY = 8;` left it green, and stripComments keeps
    // strings on purpose, so the guard's own failure text was a copy-paste away
    // from disabling it. Narrowing to the assignment's right-hand side fixed that
    // and was still only a MENTION test: measured, 6 of 7 reintroductions passed
    // it, one per row — `process.env.CI ? 8 : <good>` (the likeliest way anyone
    // puts 8 back, and on exactly the machine this is about), `Math.max(8, …)`,
    // `Number(process.env.TEST_JOBS) || <good>`, `= 8, PROBE = availableParallelism()`
    // riding the `[^;]*` across a comma, `CONCURRENCY *= 4` after a correct
    // declaration, and the use site re-pointed at a constant with another name.
    //
    // So: the expression must BE the bound, whitespace-normalised. That absorbs a
    // reformat and an interior comment, and refuses everything above. It also
    // pins the two files to the same expression and makes a deliberate change to
    // it edit this line — the same contract the roster already imposes, and the
    // reason `let` is not in the roster regex: a `let` bound leaves the roster and
    // fails there instead, loudly.
    // THE FLOOR IS 1, NOT 2, AND THAT IS THE WHOLE POINT OF THE FLOOR.
    // `Math.max(2, ...)` defeated the halving on exactly the machines the
    // halving exists for: floor(2/2) is 1, so on a two-core runner the bound
    // computed 2 and two real proxies booted at once — the oversubscription
    // this file's own comment two paragraphs down calls the defect class,
    // while the bound looked derived-from-the-machine to any reader.
    //   cores  1 2 3 4 8 48
    //   max(2) 2 2 2 2 4 24
    //   max(1) 1 1 1 2 4 24     <- differs ONLY at 1-3 cores
    //
    // ARITHMETIC ONLY. THIS FIXES NO CI FAILURE — it was written as the fix for
    // PR #304's redness and that hypothesis is REJECTED, by measurement:
    // proxy-held-port.test.mjs pinned to two cores with four busy-loops on the
    // same cores fails IDENTICALLY under max(1) and under max(2) (rc=1, same
    // case, same message). What that redness actually was is fixed in
    // proxy-held-port.test.mjs and named there. How many cores CI's runner has
    // is not asserted anywhere here, on purpose (see above), so the effect
    // there is unmeasured in both directions. Keep the change because the bound
    // is wrong on its own terms, and never because CI went green after it.
    const BOUND = "Math.max(1, Math.floor(availableParallelism() / 2))";
    const assigns = [...src.matchAll(/\bCONCURRENCY\b\s*=\s*([^;]*);/g)]
      .map((m) => m[1].replace(/\s+/g, " ").trim());
    assert.deepEqual(assigns, [BOUND],
      `${f} does not size CONCURRENCY as \`${BOUND}\`. A constant, an env override, ` +
      `a CI-only branch or a later reassignment all read as "derived from the ` +
      `machine" to a search and are not. Assignments seen: ${JSON.stringify(assigns)}`);
    // The bound must be SPENT, not merely declared. A literal here is the
    // unbounded state wearing a correct declaration.
    //
    // `1` is exempt and that is not a loophole: the defect class is
    // oversubscription, and serial cannot oversubscribe. Forbidding it also
    // forbade a remedy this repo already approved for ONE of these two files —
    // docs/code-reviews/proxy-v3-implementation-rereview-8-2026-04-20.md:9,
    // "Adding `{ concurrency: 1 }` to the wrapper test suite is appropriate here
    // because these tests fork subprocesses". A guard that bans the conservative
    // direction gets turned off by whoever next needs it.
    // THE cpus() BAN IS BACK, and the round that deleted it is why it is
    // written down. A ponytail pass removed it after proving the use-site
    // assertion caught its one known mutant and both mutation tables stayed
    // complete — which was true and still wrong. The tables did not contain the
    // shape that beats everything else: a SECOND describe added as
    // `{ concurrency: cpus().length }` while the first still spends CONCURRENCY.
    // The use-site check is satisfied by the first describe, and `cpus().length`
    // is not a literal, so the literal ban misses it too. Measured: green
    // without this assertion, red with it.
    //
    // "Both tables still pass" measures the tables, not the guard. A deletion
    // needs a fresh attempt to break the thing, not a re-run of the attempts
    // that shaped it.
    // `\bcpus\b`, not `cpus\s*\(` — the paren version is walked past by
    // `import { cpus as coreCount }`, which this file's own history already
    // lists as a reintroduction shape. Measured green on both files: comments
    // are stripped and neither has `cpus` in a string literal.
    //
    // THIS IS LOAD-BEARING, and the paragraph that used to sit here claiming
    // otherwise is the reason it says so in capitals. That paragraph was written
    // after re-measuring, concluded "belt and braces", and was WRONG: a second
    // describe using `{ concurrency }` shorthand sized by `cpus().length` is red
    // only because of this assertion — remove it and that mutant goes green.
    // The re-measurement had simply not tried the shorthand.
    //
    // Twice now a deletion here has been justified by evidence that turned out
    // to be about the shapes already thought of. Bring a mutant this assertion
    // uniquely catches, and check it against the ones it caught last time.
    assert.doesNotMatch(src, /\bcpus\b/,
      `${f} still reads os.cpus(), which counts the machine rather than the cores ` +
      `this process may use — measured 48 against availableParallelism()'s 2 under ` +
      `\`taskset -c 6,7\``);
    // AND THE NAME MUST COME FROM node:os. Pinning the expression's TEXT pins
    // nothing about what `availableParallelism` resolves to. Measured: a new
    // `test/parallelism.mjs` exporting `() => cpus().length`, imported here
    // instead of node:os, left every other assertion green while the bound went
    // back to counting the machine. That is not a contrived shape — it is the
    // refactor the comment above predicts, and the first thing anyone reaches
    // for when this guard refuses their `?? cpus().length` fallback.
    // EXACTLY ONE import line may introduce the name, and it must be node:os.
    // Asserting merely that SOME node:os import mentions it is satisfied while
    // the real binding comes from elsewhere: `import { availableParallelism }
    // from "./parallelism.mjs"` next to `import { availableParallelism as _x }
    // from "node:os"` is legal JS with no name clash, and passed the first
    // version of this line.
    // Whole import STATEMENTS, not lines: a formatter that wraps the specifier
    // list across lines made the line-based version report "0 import lines" and
    // blame a resolution problem for its own work. `[^;]*?` stops at the first
    // `;`, and `import\s*[{'"]` will not match `import.meta`.
    const imports = [...src.matchAll(/^\s*import\s*[{'"][^;]*?;/gm)]
      .map((m) => m[0].replace(/\s+/g, " ").trim())
      .filter((s) => /\bavailableParallelism\b/.test(s));
    assert.equal(imports.length, 1,
      `${f} has ${imports.length} import lines naming availableParallelism; exactly ` +
      `one may, or the binding in the bound is not the one this guard checked: ` +
      `${JSON.stringify(imports)}`);
    assert.match(imports[0], /from "node:os"/,
      `${f} imports availableParallelism from ${JSON.stringify(imports[0])}, not node:os — ` +
      `the bound reads as correct while resolving to something that counts the machine`);
    // AND NOTHING MAY REDECLARE THE NAME. One node:os import satisfies the two
    // lines above while a local shadow supplies the actual binding:
    //   import { availableParallelism as osParallelism } from "node:os";
    //   const availableParallelism = () => Number(process.env.TEST_JOBS) || osParallelism();
    // passed every assertion here and reinstated verbatim the env override the
    // `assigns` comment says it refuses. Measured.
    assert.doesNotMatch(src, /\b(?:const|let|var|function)\s+availableParallelism\b/,
      `${f} declares its own availableParallelism, shadowing the node:os import — ` +
      `the bound's text is unchanged and its meaning is not`);
    // EVERY use site, not one. `match(/concurrency: CONCURRENCY/)` is an
    // EXISTENCE test: the first describe satisfies it forever, so a second one
    // could be sized by anything that is not a bare literal. Measured, all green
    // against the previous shape: `{ concurrency: coreCount().length }`,
    // `{ concurrency: CONCURRENCY * 4 }`, `{ concurrency: availableParallelism() }`.
    // `1` stays exempt — serial cannot oversubscribe, and this repo approved it
    // for one of these files:
    // docs/code-reviews/proxy-v3-implementation-rereview-8-2026-04-20.md:9,
    // "Adding `{ concurrency: 1 }` to the wrapper test suite is appropriate here
    // because these tests fork subprocesses".
    //
    // This one assertion replaces the literal ban AND the use-site existence
    // check it grew out of; both were strictly weaker than asking what the full
    // set of use sites is.
    // EVERY spelling of the key, and the colon is OPTIONAL. `{ concurrency }`
    // shorthand carries a value the `concurrency:` pattern cannot see at all, so
    // the set came back as ["CONCURRENCY"] with a second describe running at 8 —
    // measured, four cases starting within 0 ms against a 1208 ms serial spread,
    // so it is a real behaviour change and not a spelling. It is also the shape
    // you get for free the moment anyone hoists the value into a variable.
    // `{ "concurrency": 8 }` and `{ ["concurrency"]: 8 }` were invisible the same
    // way. A bare occurrence now reports itself rather than contributing nothing.
    const uses = [...new Set([...src.matchAll(/["']?\bconcurrency\b["']?\s*(?::\s*([^,}]+))?/g)]
      .map((m) => (m[1] ?? "<a bare `concurrency` with no value here>").trim()))]
      .filter((u) => u !== "1").sort();
    assert.deepEqual(uses, ["CONCURRENCY"],
      `${f} sizes a describe by something other than CONCURRENCY (or a serial 1). ` +
      `Concurrency values seen: ${JSON.stringify(uses)}`);
  }
});

