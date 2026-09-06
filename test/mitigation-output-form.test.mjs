// mitigation-output-form — the OUTPUT-side companion to `mitigated`.
//
// `findMitigationGaps`'s `mitigated` field is an INPUT-side fact: it trusts
// insertion-normalization's own self-report that it re-serialised CC's
// splice into an append, and prices the miss from CC's own input divergence
// index. It has no opinion on where the result actually landed once
// forwarded. Measured 2026-07-29 (capture s-4b6a435234bf, pair n=26->28):
// `mitigated: true`, `rebilledBytes: 0` — while the forwarded array kept a
// byte-stable prefix through index 30 and then SPLICED a standalone system
// message in at index 31, re-billing everything from there (outcome record:
// cacheRead 15424 / cacheCreation 124025). `mitigated` alone cannot see
// this; `outputForm`/`outputPreserved`/`rebilledOutBytes` can, because they
// compare `outHash`/`outBytes` — what we actually forwarded — instead of
// `inHash`/`inBytes` — what CC sent.
//
// Full evidence trail: the fidelity probe report, `fidelity-probe-report.md`,
// in the authoring session's scratchpad. Its absolute path is not repeated
// here — it carried the live session UUID, and this repo is public (same
// class as the REAL_CAPTURE default below, BACKLOG.md g2).
//
// Since this file was written, two further fixes landed on the SAME pair:
// insertion-normalization's pin-and-suppress (c5d870d) removed the 61 kB
// reminder splice at index 31, leaving a marker-sized residual at index 48
// (ttl-management relocating its cache_control breakpoint to the new
// tail); then outHashSem (tools/replay.mjs, BACKLOG's "census outputForm
// hashes must strip cache_control") stopped counting a cache_control-only
// relocation as a splice at all. n=26->28 now reads outputForm:"append" —
// the real-pair test below asserts the CURRENT state, not the original
// 2026-07-29 measurement quoted above, which is kept for the mechanism it
// documents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findMitigationGaps, readCapture } from "../tools/replay.mjs";
import { readPinnedFixture, sidToken } from "../tools/harvest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const EXT_DIR = join(REPO, "proxy", "extensions");
const EXT_CONFIG = join(REPO, "proxy", "extensions.json");

const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const sys = (t) => ({ role: "system", content: t });

// One capture entry as replay.mjs's own main() loop builds it, before
// compactEntry converts it (same shape used by test/replay-gate-selfcheck).
const entry = (n, inMsgs, outMsgs, extra = {}) => ({
  n,
  ts: `2026-07-28T00:00:${String(n).padStart(2, "0")}Z`,
  key: "k",
  inMsgs,
  outMsgs,
  action: null,
  resetReason: null,
  ...extra,
});

// --- (ii) fires-on-non-defect guard: a GENUINE tail append is not flagged ---
//
// Same input-side shape as the existing "normalized splice counts as
// absorbed" test in replay-gate-selfcheck (input splices SPLICED mid-array,
// action: "normalized"), but here the reconstruction actually does what
// `mitigated: true` claims: the forwarded array keeps prev's output as a
// strict prefix and appends the new content at the TAIL. This must NOT be
// flagged — a checker that fires on a correct append is broken the same way
// as one that misses a real splice.
test("mitigation output-form: a genuine tail-append reconstruction reports append/preserved/0", () => {
  const prevIn = [user("u0"), asst("a1"), user("u2")];
  const curIn = [user("u0"), asst("a1"), user("SPLICED"), user("u2")];
  // The extension correctly stabilises the shared prefix AND appends the
  // new content at the tail instead of splicing it mid-array.
  const prevOut = [user("u0"), asst("a1"), user("u2")];
  const curOut = [user("u0"), asst("a1"), user("u2"), user("SPLICED")];

  const rows = findMitigationGaps([
    entry(0, prevIn, prevOut, { action: "append-only" }),
    entry(1, curIn, curOut, { action: "normalized" }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "splice/insert-mid", "input-side classification is unchanged");
  assert.equal(rows[0].mitigated, true);
  assert.equal(rows[0].outputForm, "append");
  assert.equal(rows[0].outputPreserved, true);
  assert.equal(rows[0].rebilledOutBytes, 0);
});

// --- (i) the real defect: capture s-4b6a435234bf, pair n=26->28 ---
//
// Replays the ACTUAL extension pipeline over the ACTUAL capture, from the
// start of the file through request 28, under the same gate set the
// fidelity probe used (the boot record's gates, capture file line 1) — the
// same machinery tools/replay.mjs's main() drives (loadExtensions +
// runOnRequest, scratch CLAUDE_CONFIG_DIR), not a re-derivation of it.
// insertion-normalization is stateful (canonical persisted per conversation
// under CLAUDE_CONFIG_DIR), so every request from 0 must be replayed in
// order for n=28's reconstruction to match what actually shipped.
//
// The capture lives outside the repo, in the per-machine capture directory
// that rotates on a quadratic clock (docs/dev-loop.md, "Corpus hygiene") —
// it is not a committed fixture. If it has rotated away, this test falls
// back to a PINNED fixture (BACKLOG.md "READY — harvest --pin freezes
// evidence ranges as fixtures"): `node tools/harvest.mjs --pin <key> n..m`
// freezes the sanitized range as test/fixtures/harvested/pinned-<key>-n-m
// .json, committed and therefore immune to capture rotation. Only if BOTH
// the live capture and the pinned fixture are unavailable does the test
// SKIP with a stated reason, rather than reporting a false pass or a false
// fail (docs/dev-loop.md, "A checker has THREE answers").
//
// Both paths are overridable via env for the fallback's own red-green test
// (test/harvest-pin.test.mjs) — never by editing the real capture, which is
// read-only evidence shared with other work.
const PINNED_FIXTURE =
  process.env.CACHE_FIX_TEST_FIXTURE_OVERRIDE ??
  join(__dirname, "fixtures", "harvested", "pinned-s-4b6a435234bf-26-28.json");

// The capture is NAMED WITHOUT BEING NAMED (BACKLOG.md g2: "test
// REAL_CAPTURE defaults carry a live session UUID and an absolute /home
// path" — this repo is public, and a capture UUID plus a home path is a live
// identifier). The pinned fixture's header already carries `s-<sha12>` =
// sidToken(conversation key) for the capture it was frozen from, and every
// capture on disk is named `<key>-requests.jsonl`, so the right file is
// recoverable by hashing the candidates rather than by hardcoding one. The
// per-machine capture directory itself comes from homedir(), never a literal
// path. Nothing on disk that matches -> null -> the fixture fallback, then
// the designed skip.
function resolveRealCapture(fixturePath) {
  if (process.env.CACHE_FIX_TEST_CAPTURE_OVERRIDE) return process.env.CACHE_FIX_TEST_CAPTURE_OVERRIDE;
  let wanted;
  try {
    wanted = JSON.parse(readFileSync(fixturePath, "utf-8")).header?.key;
  } catch {
    return null;
  }
  if (!wanted) return null;
  const dir = join(homedir(), ".claude", "cache-fix-captures");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const SUFFIX = "-requests.jsonl";
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue;
    if (sidToken(name.slice(0, -SUFFIX.length)) === wanted) return join(dir, name);
  }
  return null;
}
const REAL_CAPTURE = resolveRealCapture(PINNED_FIXTURE);
const GATES = {
  CACHE_FIX_FORWARD_PROXY: "on",
  CACHE_FIX_SESSION_MIRROR: "on",
  CACHE_FIX_PREFIXDIFF: "1",
  CACHE_FIX_INSERTION_NORMALIZE: "1",
  CACHE_FIX_VOLATILE_PIN: "1",
  CACHE_FIX_TOOL_REWRITE: "1",
  CACHE_FIX_UPSTREAM_DETECTION: "1",
  CACHE_FIX_REQUEST_CAPTURE: "1",
  CACHE_FIX_CAPTURE_MAX_MB: "8192",
  CACHE_FIX_OUTPUT_GUARD: "1",
};
const TARGET_N = 28;

test(
  "mitigation output-form: real capture n=26->28 reports append/preserved once suppression and the cache_control strip both apply",
  async (t) => {
    // Fixture-fallback: capture present -> unchanged live-capture path;
    // capture absent -> pinned fixture if present; else skip. Both readers
    // yield the same [n, line] tuple shape, so the replay loop below is
    // identical either way.
    //
    // ORDINALS. The fixture is MINIMIZED (directive, "Fixture strategy"): it
    // holds capture ordinals replayFrom..m rather than 0..m, since the
    // dropped prefix only ever established pin state. Numbering the replayed
    // entries from `header.replayFrom` instead of from 0 is what keeps
    // "n=26->28" the same pair on both paths — the assertions below are
    // untouched by the cut. The live capture starts at 0 by definition.
    let source;
    let replayFrom = 0;
    if (REAL_CAPTURE && existsSync(REAL_CAPTURE)) {
      source = readCapture(REAL_CAPTURE);
    } else if (existsSync(PINNED_FIXTURE)) {
      source = readPinnedFixture(PINNED_FIXTURE);
      replayFrom = JSON.parse(readFileSync(PINNED_FIXTURE, "utf-8")).header?.replayFrom ?? 0;
    } else {
      t.skip(
        `capture rotated away (no capture on disk hashing to the fixture's key) and no pinned fixture at ${PINNED_FIXTURE} — COULD NOT VERIFY`,
      );
      return;
    }

    const scratch = await mkdtemp(join(tmpdir(), "mitigation-output-form-"));
    const saved = {};
    const overrides = { CLAUDE_CONFIG_DIR: scratch, ...GATES };
    for (const k of Object.keys(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = overrides[k];
    }

    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const { loadExtensions, runOnRequest } = await import(
        pathToFileURL(join(REPO, "proxy", "pipeline.mjs")).href
      );
      const extensions = await loadExtensions(EXT_DIR, EXT_CONFIG);

      const entries = [];
      let reqN = replayFrom - 1;
      for await (const [, line] of source) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "outcome" || rec.type === "boot") continue;
        const n = ++reqN;
        const body = structuredClone(rec.body);
        const headers = {
          "anthropic-beta": rec.headers?.["anthropic-beta"] ?? undefined,
          "x-session-id": rec.headers?.["session-id"] ?? rec.sid ?? undefined,
        };
        const ctx = { body, headers, meta: { route: "messages" } };
        await runOnRequest(ctx, extensions);
        entries.push(
          entry(
            n,
            Array.isArray(rec.body?.messages) ? rec.body.messages : [],
            Array.isArray(ctx.body?.messages) ? ctx.body.messages : [],
            {
              key: rec.key,
              ts: rec.ts,
              action: ctx.meta.insertionNormalizeStats?.action ?? null,
              resetReason: ctx.meta.insertionNormalizeStats?.resetReason ?? null,
            },
          ),
        );
        if (n === TARGET_N) break;
      }

      const rows = findMitigationGaps(entries);
      const row = rows.find((r) => r.n === 28 && r.prevN === 26);

      assert.ok(row, "expected a mitigation row for pair n=26->28");
      // Established facts from the fidelity probe (not re-derived here):
      // input-side self-report claims full mitigation.
      assert.equal(row.mitigated, true, "input-side self-report: normalized, 0 rebilled");
      assert.equal(row.rebilledBytes, 0);
      // Output-side reality with BOTH fixes active (c5d870d's suppression,
      // then the cache_control strip this test now asserts): suppression
      // removed the 61 kB reminder splice, leaving the forwarded arrays
      // byte-identical through index 47 and diverging at 48 — n=26's
      // message[48] carries ttl-management's cache_control marker (it was
      // the tail then), n=28's does not (the conversation grew past it).
      // The two messages differ ONLY in that key (direct diff, suppression
      // build report (c)4). A relocated cache_control marker is not
      // conversation content (outputContentHash's definitional comment,
      // tools/replay.mjs) — it is invisible to this content metric BY
      // DESIGN, so the pair now reads as a clean tail append with nothing
      // re-billed.
      assert.equal(row.outputForm, "append", "a relocated cache_control marker is not a splice");
      assert.equal(row.outputPreserved, true);
      assert.equal(row.rebilledOutBytes, 0);
    } finally {
      process.stderr.write = origStderr;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  },
);
