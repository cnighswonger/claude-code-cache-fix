// Fingerprint of the proxy's own source tree, computed once at startup and
// reported on /health as `proxy_tree`.
//
// Why this exists. Hot-reload is off, so the running process keeps whatever
// code it loaded at start; edit proxy/ without restarting and the repo checks
// pass while the traffic is served by something else. The dotfiles doctor
// asked that question by comparing the newest MTIME under proxy/ against the
// unit's start time, with a comment declaring the label to be the whole truth
// because "what the process holds in memory is not hashable".
//
// It is not the whole truth, and 2026-07-28 showed how: restoring a file from
// a backup after a bite test moved its mtime while leaving the bytes
// identical, and doctor reported "still running old code" about a proxy that
// was running exactly the code on disk. A checker that fires on a non-defect
// trains its reader to ignore it — the same fault, in the same repo, that the
// mtime comment was written to avoid.
//
// What the process holds is not hashable, but what it LOADED is: it can
// fingerprint its own source at startup and publish the result. Then doctor
// compares content to content, and mtime churn is silent by construction.
//
// The algorithm is deliberately dull, because a second implementation would
// have to match it: every regular file under the root except node_modules and
// dot-directories, relative POSIX paths sorted byte-wise, each contributing
// `path\n<sha256 of contents>\n` to one running hash. Nothing here depends on
// filesystem order, mtimes, or inode numbers.
//
// There is no second implementation: doctor shells out to this file rather
// than mirroring it in Python. Two implementations of one hash is exactly the
// kind of duplication that drifts silently and reports a mismatch nobody can
// explain.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules"]);

function collect(root, dir, out) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(root, full, out);
    } else if (e.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

// SYNC, and the async export below is a wrapper over it rather than a second
// walk. The launcher needs this answer on paths that cannot await — the deploy
// watcher's interval, the spawn site, and runningOurCode() inside holderPidOn()
// — and it was hashing `proxy/server.mjs` ALONE for want of a sync tree hash.
// That is the whole defect: a deploy touching any other file under proxy/ left
// server.mjs byte-identical, so the incoming launcher read "same bytes as mine"
// and declined the takeover. The upgrade was a no-op that exited 0.
//
// One algorithm, because the file's own rule at the top holds: two hashes of
// one tree drift silently and report a mismatch nobody can explain. Measured
// 6-9 ms over proxy/ (67 files, 856 KB), which is why sync is affordable here.
export function sourceFingerprintSync(root) {
  const files = collect(root, root, []).sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const bytes = readFileSync(join(root, rel));
    h.update(rel);
    h.update("\n");
    h.update(createHash("sha256").update(bytes).digest("hex"));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 12);
}

export async function sourceFingerprint(root) {
  return sourceFingerprintSync(root);
}

export const PROXY_ROOT = dirname(fileURLToPath(import.meta.url));

// `node proxy/source-fingerprint.mjs [root]` — the form doctor calls.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? PROXY_ROOT;
  sourceFingerprint(root).then(
    (fp) => process.stdout.write(fp + "\n"),
    (err) => {
      process.stderr.write(`source-fingerprint failed: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
