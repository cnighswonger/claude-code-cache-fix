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

async function withRelay(chain, fn) {
  // THE RELAY LISTENS ON fd 3 — `srv.listen({ fd: 3 })` — because the holder
  // hands it an already-bound socket. A fixture that spawns it without one
  // produces a process that never listens, and every probe then reads as "the
  // code did nothing". Measured: the first cut of this reported zero endpoints
  // touched and zero traces, which looks exactly like a broken fix.
  const carrier = net.createServer();
  await new Promise((r) => carrier.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CACHE_FIX_HELD_PORT: String(carrier.address().port),
                CACHE_FIX_FALLBACK_PROXIES: chain };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                   "CACHE_FIX_UPSTREAM_PROXY", "ALL_PROXY", "all_proxy",
                   "CACHE_FIX_STANDBY"]) delete env[k];
  const relay = spawn(process.execPath, [relayPath],
                      { env, stdio: ["ignore", "ignore", "pipe", carrier._handle.fd] });
  let err = "";
  relay.stderr.on("data", (d) => { err += d; });
  try {
    // The premise, asserted rather than assumed.
    const up = Date.now() + 10_000;
    while (!/gap-relay carrying/.test(err) && Date.now() < up) await new Promise((r) => setTimeout(r, 50));
    assert.match(err, /gap-relay carrying/,
      `the relay never took the socket, so nothing below was measured; stderr: ${JSON.stringify(err.slice(-200))}`);
    await fn({ port: carrier.address().port, stderr: () => err });
  } finally {
    try { relay.kill("SIGKILL"); } catch {}
    await new Promise((r) => carrier.close(r));
  }
}

const connectThrough = (port, target) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  c.on("data", () => { c.destroy(); resolve("answered"); });
  c.on("error", (e) => resolve(`ERR:${e.code}`));
  setTimeout(() => { c.destroy(); resolve("TIMEOUT"); }, 6_000);
});

test("a refused first hop falls to the SECOND, not straight to a direct dial", async () => {
  const touched = [];
  const origin = await endpoint("ORIGIN", touched);
  const hop2 = await endpoint("HOP2", touched);
  const dead = await freePort();
  try {
    await withRelay(`http://127.0.0.1:${dead},http://127.0.0.1:${hop2.port}`, async ({ port, stderr }) => {
      await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 300));
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
      await connectThrough(port, `127.0.0.1:${origin.port}`);
      await new Promise((r) => setTimeout(r, 300));
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
