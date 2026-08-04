import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Ask node what a CA bundle actually buys, instead of predicting it.
//
// The predicate this replaces modelled the loader in a regex — base64 quanta,
// padding position, dash runs in markers, ten kinds of whitespace. Five review
// rounds, and still wrong in BOTH directions on a real bundle. The rule it was
// reaching for is not expressible from outside: an identical tear is recovered
// or fatal depending only on whether its truncated body happens to be complete
// DER. Both shapes are rows in test/proxy-forward-ca.test.mjs.
//
// The question is not "is our CA in this file" but "will node verify our proxy
// with it", so the probe asks exactly that. Deliberately a handshake and not
// `tls.getCACertificates`, which does not exist before v22.15 while this package
// declares `engines: >=18` — an API probe answers "cannot tell" on every one of
// those hosts, which is not a guard. Cost is one spawn, ~25 ms over a bare
// `node -e ''` (measured, 40 interleaved pairs: 17.3 ms bare, 42.4 ms probed).
// What that is 25 ms OF, because the ratio is the part that misleads: a
// `--remote-control` launch measures ~520 ms end to end, of which ~493 ms is
// forking the proxy and waiting for it to listen and 38 ms is this launcher's
// own startup. So the probe is ~8% of a launch and very nearly all of the CA
// work — 45 ms healthy, plus 72 ms of salvage on the degraded path. Both are
// worth stating: the 8% says this is not what makes a launch slow, the other
// says it is the whole cost of its own subsystem if the proxy wait shortens.
const PROBE = `
const https=require("node:https"),fs=require("node:fs");
const [k,c,h]=process.argv.slice(1);   // node -e: user args start at argv[1]
const say=(v)=>{process.stdout.write("CATRUST-OK "+v);try{s&&s.close()}catch{};process.exit(0)};
let s;
// createServer THROWS on a mismatched key/cert pair -- before listen, so an
// 'error' handler never sees it. That is our own key material, not a verdict
// about the bundle, so it must reach the caller as E rather than as a dead child.
try{s=https.createServer({key:fs.readFileSync(k),cert:fs.readFileSync(c)},(_q,r)=>r.end("ok"))}catch{say("E")}
s.on("error",()=>say("E"));
s.listen(0,"127.0.0.1",()=>{
  https.get({host:"127.0.0.1",port:s.address().port,servername:h,path:"/"},
            ()=>say("1")).on("error",()=>say("0"));
});`;

// Does node verify our leaf when handed `bundlePath`? true / false / null.
//
// null means the probe could not answer, which is NOT "no". Only a token the
// probe itself wrote separates a child that never reached the handshake from
// one that reached it and failed — exit status looks the same either way. `E`
// is the probe's own listen failure (a sandbox with no loopback).
function verifiesOurLeaf(bundlePath, leaf) {
  const r = spawnSync(process.execPath, ["-e", PROBE, leaf.keyPath, leaf.certPath, leaf.host], {
    // The probe must answer about the BUNDLE, so anything in the operator's
    // environment that changes WHAT A HANDSHAKE MEANS is cleared. Each of these
    // was measured, not guessed:
    //   NODE_TLS_REJECT_UNAUTHORIZED=0  disables peer verification, so EVERY
    //     bundle completes the handshake and the guard accepts unconditionally,
    //     with no warning — on precisely the corporate-MITM machines this
    //     feature targets. The parsing predicate this replaced was immune, so
    //     the oracle has to clear it explicitly.
    //   NODE_OPTIONS  can --require a module that writes to stdout ahead of our
    //     sentinel, turning every verdict into `unknown`.
    //   the PROXY vars  send the probe's own 127.0.0.1 request to a proxy, so
    //     the handshake terminates somewhere else entirely and the verdict is
    //     about the wrong peer. Node >=24 honours them only under
    //     NODE_USE_ENV_PROXY=1, but clearing the whole family is what makes this
    //     survive node adding a second opt-in. Measured on a healthy bundle with
    //     a listener on the proxy port: `{ok:false}` — a good bundle refused,
    //     and the session narrowed to our CA alone.
    //
    // Two named variables was the previous version of this list, and the third
    // arrived with a node release. Clear the CLASS, not the members you know.
    //
    // THREE independent blocks, not one guard plus decoration, and a mutation
    // report will read the redundancy as dead code. Measured on the runtime,
    // parent env holding NODE_USE_ENV_PROXY=1 and every *_PROXY var:
    //   no clears at all                  -> ERR_PROXY_TUNNEL  (routed)
    //   only NODE_USE_ENV_PROXY cleared   -> ECONNREFUSED      (blocked)
    //   only the *_PROXY vars cleared     -> ECONNREFUSED      (blocked)
    //   only the NO_PROXY belt            -> ECONNREFUSED      (blocked)
    // Each one alone is sufficient TODAY, so deleting any single line changes
    // no test; deleting all three fails. That is redundancy against three
    // different futures, not three copies of one check: the opt-in dies if node
    // honours the family without it, the empty values die if node stops reading
    // "" as unset, and the belt dies if node adds a proxy source NO_PROXY does
    // not cover. Round 3 shipped this list with two members when it needed
    // three, so the cost of a spare line is measured against that.
    env: { ...process.env, NODE_EXTRA_CA_CERTS: bundlePath,
           NODE_OPTIONS: "", NODE_TLS_REJECT_UNAUTHORIZED: "",
           NODE_USE_ENV_PROXY: "",
           HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "",
           ALL_PROXY: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*" },
    encoding: "utf8",
    // 5 s, not 15. Measured against this cap at three load levels on 48 cores,
    // worst of five runs each:
    //
    //   idle                          45 ms    112x headroom
    //   2x oversubscription  (96)    168 ms     29x
    //   8x oversubscription (384)    564 ms      8.9x
    //
    // The headroom shrinks with load, which is the half a single row hides — an
    // earlier version of this comment quoted 25x from the 2x row alone. Even at
    // 8x, a level no launcher should meet, the cap is nine times the worst
    // observed probe, so it only bites when one is genuinely hung.
    //
    // Worth stating because the cap was lowered on a WEDGED-case measurement,
    // where every probe burns the full timeout by construction and a smaller cap
    // therefore always looks better — the healthy-case cost above is the half that
    // could have made it too tight. The number matters because these STACK inside
    // salvage: see the budget below for the measured sweep. The cap sets the constant; the budget sets where it stops
    // growing.
    timeout: 5_000,
  });
  // `status !== 0` alone. A spawn that never ran, one killed by the timeout, and
  // one that exited non-zero all leave `status` null or non-zero — measured
  // across ENOENT, ETIMEDOUT/SIGTERM, exit 3 and exit 0, where `r.error` and
  // `r.signal` changed the verdict in none of the four. The sibling probe below
  // has always been written this way; these two disagreed for no reason.
  if (r.status !== 0) return null;
  const m = /CATRUST-OK ([10E])/.exec(r.stdout || "");
  if (!m) return null;
  // `E` is the probe failing to SERVE — a mismatched leaf.key/leaf.pem pair (a
  // real state: forward-proxy.mjs documents a two-rename window where the two
  // come from different generations), or a sandbox with no loopback. Still
  // unknown, because we could not ask; but reported apart from "the child never
  // ran", since one is our own key material and the other is the environment,
  // and the reason string is what an operator reads first.
  //
  // Deleting `"local"` and letting these land on `null` was proposed, on the
  // reasoning that the child's own stderr names the failing file better than our
  // reason string does. Measured, it does not: absent key, mismatched pair and
  // key-is-a-directory all exit 0 with EMPTY stderr, because `say("E")` catches
  // and reports before node can print anything. The sentinel is the ONLY signal
  // that separates those from a healthy run — without this branch the parent
  // sees status 0 and an unmatched token, which is indistinguishable from a
  // child that wrote nothing at all.
  if (m[1] === "E") return "local";
  // THE SAME CHILD ALREADY SAW THE LOAD, so ask it about the load as well as the
  // handshake. node emits `Ignoring extra certs` for exactly the files BoringSSL
  // discards, and this child triggered the extras load by connecting — measured
  // on the split shape (our CA, then a fatal block): `CATRUST-OK 1` on stdout AND
  // the warning on stderr, one spawn. Reading it here saves a second spawn on
  // every healthy launch, where the handshake's own success already proves node
  // loaded our CA (it verified a leaf our CA signed).
  //
  // `discarded` is reported separately from the verdict rather than folded into
  // it: the handshake genuinely succeeded, and a caller that only wants "does
  // node verify" must keep getting the true answer.
  // `|| ""` collapses "no stderr" into "no warning", i.e. into "the client would
  // keep this file". Safe ONLY because every way stderr goes missing (spawn
  // failure, timeout kill, buffer overflow) also sets status non-zero, and the
  // status check above returns first — measured. Hoist this above that check,
  // or add a fourth way stderr can vanish with status 0, and an unavailable
  // stderr silently becomes a clean bill of health.
  if (m[1] === "1" && /Ignoring extra certs/i.test(r.stderr || "")) return "discarded";
  return m[1] === "1";
}

// Is this bundle safe to hand claude as NODE_EXTRA_CA_CERTS?
//
// SELF-carry, not bundle integrity. It asks whether OUR proxy verifies, because
// our CA is the only one the launcher holds — so a merge that silently dropped
// a SIBLING publisher answers `ok` here, and the dropped component falls back to
// its own CA and keeps working. Every consumer is blind the same way, by
// construction. Only the builder, which knows what it was given, can catch that;
// this check does not replace its count and must not be read as covering it.
//
// THREE outcomes, never two. `unknown` means the probe could not be run, and a
// caller must NOT narrow trust on it. Answering "unusable" there drops every
// corporate root on a machine whose bundle was fine, which is the failure this
// contract exists to prevent.
//
// `leaf` is {keyPath, certPath, host} for a leaf OUR CA issued — the proxy's
// own, which the caller already has. Verifying it is a stronger question than
// "does the loaded set contain our CA": it is the thing the session will do.
export function bundleUsable(bundlePath, leaf) {
  const ok = verifiesOurLeaf(bundlePath, leaf);
  if (ok === "local") return { unknown: true, reason: "our own leaf key/cert pair does not serve" };
  if (ok === null) return { unknown: true, reason: "the CA loader could not be consulted" };
  // `discarded`: node verified our leaf, and it ALSO warned that it dropped the
  // file's extras. Both are true — node stops at the damage and keeps what it
  // read before it, so our CA was loaded and the handshake succeeded. The real
  // client (Bun/BoringSSL) is all-or-nothing and discards the whole file, and a
  // discarded file also takes down CAs supplied via `SSL_CERT_FILE` or
  // `SSL_CERT_DIR`. So `ok` stays true and the caller is told not to hand it over.
  if (ok === "discarded") {
    return { ok: true, discarded: true, reason: "the real client would discard this bundle" };
  }
  return ok ? { ok: true } : { ok: false, reason: "node will not verify our proxy with this bundle" };
}

// Does node load OUR CA from this file? Asked of node, and asked WITHOUT a
// handshake — that combination is the whole point. When our own leaf cannot be
// served `bundleUsable` answers `{unknown:true}` for every input, so `!ok` is
// true of a perfectly good bundle; this needs no leaf, so it still answers in
// exactly the conditions where the handshake cannot.
//
// COUNTING is not enough, and that is what this replaced. node's extras loader
// stops at the first fatal block and keeps what it read before it, so a
// healthy-then-damaged publisher truncates the load ahead of our appended CA:
// one certificate loads, it is not ours, and a count of 1 looks healthy.
// Measured — the rebuild was handed to claude, which then distrusted the very
// proxy it was routed through.
//
// Compared as normalized PEM text because that is what node returns and what we
// hold; no parsing, no fingerprinting, nothing that could disagree with the
// loader about what it loaded.
//
// THREE ANSWERS, NEVER TWO: `true` / `false` / `null`. `null` is "could not
// ask", and it is NOT a synonym for either. Collapsing it into `true` was a
// defect, not a simplification: this probe is consulted at gates reached
// BECAUSE a bundle was already refused, so an unmeasured "yes" widens onto a
// file measured unusable. `tls.getCACertificates` does not exist before v22.15
// and `engines` says `>=18`, so on most of the declared range that was every
// launch with a stale merge, not an edge case. Each caller now states what it
// does with `null` instead of inheriting one global guess.
//
// IT ALSO ASKS WHETHER THE LOAD WAS CLEAN, and that half is about a DIFFERENT
// runtime. The client is not node: `claude` is a Bun binary linked against
// BoringSSL — verified on the installed 2.1.220 (ELF, `BoringSSL` in strings).
// The switch is documented at CC v2.1.113 in this repo's README and CHANGELOG;
// that version is not on this box, so the DATE is inherited while the fact is
// measured. The two loaders disagree exactly here —
//
//   bundle                       node            real client (2.1.220)
//   our CA, then a fatal block   loads 1 (ours)  DISCARDS THE WHOLE FILE
//   fatal block, then our CA     loads 0         DISCARDS THE WHOLE FILE
//
// node truncates and KEEPS what it read before the damage; BoringSSL is
// all-or-nothing. So "node loaded ours" was true of a file the session would
// get nothing from. Measured against the shipped binary over a local TLS server
// (the handshake precedes auth, so no API session is involved).
//
// The tell is node's own stderr: it emits `Ignoring extra certs ... load
// failed` for exactly the files BoringSSL discards. That is the loader
// reporting its own failure, not us predicting one — a marker COUNT was tried
// here first and refused three files the client accepts (`-----BEGIN
// CERTIFICATE-----` inside prose or a comment inflates a substring count), which
// is the #300 defect this module exists to avoid, reinvented.
//
// Asking the client itself is not affordable on this path: the trust store
// loads LAZILY on the first TLS client, and the warning flushes only at exit.
// `claude mcp list` reaches it in ~30 s (it health-checks every MCP server); an
// isolated config dir answers in 316 ms but never loads the store at all;
// `--version`, `--help`, `update` and `doctor` never load it. There is no cheap
// door, so this is the closest signal that agrees with it — 16/16 across every
// shape either side of the review built, including the three a count got wrong
// and six constructed to break it in the UNSAFE direction (node silent, client
// discards): CRLF throughout, no trailing newline, base64 rewrapped at 48
// columns, a PUBLIC KEY block between certs, prose between certs, and a space
// before the END line. A negative result, and its limit is that six shapes are
// not a parser-diff matrix.
//
// NEITHER PROBE SUBSUMES THE OTHER, and that is the argument for both existing
// rather than one being defence in depth. Measured on the same file, our CA
// followed by a fatal block:
//
//   bundleUsable (handshake)  {ok:true}   <- node truncates and KEEPS ours
//   carriesOurCA (this)       false       <- the real client discards the FILE
//
// The handshake is immune to the lazy-load window above — it cannot answer
// without loading the store, so it reads the same on v22.14 as on v24 — and it
// is blind to the BoringSSL split, because node verified our leaf with a file
// the client will not accept at all. This one is the reverse. Delete either and
// a measured failure ships.
export function carriesOurCA(bundlePath, ourCaPem) {
  // A test seam for "the probe could not answer". Without one the branch is
  // reachable only on a pre-v22.15 runtime or a >626-certificate bundle, and a
  // branch no test can reach is not guarded — measured on the predecessor of
  // this function, where three fail-open mutations left the whole suite green.
  //
  // It drives the CHILD, not this function: an early `return null` here would
  // short-circuit ahead of the three real unanswerable paths below (the spawn
  // failed, the child reported no sentinel, the API was absent), so mutating any
  // of them to fail open left the suite green — the seam would have been testing
  // itself. Making the child print the pre-v22.15 answer runs the same code a
  // node 18 host runs.
  //
  // THE CHILD DOES THE COMPARISON, and that is what keeps this small. Shipping
  // the loaded certificate list back over the pipe meant a ~192 KB payload for
  // an ordinary corporate store and an ENOBUFS truncation past ~626
  // certificates — a failure mode this design invented, then needed a `maxBuffer`
  // bump, a test seam, and a parse guard to contain. Our CA goes IN on stdin and
  // one token comes back, so the answer is a handful of bytes at any bundle size
  // and none of that machinery has anything to contain.
  const r = spawnSync(process.execPath, ["-e",
    'const t=require("node:tls"),ours=require("node:fs").readFileSync(0,"utf8").replace(/\\s+/g,"");' +
    // The seam lives in the CHILD's condition, beside the version check it
    // simulates, so it reproduces a pre-v22.15 host rather than short-circuiting
    // the parent. A seam that returns early in the parent tests itself: mutating
    // the parent's real unanswerable paths to fail open left the suite green.
    'const api=t.getCACertificates&&!process.env.CACHE_FIX_CA_PROBE_UNANSWERABLE;' +
    // FORCE the extras load, because on newer runtimes it is LAZY — it happens
    // when the trust store is first consulted, and the only thing that consults
    // it below is `getCACertificates`. So on a host where that API is absent the
    // child answered `U` without ever touching the store, and the stderr sniff
    // that exists to serve exactly those hosts read an empty string. Measured on
    // real binaries, same file, same bundle, only the interpreter differing:
    //   v18.20.8 / v20.19.0 / v22.6.0   API absent, WARNS     (eager load)
    //   v22.7.0 … v22.14.x              API absent, SILENT    <- blind
    //   v22.15.0 / v24.11.1             API present, WARNS
    // The launcher's happy path reads a missing answer as "keep the merge", so
    // the whole window shipped a bundle the real client discards, with no
    // message. `createSecureContext({})` consults the store and nothing else;
    // wrapped because a runtime that refuses it must still reach the answer.
    //
    // It runs UNCONDITIONALLY, including under the seam. A first attempt made
    // the seam skip it — which simulated the code WITHOUT this fix, so the test
    // written to prove the fix asserted against a child that did not have it.
    // The seam's job is to hide the API (what a pre-v22.15 host presents), not
    // to hide the repair.
    'try{t.createSecureContext({})}catch{};' +
    'process.stdout.write("CATRUST-C "+(api?(t.getCACertificates("extra")' +
    '.some((p)=>p.replace(/\\s+/g,"")===ours)?"Y":"N"):"U"))'],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: bundlePath, NODE_OPTIONS: "" },
      input: String(ourCaPem), encoding: "utf8", timeout: 5_000 });
  // `status !== 0` alone, and `input:` is the reason that needs saying. A child
  // that does NOT drain stdin leaves the parent with `error.code === "EPIPE"`
  // and `status: 0` — the one shape where the shorter test disagrees with
  // `r.error || r.status !== 0` (measured). It cannot happen here: the child's
  // FIRST statement is `readFileSync(0)`, before the API check and before the
  // seam, so every path drains. Verified with a 3 MB payload on both the normal
  // and the seam path — no EPIPE, correct answer, 39 ms.
  if (r.status !== 0) return null;
  // NOTE WHAT THIS MAKES `null` MEAN. The sniff needs no API, only the forced
  // load, so a host that cannot count still refuses a client-fatal bundle:
  //
  //   bundle              census (can count)   census (cannot)
  //   healthy             true                 null
  //   ours + fatal block  false                FALSE
  //
  // So `null` is "neither probe found fault", not "nothing was looked at" — which
  // is what makes the launcher's happy path safe in keeping a merge on a
  // handshake plus a `null` here. On a pre-v22.15 host that is every launch.
  //
  // A warning means the loader hit a fatal block, and it is asked BEFORE the
  // "could not count" answer on purpose: node emits it whether or not
  // `getCACertificates` exists, so a pre-v22.15 host can still be told that its
  // bundle is one the real client discards. node kept what it read before the
  // damage; BoringSSL keeps nothing. Answer for the client.
  // Same `|| ""` collapse as the sibling probe, safe for the same reason and by
  // the same ordering: the status check above returns first.
  if (/Ignoring extra certs/i.test(r.stderr || "")) return false;
  const m = /CATRUST-C ([YNU])/.exec(r.stdout || "");
  if (!m) return null;                 // the child never reported
  return m[1] === "U" ? null : m[1] === "Y";
}

// A bundle rebuilt from the publishers that still work, or null.
//
// The old answer to a damaged merge was "use our own CA alone", which drops
// every OTHER publisher's CA for the session. The saving is one certificate per
// SURVIVING publisher, and both ends were checked because the interior looks
// simplest: ours alone and ours + one FATAL peer both TIE at 1, so at the shapes
// closest to a real broken host salvage is "no worse" rather than "better".
// This box holds ours + one peer (ccf.pem, cswap-pin.pem), where narrowing
// loads 1 certificate and salvage gives 2; on a three-publisher host it is 1
// against 3. The damage lives in the MERGE, not in the files that fed it, so
// publishers that still load are recoverable — but only the ones that PUBLISH.
// The builder also merges in this box's ambient corporate roots, which no
// component wrote into `ca-trust.d`, so a rebuild cannot carry them: measured
// here, the merge loads 132 and the trust dir holds 2 files. That is why the
// launcher prefers a merge nothing faulted over a rebuild, and only falls back
// to rebuilding when the merge was actually refused. Only asking node can do
// this: a
// predicate answers yes/no about one bundle, while the probe can be pointed at
// each input in turn.
//
// A publisher file is kept when it does not BREAK the merge, not when it
// verifies our leaf — only our own file can do that, and dropping the others is
// exactly the loss this function exists to prevent. So each candidate is tested
// concatenated with our CA: if that pair still verifies, the file is harmless.
//
// `writeTmp` takes the assembled text and returns a path to read it back from;
// the caller owns placement and cleanup. Returns null when nothing survived, so
// the caller keeps its existing fallback rather than acting on a guess.
export function salvageBundle(trustDir, ourCaPem, leaf, writeTmp) {
  // The launcher reads its CA with `readFileSync(caPem)` and no encoding, so
  // this arrives as a Buffer. Normalising here rather than at the call site:
  // every caller has a file, and which of them remembered `"utf8"` is not a
  // thing this function should be able to break on. Measured — it did, live,
  // with the whole suite green, because every test passed a string.
  const ourText = typeof ourCaPem === "string" ? ourCaPem : String(ourCaPem);
  let entries;
  try { entries = readdirSync(trustDir).filter((f) => f.endsWith(".pem")).sort(); }
  catch { return null; }
  const nl = (t) => (t.endsWith("\n") ? t : t + "\n");   // a file not ending in a
  // newline fuses its last marker to the next file's first one — the exact
  // damaged shape this path exists to survive. Do not reintroduce it here.
  // A BUDGET AND a per-probe timeout. They bound different things and the pair
  // was measured against each alternative on a fully wedged trust dir
  // (unreachable interpreter, so every probe burns its cap):
  //
  //   publishers   wedged   probes run
  //        2         15.0 s       3
  //        3         20.1 s       4
  //        4         25.1 s       5
  //        5         25.1 s       5
  //       11         25.1 s       5
  //       25         25.1 s       5
  //
  // LINEAR to 4, then flat — not "flat in N", which is what an earlier version
  // of this comment said from three samples that all sat on the plateau. The
  // ceiling is floor(budget / cap) + 1 probes, so it stops depending on N only
  // ABOVE that knee. Deliberately NOT restating the two numbers here: the cap
  // lives in `verifiesOurLeaf`, far enough up that a change to it would leave
  // this arithmetic reading as true while being false, and the formula is what
  // a reader needs anyway. The distance was written as a line count and had
  // rotted by two within one review round — a figure that measures the file's
  // own layout goes stale on any edit above it, which is the same defect one
  // level down. Name the function; that survives the edit. The wall clock alone cannot show this:
  // 11 and 25 are both 25.1 s, which reads as confirmation. The probe COUNT is
  // what says the loop stopped in the same place for the same reason.
  //
  // The budget is what puts the knee there at all; the cap is what makes the
  // constant small. Deleting the budget and relying on a smaller cap alone was
  // proposed, and the plateau is why it was not taken — without the budget there
  // is no knee and the ceiling is (N+1)x cap forever. Measured, same harness
  // with the deadline check removed:
  //
  //   publishers   no budget   probes run
  //        5         30.1 s        6
  //       11         60.3 s       12
  //
  // against 25.1 s and 5 probes with it. Linear, unbounded, and all of it after
  // the proxy is forked and before claude starts.
  // The launcher would look hung, and this is the degraded path, so the answer
  // to "we cannot judge in reasonable time" is the same as the answer to "we
  // could not ask": keep the file. Measured for scale on lmd42: a healthy probe
  // is ~43 ms and a bare spawn ~18 ms, so 20 s is three orders of magnitude of
  // headroom for any real bundle and only bites when probes are actually hanging.
  // The budget is overridable so a test can drive the EXPIRED path. Without a
  // seam, the only way to reach it is a probe that really hangs for 20 s, and a
  // test that cannot reach a branch does not guard it — measured: the version
  // with a hardcoded budget passed identically with the budget deleted.
  const budgetMs = Number(process.env.CACHE_FIX_CA_SALVAGE_BUDGET_MS) || 20_000;
  const deadline = Date.now() + budgetMs;
  const kept = [];
  for (const f of entries) {
    let text;
    try { text = readFileSync(join(trustDir, f), "utf8"); } catch { continue; }
    if (Date.now() > deadline) { kept.push(nl(text)); continue; }   // unjudged, so kept
    const answer = verifiesOurLeaf(writeTmp(nl(text) + nl(ourText)), leaf);
    // Drop ONLY on a real refusal. Everything else — `null` (the probe never
    // ran) and `"local"` (our own leaf could not be served) — is "could not
    // ask", not "broken", and dropping on it discards a HEALTHY publisher while
    // the rebuild still verifies, so nothing anywhere reports the loss. Same
    // choice the caller makes with `unknown`: never narrow on an answer we did
    // not get.
    //
    // Written as `!== false` rather than by listing the accepted values: this
    // function has FOUR return values and the version that named two of them
    // silently dropped the third. Any future unknown lands on the safe side by
    // default.
    // Skip a candidate that IS our CA: it is appended unconditionally below, and
    // node does not dedupe — measured, our CA written twice into one file loads
    // as 2 certificates. Harmless to trust, but it inflates every count anyone
    // quotes about a rebuild, and the docs were already quoting the pre-duplicate
    // figure while the code produced the inflated one.
    // `"discarded"` is named EXPLICITLY, and the comment above is why it has to
    // be. That comment defends `!== false` as future-proof — "any future unknown
    // lands on the safe side by default" — and it is right about unknowns and
    // wrong about this one. `discarded` is not an unknown; it is a MEASURED
    // refusal on behalf of the real client, and `!== false` kept it.
    //
    // Keeping it inverts the severity ordering, which is how it was found:
    //   healthy + WHOLLY torn publisher        answer false       dropped, rebuild 2 CAs
    //   healthy + (our CA copy)+(fatal block)  answer discarded   KEPT -> rebuild NULL, 1 CA
    // The more surgically damaged file caused the worse outcome, because the
    // final gate then correctly refuses the poisoned rebuild and one bad
    // publisher costs every good one. R2, not R1 — nothing unverifiable reaches
    // `claude`, but a healthy 3-CA session narrows to 1.
    if (answer !== false && answer !== "discarded") {
      if (nl(text) !== nl(ourText)) kept.push(nl(text));
    }
  }
  // `kept` empty means nothing survived, so there is nothing to rebuild FROM and
  // the caller's own fallback is at least as good. A `dupes` counter used to let
  // one case through — a trust dir holding ONLY our CA, where every candidate is
  // skipped as a duplicate — on the reasoning that returning our CA beat
  // returning nothing. It does not. Measured, that dir plus a healthy merge and
  // an unserveable leaf: the rebuild loads 1 CA, while `null` sends the launcher
  // back to a merge that loads 2. Never better, sometimes worse.
  if (!kept.length) return null;
  // The rebuild is itself a merge, so it faces the same probe as any other
  // candidate. Trusting it because we assembled it is the assumption this
  // module exists to stop making.
  //
  // `.ok === false`, not `!.ok`: `bundleUsable` returns `{unknown: true}` when
  // it could not ask, and `.ok` is then `undefined` — falsy. Discarding on that
  // throws away a rebuild nobody found fault with, and does it in exactly the
  // conditions where every candidate was also unjudgeable, so the keep rule
  // above would be cancelled here and every unknown path would still end at our
  // own CA alone. Refuse only what was actually refused.
  // A rebuild claude cannot verify OUR proxy with is never worth handing over,
  // whatever the handshake says about it. This is the composition the keep rule
  // and the re-check missed between them: when the probe cannot answer for any
  // candidate, everything is kept — including a genuinely fatal file — and the
  // re-check then also answers `unknown`, so `.ok === false` is false and the
  // broken rebuild was RETURNED.
  //
  // Two measurements, one guard. Counting caught the first and not the second:
  //   node loaded 0 CAs from the rebuild, caller's fallback loads 1
  //   node loaded 1 CA  from the rebuild and it was a PEER, not ours
  // The second is the shape a count cannot see — the loader stops at the first
  // fatal block and keeps what came before, so damage between a good publisher
  // and our appended CA reads as a healthy count of 1.
  //
  // Asked WITHOUT a handshake, and that is the whole point: when our own leaf
  // cannot be served every verdict is `unknown`, so `!verdict.ok` is true of a
  // perfectly good bundle too — narrowing a healthy 3-CA session to 1, which is
  // requirement 2 broken to fix requirement 1.
  //
  // `null` here means the probe could not answer, and this gate KEEPS the
  // rebuild on it — the opposite of what the launcher does with the same value,
  // deliberately. This one is reached with a rebuild assembled from files that
  // were individually judged (or kept because they could not be judged), and
  // discarding it on an unmeasured answer drops every other publisher for a
  // probe that never ran. The launcher's gate is reached only after the merge
  // was REFUSED, where the same value must narrow instead. Same tri-state, two
  // call sites, opposite defaults, each stated where it is taken.
  //
  // ONE gate, not two. A `bundleUsable` re-check used to follow this line, and
  // the reason it went is NOT that nothing separates the two — that was the
  // first justification written here and it is measurably false. It was reached
  // by varying the BUNDLE while holding the leaf fixed; vary the LEAF instead
  // and three rebuilds separate, all in the same direction:
  //
  //   leaf's SAN misses the probe host, rebuild carries ours
  //     census  true          -> keep
  //     re-check {ok:false}   -> DISCARD a healthy rebuild
  //
  // So the re-check was not redundant. It was WRONG: it refused rebuilds because
  // our own leaf could not verify against the probe host, which is a fact about
  // our key material and not about the bundle — R2 broken to answer a question
  // R1 had already answered. `leafCoversAllHosts()` makes that state unreachable
  // by construction (claude-via-proxy.mjs re-derives the probe host from the
  // same inputs), so it never fired in practice; if it ever had, it would have
  // narrowed trust on the wrong evidence.
  const path = writeTmp(kept.join("") + nl(ourText));
  return carriesOurCA(path, ourText) === false ? null : path;
}
