// bin/shell-prefix.sh as Claude Code runs it: the command is the one argument,
// and the environment is shaped like the kind of child being started. The
// script reads only variables Claude Code sets per child kind, so each case
// builds exactly that environment and probes what the command can see. The one
// thing it reads besides those is the file cache-fix-proxy writes under the
// config dir: the proxy cache-fix itself forwards to.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { text } from "node:stream/consumers";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exitWithin } from "./child-deadline.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "shell-prefix.sh");
const tmp = mkdtempSync(join(tmpdir(), "shell-prefix-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const SIX = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY = "localhost,example.test";
const KEPT = { NO_PROXY, no_proxy: NO_PROXY };
// By default a cache-fix session whose proxy dials direct (empty sidecar): the six come out unset.
const env = (extra) => ({ PATH: process.env.PATH, HOME: tmp, ...KEPT, ...viaCcf(""), ...extra });
// What Claude Code sets: the Bash tool has CLAUDE_PID and no CLAUDE_PROJECT_DIR;
// a hook has both; a stdio MCP server has CLAUDE_PROJECT_DIR and no CLAUDE_PID,
// unless its Claude was itself started by another Claude's Bash tool.
const bashTool = (SHELL, extra) => env({ SHELL, CLAUDE_PID: "4242", ...extra });
const hook = (extra) => env({ SHELL: "/nonexistent/fish", CLAUDE_PROJECT_DIR: "/p", CLAUDE_PID: "4242", ...extra });
const mcp = (extra) => env({ SHELL: "/nonexistent/fish", CLAUDE_PROJECT_DIR: "/p", ...extra });

// What settings.json's env block gives Claude Code: the six name cache-fix. The proxy
// writes what it forwards to into upstream-<its port> under the config dir (an empty line
// when it forwards to nothing); `sidecar` is that file's content (undefined: no file).
const UP = "http://up.invalid:3128";
const PORT = 9801; // only names the file: nothing listens here
const PIN = "http://127.0.0.1:9802"; // a pin's loopback hop: cache-fix never writes a file for it
const sixOf = (url) => Object.fromEntries(SIX.map((v) => [v, url]));
const viaCcf = (sidecar, own = `http://127.0.0.1:${PORT}`) => {
  const cfg = mkdtempSync(join(tmp, "cfg-"));
  mkdirSync(join(cfg, "cache-fix-state"));
  if (sidecar !== undefined) writeFileSync(join(cfg, "cache-fix-state", `upstream-${PORT}`), sidecar);
  return { CLAUDE_CONFIG_DIR: cfg, ...sixOf(own) };
};

async function run(e, cmd, cwd, exe = SCRIPT) {
  const child = spawn(exe, [cmd], { env: e, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const [out, err] = [text(child.stdout), text(child.stderr)];
  const code = await exitWithin(child, 15_000, "shell-prefix.sh never exited");
  return { code, pid: child.pid, out: await out, err: await err };
}
const vars = (out) => Object.fromEntries(out.split("\n").flatMap((l) => {
  const m = /^([A-Za-z_]\w*)=(.*)$/.exec(l);
  return m ? [[m[1], m[2]]] : [];
}));
const proxies = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => /_proxy$/i.test(k)));
const which = (sh) => spawnSync("sh", ["-c", `command -v ${sh}`], { encoding: "utf8" }).stdout.trim();
const PROBE = 'env; echo "sh=${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}"';

const zsh = which("zsh");
for (const sh of ["zsh", "bash"]) {
  const path = which(sh);
  test(`Bash tool under ${sh}: six proxy variables unset, NO_PROXY kept, marker exported`,
    { skip: !path && `${sh} not installed` }, async () => {
      const v = vars((await run(bashTool(path), PROBE)).out);
      assert.equal(v.sh, sh);
      assert.deepEqual(proxies(v), KEPT);
      assert.equal(v.SHELL_PREFIX_CLAUDE_PID, "4242");
    });
}

test("Bash tool: a .zshenv that re-exports HTTPS_PROXY is overridden back to the upstream",
  { skip: !zsh && "zsh not installed" }, async () => {
    const z = mkdtempSync(join(tmp, "z-"));
    writeFileSync(join(z, ".zshenv"), "export HTTPS_PROXY=http://zenv.invalid ZENV_RAN=1\n");
    const v = vars((await run(bashTool(zsh, { ZDOTDIR: z, ...viaCcf(UP) }), PROBE)).out);
    assert.equal(v.ZENV_RAN, "1", "the .zshenv did not run, so this proves nothing");
    assert.deepEqual(proxies(v), { ...sixOf(UP), ...KEPT });
  });

const bash = which("bash");
test("Bash tool: a BASH_ENV file that re-exports HTTPS_PROXY is overridden back to the upstream",
  { skip: !bash && "bash not installed" }, async () => {
    const f = join(tmp, "bash-env");
    writeFileSync(f, "export HTTPS_PROXY=http://benv.invalid BENV_RAN=1\n");
    const v = vars((await run(bashTool(bash, { BASH_ENV: f, ...viaCcf(UP) }), PROBE)).out);
    assert.equal(v.BENV_RAN, "1", "the BASH_ENV file did not run, so this proves nothing");
    assert.deepEqual(proxies(v), { ...sixOf(UP), ...KEPT });
  });

for (const [name, extra] of [["top-level", {}], ["nested", { SHELL_PREFIX_CLAUDE_PID: "4141" }]]) {
  test(`hook (${name}): runs under /bin/sh, not $SHELL; six unset, NO_PROXY kept`, async () => {
    const r = await run(hook(extra), `${PROBE}; echo /no-such-dir/*.zz`);
    assert.equal(r.code, 0, r.err); // $SHELL is a missing fish, so using it would give 127
    assert.deepEqual(proxies(vars(r.out)), KEPT);
    assert.match(r.out, /^\/no-such-dir\/\*\.zz$/m); // sh leaves an unmatched glob literal, zsh aborts
  });
}

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const server = join(tmp, "server.mjs");
writeFileSync(server, "console.log(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, ppid: process.ppid, env: process.env }));\n");
for (const [name, extra] of [["top-level", {}], ["nested", { CLAUDE_PID: "4242", SHELL_PREFIX_CLAUDE_PID: "4242" }]]) {
  test(`stdio MCP (${name}): becomes the server, argv intact, six unset, NO_PROXY kept`, async () => {
    const args = ["a b", "it's", "$HOME;x"];
    const r = await run(mcp(extra), [process.execPath, server, ...args].map(q).join(" "));
    const s = JSON.parse(r.out);
    assert.deepEqual(s.argv, args);
    assert.equal(s.pid, r.pid, "a wrapper process is left in front of the server");
    assert.equal(s.ppid, process.pid);
    assert.deepEqual(proxies(s.env), KEPT);
  });
}

const prev = join(tmp, "prev");
writeFileSync(prev, '#!/bin/sh\necho "PREV-RAN argc=$# arg=$1"\nenv\n', { mode: 0o755 });
writeFileSync(join(tmp, "plain"), "#!/bin/sh\necho PREV-RAN\n", { mode: 0o644 });

test("CACHE_FIX_PREV_SHELL_PREFIX: an absolute executable gets the command as its only argument", async () => {
  const cmd = "echo 'a b'; exit 3";
  const r = await run(bashTool("/bin/sh", { CACHE_FIX_PREV_SHELL_PREFIX: prev }), cmd);
  assert.ok(r.out.includes(`PREV-RAN argc=1 arg=${cmd}\n`), r.out);
  const v = vars(r.out);
  assert.deepEqual(proxies(v), KEPT);
  assert.equal("CACHE_FIX_PREV_SHELL_PREFIX" in v, false, "the variable must be dropped so a chain cannot loop");
});

for (const [what, p] of [["a relative name", "prev"], ["a relative path", "./prev"],
  ["a missing file", join(tmp, "nope")], ["a non-executable", join(tmp, "plain")]]) {
  test(`CACHE_FIX_PREV_SHELL_PREFIX: ${what} is skipped and the command still runs`, async () => {
    const e = bashTool("/bin/sh", { CACHE_FIX_PREV_SHELL_PREFIX: p, PATH: `${tmp}:${process.env.PATH}` });
    assert.equal((await run(e, "echo ran", tmp)).out, "ran\n");
  });
}

for (const [kind, e, cmd] of [["Bash tool", bashTool("/bin/sh"), "exit 7"], ["hook", hook(), "exit 7"],
  ["stdio MCP", mcp(), "sh -c 'exit 7'"]]) {
  test(`${kind}: the command's exit code passes through`, async () => {
    assert.equal((await run(e, cmd)).code, 7);
  });
}

// The upstream is handed on through every kind of child, whatever its shell.
const kinds = [
  ["Bash tool under sh", (x) => bashTool("/bin/sh", x)],
  ["Bash tool under zsh", (x) => bashTool(zsh, x), !zsh],
  ["Bash tool under bash", (x) => bashTool(bash, x), !bash],
  ["hook", hook],
  ["chained prefix", (x) => bashTool("/bin/sh", { CACHE_FIX_PREV_SHELL_PREFIX: prev, ...x })],
  ["stdio MCP", mcp, false, [process.execPath, server].map(q).join(" "), (r) => JSON.parse(r.out).env],
];
const NASTY = "http://us'er:p$HOME\"x`id`;\\y*[a-z]?@up.invalid:3128";
for (const [kind, mk, absent, cmd = PROBE, parse = (r) => vars(r.out)] of kinds) {
  test(`${kind}: all six get the sidecar's upstream (quotes and $ intact), none cache-fix's own; unset on an empty one, untouched without a file`,
    { skip: absent && "not installed" }, async () => {
      const seen = async (extra) => proxies(parse(await run(mk(extra), cmd)));
      for (const url of [UP, NASTY]) assert.deepEqual(await seen(viaCcf(url)), { ...sixOf(url), ...KEPT }, url);
      for (const none of ["", "\n"]) assert.deepEqual(await seen(viaCcf(none)), KEPT, `sidecar ${JSON.stringify(none)}`);
      for (const extra of [viaCcf(UP, PIN), viaCcf(undefined)])
        assert.deepEqual(await seen(extra), { ...sixOf(extra.HTTPS_PROXY), ...KEPT }, `no file for ${extra.HTTPS_PROXY}`);
    });
}

test("the upstream is exported quoted, so no shell splits or globs it", () => {
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /^\s*export \w+=\$/m);
});

const seenViaSh = async (e) => proxies(vars((await run(bashTool("/bin/sh", e), PROBE)).out));
test("the sidecar is found by HTTPS_PROXY's port in every loopback form, and only then; any other value is left as it is", async () => {
  for (const own of [`http://localhost:${PORT}`, `http://[::1]:${PORT}`, `http://u:p@127.0.0.1:${PORT}/`])
    assert.deepEqual(await seenViaSh(viaCcf(UP, own)), { ...sixOf(UP), ...KEPT }, own);
  for (const own of [`http://pin.invalid:${PORT}`, "http://127.0.0.1", `http://127.0.0.1:${PORT}x`, "http://127.0.0.1:../../x"])
    assert.deepEqual(await seenViaSh(viaCcf(UP, own)), { ...sixOf(own), ...KEPT }, own);
});
test("a sidecar naming cache-fix's own port is not handed on; another loopback port is", async () => {
  for (const own of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}/`, `http://u:p@[::1]:${PORT}`])
    assert.deepEqual(await seenViaSh(viaCcf(own)), KEPT, own);
  const other = "http://127.0.0.1:3128";
  assert.deepEqual(await seenViaSh(viaCcf(other)), { ...sixOf(other), ...KEPT });
});
test("with HTTPS_PROXY unset or empty the port comes from https_proxy", async () => {
  for (const upper of ["", undefined])
    assert.deepEqual(await seenViaSh({ ...viaCcf(UP), HTTPS_PROXY: upper }), { ...sixOf(UP), ...KEPT }, `HTTPS_PROXY ${upper}`);
});

test("run under a pin's prefix that already pointed the six at its own hop, they stay on that hop", async () => {
  const pin = join(tmp, "pin-prefix");
  writeFileSync(pin, `#!/bin/sh\nexport ${SIX.map((v) => `${v}=${PIN}`).join(" ")}\nexec ${q(SCRIPT)} "$1"\n`, { mode: 0o755 });
  const r = await run(bashTool("/bin/sh", viaCcf(UP)), PROBE, undefined, pin);
  assert.deepEqual(proxies(vars(r.out)), { ...sixOf(PIN), ...KEPT });
});
