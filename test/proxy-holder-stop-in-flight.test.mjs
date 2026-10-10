import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { HOP_ENV, OURS } from "./proc-helpers.mjs";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cmdOf, freePort as takePort, listeners } from "./proc-helpers.mjs";
import { exitWithin, withDeadline } from "./child-deadline.mjs";

// ITS OWN FILE, not tidiness: this case used to sit at the end of
// proxy-holder-handover.test.mjs, serially after that file's ~56s "holder
// handover (SIGUSR2)" describe -- upstream's own cost, not ours to carry.
// node:test runs describes within one file serially but separate FILES in
// parallel, so this case rode the suite's wall-clock as +8.4s no matter how
// cheap it was; moved here it costs max(itself, the rest of the suite)
// instead of a sum.

// THE HOLDER DELIBERATELY LEAVES A STANDBY BEHIND, and killing the holder is
// what ARMS it -- that is the standby's whole purpose (bin/gap-relay.mjs), so it
// is not a leak in the relay. It is a leak here: production wants the armed
// standby to keep a real port alive, and a test wants its ephemeral port
// released. Nothing else ends one, so this file has to.
//
// Selected by the standby's OWN declaration of its parent, never by name or age:
// a relay whose ppid no longer matches CACHE_FIX_STANDBY_PARENT has been
// orphaned, and matching that parent against the holders THIS FILE spawned is
// what keeps the sweep off production and off other sessions. The PORT is matched
// too, and the relay's own command must be one of ours (OURS): a pid this file
// once spawned can be a live holder's by now, and its standby names it as parent
// just as ours did.
//
// /proc, so linux only. CI runs linux and that is where the guard is exercised;
// on a mac the orphan survives until the OS reclaims it, which is a smaller
// wrong than sweeping by name on a shared box.
const spawnedHolders = new Map();   // pid -> the port the holder was given
const reapStandbys = () => {
  let dir;
  try { dir = readdirSync("/proc"); } catch { return; }
  for (const e of dir) {
    if (!/^\d+$/.test(e)) continue;
    let env, argv;
    try {
      argv = readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0");
      env = readFileSync(`/proc/${e}/environ`, "utf8").split("\0");
    } catch { continue; }
    if (!argv.some((a) => OURS.test(a) && a.endsWith("/gap-relay.mjs"))) continue;
    const parent = env.find((v) => v.startsWith("CACHE_FIX_STANDBY_PARENT="))?.slice(25);
    const port = spawnedHolders.get(Number(parent));
    if (!port || !env.includes(`CACHE_FIX_PROXY_PORT=${port}`)) continue;
    try { process.kill(Number(e), "SIGKILL"); } catch {}
  }
};
process.on("exit", reapStandbys);
// Records the pid and port so the sweep above can scope itself to this file's holders.
const spawnHolder = (...args) => { const h = spawn(...args); spawnedHolders.set(h.pid, args[2].env.CACHE_FIX_PROXY_PORT); return h; };

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     // THE STATUS, not merely a reply. A standby relay carrying
                     // this address answers 503 on purpose, and a fixture that
                     // took any response for "the proxy is up" started measuring
                     // 1.3s before one existed.
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  // The timeout must RESOLVE, not merely fire: an unhandled one leaves the
  // request hanging and the sampler stalls on it forever.
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The first truthy answer of `fn` within `ms`, polled; undefined when it never came.
const until = async (fn, ms) => {
  for (const by = Date.now() + ms; Date.now() < by; await sleep(100)) { const v = await fn(); if (v) return v; }
};

// A fake origin streaming `data: <n>` at 10 per second and ending after `last`.
// BY THE CLOCK, not by tick: this process polls with lsof and ps, which block its
// event loop, and a stream counted in ticks falls behind by exactly that, so how
// long it lasts would depend on how loaded the box is.
const numberedOrigin = async (last) => {
  const upstream = http.createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/event-stream" });
    const t0 = Date.now();
    let n = 0;
    const t2 = setInterval(() => {
      for (const due = Math.min(last, Math.floor((Date.now() - t0) / 100)); n < due;) {
        try { r.write(`data: ${++n}\n\n`); } catch {}
      }
      if (n === last) { clearInterval(t2); r.end(); }
    }, 100);
    r.on("close", () => clearInterval(t2));
    q.resume();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  return upstream;
};

// One streamed request through <port>: `seq()` is every number received so far,
// and `done` goes true when the reply ends OR is cut.
const openReply = (port) => {
  const got = { seen: "", done: false };
  got.seq = () => [...got.seen.matchAll(/data: (\d+)\n\n/g)].map((m) => Number(m[1]));
  got.req = http.request(
    { host: "127.0.0.1", port, path: "/v1/messages", method: "POST",
      headers: { "content-type": "application/json" } },
    (res) => { res.on("data", (d) => { got.seen += d; }); res.on("close", () => { got.done = true; });
               res.on("error", () => {}); });
  got.req.on("error", () => {});
  got.req.end(JSON.stringify({ model: "x", messages: [], stream: true }));
  return got;
};

// A run-service holder in front of `upstream`, answering 200, on the port it was
// handed (`.port`). Its stderr is kept on `.log`, for a failure message to quote.
//
// THE PORT IS NEVER FREE. One released before the holder binds can be taken by a
// neighbouring file's listen(0); the holder's bind then fails EADDRINUSE,
// takeOver() names that listener, and release() SIGHUPs it: a `node --test`
// runner, dead before it writes TAP. So the holder is handed the listening socket
// the way a handover hands one (fd 3) and adopts it, and never binds. Our copy is
// closed at once, since a listening handle here accepts connections nobody answers.
const bootHolder = async (upstream, launcher, extraEnv = {}) => {
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, "127.0.0.1", r));
  const port = sock.address().port;
  const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` };
  for (const k of [...HOP_ENV, "LISTEN_PID", "CACHE_FIX_HOLD_PORT",
                   "CACHE_FIX_WATCH_DEPLOY_MS", "CACHE_FIX_SELF_HEAL"]) delete env[k];
  Object.assign(env, { CACHE_FIX_HOLDER_HANDOVER: "1", LISTEN_FDS: "1" }, extraEnv);
  const holder = spawnHolder(process.execPath, [launcher, "run-service"],
                             { env, stdio: ["ignore", "ignore", "pipe", sock._handle.fd] });
  sock.close();
  holder.port = port;
  holder.log = "";
  holder.stderr.on("data", (d) => { holder.log += d; });
  if (await until(async () => (await probe(port)) === "ok" && "ok", 25_000) !== "ok") {
    holder.kill("SIGKILL");   // the caller never receives it
    await reapAfterFailedBoot(holder, port);
    assert.fail(`the holder never came up, so nothing was measured: ${holder.log.slice(-300)}`);
  }
  return holder;
};

// WHAT A HOLDER SIGKILL OR A RELOAD LEAVES BEHIND is nobody's child, so nothing
// else reaps it. Holders FIRST, then the rest in the same pass: a proxy whose
// holder just died spawns a replacement on its next tick, and this must outrun
// it. Only what listens on OUR port, filtered by OURS (proc-helpers listeners()).
const reapPort = async (port) => {
  for (let i = 0; i < 5; i++) {
    const owners = listeners(port).sort((a, b) =>
      /run-service/.test(cmdOf(b)) - /run-service/.test(cmdOf(a)));
    if (!owners.length) break;
    for (const o of owners) { try { process.kill(Number(o), "SIGKILL"); } catch { } }
    await sleep(300);
  }
};

// WHETHER THE PORT IS STILL THIS HOLDER'S TO CLEAR. It is while the holder is
// alive, and after its death while a listener on it names the holder in its own
// variables: the proxy inherited the socket as fd 3 and an armed standby holds it
// too, so a dead holder leaves them listening. Otherwise the number may be a
// neighbouring file's by now, and reapPort() kills whatever of ours listens there.
// /proc, so linux only; elsewhere only the first arm applies.
const namesHolder = (pid, holder) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      .some((v) => v === `CACHE_FIX_HELD_BY=${holder}` || v === `CACHE_FIX_STANDBY_PARENT=${holder}`);
  } catch { return false; }
};
const reapAfterFailedBoot = async (holder, port) => {
  if ((holder.exitCode === null && holder.signalCode === null)
      || listeners(port).some((q) => namesHolder(q, holder.pid))) await reapPort(port);
};

// THE PRODUCTION STOP, WITH SOMETHING IN FLIGHT. Every other holder case here
// signals with nothing owed, so `close()` resolves at once and the case passes
// under ANY budget — a ceiling is never reached and a stall test is never asked.
// That is the gap: the one path an operator actually takes (`systemctl stop`,
// Ctrl-C, a plain kill) has never been measured with a reply in the middle of
// being delivered.
//
// WHAT IT USED TO MEASURE IS NO LONGER MEASURABLE HERE, and the replacement is
// not a weakening. The old form timed how long run-service and the proxy stayed
// ON THE PORT after a stop and required it to be the 5s ceiling rather than the
// drain budget. That clock has collapsed: the holder now settles on the proxy's
// RELEASE announcement instead of on its exit, so the port is free in under a
// second — before the first `lsof` even returns. The while loop never ran, and
// `chunks` was then sampled at the same instant as `before`, so the case died on
// its own premise (2 -> 2) while the reply it was worried about was in fact
// still streaming. Measured directly: 2 -> 158 chunks over the ten seconds after
// the stop, holder gone inside 623 ms, and the only listener left was the
// standby relay, which a stop keeps on purpose.
//
// So this pins the two halves that ARE observable, and together they are
// STRONGER than the old assertion. "the port frees" alone passes on the old code
// too (it freed at 5s); "the reply keeps arriving after it frees" is what the 5s
// ceiling could never do, because cutting the reply is how it got there.
describe("a holder stop with a reply in flight", () => {
  it("frees the port without severing the reply", async () => {
    // Bytes must be MOVING at the moment of the stop. If they were not, a stall
    // test would end the drain too and the case could not tell the arms apart.
    const upstream = http.createServer((q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t2 = setInterval(() => { try { r.write(`data: ${++n}\n\n`); } catch {} }, 100);
      r.on("close", () => clearInterval(t2));
      q.resume();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

    const port = await takePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawnHolder(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "ignore", "ignore"] });
    let req = null;
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) {
        await new Promise((r) => setTimeout(r, 100));
        body = await probe(port);
      }
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      let chunks = 0;
      req = http.request(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => chunks++); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      const flowing = Date.now() + 15_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 50));
      assert.ok(chunks > 0,
        "premise: bytes must be reaching the client, or this measures a stop with " +
        "nothing owed — which is the case that already exists and cannot fail here");

      const before = chunks;
      const t0 = Date.now();
      holder.kill("SIGTERM");
      // 25s, not a tight bound: what must not happen is the port staying held
      // for a DRAIN budget (90s stall window, 30 minute backstop). Measured, it
      // frees in well under a second, so this is loose on purpose rather than
      // sensitive to how long a spawn takes on a loaded box.
      const stopped = Date.now() + 25_000;
      let left = listeners(port);
      while (Date.now() < stopped
             && left.some((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q)))) {
        await new Promise((r) => setTimeout(r, 200));
        left = listeners(port);
      }
      const elapsed = Date.now() - t0;
      const released = Date.now();
      assert.deepEqual(left.filter((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q))), [],
        `the holder and its proxy were still on the port ${elapsed}ms after SIGTERM — ` +
        `a stop must free the address whatever its child is still finishing`);

      // AND THE REPLY SURVIVED THE STOP THAT FREED THE PORT. This is the half the
      // 5s ceiling could not do: it freed the port by CUTTING what was in flight.
      //
      // GROWTH, NOT TOTAL, AND SAMPLED PAST THE CEILING. `chunks > before` cannot
      // see a cut at all: a 5s ceiling delivers five seconds of bytes first, so
      // the total rises either way. Measured — with the held arm reverted to the
      // ceiling this case still passed, because a 4s sample also lands INSIDE the
      // window it is trying to detect. Two late samples with growth required
      // between them is what separates "still delivering" from "delivered a lot,
      // then was severed".
      //
      // THE FIRST SAMPLE IS A DEADLINE, NOT AN EVENT -- getting past the
      // production 5s ceiling (server.mjs:1907, pinned at test/shutdown-exit-
      // code.test.mjs:1135-1144 -- move the ceiling there and this line's
      // literal has to move too) is just time passing, so it stays a sleep. Timed
      // from `released`, NOT from `t0`: the ceiling's own clock starts inside the
      // proxy (SIGTERM -> holder forwards SIGHUP -> drainStart), `d` ms after t0,
      // and a margin measured from t0 shrinks by exactly `d` -- silently, since a
      // regressed arm would still show growth within ~100ms of a `late` sample
      // taken too early, and PASS. `released` is measured after signal delivery
      // already happened (the port-free loop that produced it polls for the
      // holder's process to leave the port), so counting from there is margin
      // that does not erode with how long the signal takes to land. 2s of
      // headroom over the ceiling matches this file's own measured floor (see
      // test/shutdown-exit-code.test.mjs's UNBIND_PROBE_WAIT_MS note).
      const pastCeiling = released + 5_000 + 2_000 - Date.now();
      if (pastCeiling > 0) await new Promise((r) => setTimeout(r, pastCeiling));
      const late = chunks;
      // THE SECOND SAMPLE'S GROWTH IS AN EVENT -- poll for it instead of paying
      // a fixed sleep no passing run needs (measured: chunks grow every
      // 40-60ms here, so a passing run resolves this in well under 200ms). The
      // 2s ceiling is the same margin as above, reached only when this case is
      // about to fail regardless.
      const grew = Date.now() + 2_000;
      while (chunks <= late && Date.now() < grew) await new Promise((r) => setTimeout(r, 100));
      assert.ok(chunks > before,
        `premise: no byte arrived after the stop at all (${before}), so the drain ` +
        `ended before this could measure anything`);
      assert.ok(chunks > late,
        `the reply stopped at ${late} chunks and never moved again — the stop severed ` +
        `it instead of letting the drainer finish it, which is the ceiling this arm no ` +
        `longer has`);
    } finally {
      try { req?.destroy(); } catch { }
      upstream.close();
      try { holder.kill("SIGKILL"); } catch { }
    }
  });

  // THE SAME REPLY, WITH THE HOLDER KILLED OUTRIGHT (OOM, kill -9): nothing gets
  // to forward a signal, so the proxy is orphaned and self-heals into a new
  // holder while it is still carrying the stream. Measured on integrated, 4 runs:
  // the stream was cut every time, by the orphan's own `process.exit(0)` once the
  // new holder's proxy was serving, 1.4-1.6 s after the kill. A LAST sequence
  // number is asserted, not growth, because a cut stream also grows until it is cut.
  it("finishes the reply when the holder is SIGKILLed under it", async () => {
    const LAST = 50;
    const upstream = await numberedOrigin(LAST);
    let holder, reply;
    try {
      holder = await bootHolder(upstream, launcherPath);
      const { port } = holder;
      const orphan = Number(execFileSync("pgrep", ["-P", String(holder.pid)], { encoding: "utf8" })
        .trim().split("\n").find((q) => /server\.mjs/.test(cmdOf(q))));
      assert.ok(orphan > 1, "no proxy under the holder, so there is nothing to orphan");

      reply = openReply(port);
      assert.ok(await until(() => reply.seq().length >= 3, 15_000), "premise: the reply must be flowing at the kill");

      holder.kill("SIGKILL");
      // "A different server.mjs pid is serving": the event the old exit keyed on.
      assert.ok(await until(() => listeners(port).some((q) => Number(q) !== orphan && /server\.mjs/.test(cmdOf(q))), 25_000),
        "premise: the orphan never healed into a serving successor");
      // The number, not `reply.done`: a proxy that still exits has cut the reply (done) by
      // now, and the cut is the defect. Only a reply that already finished makes this vacuous.
      assert.ok(reply.seq().at(-1) < LAST,
        "premise: the whole reply had arrived before the successor was seen serving, so a proxy that still exits would pass");
      await until(() => reply.done, 15_000);
      assert.equal(reply.seq().at(-1), LAST,
        `the reply stopped at ${reply.seq().at(-1)} of ${LAST} (done=${reply.done}) — the orphaned proxy ` +
        `left while it still carried the stream, so a holder SIGKILL cuts every tunnel on it`);
    } finally {
      try { reply?.req.destroy(); } catch { }
      upstream.close();
      try { holder?.kill("SIGKILL"); } catch { }
      if (holder) await reapPort(holder.port);   // the healed lineage is nobody's child
    }
  });

  // THE SAME REPLY, WITH THE PROXY SWAPPED BY THE DEPLOY WATCHER AND THEN THE
  // HOLDER RELOADED (SIGUSR2). The swap leaves the old proxy draining the stream,
  // parented to the holder but no longer its `child`. The reload signals only the
  // CURRENT child and exits, so the drainer is orphaned, self-heals into a holder,
  // and used to exit the moment the successor holder's proxy served. Measured by
  // the deploy sandbox, 2 of 2 runs: curl rc 18 under the stream.
  //
  // A SCRATCH COPY OF THE PACKAGE, never this tree's own proxy/: the watcher swaps
  // on a changed byte under the proxy/ it runs from, and every holder in the run
  // that runs from this tree would swap with it.
  it("finishes the reply a watch swap left draining when the holder is reloaded", async () => {
    const LAST = 60;
    const upstream = await numberedOrigin(LAST);
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    let pkg, holder, reply;
    try {
      pkg = mkdtempSync(join(tmpdir(), "ccf-swap-"));
      for (const d of ["bin", "proxy"]) cpSync(join(root, d), join(pkg, d), { recursive: true });
      // The node_modules node itself resolves from here: a checkout under .claude/worktrees/ has none at
      // its own root, only an ancestor's, and a link to the missing one leaves the copy unable to load.
      symlinkSync(createRequire(import.meta.url).resolve.paths("hpagent").find((d) => existsSync(join(d, "hpagent"))),
                  join(pkg, "node_modules"));
      // CACHE_FIX_HANDOVER_ENV: a handover re-reads CACHE_FIX_* from a file in the
      // operator's claude home, and whatever it holds would reach the successor.
      holder = await bootHolder(upstream, join(pkg, "bin", "claude-via-proxy.mjs"),
        { CACHE_FIX_WATCH_DEPLOY_MS: "200", CACHE_FIX_HANDOVER_ENV: join(pkg, "none.env") });
      const { port } = holder;
      const serving = (...not) => listeners(port).find((q) => /server\.mjs/.test(cmdOf(q)) && !not.includes(q));
      const first = serving();
      assert.ok(first, "no proxy is serving, so there is nothing to swap");
      reply = openReply(port);
      assert.ok(await until(() => reply.seq().length >= 3, 15_000), "premise: the reply must be flowing at the swap");

      appendFileSync(join(pkg, "proxy", "helpers.mjs"), "\n// a deploy\n");
      const second = await until(() => serving(first), 25_000);
      assert.ok(second, `the watcher never swapped the proxy: ${holder.log.slice(-300)}`);
      assert.ok(!reply.done, "premise: the old proxy is draining a live reply");

      holder.kill("SIGUSR2");
      assert.ok(await until(() => serving(first, second), 25_000),
        "premise: the reload never put a successor proxy on the port");
      await until(() => reply.done, 15_000);
      assert.equal(reply.seq().join(" "), Array.from({ length: LAST }, (_, i) => i + 1).join(" "),
        `the reply stopped at ${reply.seq().at(-1)} of ${LAST} (done=${reply.done}): the proxy the swap ` +
        `left draining was orphaned by the reload and left while it still carried the stream. ` +
        holder.log.split("\n").filter((l) => /died|surplus|changed|drained/.test(l)).join(" | "));
    } finally {
      try { reply?.req.destroy(); } catch { }
      upstream.close();
      try { holder?.kill("SIGKILL"); } catch { }
      if (holder) await reapPort(holder.port);
      if (pkg) rmSync(pkg, { recursive: true, force: true });
    }
  });
});

// THE HANDOVER FILE IS READ AT EVERY PROXY SPAWN, not only at a SIGUSR2: a setting a
// deploy writes there must land when the deploy watcher swaps the proxy first (the
// reload then finds the trees equal and sends nothing). /proc, so linux only.
describe("a proxy the holder spawns itself", () => {
  it("takes its CACHE_FIX_* settings from the handover file on a watch swap", { skip: !existsSync("/proc") }, async () => {
    const upstream = await numberedOrigin(1);
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    let pkg, holder;
    try {
      pkg = mkdtempSync(join(tmpdir(), "ccf-handover-env-"));
      for (const d of ["bin", "proxy"]) cpSync(join(root, d), join(pkg, d), { recursive: true });
      symlinkSync(createRequire(import.meta.url).resolve.paths("hpagent").find((d) => existsSync(join(d, "hpagent"))),
                  join(pkg, "node_modules"));
      const file = join(pkg, "handover.env");
      holder = await bootHolder(upstream, join(pkg, "bin", "claude-via-proxy.mjs"),
        { CACHE_FIX_WATCH_DEPLOY_MS: "200", CACHE_FIX_HANDOVER_ENV: file });
      const serving = (...not) => listeners(holder.port).find((q) => /server\.mjs/.test(cmdOf(q)) && !not.includes(q));
      const has = (pid, kv) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(kv);
      const first = serving();
      assert.ok(first, "no proxy is serving, so there is nothing to swap");

      // The file cannot move itself or arm the standby branch: a self-healed holder inherits this env.
      writeFileSync(file, "CACHE_FIX_CAPTURE_MAX_MB=256\nCACHE_FIX_STANDBY=1\nCACHE_FIX_HANDOVER_ENV=/elsewhere.env\n");
      assert.ok(!has(first, "CACHE_FIX_CAPTURE_MAX_MB=256"), "premise: the setting reached the proxy booted before it was written");
      appendFileSync(join(pkg, "proxy", "helpers.mjs"), "\n// a deploy\n");
      const second = await until(() => serving(first), 25_000);
      assert.ok(second, `the watcher never swapped the proxy: ${holder.log.slice(-300)}`);
      assert.ok(has(second, "CACHE_FIX_CAPTURE_MAX_MB=256"),
        "the proxy the watch swap spawned runs without the setting the handover file holds: it was started " +
        "from the holder's boot environment, so a deploy that lost the race to the watcher never lands it");
      assert.ok(has(second, `CACHE_FIX_HANDOVER_ENV=${file}`) && !has(second, "CACHE_FIX_STANDBY=1"),
        "the file moved its own path or set CACHE_FIX_STANDBY for the proxy, and a self-healed holder inherits both");
    } finally {
      upstream.close();
      try { holder?.kill("SIGKILL"); } catch { }
      if (holder) await reapPort(holder.port);
      if (pkg) rmSync(pkg, { recursive: true, force: true });
    }
  });
});

// A PID THIS FILE ONCE SPAWNED CAN BE A LIVE HOLDER'S BY THE TIME THE SWEEP RUNS,
// and that holder's standby names it as its parent exactly as ours did. What tells
// them apart is the port this file gave the holder, which the relay carries in its
// own environment. Both relays here are this test's own spawns.
describe("the exit sweep of standbys", () => {
  it("leaves a relay on another port alone, whatever pid it names as its parent", { skip: !existsSync("/proc") }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccf-sweep-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gap-relay.mjs"), "setInterval(() => {}, 1e6);\n");
    assert.ok(OURS.test(join(dir, "bin", "gap-relay.mjs")), "premise: the stand-in must look like one of our relays");
    const [mine, theirs] = [await takePort(), await takePort()];
    const holder = spawnHolder(process.execPath, ["-e", ""],
      { env: { ...process.env, CACHE_FIX_PROXY_PORT: String(mine) }, stdio: "ignore" });
    const relay = (port) => spawn(process.execPath, [join(dir, "bin", "gap-relay.mjs")], { stdio: "ignore",
      env: { ...process.env, CACHE_FIX_STANDBY_PARENT: String(holder.pid), CACHE_FIX_PROXY_PORT: String(port) } });
    const [ours, stranger] = [relay(mine), relay(theirs)];
    try {
      reapStandbys();
      assert.ok(await until(() => ours.signalCode, 5_000), "the sweep left this file's own standby running");
      await sleep(300);
      assert.equal(stranger.signalCode ?? stranger.exitCode, null,
        "the sweep killed a relay on a port this file never gave a holder");
    } finally {
      for (const p of [ours, stranger]) { try { p.kill("SIGKILL"); } catch { } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A DEAD HOLDER DOES NOT TAKE ITS PORT WITH IT: its proxy inherited the listening
// socket as fd 3, and an armed standby holds it too, so they outlive the holder
// and nothing else ends them. What tells them from a neighbouring file's listener
// on a reused number is the holder pid each carries in its own variables. Both
// listeners here are this test's own stand-ins.
describe("the reap after a boot that failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-failedboot-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "stand-in.mjs"),
    'import net from "node:net";\nnet.createServer().listen({ fd: 3 }, () => console.log("up"));\nsetInterval(() => {}, 1e6);\n');
  after(() => rmSync(dir, { recursive: true, force: true }));
  const deadHolder = async () => {
    const h = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await exitWithin(h, 10_000, "the throwaway holder never exited");
    return h;
  };
  // THE CASE KEEPS THE NUMBER: the stand-in's death would free it, and the reap's
  // rescan 300 ms later would then kill whatever of ours a sibling file put there.
  // Unref'd, so a case that fails early cannot keep the run alive. Waits for the
  // stand-in's first line, so one that died on its own reads as a fixture failure
  // here and not as a gate that left it standing.
  const listening = async (env) => {
    const sock = net.createServer();
    await new Promise((r) => sock.listen(0, "127.0.0.1", r));
    sock.unref();
    const port = sock.address().port;
    const p = spawn(process.execPath, [join(dir, "bin", "stand-in.mjs")],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore", sock._handle.fd] });
    await withDeadline(new Promise((r) => p.stdout.once("data", r)), 5_000, p, "premise: the stand-in never came up");
    return { p, port };
  };
  const skip = !existsSync("/proc");

  it("clears what names the dead holder", { skip }, async () => {
    const holder = await deadHolder();
    const { p, port } = await listening({ CACHE_FIX_HELD_BY: String(holder.pid) });
    try {
      await reapAfterFailedBoot(holder, port);
      assert.ok(await until(() => p.signalCode, 5_000), "the proxy of a dead holder was left on the port");
    } finally { try { p.kill("SIGKILL"); } catch { } }
  });

  it("leaves a listener that names another holder alone", { skip }, async () => {
    const holder = await deadHolder();
    const { p, port } = await listening({ CACHE_FIX_HELD_BY: String(process.pid) });
    try {
      await reapAfterFailedBoot(holder, port);
      await sleep(300);
      assert.equal(p.signalCode ?? p.exitCode, null, "a listener of another holder was killed");
    } finally { try { p.kill("SIGKILL"); } catch { } }
  });
});
