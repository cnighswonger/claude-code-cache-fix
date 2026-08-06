#!/usr/bin/env node

import { execFileSync, fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { X509Certificate, createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { bundleUsable, carriesOurCA, salvageBundle } from "./ca-trust.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");
// Our own path, so a holder can spawn its successor from the file AS IT IS ON
// DISK rather than from the bytes it booted with — which is the only reason
// anyone asks it to hand the port on.
const LAUNCHER_PATH = fileURLToPath(import.meta.url);
// AT MODULE LOAD, not on first use. This value is an IDENTITY — "the bytes this
// process is running" — and the only moment it is certainly true is next to the
// exec that loaded them. Hashing lazily instead reads DISK at whatever later
// moment the first child is spawned, and a source replaced in between would be
// reported as ours: a stale holder publishing the current hash, which is
// precisely the case the field exists to catch.
//
// Measured before hoisting it, on the lazy version: source changed under a
// running holder, child respawned, holder_tree still reported the old hash — so
// memoisation was already covering the common case. The window it did NOT cover
// is boot to first spawn, ~260ms wide. cswap's pin flagged it while deciding
// whether to copy the field, and named the distinction exactly: their
// daemon_fingerprint() re-reads the file on every call, which is RIGHT for a
// watchdog asking "does disk still match what I loaded" and wrong for an
// identity handed down. Same function, opposite requirement.
const HOLDER_TREE = (() => {
  try {
    return createHash("sha256").update(readFileSync(LAUNCHER_PATH)).digest("hex").slice(0, 12);
  } catch { return ""; }
})();

const args = process.argv.slice(2);
const SUBCOMMAND = args[0];

// CACHE_FIX_HOLD_PORT=on: keep the advertised port bound HERE and relay to a
// proxy on an ephemeral one, so restarting the proxy never unbinds it. A client
// resolves HTTPS_PROXY once at exec and never re-reads it, so a port with no
// owner — even for the moment a restart takes — strands it for good.
//
// A relay rather than handing the listening socket down: two processes holding
// one socket both accept, and the kernel splits connections between them.
//
// Opt-in: it only pays where something restarts this command, and systemd
// socket activation already gives the same guarantee.
// Who owns <port>, and is it one of ours already holding it?
//
// `lsof` rather than /proc: this has to work on macOS too, and a namespace the
// caller cannot see is exactly the case where guessing is worse than declining.
// A port held WITHOUT accepting on it.
//
// The trick is the bind/listen split. `uv_listen()` installs libuv's accept
// callback, and from that moment the handle accepts connections whether or not
// JS ever sets `onconnection` — every passive-hold attempt failed on this
// (readStop(), unref(), onconnection=null, all measured, all still stole; a
// holder keeping a LISTENING fd measured ok=16337 hung=80 under load). `bind()`
// installs nothing, so a bound-only handle cannot steal. The first child calls
// listen() on the inherited fd and owns the accept path from then on.
//
// Presents the slice of net.Server the holder used, so the call sites did not
// change: on/off (error, listening), listen(), close(), and `_handle.fd` for
// the spawn.
class HolderSocket extends EventEmitter {
  constructor() {
    super();
    this._handle = null;
    this._gap = null;
  }
  listen({ port, host }) {
    // A fresh handle per attempt: a TCP handle that failed to bind cannot be
    // rebound, and reusing it turns every retry into the same error.
    const { TCP, constants } = process.binding("tcp_wrap");

    // A SUCCESSOR HOLDER ADOPTS, IT DOES NOT BIND. This is the whole escape
    // from a lossy handover: the outgoing holder spawns us with its socket on
    // fd 3 and only then goes away, so the socket never loses its last fd and
    // we never race anyone for the address. Binding here instead is what cost
    // 63 of 1,281 requests, because the incumbent has to let go BEFORE a second
    // bind can succeed at all — EADDRINUSE 98 on linux against a LISTENING
    // socket, and 48 on darwin against a merely bound one (both measured by
    // cswap's pin, who hit this failure first and fixed it the same way).
    //
    // HANDED_DOWN_HOLDER, not LISTEN_FDS alone: "my holder is alive above me
    // and will replace me" and "my predecessor gave me this on its way out"
    // look identical in the fd variables and mean opposite things when we are
    // signalled. The proxy already distinguishes them with CACHE_FIX_HELD_PORT
    // against CACHE_FIX_FROM_HANDOVER; this is the same distinction one layer up.
    if (process.env.CACHE_FIX_HOLDER_HANDOVER === "1" && Number(process.env.LISTEN_FDS) >= 1) {
      delete process.env.CACHE_FIX_HOLDER_HANDOVER;
      delete process.env.LISTEN_FDS;
      const adopted = new TCP(constants.SOCKET);
      // Wrap the descriptor we were handed; it is already bound AND listening,
      // so there is nothing to do to it but hold it.
      if (adopted.open(3) === 0) {
        this._handle = adopted;
        this._host = host;
        const got = {};
        adopted.getsockname(got);
        this._port = got.port || port;
        this._adopted = true;
        queueMicrotask(() => this.emit("listening"));
        return this;
      }
      try { adopted.close(); } catch { }
      // Fall through and bind: a handover we could not take is not a reason to
      // leave the port unheld, it is a reason to take it the ordinary way.
    }

    const h = new TCP(constants.SOCKET);
    const err = h.bind(host, port);
    if (err) {
      try { h.close(); } catch { /* never bound */ }
      const e = new Error(`bind ${host}:${port} failed`);
      // The code net.Server would have emitted, so callers that branch on
      // EADDRINUSE keep working.
      e.code = err === -98 || err === -48 ? "EADDRINUSE" : "EACCES";
      queueMicrotask(() => this.emit("error", e));
      return this;
    }
    // BIND SUCCESS IS NOT OWNERSHIP. A second handle binds a port another
    // process merely BOUND — that is the whole reason the gap listener works —
    // so a second run-service used to bind happily, never reach `bindFailed`,
    // never consult holderPidOn(), and fork a rival proxy on an ephemeral port
    // while the real one kept serving. Measured: "proxy listening on
    // 0.0.0.0:33273" beside a healthy holder on the requested port.
    //
    // Listening is what settles it: only one handle may LISTEN, so a failed
    // listen means someone is already serving here.
    if (h.listen(511) === 0) {
      // Nobody was serving; we are the holder. Hand the accept path straight
      // back — the gap listener below re-takes it, and the child takes it from
      // there. Closing this listen is what keeps libuv out of the accept path.
      h.close();
      const h2 = new TCP(constants.SOCKET);
      if (h2.bind(host, port)) {
        const e = new Error(`re-bind ${host}:${port} failed`);
        e.code = "EADDRINUSE";
        queueMicrotask(() => this.emit("error", e));
        return this;
      }
      this._handle = h2;
    } else {
      try { h.close(); } catch { }
      const e = new Error(`${host}:${port} is already being served`);
      e.code = "EADDRINUSE";
      queueMicrotask(() => this.emit("error", e));
      return this;
    }
    this._host = host;
    // The BOUND port, not the requested one: `port: 0` means the OS chose it,
    // and storing the 0 made the gap listener bind a different, useless port
    // — measured, the held port still answered ECONNREFUSED with gap=true.
    const bound = {};
    h.getsockname(bound);
    this._port = bound.port || port;
    // Answer from this instant, even though no child is up yet. Without it a
    // session dialling before the first proxy binds gets ECONNREFUSED, and
    // HTTPS_PROXY is baked at exec — so that session is stranded for life.
    this.openGap();
    queueMicrotask(() => this.emit("listening"));
    return this;
  }
  // A SECOND handle on the same port, listening, alive only while no child is.
  //
  // The holder's own handle must never listen: `uv_listen()` installs libuv's
  // accept callback and this process then accepts connections nobody in it
  // will answer — measured on identical code with one child and no handovers,
  // bind+listen served 1,870 and lost 30, bind alone served 51,712 and lost 0.
  //
  // But a bound-only port REFUSES, which is wrong whenever no child is serving
  // — cold start, a restart, a backoff rung. cswap's pin has both because
  // CPython only accepts when you CALL accept(); node cannot split one handle
  // that way, so we split it across two. A second bind+listen on a port the
  // first handle merely BOUND succeeds (measured), and it is closed the moment
  // a child takes over, so it never competes for traffic.
  // AND IT RELAYS, because answering is not the same as working. Accepting with
  // nobody behind it turns ECONNREFUSED into a HANG: measured, a request through
  // a held port whose proxy was gone took 10,012 ms and then failed. A session
  // whose HTTPS_PROXY was baked at exec cannot be re-pointed, so "CCF is off"
  // has to mean "the address still carries", not "the address still accepts".
  //
  // A dumb TCP splice is enough and is the only thing that is correct here: the
  // fallback is another HTTP proxy speaking the same protocol, so CONNECT and
  // absolute-form both pass through untouched. Parsing them would add a second
  // implementation of the thing we are relaying to.
  openGap() {
    if (this._gap || !this._handle) return;
    const hop = (process.env.CACHE_FIX_FALLBACK_PROXIES || "").split(",")[0].trim();
    const m = /^(?:https?:\/\/)?(?:[^@/]*@)?([^:/]+):(\d+)/.exec(hop);
    const live = new Set();
    const srv = net.createServer((client) => {
      live.add(client);
      client.on("close", () => live.delete(client));
      if (!m) { client.destroy(); return; }          // nothing to relay to
      const up = net.connect(Number(m[2]), m[1]);
      live.add(up);
      up.on("close", () => live.delete(up));
      const bail = () => { up.destroy(); client.destroy(); };
      up.on("error", bail);
      client.on("error", bail);
      up.on("connect", () => { client.pipe(up); up.pipe(client); });
    });
    srv.on("error", () => { try { srv.close(); } catch { } if (this._gap === srv) this._gap = null; });
    srv.listen({ port: this._port, host: this._host });
    this._gapSockets = live;
    this._gap = srv;
  }
  // Before spawning: the child cannot listen on the fd while we are listening
  // on the same port.
  closeGap() {
    if (!this._gap) return;
    try { this._gap.close(); } catch { }
    // AND DESTROY WHAT IT WAS RELAYING. close() stops accepting but waits on
    // open sockets, and the child cannot listen until this one lets go — so a
    // relay still in flight would hold the port against the very process that
    // is meant to take over. The relay only exists while nothing better is
    // serving; a child arriving IS the better thing.
    for (const s of this._gapSockets || []) { try { s.destroy(); } catch { } }
    this._gapSockets = null;
    this._gap = null;
  }
  close() {
    // Deliberately a NO-OP on the socket. The holder's entire job is that this
    // descriptor never goes away; closing it is what created the re-acquire
    // window that cost 4 lost per 12,557. Kept so the old call site reads the
    // same, and so nothing silently starts closing it again.
    return this;
  }
  address() {
    if (!this._handle) return null;
    const out = {};
    this._handle.getsockname(out);
    return out;
  }
}

// Returns "holder" when the owner is a holder of ours (nothing to do), a pid
// when it is something else we may ask to stop, or null when we cannot tell —
// and NULL MEANS LEAVE IT ALONE. Signalling a pid we did not identify is how a
// deploy comes to kill an unrelated service that happened to be on the port.
function holderPidOn(port) {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  // EVERY owner, not the first line. The holder keeps a bound descriptor AND a
  // gap listener on the same port while its child serves, so lsof returns more
  // than one pid and their order is not ours to rely on — measured, a second
  // run-service read the CHILD's pid first, failed to recognise a holder, and
  // started a rival proxy on an ephemeral port (46155) while the real one kept
  // serving. A deploy that silently forks a rival is the failure this whole
  // function exists to prevent.
  const pids = out.trim().split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 1);
  if (!pids.length) return null;
  // A holder among them settles it: it is ours and it is already serving.
  for (const p of pids) {
    try {
      const c = execFileSync("ps", ["-p", String(p), "-o", "command="],
                             { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (/\brun-service\b/.test(c)) return "holder";
    } catch { /* gone between lsof and ps */ }
  }
  const pid = pids[0];
  // A holder of ours is running the `run-service` SUBCOMMAND. Nothing weaker
  // works: the rule was "names our launcher and is not server.mjs", and the
  // incumbent a real deploy meets is
  //
  //     node /opt/homebrew/bin/cache-fix-proxy server
  //
  // which satisfies both — `cache-fix-proxy` IS our launcher's bin name, and the
  // script path never appears when it is invoked through the shim. Measured on
  // the work Mac: `cc-update --apply --force` relaunched six sessions onto 9901
  // and left the pre-deploy proxy (pid 15060) serving, because the takeover read
  // it as one of ours and skipped it. A deploy that silently does nothing is
  // worse than one that fails.
  //
  // Read from `ps` rather than a pidfile: a pidfile outlives the process that
  // wrote it, and this decision is about who holds the socket RIGHT NOW.
  //
  // Ask about the PARENT too. Since the holder hands its socket down and stops
  // accepting, the process actually LISTENING is the proxy child, whose command
  // line is `.../proxy/server.mjs` — no `run-service` anywhere. Reading only the
  // listener therefore called our own healthy proxy a stranger: measured on
  // both machines, a second `run-service` SIGTERMed the running proxy, took the
  // port, and never exited 0. That is the "already running, nothing to do" case
  // turning into an outage plus a rival holder on a different port.
  let cmd = "";
  try {
    cmd = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,command="],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return pid; }
  if (/\brun-service\b/.test(cmd)) return "holder";
  const ppid = Number(cmd.trim().split(/\s+/)[0]);
  if (Number.isInteger(ppid) && ppid > 1) {
    try {
      const parent = execFileSync("ps", ["-p", String(ppid), "-o", "command="],
                                  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (/\brun-service\b/.test(parent)) return runningOurCode(port) ? "holder" : ppid;
    } catch { /* parent gone: fall through and treat the listener on its own */ }
  }
  return pid;
}

// Is the incumbent running the code THIS launcher would install?
//
// "Is it one of ours" is the wrong question, and asking it made every upgrade a
// no-op: a holder from an older deploy is still ours, so run-service exits 0 and
// the new code never starts. Measured on the work Mac against 54 live sessions —
// rc=0, holder untouched, and the fix sat on disk doing nothing until a human
// retired the old process by hand. cswap's pin had the mirror defect (an upgrade
// that ACTED and moved the port); both leave the outcome depending on somebody
// knowing to intervene.
//
// Compare the CODE, by content hash of the file the proxy booted from.
//
// Cheaper proxies for "is this the same code" are all wrong, and both of us
// shipped one before measuring:
//   PATH — mine. An in-place `git pull` does not move the file, so a real
//     upgrade compares equal and the old process keeps serving. Measured on
//     this box: disk at one commit, process running another, run-service
//     exited 0.
//   MTIME — cswap's pin. Wrong in BOTH directions, reproduced here: `rsync -a`
//     preserves mtime, so new content compares equal and the upgrade is MISSED;
//     and `touch` alone changes it, recycling a healthy daemon for nothing.
//   A VERSION STRING the proxy prints at boot answers "what did it think it
//     was", which cannot see a file replaced under a running process.
//
// So a holder publishes the sha256 of the server.mjs it is about to run, and
// the next one compares. A running process cannot be asked for its bytes; the
// record is it telling us what it booted with.
//
// The file lives beside the port it describes and is rewritten on every spawn,
// so it cannot outlive the fact — and if it does (a holder killed -9 mid-write,
// a stale file from a previous boot), the fallback below is "leave it alone",
// which is the safe direction.
//
// Unknown answers "yes" — a listener we cannot identify is one we must not
// signal, or this becomes the thing that kills an unrelated service on the port.
function codeFingerprint(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch { return ""; }
}

function fingerprintPath(port) {
  return join(tmpdir(), `cache-fix-proxy-${port}.sha256`);
}

// Temp + rename: a reader that opens this mid-write would compare against a
// truncated hash and retire a healthy proxy.
function publishFingerprint(port) {
  const fp = codeFingerprint(SERVER_PATH);
  if (!fp) return;
  const path = fingerprintPath(port);
  try {
    writeFileSync(`${path}.${process.pid}`, fp);
    renameSync(`${path}.${process.pid}`, path);
  } catch { /* best effort: an unwritable tmpdir must not stop a proxy starting */ }
}

function runningOurCode(port) {
  let theirs = "";
  try { theirs = readFileSync(fingerprintPath(port), "utf8").trim(); } catch { return true; }
  if (!theirs) return true;                       // cannot tell: leave it alone
  const ours = codeFingerprint(SERVER_PATH);
  if (!ours) return true;                         // cannot read our own: same
  return theirs === ours;
}

function holdPort(rest) {
  // The proxy's own default: holding a different port than the proxy would have
  // served leaves nothing at the documented address.
  const port = Number(process.env.CACHE_FIX_PROXY_PORT) || 9801;
  const bind = process.env.CACHE_FIX_PROXY_BIND || "127.0.0.1";

  return new Promise((resolveP) => {
    let child = null, childPort = 0, stopping = false, restart = null, failures = 0, served = false;
    // Which process currently owns the listening socket, and whether a successor
    // is already on its way. Both the reclaim poll and the child's exit can be
    // the second of the two events that must happen before a successor starts —
    // the port has to be ours again AND the old proxy has to be gone — so each
    // fires the same guarded spawn and only the later one gets through.
    let bound = false, reclaiming = null;
    // The sha256 the CURRENT child booted from, so a deploy can reach the
    // running process without a human. See the watcher below.
    let bootedHash = "";
    // `run-service` is idempotent: re-running it must not put a second proxy
    // beside the first. Only the holder can answer that, because the bind is
    // the only thing that knows whether the port is already taken.
    const alreadyRunning = process.env.CACHE_FIX_EXIT_IF_RUNNING === "1";
    const settle = (code) => { stopping = true; resolveP(code ?? 0); };
    const forward = (sig) => {
      stopping = true;
      // SIGHUP, not the signal we were sent: the proxy spawns its own successor
      // on SIGTERM (that is what makes a redeploy free), and a successor here
      // would keep this holder supervising forever — measured, the case that
      // asserts a holder stops on SIGTERM went 587ms -> 10,642ms and failed.
      // Only the holder knows a stop from a redeploy, so only the holder can
      // say it. SIGHUP means "go, and do not replace yourself".
      sig = "SIGHUP";
      clearTimeout(restart);
      // Between the proxy's death and its respawn there is no child to forward
      // to; stop now rather than wait for one that would never answer.
      if (!child || child.exitCode !== null || child.signalCode) return settle(0);
      try { child.kill(sig); } catch { settle(0); }
    };
    process.on("SIGTERM", () => forward("SIGTERM"));
    process.on("SIGINT", () => forward("SIGINT"));
    // SIGHUP is the word for "release the port" everywhere else in this file, so
    // a holder must answer it too. Without a handler node's default killed the
    // holder outright, leaving its child holding the socket — the takeover below
    // then had nobody to ask and waited out its deadline.
    process.on("SIGHUP", () => forward("SIGHUP"));

    // SIGUSR2 — "replace yourself, and keep the socket alive while you do it".
    //
    // The difference from SIGHUP is who ends up holding the address. SIGHUP
    // means let go, which leaves the port unowned until whoever asked can bind
    // it, and a bind cannot even be attempted until we have let go. Here WE
    // spawn the successor, hand it this socket on fd 3, and only then leave, so
    // the socket never loses its last descriptor and the successor never binds
    // anything. Same-tree by construction; cross-tree was the choice that made
    // the handover lossy, not a constraint of the platform.
    //
    // The successor runs the launcher AS IT IS ON DISK, which is the point: a
    // caller asks for this because the file changed under us.
    process.on("SIGUSR2", () => {
      if (stopping || !holder?._handle) return settle(0);
      stopping = true;
      clearTimeout(restart);
      try {
        spawn(process.execPath, [LAUNCHER_PATH, "run-service"], {
          detached: true,
          stdio: ["ignore", "inherit", "inherit", holder._handle.fd],
          // EXIT_WITH_PARENT is dropped, and this is the distinction cswap's
          // pin warned about before we hit it: "my parent is alive and watching
          // me" and "my predecessor handed me its socket on the way out" look
          // identical in the environment and mean opposite things. We are about
          // to exit BY DESIGN, so a successor that inherited the orphan guard
          // reads our death as its own cue and takes the port down with it —
          // measured, every request in the sampling window refused.
          env: { ...process.env, CACHE_FIX_HOLDER_HANDOVER: "1", LISTEN_FDS: "1",
                 CACHE_FIX_EXIT_WITH_PARENT: "0" },
        }).unref();
      } catch (e) {
        process.stderr.write(`[cache-fix] could not hand the port on: ${e.message}\n`);
        stopping = false;
        return;
      }
      // The child under us keeps serving until IT is replaced by the successor's
      // own child; nothing here interrupts the accept path.
      if (child && child.exitCode === null && !child.signalCode) {
        try { child.kill("SIGHUP"); } catch { }
      }
      settle(0);
    });

    // STOP WHEN NOBODY IS LEFT TO STOP US.
    //
    // A holder is deliberately hard to kill: its whole job is to put the proxy
    // back. That is right while someone owns it and catastrophic once nobody
    // does — a SIGKILLed parent runs no cleanup (a `finally` never executes),
    // so the pair reparents to init and holds its port, its memory and the
    // runner's pipes forever. Measured on this box: 151 orphaned holder/proxy
    // processes, oldest 6.8 hours, 9.17 GiB resident, from test runs whose
    // node --test runner had been killed. Nothing on the machine would ever
    // have collected them, because the only name they answer to carries the
    // dead runner's pid.
    //
    // Linux has PR_SET_PDEATHSIG for exactly this and node cannot call prctl,
    // so poll: cheap (one getppid-equivalent every 5s), portable to macOS, and
    // it cannot fire early — reparenting to init is irreversible, so ppid 1 is
    // a fact rather than a race. Skipped when we were STARTED detached (ppid
    // already 1), which is the supported "outlive my shell" launch and must
    // keep working.
    //
    // Not gated on being under a test: a holder orphaned in production is the
    // same leak with a longer fuse.
    // ONLY WHEN A SUPERVISOR ASKS FOR IT. Reparenting to init is the NORMAL
    // launch here, not a death: `wire.zsh` starts us with `&!` and the shell
    // that did it exits immediately, so ppid goes 1 within seconds of boot.
    // Treating that as "our parent died" made this holder release the port and
    // stop — measured on this box, 9901 went down twice under a live session
    // and had to be restarted by hand, with the log saying exactly
    // "[cache-fix] parent gone; releasing the port and stopping".
    //
    // So the guard exists for the case it was written for — a TEST RUNNER that
    // is SIGKILLed, leaving a holder nothing will ever collect (151 of them,
    // 9.17 GiB) — and that caller can ask for it. A production holder outliving
    // its shell is the design.
    if (process.env.CACHE_FIX_EXIT_WITH_PARENT === "1" && process.ppid > 1) {
      const orphanCheck = setInterval(() => {
        if (stopping || process.ppid > 1) return;
        process.stderr.write("[cache-fix] parent gone; releasing the port and stopping\n");
        clearInterval(orphanCheck);
        forward("SIGTERM");
      }, 5_000);
      orphanCheck.unref();
    }

    // Take the port back as soon as the child stops owning it. Polled rather
    // than event-driven: nothing tells a parent "your child just called
    // close()", and the child releases the socket well before it exits.
    //
    // Retried at 1ms, because this IS the outage: every request arriving while
    // nothing owns the port is refused, and a refusal is instant.
    //
    // The interval is not what closes the window, and measuring said so: 1ms
    // and 20ms both leave 5-6 refused per restart, as does closing before
    // announcing. The window is the RE-ACQUIRE itself — this holder gives the
    // socket up and has to win it back, and nothing owns the port in between.
    //
    // A HOLDER THAT NEVER LETS GO WAS TRIED HERE AND MEASURES WORSE IN NODE.
    // cswap's pin does exactly that and measures 0, so it looked like the fix.
    // Built end to end (keep the fd, hand each child a dup, forward what the
    // holder accepts over IPC, queue anything arriving mid-handover):
    //     this shape     5257 req   3 lost   max   83 ms
    //     never-let-go   1543 req   6 lost   max 5004 ms
    // Steady state is identical (4491 vs 4500, 0 lost), so the handoff itself is
    // free; the cost is entirely the handover, where one request eats the full
    // client timeout. An isolated prototype DID reproduce the 0, so the shape is
    // sound — in a runtime that can hold a listening fd without accepting.
    //
    // Node cannot: readStop() and nulling _handle.onconnection both still steal,
    // 92 of 200 measured. So our holder is FORCED to become an acceptor, and an
    // accepted connection is one the successor cannot see — queueing it is a
    // second implementation of the kernel backlog, and that duplicate is the
    // outlier. The pin's holder never calls accept() at all (it blocks in
    // Popen.wait(), no event loop), so the backlog stays the kernel's. Measured
    // on their live pair: holder 0 accepted, daemon 20.
    //
    // Do not retry this without a way to hold a listening fd passively.
    //
    // Backs off after 100 tries (~0.1s) so a port taken by something else costs
    // one attempt per 20ms rather than a thousand a second.
    let tries = 0;
    const reclaim = () => {
      if (stopping || bound) return;
      clearTimeout(reclaiming);
      const again = () => {
        holder.off("error", again);
        reclaiming = setTimeout(reclaim, ++tries < 100 ? 1 : 20);
      };
      holder.on("error", again);
      holder.listen({ port, host: bind });
    };

    // A successor may start as soon as the port is ours again. It does NOT wait
    // for the old proxy to exit: a proxy that has released its listening socket
    // is draining connections it already accepted, and needs nothing further
    // from the port. Waiting for its exit instead left the holder bound and
    // accepting, with no handler, for the whole 5s drain — measured, requests
    // arriving there hung until the client's own timeout rather than being
    // served by the successor.
    const spawnWhenReady = () => {
      if (stopping || child || !bound) return;
      // A pending restart timer OWNS the next spawn. Without this the bind that
      // reclaim() lands fires `listening` -> spawnWhenReady -> start(), which
      // skips the ladder entirely: measured, a proxy that could not start was
      // respawned 51 times in 1.2s. The ladder exists so a proxy broken for
      // hours costs one attempt every few seconds, not forty a second.
      if (restart) return;
      start();
    };

    const start = () => {
      if (stopping) return;
      childPort = 0;
      // Piped only to read the ephemeral port back; every byte is written on.
      // The child binds loopback on its own ephemeral port; we advertise $bind.
      // Pinning it here keeps the dial address below correct whatever $bind is.
      // fork, not spawn: fork opens an IPC channel, and the channel is how the
      // LISTENING SOCKET reaches the child. The child then accepts on it
      // directly, so the connection a client made IS the connection the proxy
      // serves — there is no second socket, and a proxy that dies has nothing
      // half-delivered to strand.
      //
      // This replaces a relay. The relay held a client-side socket that outlived
      // the upstream one, which cost one cut request in forty on every restart
      // (measured), and could not be fixed by retrying: once bytes have reached
      // the client a request is unrepeatable, and a retry sends it twice —
      // measured at 80 of 80 failing.
      // The listening socket goes down as FD 3 with LISTEN_FDS=1 — the systemd
      // socket-activation convention, not a private protocol. Anything that
      // speaks it can drive this proxy, and this holder can drive anything that
      // speaks it. `stdio` index 3 IS the child's fd 3, so no IPC is involved.
      //
      // The child accepts on that socket directly, which is what removes the
      // relay. A relay holds a client-side socket outliving the upstream one, so
      // a proxy that died mid-request cut it — one in forty on every restart,
      // measured — and retrying could not fix it: once bytes have reached the
      // client the request is unrepeatable, and a retry sent it twice (80 of 80
      // failed).
      // Publish BEFORE the spawn, and the reason is the OPPOSITE of what this
      // comment used to claim. It said the record must never name a newer build
      // than the process serving — but publishing early is exactly what makes it
      // do that, for the child's whole boot.
      //
      // What the order actually buys: a concurrent run-service reads this record
      // through runningOurCode() to decide whether to take the port. Publish
      // after the child reports listening and the record names the OLD build for
      // ~1.2s, so a deploy landing in that window reads an already-upgrading
      // holder as stale and churns it. Publish first and it reads "same bytes as
      // mine, leave it alone", which is the right answer while an upgrade is in
      // flight. The cost is the mirror case — a spawn that fails leaves the
      // record naming a build nothing serves — and that one self-corrects,
      // because the restart ladder republishes on every attempt and a port with
      // no listener never reaches this comparison at all.
      //
      // Written on every spawn, so a restart that picks up a redeployed file
      // republishes without anyone asking.
      publishFingerprint(port);
      bootedHash = codeFingerprint(SERVER_PATH);
      // The gap listener must let go before the child can listen on the
      // inherited fd: two handles may BIND one port, but only one may LISTEN —
      // measured, holding it across the spawn gave "socket handover refused
      // (EADDRINUSE)" and the child bound an ephemeral port instead.
      holder.closeGap();
      child = spawn(process.execPath, [SERVER_PATH, ...rest], {
        stdio: ["inherit", "pipe", "inherit", holder._handle.fd],
        // CACHE_FIX_HELD_PORT: the ADVERTISED port, so a child whose holder dies
        // can put a new holder back on it rather than exiting quietly.
        // LISTEN_PID is deliberately unset — the child's pid is unknown before
        // the spawn, and the receiver reads an absent one as "addressed to me".
        // CACHE_FIX_HELD_BY names US, and only a holder ever sets it. The child
        // can then tell "a holder is alive above me" from "my predecessor handed
        // me this on its way out" with two free facts and no probe: the marker
        // outlives us because it is the child's own environment, while its ppid
        // moves to 1 the instant we die. The two disagreeing IS the orphaning.
        // cswap's pin answers the same question this way; we had been answering
        // it with "did my ppid change", which is true on every handover too and
        // therefore cost a rival holder — 1,970 then 6,528 requests.
        env: { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_PROXY_BIND: "127.0.0.1",
               CACHE_FIX_HELD_PORT: String(port), CACHE_FIX_HELD_BY: String(process.pid),
               // OUR OWN BYTES, so the holder's version is observable instead of
               // inferred. The proxy already publishes proxy_tree and a checker
               // can compare it with disk; there was no equivalent for the layer
               // ABOVE it, and a stale holder execs the launcher from disk — so
               // it can spawn a perfectly current proxy while carrying none of
               // the holder-side code itself. Presence of a marker proves a
               // GENERATION, not a commit; this proves the commit.
               CACHE_FIX_HOLDER_TREE: HOLDER_TREE,
               LISTEN_FDS: "1" },
      });
      // Hand the socket over NOW, not when the child reports "listening".
      //
      // `spawn` dup'd the fd into the child at exec, so the port is already
      // held there and closing our copy cannot unbind it. Waiting for the
      // child's first line instead leaves US the only acceptor for the whole
      // boot — ~80ms — and a net.Server with no connection handler accepts and
      // then hangs forever. Measured across one SIGTERM: 4 requests arriving in
      // that window hung until the client's own 8s timeout.
      //
      // With nobody accepting, those connections wait in the KERNEL BACKLOG and
      // the child accepts them when it comes up. A queued connection costs
      // latency; an accepted-and-hung one costs the request.
      //
      // `me`: this spawn's own child, captured so the handlers below can tell
      // whether the shared `child` still refers to them. A retiring proxy and
      // its successor overlap, so `child` may already be the next one.
      const me = child;
      let retired = false;
      // The same defect in steady state: both processes hold one listening
      // socket, the kernel gives each connection to exactly ONE of them, and
      // there was no way to hold the fd without accepting: net.Server has no
      // pause(), maxConnections=0 accepts then RSTs (19 of 20 measured), and a
      // holder that stayed open ate a share of ALL traffic rather than just
      // traffic during a restart — 200 concurrent requests, hung=36
      // acceptedByHolder=36, exactly 1:1.
      //
      // THE HOLDER MUST NOT LISTEN. `uv_listen()` installs libuv's accept
      // callback, and from then on this process accepts connections nobody in
      // it will ever answer — measured on the same code with a single child
      // and no handovers at all: bind+listen served 1,870 and lost 30, bind
      // alone served 51,712 and lost 0. Twenty-eight times the throughput,
      // from one line.
      //
      // That loss looked for a long time like a handover window. It was not:
      // running the harness with ONE generation and NO signals reproduced it
      // exactly, which is what finally ruled the handover out.
      //
      // So we bind and stop. The CHILD calls listen() on the inherited fd and
      // owns the accept path; we keep the descriptor so we can start the next
      // one, including after a crash. Deploys measured at 149,038 / 148,658 /
      // 146,225 requests, zero lost, zero refused, zero reset.
      // Buffered until a newline: the port arrives on stdout, and a chunk
      // boundary inside that line would otherwise lose it silently — every
      // connection would then wait out the relay's deadline.
      let line = "";
      me.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        // The proxy announces the release before it drains, so the port comes
        // back to us at the START of its shutdown rather than at its exit.
        // Retire it here: it is no longer the proxy this holder supervises, so
        // the successor can boot while it finishes its in-flight work, and its
        // eventual exit must not be read as a death needing a respawn.
        if (!retired && String(chunk).includes("releasing the listening socket")) {
          retired = true;
          if (child === me) child = null;
          // "(handed off)" means the proxy already put its own successor on the
          // socket before announcing, and that successor is serving right now.
          // Reclaiming would take the port from a live proxy and spawning would
          // add a second — measured without this: one extra proxy per deploy,
          // 3 alive after 4 deploys. Nothing to do but stop supervising the
          // one that left.
          if (String(chunk).includes("(handed off)")) return;
          reclaim();
          // AND ask for the successor. reclaim() only starts one if its bind
          // lands after this point; when the port is already ours — a proxy
          // that released before we ever gave it up — `bound` is still true and
          // no `listening` event will fire, so nothing else would spawn one.
          // Measured on the personal Mac: a holder sat 26 minutes with no child
          // and no listening socket, and the suite hung behind it.
          spawnWhenReady();
        }
        if (childPort) return;
        line += chunk;
        const m = /listening on [\d.]+:(\d+)\n/.exec(line);
        if (m) {
          childPort = Number(m[1]); served = true; failures = 0; line = "";
          // The proxy has generated its CA by the time it says this, so publish
          // it now. A host wired by rc starts the proxy HERE and launches claude
          // from the shell, so the --remote-control path that used to be the
          // only publisher never runs — and every sibling then builds a merged
          // bundle without us. Only in forward-proxy mode: reverse mode
          // terminates no TLS, so it has no CA to offer.
          if (process.env.CACHE_FIX_FORWARD_PROXY === "on") publishOurCA(ourCAPath());
        }
        else if (line.length > 4096) line = line.slice(-256);
      });
      me.on("error", (err) => {
        process.stderr.write(`Failed to start proxy server: ${err.message}\n`);
        settle(1);
      });
      me.on("close", (code, sig) => {
        // NOBODY IS SERVING FROM HERE UNTIL THE NEXT CHILD BINDS. Put the gap
        // listener back so the port answers meanwhile — a request arriving now
        // queues in the backlog instead of being refused, and a refusal is what
        // strands a session whose HTTPS_PROXY was baked at exec. Idempotent, and
        // a no-op when a successor already took the port (its bind wins, ours
        // fails and is discarded).
        holder.openGap();
        // A proxy that announced its release was retired then: the port is
        // already back and a successor is already running, so its exit is
        // bookkeeping, not an event. Respawning here would put a second proxy
        // beside the one that replaced it.
        //
        // But a retiring proxy is STILL what a shutdown is waiting on when the
        // holder was signalled while it drained. Returning unconditionally left
        // `settle()` uncalled, so the holder never resolved and never exited —
        // measured on the personal Mac: the suite hung for 25 minutes with five
        // run-service holders alive after their SIGTERM.
        if (retired) return stopping ? settle(code) : undefined;
        childPort = 0;
        if (child === me) child = null;
        // A crash releases the socket without ever having handed it back, so the
        // reclaim poll may not be running. Idempotent when it already is.
        reclaim();
        // Only OUR being signalled ends this. The proxy exiting is what the held
        // port exists to survive — including the clean exit 0 a reload produces.
        if (stopping) return settle(code);
        // Two different failures, deliberately handled differently.
        //
        // Never served: the port has no sessions on it, so holding it open in
        // front of a proxy that cannot start only makes callers wait out the
        // relay deadline instead of failing over. Give it up.
        if (!served && ++failures >= 5) {
          process.stderr.write("[cache-fix] proxy failed to start 5 times; releasing the port\n");
          return settle(code || 1);
        }
        // Served before: sessions ARE wired to this port and releasing it
        // strands them for good, so keep holding and keep retrying — a later
        // deploy is picked up by the next respawn. Back off so a proxy that is
        // broken for hours costs one attempt every 5s, not four a second.
        // Test seam: the ladder's base. Proving the backoff exists means
        // sleeping through several rungs of it.
        // A proxy that HAD served and died once is not a failing proxy — it is a
        // restart, and the backoff is for a proxy that cannot start. Waiting out
        // a rung there costs the requests sitting in the kernel accept queue:
        // measured, one request in forty timed out across a 500ms first rung,
        // and zero across an immediate respawn.
        //
        // The ladder still applies to REPEATED deaths, which is what it is for.
        const base = Number(process.env.CACHE_FIX_RESTART_BASE_MS) || 250;
        const firstAfterServing = served && failures === 0;
        if (served) failures++;
        // Through the gate, not straight to start(): the port may not be back
        // yet (reclaim() is still polling), and spawning a child that cannot
        // inherit a bound socket gives it nothing to accept on.
        // Cleared as it FIRES, not after: spawnWhenReady refuses while a
        // restart is pending, so a timer that stayed set would block the very
        // spawn it was scheduled for — and every one after it.
        restart = setTimeout(() => { restart = null; spawnWhenReady(); }, firstAfterServing
          ? 0
          : Math.min(base * 2 ** Math.min(failures, 5), base * 20));
      });
    };

    // Wait for the proxy rather than refusing: to a client that baked
    // HTTPS_PROXY at exec, a refusal is as fatal as an unbound port.
    // No relay. The child accepts on the socket we bound (handed down as fd 3,
    // LISTEN_FDS=1), so the connection a client makes IS the connection the
    // proxy serves. Requests that arrive while a proxy is restarting wait in the
    // KERNEL accept queue and are served by the successor — which is why the
    // port never has to answer anything itself.
    //
    // Measured across three SIGKILLs of the proxy: with a relay in the path,
    // requests were cut (ECONNRESET) because it held a client-side socket that
    // outlived the upstream one; retrying could not fix it, since a request
    // whose bytes have started cannot be replayed.
    // A BOUND socket that is NOT listening, and the distinction is the whole
    // fix. `uv_listen()` is what installs libuv's accept callback, and once
    // installed it accepts whether or not JS ever sets `onconnection` — that is
    // why every previous attempt to hold the fd passively failed (readStop(),
    // unref(), onconnection=null: all measured, all still stole; a holder that
    // kept a LISTENING fd measured ok=16337 hung=80 under load).
    //
    // bind() alone installs nothing, so there is nothing to steal with. The
    // FIRST CHILD calls listen() on the inherited fd, and from then on the
    // holder simply owns a descriptor. Measured end to end: 4 deploys, 30
    // concurrent, 67,480 requests, 0 lost, 0 refused, 0 hung, same fd across
    // all four generations.
    //
    // This is the node equivalent of cswap's pin holding `self._srv` and never
    // closing it. CPython gets it free (a socket accepts only when you CALL
    // accept()); node needs the bind/listen split to get the same property.
    const holder = new HolderSocket();
    // Only the BIND may fall back: another proxy owns the port, so run ours on
    // it directly and let the collision be reported the way it always has been.
    // A later server error must not start a second proxy beside the first.
    // Under run-service the collision is the ANSWER, not a fallback: something
    // is already serving, which is all the caller asked for.
    const bindFailed = () => {
      holder.off("error", bindFailed);
      if (alreadyRunning) return takeOver();
      resolveP(runProxy(rest));
    };
    holder.on("error", bindFailed);
    // ONE success handler for every bind attempt, first or retried. Passing the
    // callback to listen() adds a `listening` listener PER CALL and node fires
    // all of them on the bind that finally lands — measured standalone, 21
    // callbacks from one success; on the work Mac a single takeover left the
    // holder supervising 100 proxies, 72 of them holding ephemeral ports.
    // `on`, not `once`: the holder rebinds on every restart, and a one-shot
    // listener would leave every bind after the first unobserved.
    holder.on("listening", () => {
      holder.off("error", bindFailed);
      bound = true;
      tries = 0;
      clearTimeout(reclaiming);
      spawnWhenReady();
    });
    const listen = () => holder.listen({ port, host: bind });

    // Somebody else owns the port. Under run-service that is a DEPLOY, not an
    // error: the caller wants this code serving that address, and the incumbent
    // is usually a proxy an older rc started — commonly a plain `server` that
    // bound the port itself, with nothing under it to hand the socket down.
    //
    // So: ask it to RELEASE, then take the port. SIGHUP, not SIGTERM — SIGTERM
    // is the signal that makes a redeploy free, so our own proxy answers it by
    // handing the listening socket to a successor and the port never frees at
    // all. Measured on the personal Mac: pid 78405 handed down to 83219, this
    // path printed "could not take port within 20s", the holder exited, and the
    // lineage stayed unsupervised — a livelock, not a slow takeover. SIGHUP
    // means "go, and do not replace yourself"; both roles honour it and both
    // drain in-flight requests first. The window between the release and our
    // bind is the only unowned moment, measured at 0.06s, and it is paid ONCE:
    // everything after this restarts under the holder with no window at all.
    //
    // Idempotence is preserved by what we stop: an incumbent that is ALREADY a
    // holder of ours answers nothing here and keeps its port, because we only
    // reach this path when our own bind lost — and we identify the incumbent
    // before signalling, so a second run-service against a healthy holder exits
    // 0 rather than churning it.
    const takeOver = () => {
      const incumbent = holderPidOn(port);
      if (incumbent === "holder") return settle(0);   // ours already; nothing to do
      if (!incumbent) return settle(0);               // cannot identify it: leave it alone
      // ASK A HOLDER TO HAND THE PORT ON RATHER THAN DROP IT.
      //
      // A holder can spawn our replacement itself and pass it this very socket,
      // so the address never goes unowned and nothing has to bind. Releasing
      // costs the incoming child's whole boot, because a second bind is refused
      // while the incumbent still holds the port — that is the 63-of-1,281 this
      // avoids. Only a holder can do it; a bare proxy has no successor-holder to
      // spawn, so that case still goes the release route below.
      let argv = "";
      try {
        argv = execFileSync("ps", ["-o", "command=", "-p", String(incumbent)],
                            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch { }
      if (argv.includes("run-service")) {
        try { process.kill(incumbent, "SIGUSR2"); } catch { return settle(0); }
        // Confirm it actually happened. An incumbent too old to know SIGUSR2
        // takes node's default and dies outright, which leaves its child on the
        // socket and nobody supervising — so a handover we cannot SEE must fall
        // back rather than be assumed.
        const until = Date.now() + 10_000;
        const settled = () => {
          if (holderPidOn(port) === "holder") return settle(0);
          if (Date.now() < until) return void setTimeout(settled, 100);
          process.stderr.write(
            `[cache-fix] pid ${incumbent} did not hand the port on; taking it the slow way\n`);
          release();
        };
        return void settled();
      }
      release();
    };

    // The older route: ask the incumbent to let go, then bind what it drops.
    // Whatever arrives here cannot hand a socket on, so the port is unowned for
    // as long as our child takes to boot.
    const release = () => {
      const incumbent = holderPidOn(port);
      if (incumbent === "holder" || !incumbent) return settle(0);
      try { process.kill(incumbent, "SIGHUP"); } catch { return settle(0); }
      // Retry the bind until it lands. The incumbent drains first, so this is
      // not a fixed wait — a busy proxy takes longer and we simply keep asking.
      const deadline = Date.now() + 20_000;
      const retry = () => {
        if (stopping) return;
        if (Date.now() > deadline) {
          process.stderr.write(
            `[cache-fix] could not take port ${port} from pid ${incumbent} within 20s\n`);
          return settle(1);
        }
        const again = () => { holder.off("error", again); setTimeout(retry, 50); };
        holder.on("error", again);
        holder.listen({ port, host: bind });
      };
      retry();
    };

    // A DEPLOY THAT NOBODY RELAUNCHES NEVER RUNS.
    //
    // Node reads the proxy source once at startup, so `git pull` updates files
    // the live process is not executing. The machine that most needs an upgrade
    // is the one whose sessions never restart — cswap's pin served code replaced
    // 19 hours earlier for 22 hours, with every health signal green, and this
    // fleet is in that state right now on all three hosts.
    //
    // We already publish the sha256 at spawn; this is the missing half, the
    // incumbent re-reading it. On a change, SIGTERM the child: the holder keeps
    // the port, the proxy drains, and the successor comes up on the new file —
    // the same path a crash already takes, measured at 3 lost of 5257 across 3
    // restarts. That cost is why this is OPT-IN: a restart is never free, and
    // whether stale code or a few dropped requests is worse depends on the host.
    //
    // Polled, not fs.watch: a watch fires on a touch that changed no bytes and
    // misses a replace-by-rename on some platforms. The hash answers the only
    // question that matters — are these the bytes the child booted from.
    // CACHE_FIX_SELF_HEAL=off means "do not act on your own", and this acts on
    // its own — so it has to ask. The switch predates this watcher and the
    // proxy-side check honoured it, so a reader would assume it was covered:
    // measured, it was not. An operator editing the file with the switch OFF
    // still lost the proxy under them, which is the one thing the switch exists
    // to prevent, reached through a path added later.
    //
    // cswap's pin had the identical defect and found it from this side of the
    // conversation. Same shape, both codebases, both added after the switch.
    const watchMs = process.env.CACHE_FIX_SELF_HEAL === "off"
      ? 0
      : Number(process.env.CACHE_FIX_WATCH_DEPLOY_MS) || 0;
    let warnedUnreadable = false;
    if (watchMs > 0) {
      const watcher = setInterval(() => {
        if (stopping || !child || !bootedHash) return;
        const onDisk = codeFingerprint(SERVER_PATH);
        // An UNREADABLE file and an UNCHANGED one are different facts, and
        // folding them together hides the first: a watcher that can never read
        // its own source looks exactly like one with nothing to do. Say it once
        // — repeating it every tick would bury the log it belongs in.
        if (!onDisk) {
          if (!warnedUnreadable) {
            warnedUnreadable = true;
            process.stderr.write(
              `[cache-fix] deploy watcher cannot read ${SERVER_PATH}; it will never fire\n`);
          }
          return;
        }
        if (onDisk === bootedHash) return;
        process.stderr.write(
          `[cache-fix] proxy source changed (${bootedHash.slice(0, 12)} -> ` +
          `${onDisk.slice(0, 12)}); restarting onto it\n`);
        bootedHash = onDisk;   // once per change, not once per tick
        try { child.kill("SIGTERM"); } catch { /* already gone; the exit path handles it */ }
      }, watchMs);
      watcher.unref();
    }

    listen();
  });
}

function runProxy(rest) {
  return new Promise((resolveP) => {
    // "inherit" passes fds 0-2 only, so an inherited socket would stop here
    // and the server would bind its own port. LISTEN_PID is dropped rather
    // than re-stamped: a parent cannot know its child's pid before spawning.
    const socketActivated = Number(process.env.LISTEN_FDS) >= 1;
    const env = { ...process.env };
    if (socketActivated) delete env.LISTEN_PID;
    const serverProc = spawn(process.execPath, [SERVER_PATH, ...rest], {
      stdio: socketActivated ? ["inherit", "inherit", "inherit", 3] : "inherit",
      env,
    });
    // Forward termination to the child so a supervisor killing THIS launcher
    // doesn't leak the actual server process. Without this, `kill <launcher>`
    // leaves the listening child orphaned (it reparents to init and keeps the
    // port bound). Each handler is idempotent; the child's exit resolves us.
    const forward = (sig) => { try { serverProc.kill(sig); } catch {} };
    const onSIGTERM = () => forward("SIGTERM");
    const onSIGINT = () => forward("SIGINT");
    process.on("SIGTERM", onSIGTERM);
    process.on("SIGINT", onSIGINT);
    serverProc.on("close", (code) => {
      process.off("SIGTERM", onSIGTERM);
      process.off("SIGINT", onSIGINT);
      resolveP(code ?? 0);
    });
    serverProc.on("error", (err) => {
      process.stderr.write(`Failed to start proxy server: ${err.message}\n`);
      resolveP(1);
    });
  });
}

// Subcommand dispatch (must come before the wrapper-arg parser so subcommand
// names don't get treated as claude args). Returns null when no subcommand
// matched, signaling fall-through to wrapper mode below.
// The proxy's CA, resolved from the SAME inputs as its config.caDir and in the
// same order: CACHE_FIX_CA_DIR wins, else ${CLAUDE_CONFIG_DIR||~/.claude}/
// cache-fix-ca. One function because two callers resolving it separately is how
// a launcher comes to point at a different CA than the proxy generated.
const ourCADir = () => process.env.CACHE_FIX_CA_DIR ||
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cache-fix-ca");
const ourCAPath = () => join(ourCADir(), "ca.pem");

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// The salvage scratch dir's name, in ONE place. Two matching string literals is
// how the reaper below came to match `cache-fix-ca-prod` — an operator CA dir,
// which README documents living under /tmp — and delete the private key the
// running proxy signs with. A constant makes the mkdtemp and the glob provably
// the same set.
const SCRATCH_PREFIX = "cache-fix-ca-scratch-";

const caTrustDir = join(configDir, "ca-trust.d");
const PUBLISHED_CA_NAME = "ccf.pem";

// Publish our MITM CA into the ca-trust.d rendezvous, and sweep our own
// orphaned temps. Called from BOTH launch paths: --remote-control, which execs
// claude itself, and run-service, which only supervises a proxy. It used to be
// inline in the first, so a host wired by rc — proxy started by run-service,
// claude launched by the shell — published nothing and every sibling built a
// merged bundle without us. Measured on the work Mac: ca-trust.d held
// cswap-pin.pem alone and the verifier said node loads no CA of ours from it.
function publishOurCA(caPem) {

  try {
    mkdirSync(caTrustDir, { recursive: true });
    const ours = readFileSync(caPem);
    // Parse BEFORE publishing. Validating later (we do, at the own-CA step
    // below) still handed a corrupt ca.pem to every OTHER component: "ccf" sorts
    // first in the builder's sort(*.pem), so a bad entry lands in the same fatal
    // leading position the torn-write guard above protects — measured, such a
    // bundle loads 0 extra CAs and warns `bad base64 decode`. Atomicity
    // guarantees whole bytes, never loadable ones. Throwing lands in the catch
    // below, leaving any previous good ccf.pem in place for siblings to keep
    // trusting.
    new X509Certificate(ours);
    // The published name and the orphan-sweep prefix, derived from one constant.
    // Two matching literals is how SCRATCH_PREFIX came to delete an operator CA
    // dir; this pair is the same hazard 50 lines earlier and was still two
    // literals. Measured with the prefix shortened by one character: the sweep
    // removed `ccf.pem` itself — the CA every other component reads.
    const dst = join(caTrustDir, PUBLISHED_CA_NAME);
    // Byte-compare skip so a bundle builder keying on mtime is not woken by a
    // launch that changed nothing.
    let same = false;
    // ANY read failure means "write": absent, unreadable, EACCES, EISDIR, torn.
    // Measured with dst at mode 0: same=false, and the branch republishes OURS.
    // Safe because the only thing this branch can write is our own CA via
    // temp+rename — the collapse cannot publish worse content than it could not
    // read. That is a property of the WRITE, not of this catch; publish anything
    // else here and an unreadable dst becomes indistinguishable from a stale one.
    try { same = readFileSync(dst).equals(ours); } catch { /* see above */ }
    if (!same) {
      // Write a temp sibling and rename() over the target: rename is atomic on
      // POSIX, so a builder reading the directory sees either the old complete
      // file or the new one, never a half. A plain writeFileSync(dst) opens with
      // O_TRUNC and leaves a torn pem visible for the duration of the write —
      // and a torn pem does not merely lose OUR CA, it can void the ENTIRE merged
      // bundle: Node's PEM reader aborts the whole extras load on an unterminated
      // block. Measured on node v24 / openssl 3.5 with a leaf signed by this CA:
      // torn entry AFTER a good one warns "bad end line" but still verifies;
      // torn entry BEFORE it fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The
      // builder concatenates sort(*.pem) and "ccf.pem" sorts first, so a torn
      // OURS lands in exactly the fatal position and takes every other component
      // CA and corporate root down with it. Temp must be in the SAME directory —
      // rename across filesystems is not atomic (and would EXDEV).
      // pid alone is not unique: two launches in separate PID namespaces sharing
      // a bind-mounted config dir can hold the same pid and collide on the temp
      // path, so one publishes the other's bytes. uuid removes that.
      const tmp = `${dst}.${process.pid}.${randomUUID()}`;
      writeFileSync(tmp, ours);
      renameSync(tmp, dst);
    }
  } catch (e) {
    // Non-fatal: publishing is how OTHERS trust us. This session only needs its
    // own CA, so a failure to publish must not stop it.
    process.stderr.write(`cache-fix: could not publish CA to ${caTrustDir}: ${e.message}\n`);
}
// Reap temps orphaned by a kill between the write and the rename. They do not
// match a *.pem glob so a builder ignores them, but nothing else would ever
// remove them.
//
// Its OWN try, deliberately outside the publish one. Sharing that block made
// reaping conditional on the rename succeeding, so exactly when publishing is
// persistently broken — a root-owned ccf.pem, a read-only mount, ENOSPC — the
// launcher abandoned one full-CA temp per launch and cleaned up none of them,
// growing without bound in the directory a builder globs.
//
// Age-gated, because a temp is indistinguishable from an orphan by name: a
// CONCURRENT launcher has its own ccf.pem.<pid>.<uuid> on disk in the window
// between its writeFileSync and its renameSync, and deleting that makes its
// rename throw a publish failure we caused. The window is one small write to
// the same directory, microseconds; a minute is four orders of magnitude of
// headroom and still collects the orphan on the next launch. Deleting late
// costs nothing — nothing reads these — while deleting early breaks a peer.
try {
  const orphanAgeMs = 60_000;
  for (const f of readdirSync(caTrustDir)) {
    if (!f.startsWith(`${PUBLISHED_CA_NAME}.`)) continue;
    const p = join(caTrustDir, f);
    try { if (Date.now() - statSync(p).mtimeMs > orphanAgeMs) rmSync(p); }
    // Raced, OR the delete was REFUSED — measured with the dir at mode 0500:
    // removed=0, file still there. Tolerable because a survivor is disk, not
    // trust: this name is `ccf.pem.<pid>.<uuid>` and does not end in `.pem`,
    // so no builder globbing `*.pem` reads it.
    catch { /* see above */ }
  }
} catch { /* unreadable dir: the publish warning above already said so */ }
}

async function dispatch() {
  if (SUBCOMMAND === "server") {
    if (process.env.CACHE_FIX_HOLD_PORT === "on" && !(Number(process.env.LISTEN_FDS) >= 1)) {
      return holdPort(args.slice(1));
    }
    return runProxy(args.slice(1));
  }
  // run-service — what install-service's unit does, without a service manager.
  // The README tells you to run forward-proxy mode supervised; systemd and
  // launchd are how, and neither exists in a container, in WSL, or for a
  // non-root user on a shared host. This is the same guarantee from the
  // process itself: it holds the port, restarts the proxy under it, and exits
  // quietly when one is already serving.
  //
  // The mode comes from the environment, exactly as install-service takes it:
  //   CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy run-service
  if (SUBCOMMAND === "run-service") {
    process.env.CACHE_FIX_HOLD_PORT = "on";
    process.env.CACHE_FIX_EXIT_IF_RUNNING = "1";
    // A SERVICE MUST NOT INHERIT THE SESSION'S WIRING.
    //
    // HTTPS_PROXY/ALL_PROXY name the hop a SESSION dials — us, or something in
    // front of us. Reaching this process by inheritance, they become our own
    // upstream, so what we forward to depends on which shell was open when
    // someone typed the command. Measured twice on one box in a day: started
    // from a wired shell we adopted the hop in front of us and every request
    // looped, while the correct value sat unused in the same environment.
    //
    // Dropped rather than overridden, so the fallback chain the launcher
    // computed is what decides. An operator who genuinely wants a specific
    // upstream for the service says so with CACHE_FIX_UPSTREAM_PROXY, which
    // nothing inherits by accident.
    if (!process.env.CACHE_FIX_UPSTREAM_PROXY) {
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "ALL_PROXY", "all_proxy"]) {
        delete process.env[k];
      }
    }
    // A SERVICE NEEDS ITS ADDRESS SAID OUT LOUD. Sessions bake a port at exec,
    // so this one is not ours to guess: falling back to the built-in default
    // binds a port nobody was told about, and every health field then reports a
    // perfectly working proxy that no session can reach. Measured — a
    // run-service started without it took 9801 while the fleet dialled 9901.
    //
    // Only here. Wrapper mode keeps the default because it wires the client it
    // launches, so the number is private to that pair; a service is the case
    // where something else already knows the address.
    if (!process.env.CACHE_FIX_PROXY_PORT) {
      process.stderr.write(
        "[cache-fix] run-service needs CACHE_FIX_PROXY_PORT — a service must bind the " +
        "port sessions were told to use, and that cannot be guessed. " +
        "e.g. CACHE_FIX_PROXY_PORT=9901 CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy run-service\n");
      return 2;
    }
    return holdPort(args.slice(1));
  }
  if (SUBCOMMAND === "install-service") {
    const force = args.includes("--force");
    const { install } = await import("./install-service.mjs");
    return install({ force });
  }
  if (SUBCOMMAND === "uninstall-service") {
    const { uninstall } = await import("./install-service.mjs");
    return uninstall();
  }

  if (SUBCOMMAND === "--help" || SUBCOMMAND === "-h" || SUBCOMMAND === "help") {
    process.stdout.write(
      "Usage: cache-fix-proxy [subcommand] [args]\n\n" +
        "Subcommands:\n" +
        "  (no subcommand)        Spawn the proxy + launch claude with ANTHROPIC_BASE_URL set.\n" +
        "                         Pass any claude args after optional --proxy-port / --proxy-upstream.\n" +
        "  server                 Run just the proxy in the foreground (for systemd/launchd ExecStart).\n" +
        "  run-service            What install-service's unit does, without a service manager:\n" +
        "                         holds the port, restarts the proxy under it, and exits 0\n" +
        "                         when one is already serving. For hosts with no systemd or\n" +
        "                         launchd (containers, WSL, a non-root user). Mode comes from\n" +
        "                         the environment: CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy run-service\n" +
        "  install-service        Install a systemd user service (Linux) or launchd agent (macOS).\n" +
        "                         Pass --force to overwrite an existing config.\n" +
        "  uninstall-service      Stop, disable, and remove the installed service.\n" +
        "  help                   Show this help.\n\n" +
        "Wrapper-mode flags:\n" +
        "  --proxy-port <N>       Port for the spawned proxy (default 9801)\n" +
        "  --proxy-upstream <URL> Upstream URL the proxy forwards to (default api.anthropic.com)\n" +
        "  --remote-control       Run in forward-proxy mode: spawn the proxy with\n" +
        "                         CACHE_FIX_FORWARD_PROXY=on and wire claude via\n" +
        "                         HTTPS_PROXY + the proxy's MITM CA instead of\n" +
        "                         ANTHROPIC_BASE_URL, so Claude Code stays first-party\n" +
        "                         and Remote Control / mobile session visibility keeps\n" +
        "                         working (CC >= 2.1.196 disables it when\n" +
        "                         ANTHROPIC_BASE_URL is set). Also adds localhost to\n" +
        "                         NO_PROXY so local HTTP MCP servers / services bypass\n" +
        "                         the proxy (any existing NO_PROXY is preserved).\n" +
        "\nEnvironment:\n" +
        "  CACHE_FIX_PROXY_PORT     Port for the proxy server\n" +
        "  CACHE_FIX_PROXY_UPSTREAM Upstream URL\n" +
        "  CACHE_FIX_DEBUG=1        Verbose proxy logging\n" +
        "  CACHE_FIX_HOT_RELOAD=on  Enable in-process extension hot-reload (off by default; see #196)\n" +
        "  CACHE_FIX_HOLD_PORT=on   `server` keeps the port bound and relays to the proxy, so\n" +
        "                           restarting the proxy never unbinds it. For supervisors that\n" +
        "                           restart this command; systemd socket activation already\n" +
        "                           provides the same guarantee.\n" +
        "  CACHE_FIX_CLAUDE_CMD     Override the `claude` command for the wrapper\n" +
        "\nNotes on --remote-control:\n" +
        "  Remote Control performs a trusted-device enrollment handshake on first\n" +
        "  connect. That step is Claude Code's own, runs upstream, and can need a\n" +
        "  few retries — especially on a freshly launched or auto-resumed session,\n" +
        "  or when the Anthropic API is degraded. A failure prints \"device\n" +
        "  enrollment didn't complete... run /remote-control again\"; re-running RC\n" +
        "  is the intended fix and normally succeeds within a few attempts. This is\n" +
        "  enrollment flakiness, NOT a forward-proxy failure — the proxy relays the\n" +
        "  enrollment traffic unchanged (check the proxy journal for passthrough\n" +
        "  errors to rule the proxy in or out).\n" +
        "\n" +
        "  Enabling RC on an already-warm session costs ONE prompt-cache rebuild:\n" +
        "  enrollment adds an RC anthropic-beta (and X-Trusted-Device-Token) to\n" +
        "  outbound requests, and Anthropic keys the prompt cache partly on the beta\n" +
        "  set, so the first post-/rc request rebuilds the prefix under the new\n" +
        "  namespace. It re-warms on the very next turn (measured: 13.9% -> 98.2%\n" +
        "  hit rate one turn later). To avoid paying it mid-session, launch with\n" +
        "  --remote-control from the start so the beta is present from request one.\n",
    );
    return 0;
  }
  return null;
}

const subcommandExit = await dispatch();
if (subcommandExit !== null) process.exit(subcommandExit);

// No subcommand matched → wrapper mode (back-compat with v3.0.x behavior).
let proxyPort = 9801;
let proxyUpstream = undefined;
let remoteControl = false;
const claudeArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--proxy-port" && args[i + 1]) {
    proxyPort = parseInt(args[++i], 10);
  } else if (args[i] === "--proxy-upstream" && args[i + 1]) {
    proxyUpstream = args[++i];
  } else if (args[i] === "--remote-control") {
    remoteControl = true;
  } else {
    claudeArgs.push(args[i]);
  }
}

const proxyEnv = { ...process.env, CACHE_FIX_PROXY_PORT: String(proxyPort) };
if (proxyUpstream) proxyEnv.CACHE_FIX_PROXY_UPSTREAM = proxyUpstream;
// Forward-proxy mode: the spawned proxy must attach the CONNECT/MITM handler,
// or the HTTPS_PROXY wiring below would tunnel to a proxy that only speaks
// reverse-proxy and never terminates TLS for the upstream host.
if (remoteControl) {
  proxyEnv.CACHE_FIX_FORWARD_PROXY = "on";
  // ...and tell it we will wire claude ourselves, so it does not print a recipe
  // that would undo that. Internal handshake between these two files,
  // deliberately not an operator knob — see the banner in proxy/server.mjs.
  proxyEnv.CACHE_FIX_WIRED_BY_LAUNCHER = "1";
}

const proxyProc = fork(SERVER_PATH, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: proxyEnv,
});

let claudeProc = null;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  if (claudeProc && !claudeProc.killed) claudeProc.kill("SIGTERM");
  if (proxyProc && !proxyProc.killed) proxyProc.kill("SIGTERM");
}

proxyProc.on("exit", (code) => {
  if (!exiting) {
    process.stderr.write(`proxy exited unexpectedly (code ${code})\n`);
    cleanup();
    process.exit(1);
  }
});

proxyProc.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function waitForReady() {
  return new Promise((resolve, reject) => {
    let output = "";
    proxyProc.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on ([\d.]+):(\d+)/);
      if (match) resolve(parseInt(match[2], 10));
    });
    proxyProc.on("exit", (code) => {
      reject(new Error(`Proxy exited (code ${code}) before ready`));
    });
    setTimeout(() => reject(new Error("Proxy failed to start within 10s")), 10000);
  });
}

let actualPort;
try {
  actualPort = await waitForReady();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  cleanup();
  process.exit(1);
}

let claudeEnv;
if (remoteControl) {
  // Forward-proxy wiring. Leave ANTHROPIC_BASE_URL UNSET (that is exactly what
  // keeps Remote Control enabled) and route claude through the proxy as an
  // HTTPS proxy, trusting the MITM CA it generated on startup. Resolve the CA
  // dir from the SAME inputs as the proxy's config.caDir, in the same order:
  // CACHE_FIX_CA_DIR wins, else ${CLAUDE_CONFIG_DIR||~/.claude}/cache-fix-ca.
  // (Reading only CLAUDE_CONFIG_DIR here would ignore a CACHE_FIX_CA_DIR
  // override and point claude at the wrong — or absent — CA than the one the
  // spawned proxy actually generated.)
  const caDir = ourCADir();
  const caPem = join(caDir, "ca.pem");
  if (!existsSync(caPem)) {
    process.stderr.write(
      `--remote-control: proxy MITM CA not found at ${caPem}. The proxy should ` +
        `generate it on startup in forward-proxy mode; check for an openssl ` +
        `failure in the proxy output above.\n`,
    );
    cleanup();
    process.exit(1);
  }
  const proxyUrl = `http://127.0.0.1:${actualPort}`;
  claudeEnv = { ...process.env };
  delete claudeEnv.ANTHROPIC_BASE_URL;
  claudeEnv.HTTPS_PROXY = proxyUrl;
  claudeEnv.https_proxy = proxyUrl;
  // Publish our MITM CA where other components can find it. NODE_EXTRA_CA_CERTS
  // takes ONE file, so whoever assigns it last wins and every other CA is
  // silently untrusted — measured 2026-07-30 against an account-switching pin
  // proxy, which also MITMs api.anthropic.com and also set the var, breaking
  // Remote Control inbound on the work Mac. The fix is a directory each component publishes its
  // own file into, so a bundle can be built from all of them.
  //
  // We write EXACTLY ONE path, ca-trust.d/ccf.pem, and never a sibling's.
  // Rewritten every launch, not once: the proxy regenerates its CA whenever
  // caDir is wiped, and a stale pem would advertise a key nothing signs with.
  //
  // Fixed name, no env override, for the same reason the merged bundle below has
  // none: both halves are a rendezvous, and a knob on one half only lets this
  // launcher publish where no builder is looking while still consuming the
  // canonical bundle — dropping out of the contract while appearing to implement
  // it. Relocating the pair is what CLAUDE_CONFIG_DIR already does, and it moves
  // both sides together.
  publishOurCA(caPem);
  // Read the merged bundle if something built one, so a session trusts every
  // component's CA and not only ours.
  //
  // We deliberately do NOT build it. Merging must include the ambient/corporate
  // roots, and finding those is environment-specific (a Linux host may keep them
  // in /usr/local/share/ca-certificates/*.crt and NOT in the system bundle a
  // shell points at; a Mac keeps them in the keychain). That knowledge does not
  // belong in this repo. It also keeps the writer count at one: two launchers
  // both rebuilding the bundle would race the same output. We are write-own +
  // read-merged.
  //
  // No bundle => our own CA alone, byte for byte what this did before, so a host
  // with no other MITM and no bundle builder sees no change at all.
  // Fixed name, no env override: the builder writes this exact path (it resolves
  // the config dir the same way), so a knob here could only ever point the two
  // sides at different files.
  const caTrustBundle = join(configDir, "ca-trust.pem");
  let caForClaude = caPem;
  // Our own CA is parsed in its OWN step, before the bundle is even read.
  // Folded into the bundle try (as it was), a corrupt or zero-byte ca.pem threw
  // from the X509 parse and printed `ignoring <ca-trust.pem> (no start line)` —
  // naming a file that may be perfectly healthy — and then fell back to the very
  // ca.pem that had just failed to parse. Same failure, wrong component blamed.
  let ourCa = null;
  try {
    ourCa = readFileSync(caPem);
    new X509Certificate(ourCa);
  } catch (e) {
    ourCa = null;
    // And do NOT hand claude the file that just failed to parse. Node reads
    // NODE_EXTRA_CA_CERTS once at startup and warns-and-continues on a bad one,
    // so pointing at it buys nothing and costs the ambient roots nothing either
    // way — but naming it implies it is a CA we vouch for. Leaving the variable
    // unset falls back to node's built-in store, which is the honest state: we
    // have no usable CA to add. The proxy will have failed to attach its MITM
    // for the same reason, so the session needs the ambient roots, not ours.
    caForClaude = null;
    process.stderr.write(
      `cache-fix: our own CA at ${caPem} does not parse (${e.message}); ` +
        `remove ${caDir} and relaunch to regenerate it\n`,
    );
  }
  // Accept the bundle only if node's loader really loads our CA from it. The
  // decision lives in bin/ca-trust.mjs so the tests drive this exact code; it
  // used to be inline here with a hand-copied twin in the test file, and
  // mutating this one left the whole suite green.
  // The probe needs a leaf OUR CA issued; the proxy's own is right here and is
  // regenerated alongside ca.pem, so it cannot drift out of sync with it.
  // The host must be the one the leaf's SAN covers, which forward-proxy.mjs
  // derives from the upstream — so a session launched with --proxy-upstream
  // gets a leaf for THAT host, and a probe asking for api.anthropic.com fails
  // the name check and refuses a perfectly good bundle on every launch.
  // Resolved from the same inputs, in the same order, as the proxy uses.
  // Reading it off the leaf's SAN instead was tried and reverted. It is the same
  // predict-vs-ask substitution as the rest of this change, and it looked
  // strictly better — but the divergence it protects against does not exist:
  // `ensureCA`'s `leafCoversAllHosts()` re-mints the leaf whenever its SAN stops
  // covering the current upstream, so by the time this runs the two sources
  // agree by construction. Measured: with the SAN read in place, mutating it
  // back to this derivation left the whole suite green, and the test written to
  // separate them could not, because no reachable state separates them.
  let probeHost = "api.anthropic.com";
  try { probeHost = new URL(proxyUpstream || process.env.CACHE_FIX_PROXY_UPSTREAM
                            || "https://api.anthropic.com").hostname; } catch { /* default */ }
  const probeLeaf = { keyPath: join(caDir, "leaf.key"), certPath: join(caDir, "leaf.pem"),
                      host: probeHost };

  // No `existsSync(leaf.key)` here. It used to gate this block, and an absent
  // leaf key then skipped everything SILENTLY: `caForClaude` stayed at our own
  // CA and nothing was printed. That is a probe-that-could-not-be-run narrowing
  // trust, which is the one thing the three-outcome contract exists to forbid —
  // measured with a healthy 2-CA merge present, the gate handed over 1 CA with
  // no message, where letting the block run reports `unknown` and salvages 3.
  // The probe already answers "local" for an unreadable key, and the code below
  // routes that like every other unknown, so the guard was both redundant and
  // wrong. It was also weaker than it looked: `existsSync` on a DIRECTORY named
  // leaf.key returns true, so it never caught the unusable case anyway.
  if (ourCa && existsSync(caTrustBundle)) {
    // mkdtemp, not a pid-named file: it is atomically exclusive and 0700, so
    // nothing can pre-create the path as a symlink to somewhere else, a
    // recycled pid cannot collide with a stale file, and a leftover is
    // unreadable by anyone else. Left behind deliberately — node reads
    // NODE_EXTRA_CA_CERTS at startup and claude holds it for the session.
    let scratch = null, nth = 0;
    const writeTmp = (text) => {
      scratch ??= mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
      const p = join(scratch, `b${++nth}.pem`);
      writeFileSync(p, text);
      return p;
    };
    // ...but "left behind deliberately" is not "left behind forever". One dir
    // per salvage launch, and nothing else on the machine removes them: 81 had
    // accumulated here during this change's own development.
    //
    // The gate is SEVEN DAYS, not the day it was first written. A scratch dir's
    // mtime is LAUNCH time — it is written once and never touched again — so a
    // shorter gate deletes the bundle out from under a session that is merely
    // long-lived. That is not free: claude spawns node children (hooks, MCP
    // servers, tool subprocesses) which inherit NODE_EXTRA_CA_CERTS and re-read
    // it. Measured with the path deleted: `Warning: Ignoring extra certs ...
    // No such file or directory`, extras loaded 0. The already-running process
    // is fine; every child it starts is not. Seven days still collects.
    //
    // The prefix is SCRATCH_PREFIX and nothing shorter. `cache-fix-ca-` also
    // matches an operator CA dir — README documents `CACHE_FIX_CA_DIR=/tmp/
    // cache-fix-ca`, and any suffixed variant (`-prod`, `-work`) is caught by
    // that glob. Measured with the previous prefix: a dir holding ca.key,
    // ca.pem, leaf.key and leaf.pem was removed entirely, taking the private
    // key the running proxy signs with. `mkdtempSync` guarantees OUR dir is
    // unique; it guarantees nothing about what else shares a prefix, so the two
    // sites read one constant rather than two matching string literals.
    try {
      const scratchAgeMs = 7 * 86_400_000;
      for (const f of readdirSync(tmpdir())) {
        if (!f.startsWith(SCRATCH_PREFIX)) continue;
        const p = join(tmpdir(), f);
        try { if (Date.now() - statSync(p).mtimeMs > scratchAgeMs) rmSync(p, { recursive: true }); }
        // Someone else's, already gone, or REFUSED (dir mode 0500, measured).
        // A survivor is litter under tmpdir() that nothing reads — unlike a
        // refused delete that leaves a live state armed, which would need code.
        catch { /* see above */ }
      }
    } catch { /* unreadable tmpdir: not worth failing a launch over */ }
    // A read-only or absent TMPDIR must not take the session down. Every path
    // in here is a fallback path already; throwing from one turns "the merged
    // bundle is broken" into "the launcher does not start", and because this
    // runs at top level the throw would also skip cleanup() and orphan the
    // proxy we forked above.
    let verdict;
    try {
      verdict = bundleUsable(caTrustBundle, probeLeaf);
      // BOTH questions, not just the handshake. `verdict.ok` means node verified
      // our leaf with this file — a NODE answer, and the consumer is Bun's
      // BoringSSL. They disagree on exactly one shape: our CA followed by a
      // fatal block. node stops at the damage and keeps what it read, so the
      // handshake succeeds; the client discards the whole file, and a discarded
      // file also takes down CAs supplied through `SSL_CERT_FILE` or
      // `SSL_CERT_DIR` (measured, two independent sources). Handing that over is
      // worse than handing over our own CA alone.
      //
      // `!== false` so a probe that could not answer keeps the merge: this is
      // the branch where the handshake SUCCEEDED, so there is positive evidence
      // for the file and none against it. The gate below is reached after a
      // refusal and takes the opposite default for that reason.
      // No second spawn here. `verdict.ok` means node verified a leaf OUR CA
      // signed, so node necessarily loaded our CA — the census's Y/N half is
      // already implied on this branch, and only its "would the client discard
      // the file" half added anything. That half now rides on the handshake's
      // own stderr (`verdict.discarded`), measured from the same child: the
      // split shape returns `CATRUST-OK 1` on stdout AND the warning on stderr.
      // One spawn instead of two on every healthy launch.
      if (verdict.ok && !verdict.discarded) {
        caForClaude = caTrustBundle;
      } else {
        // Refused, or unjudgeable. Both rebuild rather than hand the merge
        // over: a bundle node loads nothing from makes claude distrust the very
        // proxy it is routed through, and `unknown` cannot rule that out.
        //
        // They differ in what the rebuild KEEPS, and that is what makes routing
        // them together safe. salvage drops a publisher ONLY on a real refusal,
        // so when the probe is broken for everything (no leaf to serve, no
        // interpreter), every file is kept and the rebuild reproduces what the
        // merge carried. Measured, two publishers + our CA, leaf key removed:
        // verdict `unknown`, salvage returns a rebuild node loads 2 CAs from,
        // where narrowing to our own CA gives 1.
        //
        // Under a real refusal the same code drops exactly the broken file, and
        // the saving is one certificate per surviving publisher. This host holds
        // ours plus one peer, so it is 2 vs 1 here; measured on a
        // three-publisher host it was 3 vs 1. One branch, because the keep rule
        // already encodes the distinction.
        //
        // Both halves are load-bearing and BOTH have been wrong here before:
        // the keep rule named the accepted values and silently dropped a fourth
        // one, and the rebuild's own re-check discarded on `!ok` when `unknown`
        // is also not-ok. Either alone turns this branch into "narrow to our CA
        // whenever we could not ask" — the failure the branch exists to avoid.
        const salvaged = salvageBundle(caTrustDir, ourCa, probeLeaf, writeTmp);
        // Salvage null does not mean our own CA. It means nothing was REBUILT,
        // and the merge on disk may still be perfectly good — this branch is
        // reached on `unknown` as well as on a refusal, and `unknown` is mostly
        // "the probe could not run", not "the bundle is broken".
        //
        // Three answers have been shipped here and the first two were both
        // wrong in one direction each:
        //   - "keep it if node loads ANYTHING from it" — a STALE merge (built
        //     before we published, the normal state right after an upgrade)
        //     loads a corporate cert and carries none of ours, so it passed and
        //     the session failed TLS against the proxy it was routed through.
        //   - "narrow to our CA whenever we could not judge" — honest, and it
        //     costs a healthy merge every OTHER publisher on the box. Measured:
        //     2 CAs on disk, 1 handed over, and the ambient corporate root the
        //     builder merged in is not in `ca-trust.d` for salvage to recover.
        //
        // "Loads something" and "loads OURS" are different questions, and only
        // the second one separates the two cases. It is answered by asking node
        // which certificates it loaded — no handshake, so it still answers in
        // exactly the conditions where the handshake cannot, which is what made
        // the previous two answers reach for a proxy for it.
        //
        // It cannot answer before v22.15 (`engines: >=18`), and there it
        // returns true: keep the merge. Same direction as every other unknown,
        // and the merge is what the builder published — narrowing on a runtime
        // that simply cannot be asked would drop every corporate root on it.
        // The probe answers `true` / `false` / `null`, and `null` is "could not
        // ask". This gate is reached only AFTER the merge was refused or could
        // not be judged, so an unmeasured answer must land on `caPem` — the one
        // file we have direct evidence for. What made that wrong before was the
        // PROBE returning `true` when it could not ask, not the test here: on
        // any runtime before v22.15 (most of `engines: >=18`) that was every
        // launch with a stale merge. Salvage's gate takes the opposite default,
        // and does need `=== false` to say so; this one only needs to not treat
        // a non-answer as a yes, which `null` being falsy already gives it.
        // A PROBE MAY VETO, NEVER APPROVE ALONE. This branch is reached because
        // the handshake said `not ok` OR could not answer, and the census was
        // letting it re-approve the very bundle the handshake had just refused.
        // Measured: a merge carrying our CA, probed against a host the leaf does
        // not cover — handshake `NOT OK`, census `true`, launcher handed over the
        // merge. The two ask different questions, so "our CA is loaded" is not
        // evidence that our proxy verifies.
        //
        // So the census only gets a say where the handshake ABSTAINED. On a
        // definitive refusal there is direct evidence against the file and the
        // fallback is the one thing proven to work.
        // THE MERGE FIRST WHEN NOTHING FAULTED IT. `salvaged ||` put the rebuild
        // ahead of everything, so on `unknown` a rebuild pre-empted a merge the
        // census had just confirmed carries our CA. The rebuild can only hold
        // what `ca-trust.d` supplies, and the ambient corporate roots are not
        // there (see the limit stated above the salvage call), so it is a strict
        // SUBSET whenever the merge carries one. Measured on this box's real
        // bundle: merge 132 CAs, rebuild 2 — 130 dropped with nothing refused.
        //
        // That is the rule that deleted the `dupes` counter, applied generally
        // instead of to one instance: narrowing on an answer we did not get is
        // R2 broken, and "could not ask" is not evidence against the file.
        //
        // Salvage still wins on a REFUSAL, which is the branch it was written
        // for — there the merge has evidence against it and the rebuild is the
        // best available. Not claimed: that either side dominates universally. A
        // merge built before a new peer published carries ours and misses that
        // peer, so a rebuild can hold something the merge lacks. Taking the
        // max of both would need its own measurement.
        caForClaude = (verdict.unknown && carriesOurCA(caTrustBundle, ourCa))
          ? caTrustBundle
          : (salvaged || caPem);
        // Three outcomes, so three messages. The old line said "using our own CA
        // only" for everything that was not a salvage, which would now report a
        // KEPT merge as a narrowing — the operator reads this to find out what
        // their session is trusting, and a wrong answer here is worse than none.
        process.stderr.write(
          // Every verdict that reaches this branch carries a `reason` — the four
          // are `local`, `null`, `discarded`, and a plain refusal. The bare
          // `{ok:true}` is the happy path and never arrives here. A `??`
          // fallback used to sit on this expression and was measured UNREACHED
          // (a write-marker on each side: the left fired, the right never did),
          // so it was dead code that read as a safety net. It was added for
          // `{ok:true, discarded:true}`, which does carry a reason.
          `cache-fix: ${caTrustBundle} ${verdict.unknown ? "could not be verified" : "is unusable"} ` +
            `(${verdict.reason}); ` +
            // Tested in the SAME order the value above is computed, and the
            // first arm READS that value rather than re-deriving it. Testing
            // `salvaged` first re-derives, and the two disagree on exactly the
            // branch the keep-the-merge arm added: salvage can succeed while
            // the merge is what gets handed over, so it reported a rebuild
            // about a file it kept.
            `${caForClaude === caTrustBundle ? "keeping it: node loads our CA from it"
              : salvaged ? "rebuilt from the publishers that work"
              : "using our own CA only"}\n`);
      }
    } catch (e) {
      caForClaude = caPem;
      process.stderr.write(`cache-fix: could not evaluate ${caTrustBundle} (${e.message}); using our own CA only\n`);
    }
  }
  if (caForClaude) claudeEnv.NODE_EXTRA_CA_CERTS = caForClaude;
  else delete claudeEnv.NODE_EXTRA_CA_CERTS;
  // MAKE NODE ACTUALLY USE THE PROXY WE JUST POINTED IT AT.
  //
  // node has no implicit proxy support: HTTPS_PROXY is inert unless this is set
  // (node 24+). Measured on the work Mac with a DEAD proxy, which is the only
  // way to tell "used it" from "ignored it" — a live one succeeds either way:
  //   HTTPS_PROXY=<dead>                     -> UNABLE_TO_GET_ISSUER_CERT
  //   no proxy variable at all               -> UNABLE_TO_GET_ISSUER_CERT
  // identical, so nothing read the variable. curl given the same dead proxy
  // fails to connect, because curl does honour it.
  //
  // WHAT THAT COST: the CLI's own auto-updater is node, so it dialled DIRECT,
  // landed on the corporate TLS interceptor, and failed — three times, then
  // wrote install_failed and pinned "✘ Auto-update failed" for the session's
  // life. And NODE_EXTRA_CA_CERTS could not save it: on node 26 the file is
  // loaded (getCACertificates("extra") = 168) but not used for verification —
  // the same bundle passed as `ca:[...]` verifies the same chain fine. So the
  // fix is not more trust, it is going through the proxy at all.
  //
  // With it: the same updater URL returns 200 body "2.1.223" through our port.
  claudeEnv.NODE_USE_ENV_PROXY = "1";
  // Exclude localhost from the proxy. Without this, HTTPS_PROXY routes EVERY
  // connection claude makes — including to local services like HTTP/SSE-transport
  // MCP servers (e.g. an MCP on 127.0.0.1) — at the cache-fix proxy, which only
  // knows how to serve api.anthropic.com and 404s the rest. stdio-transport MCPs
  // are unaffected (they're pipes, no network), which is why only network-transport
  // local services break. Merge into any existing NO_PROXY rather than clobber it
  // (a corporate env may already set one). Set both cases to cover libs that read
  // either variable.
  const NO_PROXY_LOCAL = "127.0.0.1,localhost,::1";
  const mergeNoProxy = (existing) => {
    const parts = (existing || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const h of NO_PROXY_LOCAL.split(",")) if (!parts.includes(h)) parts.push(h);
    return parts.join(",");
  };
  const merged = mergeNoProxy(claudeEnv.NO_PROXY || claudeEnv.no_proxy);
  claudeEnv.NO_PROXY = merged;
  claudeEnv.no_proxy = merged;
} else {
  claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${actualPort}`,
  };
}

const spawnOpts = { stdio: ["inherit", "pipe", "pipe"], env: claudeEnv };
if (process.env.CACHE_FIX_CLAUDE_CMD) {
  const parts = process.env.CACHE_FIX_CLAUDE_CMD.split(" ");
  claudeProc = spawn(parts[0], [...parts.slice(1), ...claudeArgs], spawnOpts);
} else {
  claudeProc = spawn("claude", claudeArgs, spawnOpts);
}

claudeProc.stdout.on("data", (chunk) => process.stdout.write(chunk));
claudeProc.stderr.on("data", (chunk) => process.stderr.write(chunk));

claudeProc.on("error", (err) => {
  if (err.code === "ENOENT") {
    process.stderr.write("Error: 'claude' command not found. Is Claude Code installed?\n");
  } else {
    process.stderr.write(`Failed to start claude: ${err.message}\n`);
  }
  cleanup();
  process.exit(1);
});

claudeProc.on("close", (code) => {
  const exitCode = code ?? 0;
  cleanup();
  process.exit(exitCode);
});

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
