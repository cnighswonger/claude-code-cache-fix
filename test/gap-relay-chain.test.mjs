// THE RELAY MUST WALK THE WHOLE CHAIN, and this is its own file because it
// spawns a relay per case against three live endpoints.
//
// It took the FIRST usable candidate at startup and fell straight to a direct
// dial when that one would not carry, so a configured second hop was never
// tried. proxy/upstream.mjs resolveHop() walks the whole list — one chain, two
// definitions of what "the chain" is, and the relay's copy is the one that runs
// precisely when the proxy is down.
//
// cswap's pin walks its own candidates the same way and gave the shape: treat a
// refusal as "refused BY this hop", try the one behind it, TRACE the refusal,
// and reach direct only when none will carry. Explicitly NOT a hard close on
// no-hop — their measurement is that closing there trades an invisible
// fall-open for an invisible outage, and this tunnel is the most expensive
// place to take one.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const relayPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gap-relay.mjs");

const freePort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};

// An endpoint that records being reached and answers a CONNECT. Every one of
// them records, so a failure names which was touched instead of leaving an
// empty set — an assertion that fires on `[]` has already discarded the
// evidence that would narrow it.
const endpoint = async (name, touched) => {
  const s = net.createServer((c) => {
    touched.push(name);
    c.once("data", () => c.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
    c.on("error", () => {});
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { srv: s, port: s.address().port };
};

// A HOP THAT DEMANDS Proxy-Authorization, which is what a corp proxy does.
// Answers 407 without it and 200 with the right one, so the assertion can be
// "the client got through", not "we found the header somewhere".
const authHop = async (user, pass, seen) => {
  const want = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const s = net.createServer((c) => {
    c.once("data", (d) => {
      const req = String(d);
      const got = /^proxy-authorization:[ \t]*(.+)$/im.exec(req);
      seen.push(got ? got[1].trim() : null);
      c.write(got && got[1].trim() === want
        ? "HTTP/1.1 200 Connection Established\r\n\r\n"
        : "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          "Proxy-Authenticate: Basic realm=\"x\"\r\n\r\n");
    });
    c.on("error", () => {});
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { srv: s, port: s.address().port };
};

async function withRelay(chain, fn, extraEnv = {}) {
  // THE RELAY LISTENS ON fd 3 — `srv.listen({ fd: 3 })` — because the holder
  // hands it an already-bound socket. A fixture that spawns it without one
  // produces a process that never listens, and every probe then reads as "the
  // code did nothing". Measured: the first cut of this reported zero endpoints
  // touched and zero traces, which looks exactly like a broken fix.
  const carrier = net.createServer();
  await new Promise((r) => carrier.listen(0, "127.0.0.1", r));
  // The port has to be read now: the parent stops listening below, and the
  // address is gone once it does.
  const carrierPort = carrier.address().port;
  const env = { ...process.env, CACHE_FIX_HELD_PORT: String(carrierPort),
                CACHE_FIX_FALLBACK_PROXIES: chain };
  // CACHE_FIX_REQUIRE_HOP joins the scrub list for the reason the others are on
  // it: an operator who exported it while debugging would silently change what
  // every case here measures. The one case that needs it passes it explicitly.
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                   "CACHE_FIX_UPSTREAM_PROXY", "ALL_PROXY", "all_proxy",
                   "CACHE_FIX_STANDBY", "CACHE_FIX_REQUIRE_HOP"]) delete env[k];
  Object.assign(env, extraEnv);
  const relay = spawn(process.execPath, [relayPath],
                      { env, stdio: ["ignore", "ignore", "pipe", carrier._handle.fd] });
  // THE PARENT MUST STOP ACCEPTING once the child has the fd. Both processes are
  // listeners on the same socket, so the kernel gives each connection to
  // whichever accepts first — and this parent has no `connection` handler, so a
  // connection it wins is held open with nothing to end it. `close(cb)` waits for
  // every open connection, so its callback never comes, the promise never
  // settles, and the file hangs until CI's 6-hour ceiling.
  //
  // Timing-dependent, which is why it hid: 48 cores here let the child win every
  // time; a 4-core runner does not. Measured with `taskset -c 0-3` — reproduces
  // constrained, never unconstrained.
  //
  // Closing here does NOT disturb the child: `stdio` handed it a dup of the fd,
  // and the socket lives until the last descriptor goes. Done AFTER spawn and
  // before any client dials, so there is no window where nobody is listening.
  await new Promise((r) => carrier.close(r));
  let err = "";
  relay.stderr.on("data", (d) => { err += d; });
  try {
    // The premise, asserted rather than assumed.
    const up = Date.now() + 10_000;
    while (!/gap-relay carrying/.test(err) && Date.now() < up) await new Promise((r) => setTimeout(r, 50));
    assert.match(err, /gap-relay carrying/,
      `the relay never took the socket, so nothing below was measured; stderr: ${JSON.stringify(err.slice(-200))}`);
    await fn({ port: carrierPort, stderr: () => err });
  } finally {
    try { relay.kill("SIGKILL"); } catch {}
  }
}

// Returns the CONNECT REPLY LINE, not merely "something answered". The status
// on that line is a cross-component contract: cswap's pin reads a non-200
// CONNECT reply as a refusal and walks past us to the next hop
// (_blind_tunnel -> "chain refused <target> (<status>)"), and their
// runtime_health chain probe requires " 200 " in this exact line or reports the
// connect stage FAILED. Their /health probes are deliberately status-blind — a
// 503 there is fine and intended — so THIS line is the only status we owe them.
const connectThrough = (port, target) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  c.on("data", (d) => { c.destroy(); resolve(String(d).split("\r\n")[0]); });
  c.on("error", (e) => resolve(`ERR:${e.code}`));
  setTimeout(() => { c.destroy(); resolve("TIMEOUT"); }, 6_000);
});

// REQUIRE_HOP=1 IS THE OPERATOR OVERRIDING THIS FILE'S OWN DEFAULT.
//
// The fall-through to direct is deliberate and argued 60 lines up: closing when
// no hop carries "trades an invisible fall-open for an invisible outage, and
// this tunnel is the most expensive place to take one". That reasoning holds
// when nobody has said otherwise. CACHE_FIX_REQUIRE_HOP=1 IS saying otherwise —
// it is the operator declaring that for them the fall-open is the worse half.
//
// The live proxy already honours it in two places (forward-proxy.mjs:319,372
// and upstream.mjs:453) and refuses with a 502. The relay carries the address
// only during holder transitions — which is every deploy — so this was a policy
// hole that opened exactly while the zero-downtime path was doing its work, and
// closed again before anyone looked.
//
// ASSERTED ON THE ORIGIN, not on the reply line. A relay that answers non-200
// and still dials would pass a reply-only check; `touched` is what proves no
// credential-bearing TLS left the box unproxied.
test("refuses rather than dialling direct when CACHE_FIX_REQUIRE_HOP=1", async () => {
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const dead = await freePort();
  try {
    await withRelay(`http://127.0.0.1:${dead}`, async ({ port, stderr }) => {
      const reply = await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(touched, [],
        `no hop would carry and REQUIRE_HOP=1, yet the relay dialled the origin ` +
        `itself — a session that set that flag just sent its credentials ` +
        `unproxied. reply=${JSON.stringify(reply)} stderr=${JSON.stringify(stderr().slice(-300))}`);
      assert.doesNotMatch(reply, /\s200\s/,
        `the relay told the client the tunnel was established; pin reads a non-200 ` +
        `on this line as "walk past us", which is the behaviour a refusal owes. ` +
        `reply=${JSON.stringify(reply)}`);
    }, { CACHE_FIX_REQUIRE_HOP: "1" });
  } finally { origin.srv.close(); }
});

// A HOP URL MAY CARRY CREDENTIALS AND WE NEVER SEND THEM.
//
// CACHE_FIX_FALLBACK_PROXIES supports userinfo — that support is the whole
// reason the "using proxy" line had a password in it to leak. But the relay
// dials with net.connect(portOf(u), u.hostname) and then writes the CLIENT'S
// original CONNECT bytes verbatim, so the userinfo in the hop URL reaches
// nothing. Nowhere in bin/ or proxy/ derives Proxy-Authorization from a hop
// URL; the only related line strips credentials (server.mjs:822).
//
// So an authenticated hop answers 407, and `carried` is already true by then —
// it is set on TCP connect, before any hop reply — so the 407 is piped straight
// back and the client sees it. That is a silent failure precisely during a
// holder transition, on a chain the operator configured correctly.
//
// ASSERTED ON THE CLIENT GETTING THROUGH, plus what the hop actually received,
// so a fix that sends a malformed or wrong-user header fails rather than
// passing on the presence of the word "Basic".
// Same as connectThrough, plus headers the CLIENT chose to send. Needed because
// a Proxy-Authorization from the client is addressed to US, not to the hop.
const connectWithHeaders = (port, target, headers) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => c.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`));
  c.on("data", (d) => { c.destroy(); resolve(String(d).split("\r\n")[0]); });
  c.on("error", (e) => resolve(`ERR:${e.code}`));
  setTimeout(() => { c.destroy(); resolve("TIMEOUT"); }, 6_000);
});

test("sends Proxy-Authorization derived from a hop URL's userinfo", async () => {
  const seen = [];
  const hop = await authHop("alice", "s3cr3t-token", seen);
  try {
    await withRelay(`http://alice:s3cr3t-token@127.0.0.1:${hop.port}`, async ({ port, stderr }) => {
      const reply = await connectThrough(port, "example.invalid:443");
      assert.match(reply, /\s200\s/,
        `an authenticated hop refused us, so a correctly configured chain fails ` +
        `during every holder transition. hop saw Proxy-Authorization=` +
        `${JSON.stringify(seen[0])} reply=${JSON.stringify(reply)} ` +
        `stderr=${JSON.stringify(stderr().slice(-200))}`);
      assert.equal(seen[0], "Basic " + Buffer.from("alice:s3cr3t-token").toString("base64"),
        `the hop received ${JSON.stringify(seen[0])}`);
    });
  } finally { hop.srv.close(); }
});

// A PASSWORD WITH RESERVED CHARACTERS MUST ARRIVE RAW.
//
// Written because the mutation table said it was needed: dropping
// decodeURIComponent passed the case above, whose credentials contain nothing
// URL escapes. `new URL()` percent-encodes userinfo, so `p@ss:w#rd` reaches us
// as `p%40ss%3Aw%23rd` and a hop comparing against the real password refuses.
// This is the shape an operator hits first, because a generated proxy password
// is exactly where reserved characters live.
test("sends a hop password that URL-escaped, decoded back to its real bytes", async () => {
  const seen = [];
  const USER = "al ice";
  const PASS = "p@ss:w#rd";
  const hop = await authHop(USER, PASS, seen);
  try {
    const enc = `${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}`;
    await withRelay(`http://${enc}@127.0.0.1:${hop.port}`, async ({ port }) => {
      const reply = await connectThrough(port, "example.invalid:443");
      assert.match(reply, /\s200\s/,
        `the hop refused: it wants ${JSON.stringify(USER + ":" + PASS)} and we sent ` +
        `something else. The percent-encoding URL applied to userinfo was passed ` +
        `through instead of decoded. hop saw ${JSON.stringify(seen[0])}`);
    });
  } finally { hop.srv.close(); }
});

// A CLIENT'S OWN Proxy-Authorization IS ADDRESSED TO US, NOT TO THE HOP.
//
// Also written because a mutation survived: turning the replace into an append
// passed every case above, since no fixture had a client that sends one. A
// forwarded client header presents the wrong identity to the hop, and two
// Proxy-Authorization headers in one request is a shape a strict proxy rejects
// outright.
test("replaces a client's own Proxy-Authorization rather than forwarding it", async () => {
  const seen = [];
  const hop = await authHop("alice", "s3cr3t-token", seen);
  try {
    await withRelay(`http://alice:s3cr3t-token@127.0.0.1:${hop.port}`, async ({ port }) => {
      const reply = await connectWithHeaders(port, "example.invalid:443",
        "Proxy-Authorization: Basic " + Buffer.from("mallory:not-ours").toString("base64") + "\r\n");
      assert.match(reply, /\s200\s/,
        `the hop saw ${JSON.stringify(seen[0])} — the client's credentials were ` +
        `forwarded instead of ours`);
      assert.equal(seen.length, 1, "the hop was dialled more than once");
      assert.equal(seen[0], "Basic " + Buffer.from("alice:s3cr3t-token").toString("base64"),
        `the hop received ${JSON.stringify(seen[0])}, not the hop's own credentials`);
    });
  } finally { hop.srv.close(); }
});

test("a refused first hop falls to the SECOND, not straight to a direct dial", async () => {
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const hop2 = await endpoint("HOP2", touched);
  const dead = await freePort();
  try {
    await withRelay(`http://127.0.0.1:${dead},http://127.0.0.1:${hop2.port}`, async ({ port, stderr }) => {
      const reply = await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 300));
      // Carrying VIA A HOP: the hop's own reply is piped straight back, so the
      // 200 the client sees is the hop's. Asserted because pin walks past any
      // non-200 on this line — a relay that falls through to a live hop but
      // reports the fall-through in the status has still broken their chain.
      assert.match(reply, /^HTTP\/1\.[01] 200\b/,
        `the CONNECT reply while carrying was ${JSON.stringify(reply)} — pin reads ` +
        `anything but 200 here as a refusal and routes around this address`);
      assert.deepEqual(touched, ["HOP2"],
        `the second hop was skipped; endpoints touched: ${JSON.stringify(touched)} ` +
        `(ORIGIN means it dialled direct past a hop that would have carried)`);
      assert.match(stderr(), /hop http:\/\/127\.0\.0\.1:\d+ unusable .* trying the next/,
        "the refusal was not traced — a relay that falls through silently is " +
        "indistinguishable from one that had no chain at all");
    });
  } finally { origin.srv.close(); hop2.srv.close(); }
});

test("direct is the LAST resort, reached only when no hop will carry", async () => {
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const dead1 = await freePort(), dead2 = await freePort();
  try {
    await withRelay(`http://127.0.0.1:${dead1},http://127.0.0.1:${dead2}`, async ({ port, stderr }) => {
      const reply = await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 300));
      // AND ON THE DIRECT PATH TOO, where the 200 is ours to write rather than
      // a hop's to forward. This is the state pin is most likely to meet us in
      // — every hop refused, us terminating CONNECT ourselves — and answering
      // anything else here makes the last line of defence read as a refusal.
      assert.match(reply, /^HTTP\/1\.[01] 200\b/,
        `the CONNECT reply on the direct path was ${JSON.stringify(reply)} — this is ` +
        `the fall-open state, and a non-200 makes pin route around a working address`);
      // NOT a close. Closing here would trade an invisible fall-open for an
      // invisible outage, on the tunnel that runs when the proxy is down.
      assert.deepEqual(touched, ["ORIGIN"],
        `no hop would carry and the request did not reach the origin either; ` +
        `endpoints touched: ${JSON.stringify(touched)}`);
      const traced = (stderr().match(/unusable/g) || []).length;
      assert.equal(traced, 2,
        `${traced} refusals traced, want one per hop — a direct dial nobody can ` +
        `see in the log is the silent bypass this tracing exists to end`);
    });
  } finally { origin.srv.close(); }
});

// A STANDBY THAT CANNOT KNOW ITS HOLDER MUST NOT PRETEND TO BE ONE.
//
// Arming is decided by comparing our holder's pid against the current parent:
// once they differ, the holder is gone and we take the address. The pid we
// compare against is HANDED to us in CACHE_FIX_STANDBY_PARENT, because
// process.ppid is read tens of ms after spawn and a holder that died inside
// that window has already been replaced by init — 1 vs 1 forever, never arming,
// while still holding a listening socket. Accept-and-hang.
//
// `Number(env) || process.ppid` restores exactly that failure the moment the
// variable is missing, and does it silently. The holder does set it today, so
// this is not reachable now — it is reachable the first time someone adds a
// second spawn site or renames the variable, and the symptom then is a port
// that accepts and never answers, which is the hardest shape to diagnose.
//
// Refusing is louder AND safer: openStandby's `lost()` handler already prints
// "standby relay gone; the port will not survive this holder" on our exit, so
// the operator gets a sentence instead of a hang.
test("a standby with no handed-down parent refuses to arm", async () => {
  const sock = net.createServer(() => {});
  await new Promise((r) => sock.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CACHE_FIX_STANDBY: "1" };
  delete env.CACHE_FIX_STANDBY_PARENT;
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                   "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_REQUIRE_HOP", "ALL_PROXY", "all_proxy"]) delete env[k];
  const relay = spawn(process.execPath, [relayPath],
                      { env, stdio: ["ignore", "ignore", "pipe", sock._handle.fd] });
  let err = "";
  relay.stderr.on("data", (d) => (err += d));
  const exited = await Promise.race([
    new Promise((res) => relay.on("exit", (code) => res(code))),
    new Promise((res) => setTimeout(() => res("STILL_RUNNING"), 4000)),
  ]);
  try {
    assert.notEqual(exited, "STILL_RUNNING",
      "the standby started with no CACHE_FIX_STANDBY_PARENT: it is now holding a " +
      "listening socket it can never arm on, which accepts connections and answers none");
    assert.notEqual(exited, 0, "refusing must be a failure exit, or nothing upstream notices");
    assert.match(err, /CACHE_FIX_STANDBY_PARENT/,
      `it refused without naming the variable: ${JSON.stringify(err)}`);
  } finally {
    try { relay.kill("SIGKILL"); } catch {}
    await new Promise((r) => sock.close(r));
  }
});

// HTTP_PROXY IS PART OF THE CHAIN, BECAUSE IT IS PART OF THE PROXY'S CHAIN.
//
// The relay's candidate list read CACHE_FIX_UPSTREAM_PROXY, HTTPS_PROXY and
// https_proxy and stopped. proxy/config.mjs resolves an https upstream through
// the same three, and proxy/upstream.mjs documents the fallback to HTTP_PROXY
// when HTTPS_PROXY is unset — so an operator with only HTTP_PROXY set had a
// proxy that used it and a relay that saw no chain at all and dialled direct.
// The relay's own comment forbids exactly that ("one chain, two definitions"),
// and the divergence fires on the path that only runs while the proxy is down.
test("HTTP_PROXY alone is a chain hop, the way it is for the proxy itself", async () => {
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const hop = await endpoint("HOP", touched);
  try {
    // No fallback list at all: HTTP_PROXY is the ONLY thing naming a hop, which
    // is the whole configuration under test.
    await withRelay("", async ({ port }) => {
      const reply = await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.match(reply, /^HTTP\/1\.[01] 200\b/,
        `the CONNECT reply was ${JSON.stringify(reply)}`);
      assert.deepEqual(touched, ["HOP"],
        `HTTP_PROXY was not treated as a hop; endpoints touched: ${JSON.stringify(touched)} ` +
        `(ORIGIN means the relay went direct past a proxy the live code would have used)`);
    }, { HTTP_PROXY: `http://127.0.0.1:${hop.port}` });
  } finally { origin.srv.close(); hop.srv.close(); }
});

// Writes the request in two TCP segments with a gap between them, which is what
// a real client can produce and what the relay used to be unable to read.
const connectSplit = (port, target, headers = "") => new Promise((resolve) => {
  const req = `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`;
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => {
    // FOUR BYTES, so the split lands INSIDE the method token. Splitting at a
    // header boundary would still leave a parseable first line and prove
    // nothing.
    c.write(req.slice(0, 4));
    setTimeout(() => c.write(req.slice(4)), 120);
  });
  c.on("data", (d) => { c.destroy(); resolve(String(d).split("\r\n")[0]); });
  c.on("error", (e) => resolve(`ERR:${e.code}`));
  setTimeout(() => { c.destroy(); resolve("TIMEOUT"); }, 8_000);
});

// A REQUEST LINE SPLIT ACROSS SEGMENTS MUST STILL ROUTE, AND STILL AUTHENTICATE.
//
// The handler ran on the first `data` event and parsed whatever had arrived, so
// a CONNECT split mid-token matched neither /^GET \/health/ nor /^CONNECT/: it
// fell to direct(), the regex failed there too, and the client was destroyed
// with nothing written to any log. withHopAuth had the same dependency from the
// other side — it returns the chunk unchanged when the header block is
// incomplete — so even a split that happened to route reached an authenticated
// hop with no credentials and got 407.
//
// Both halves are asserted here, through a hop that answers 407 without the
// right header: a 200 means the line was parsed AND the credentials survived.
test("a CONNECT split across TCP segments still routes, and still carries its hop auth", async () => {
  const seen = [];
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const hop = await authHop("al ice", "p@ss:w#rd", seen);
  try {
    await withRelay(
      `http://${encodeURIComponent("al ice")}:${encodeURIComponent("p@ss:w#rd")}@127.0.0.1:${hop.port}`,
      async ({ port }) => {
        const reply = await connectSplit(port, `127.0.0.1:${origin.port}`);
        await new Promise((r) => setTimeout(r, 300));
        assert.match(reply, /^HTTP\/1\.[01] 200\b/,
          `a CONNECT whose request line arrived in two segments got ${JSON.stringify(reply)} — ` +
          `407 means the header block was incomplete when the auth was rewritten, and a ` +
          `transport error means it was never parsed as a CONNECT at all`);
        assert.deepEqual(seen, ["Basic " + Buffer.from("al ice:p@ss:w#rd").toString("base64")],
          `the hop saw ${JSON.stringify(seen)}`);
        assert.deepEqual(touched, [], `the relay dialled the origin directly: ${JSON.stringify(touched)}`);
      });
  } finally { origin.srv.close(); hop.srv.close(); }
});
