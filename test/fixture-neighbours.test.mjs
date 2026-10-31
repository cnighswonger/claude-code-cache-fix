// Two fixtures a NEIGHBOUR must not be able to turn red. node:test runs files
// concurrently, and each file listens on ephemeral ports of its own, so a number
// one case freed or an address one case opened is reachable by a stranger.
// The upstream case injects the stranger; the dead-hop case asserts where it lives.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEAD_HOP, byEnv, directFixture, orphanTargets, sweepTargets, upstreamFixture } from "./proc-helpers.mjs";

const epipeChild = fileURLToPath(new URL("./fixtures/stdio-epipe-child.mjs", import.meta.url));

// A dead hop a stranger can reach is no longer dead: the walk in proxy-hop-fallback
// finds a listener on the address meant as unreachable and "the same chain is
// still unreachable" fails (measured: a squatter listening there 3 s into the
// case). This case never binds the address, since a listener there is the hazard
// itself. It asserts what keeps strangers off it: the port is below every port a
// bind-to-0 can hand out.
it("the dead hop is a port no neighbour's listen(0) can be given", () => {
  const port = Number(new URL(DEAD_HOP).port);
  assert.ok(port > 0 && port < 1024, `${DEAD_HOP} is a port a neighbour's listen(0) can be handed`);
});

// The relayed-path case asks "did the request reach the upstream?" of a log the
// fixture writes. Counting every ACCEPT answered a different question: ten
// connections from elsewhere to its port read as ten dials by the proxy.
it("an upstream fixture records the request that carries its marker, not every connection", async () => {
  const trace = [];
  const up = upstreamFixture("mark-under-test", trace);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { port } = up.address();
  try {
    await Promise.all(Array.from({ length: 10 }, () => new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => s.end());
      s.on("close", r);
    })));
    assert.deepEqual(trace, [], "connections that sent no request were counted as the proxy's dial");

    // The control: the instrument still sees what it exists to see.
    await new Promise((r) => http.get({ port, host: "127.0.0.1", agent: false, path: "/v1/messages?mark-under-test" },
      (res) => { res.resume(); res.on("end", r); }));
    assert.deepEqual(trace, ["UPSTREAM"], "control: a request carrying the marker was not recorded");
  } finally {
    up.close();
  }
});

// The fail-open case asks "did the proxy dial the target?" of the fixture where a
// direct dial lands. Counting every ACCEPT answered a different question: another
// test file's client reusing that port number read as the proxy's dial (measured:
// ["DIRECT","DIRECT","DIRECT"] for an expected ["DIRECT"] in a full run under load).
// Only a connection whose first bytes are the marker the case's own client sends
// behind its CONNECT, which the proxy writes into the tunnel it dials, is the proxy's.
it("a direct-dial fixture records a connection that opens with its marker, not every connection", async () => {
  const trace = [];
  const direct = directFixture("mark-under-test", trace);
  await new Promise((r) => direct.listen(0, "127.0.0.1", r));
  const { port } = direct.address();
  const dial = (bytes) => new Promise((r) => {
    const s = net.connect(port, "127.0.0.1", () => s.end(bytes));
    s.on("error", () => {});
    s.on("close", r);
  });
  try {
    await Promise.all([...Array.from({ length: 10 }, () => dial()), dial("GET / HTTP/1.1\r\n\r\n")]);
    assert.deepEqual(trace, [], "connections that did not open with the marker were counted as the proxy's dial");

    // The control: a double dial by the proxy still shows as two.
    await Promise.all([dial("mark-under-test"), dial("mark-under-test")]);
    assert.deepEqual(trace, ["DIRECT", "DIRECT"], "control: connections that opened with the marker were not recorded");
  } finally {
    direct.close();
  }
});

// The EPIPE case chose its proxy's port BEFORE the child started: freePort() binds
// 0, reads the number and closes, so a neighbour can take it in between, and the
// proxy's self-heal swallows the EADDRINUSE and exits 0 with nothing printed
// ("child exited early, code=0"). The number a neighbour holds is handed to the
// child here, and it must still come up, on a port it took at bind.
it("the stdio-EPIPE child binds a port of its own, so a number a neighbour holds cannot stop it", async () => {
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const taken = squatter.address().port;
  const child = spawn(process.execPath, [epipeChild, String(taken)],
    { env: { ...process.env, STDIO_EPIPE_CHILD: "1" }, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const said = await new Promise((res, rej) => {
      child.stdout.once("data", (d) => res(String(d)));
      child.on("close", (c) => rej(new Error(`child exited before it listened, code=${c}`)));
    });
    const port = Number(/^listening (\d+)/.exec(said)?.[1]);
    assert.ok(port > 0 && port !== taken, `the child announced ${JSON.stringify(said)}, not a port of its own`);
  } finally {
    child.kill("SIGKILL");
    squatter.close();
  }
});

// `node --test` collects every .mjs under test/, the EPIPE child included, and runs
// it bare. Bare, its port argument was NaN, which the proxy's self-heal swallowed
// and the file "passed" by exiting; a child that binds a port of its own would
// listen on stdin for ever, which hangs the whole suite (measured: 24 minutes,
// then killed). Run bare, as the collector does, it must do nothing and exit.
it("the stdio-EPIPE child exits at once when node --test collects it as a test file", async () => {
  const child = spawn(process.execPath, [epipeChild], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    const exited = await Promise.race([once(child, "exit").then(() => true),
                                       new Promise((r) => setTimeout(r, 3_000, false))]);
    assert.ok(exited, "the bare fixture is still listening 3 s on: collected by node --test it never ends");
  } finally {
    child.kill("SIGKILL");
  }
});

// "answers 502 when the upstream refuses" needs an upstream that REFUSES. A
// freePort() number is unowned once returned, so a neighbour that takes it turns
// the refusal into a 200. The address is chosen inside the case, so this reads the
// case for the one hop a neighbour cannot be handed.
it("the refusing-upstream case dials the dead hop, not a number freePort() let go", () => {
  const src = readFileSync(new URL("./proxy-server.test.mjs", import.meta.url), "utf8");
  const body = /it\("answers 502 when the upstream refuses[\s\S]*?\} finally/.exec(src)?.[0];
  assert.ok(body, "the 502 case moved, so this no longer guards anything");
  assert.match(body, /CACHE_FIX_PROXY_UPSTREAM = DEAD_HOP;/,
    "the case's upstream is a number freePort() let go, which a neighbour can listen on");
});

// The hop-down handover case needs an address nobody listens on: a freePort()
// number is unowned once returned, so a neighbour that takes it makes "down" a hop
// that accepts and answers nothing.
it("the hop-down handover case dials the dead hop, not a number freePort() let go", () => {
  const src = readFileSync(new URL("./proxy-holder-handover.test.mjs", import.meta.url), "utf8");
  assert.match(src, /env\.CACHE_FIX_FALLBACK_PROXIES = DEAD_HOP;/,
    "the case's down hop is a number freePort() let go, which a neighbour can listen on");
});

// The forced-kill probe needs a port nobody listens on: a freePort() number is
// unowned once returned, so a neighbour that takes it before the probe runs turns
// the refusal it counts into whatever that neighbour answers.
it("the forced-kill probe case dials the dead hop, not a number freePort() let go", () => {
  const src = readFileSync(new URL("./proxy-held-port.test.mjs", import.meta.url), "utf8");
  const body = /it\("hands classify only strings[\s\S]*?\} finally/.exec(src)?.[0];
  assert.ok(body, "the forced-kill probe case moved, so this no longer guards anything");
  assert.match(body, /new URL\(DEAD_HOP\)\.port/,
    "the case's dead port is a number freePort() let go, which a neighbour can listen on");
  assert.doesNotMatch(body, /freePort\(\)/, "the case still allocates its dead port through freePort()");
});

// A file's after() sweep SIGHUPs whatever sweepTargets() names on the ports it
// registered, and a number it let go can later be a NEIGHBOUR's: that launcher
// listens there and matches OURS. Selected here and signalled by nobody: our own
// child, an orphan that carries this runner's lineage tag (the leaked successor
// the sweep exists for), and the two strangers, a neighbour's live launcher and a
// parentless process of nobody's lineage. ppid 1 alone cannot tell the second
// stranger from the orphan: init adopts both.
it("the sweeps select our own child and our orphan on a registered port, never a stranger's, and a case's only its own", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-sweep-"));
  mkdirSync(join(dir, "bin"));
  const holder = join(dir, "bin", "holder.mjs");
  writeFileSync(holder, `import net from "node:net";
const s = net.createServer(() => {});
s.listen(0, "127.0.0.1", () => process.stdout.write(s.address().port + " " + process.pid + "\\n"));
s.unref();
setTimeout(() => {}, 60_000);
`);
  const run = `${JSON.stringify(process.execPath)} ${JSON.stringify(holder)}`;
  const pids = [];
  const tagged = (tag) => ({ ...process.env, CACHE_FIX_TEST_LINEAGE: tag });
  const up = (cmd, args, env = process.env) => new Promise((res) => spawn(cmd, args, { env, stdio: ["ignore", "pipe", "ignore"] })
    .stdout.once("data", (d) => { const [port, pid] = String(d).split(" ").map(Number); pids.push(pid); res({ port, pid }); }));
  try {
    const mine = await up(process.execPath, [holder]);
    const stranger = await up("sh", ["-c", `${run}; true`], tagged(`sweep-${process.pid + 1}`));
    const orphan = await up("sh", ["-c", `${run} &`]);
    const foreign = await up("sh", ["-c", `${run} &`], tagged(undefined));
    // A sibling case's live tree: a tagged launcher (our child) over its proxy, and one level deeper.
    const nested = await up("sh", ["-c", `${run}; true`]);
    const deep = await up("sh", ["-c", `sh -c '${run}; true'; true`]);
    const got = new Set(sweepTargets([mine.port, stranger.port, orphan.port, foreign.port]).map(Number));
    assert.deepEqual(got, new Set([mine.pid, orphan.pid]),
      `selected ${[...got]}; own child ${mine.pid} and our orphan ${orphan.pid} belong to the sweep, ` +
      `neither the neighbour's ${stranger.pid} nor the untagged orphan ${foreign.pid} does`);
    // The per-case cleanup runs while sibling cases are live: a sibling's launcher is a
    // child of this runner that carries the tag, and its proxy sits under it. Only the
    // orphan, whose parent is outside this lineage, is taken.
    const per = orphanTargets([mine.port, orphan.port, nested.port, deep.port]).map(Number);
    assert.deepEqual(per, [orphan.pid],
      `per-case cleanup selected ${per}; live ${mine.pid}, ${nested.pid} and ${deep.pid} are a sibling case's launcher and its descendants`);
    // A CASE'S OWN SWEEP IS KEYED BY ITS CASE MARKER: every case of one file shares the
    // runner's lineage, so a sibling's launcher, live or detached, is inside it. Only
    // this case's own are taken, its orphan and its live child alike: not a sibling's live
    // child, not a sibling's detached successor (70 starts with 7), not another runner's
    // case 7, not our own child that carries no case marker.
    const cased = (n) => ({ ...process.env, CACHE_FIX_TEST_CASE: String(n) });
    const own = await up("sh", ["-c", `${run} &`], cased(7));
    const liveOwn = await up(process.execPath, [holder], cased(7));
    const sibling = await up(process.execPath, [holder], cased(8));
    const successor = await up("sh", ["-c", `${run} &`], cased(70));
    const other = await up("sh", ["-c", `${run} &`], { ...cased(7), CACHE_FIX_TEST_LINEAGE: `sweep-${process.pid + 1}` });
    const keyed = new Set(sweepTargets([own.port, liveOwn.port, sibling.port, successor.port, other.port, mine.port], 7).map(Number));
    assert.deepEqual(keyed, new Set([own.pid, liveOwn.pid]),
      `case 7 selected ${[...keyed]}; only its own orphan ${own.pid} and live child ${liveOwn.pid} belong to it, not the sibling's child ${sibling.pid}, ` +
      `its detached successor ${successor.pid}, another runner's case 7 ${other.pid}, or the unmarked ${mine.pid}`);
    // AND THE ENVIRON IS READ ONLY FOR THE PIDS ASKED ABOUT. Scanning every process
    // costs one ps per tagged OURS process on the box, and the tag is on all of this
    // runner's launchers: measured, that starved the cases running beside a sweep.
    assert.deepEqual(byEnv(/CACHE_FIX_TEST_LINEAGE=/, [String(mine.pid)]), [String(mine.pid)],
      "byEnv answered for pids it was not asked about, so every sweep pays for the whole box");
  } finally {
    for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { }
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every other signal site reads its targets from the same place, so the row above
// covers them only if they all go through sweepTargets(): a pid taken from onPort
// or listeners() in any test file signals a neighbour's live launcher once the OS
// recycles the number. Static, because each site selects inline. Every process.kill
// is walked back through the nearest earlier binding of each name it reads (a loop
// variable, a parent read with ps) and must not arrive at either call. Straight-line
// only: a name re-bound on a branch is followed through its last binding alone.
const fromPort = (src, expr, at) =>
  /\b(?:listeners|onPort)\(/.test(expr) ||
  [...expr.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)].some(([name]) => {
    const last = [...src.slice(0, at).matchAll(new RegExp(`\\b${name}(?: = | of )([^;{]*)`, "g"))].pop();
    return last !== undefined && fromPort(src, last[1], last.index);
  });

it("no test file takes signal targets straight from onPort or listeners(), only through sweepTargets", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const bad = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "fixture-neighbours.test.mjs")) {
    const src = readFileSync(join(dir, f), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const k of src.matchAll(/process\.kill\((?!\))([^,;]*)/g)) {
      const before = src.slice(0, k.index);
      if (fromPort(src, before.split(/[;{}]/).pop() + k[1], k.index)) bad.push(`${f}:${before.split("\n").length}`);
    }
  }
  assert.deepEqual(bad, [], `these signal a pid selected on a port without the lineage filter: ${bad}`);
});

// The helper protects only the per-case cleanups that select through it. proxy-server's
// takes orphans; proxy-held-port's cases run side by side in one runner, so each signals
// only what carries its own case tag (the file's after() sweeps every port it handed out).
it("the per-case cleanup sweeps select through orphanTargets, or through their case tag", () => {
  assert.ok(/const owners = orphanTargets\(/.test(readFileSync(new URL("./proxy-server.test.mjs", import.meta.url), "utf8")),
    "proxy-server: its per-case cleanup selects with sweepTargets(), which also signals our own live children");
  const src = readFileSync(new URL("./proxy-held-port.test.mjs", import.meta.url), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const bad = [...src.matchAll(/\b(?:sweepTargets|orphanTargets)\(([^)]*)\)/g)]
    .filter(([, args]) => args !== "usedPorts" && args !== "[port], caseId")
    .map((m) => `:${src.slice(0, m.index).split("\n").length}`);
  assert.deepEqual(bad, [], `proxy-held-port sweeps with no case tag, so they can signal a sibling case's launcher: ${bad}`);
});
