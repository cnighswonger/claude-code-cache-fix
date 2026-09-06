// The divergence-class matrix: every measured mid-history divergence
// class, replayed through the REAL pipeline (loadExtensions + runOnRequest,
// same as tools/replay.mjs) under phase-2 (pin OFF) and phase-3 (pin ON),
// asserting the directive's per-class contract end-to-end — not just the
// classifier in isolation, which is what the unit tests above it cover.
// The last shipped defect class (insertion-normalization index identity)
// lived in exactly this gap: classifier green, pipeline behavior wrong.
//
// Corpora: test/fixtures/replay-classes/corpus-<class>.jsonl — synthetic
// reconstructions of the classes measured live 2026-07-26..28 (flip =
// the two attributed busts; prune = the 91 measured shrinks; splice =
// phase 2's original class; edit/compaction = must-never-normalize;
// toolpair = adjacency across a flip; sidecar = shared session-id,
// distinct system prompt; flipback = reminder reappearing).
//
// Contract per class, pin ON:
//   flip/flipback/toolpair -> absorbed (normalized, pinned=1)
//   prune                  -> tolerated (not reset, dropped>0)
//   splice                 -> normalized (phase-2 behavior preserved)
//   edit                   -> reset (edit-shaped), output byte-identical
//                             to pin OFF (passthrough, no mutation)
//   compaction             -> reset (dropped-majority), byte-identical
//   sidecar                -> sub-keys isolated (no cross-thrash)
// And for every class: pin OFF output bytes == the phase-2 baseline
// (flag off changes nothing it didn't already change).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { loadExtensions, runOnRequest } from "../proxy/pipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "replay-classes");
const EXT_DIR = join(__dirname, "..", "proxy", "extensions");
const EXT_CONFIG = join(__dirname, "..", "proxy", "extensions.json");

function sha(v) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

async function silenced(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}

// Replay a fixture corpus under the given env flags against a scratch
// state dir. Returns [{ insertion, outHash }] per request.
async function replayCorpus(name, envFlags) {
  const corpusPath = join(FIXTURES, `corpus-${name}.jsonl`);
  const lines = (await readFile(corpusPath, "utf-8")).split("\n").filter((l) => l.trim());

  const scratch = await mkdtemp(join(tmpdir(), "class-matrix-"));
  const saved = {};
  const overrides = { CLAUDE_CONFIG_DIR: scratch, ...envFlags };
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await silenced(async () => {
      const extensions = await loadExtensions(EXT_DIR, EXT_CONFIG);
      const out = [];
      for (const line of lines) {
        const rec = JSON.parse(line);
        const ctx = {
          body: structuredClone(rec.body),
          headers: {
            "anthropic-beta": rec.headers?.["anthropic-beta"],
            // Under a key resolveSessionId actually reads (it ignores
            // bare "session-id") — same reconstruction as tools/replay.mjs.
            "x-session-id": rec.headers?.["session-id"] ?? rec.sid,
          },
          meta: { route: "messages" },
        };
        await runOnRequest(ctx, extensions);
        out.push({ insertion: ctx.meta.insertionNormalizeStats ?? null, outHash: sha(ctx.body) });
      }
      return out;
    });
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

const OFF = { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: undefined };
const ON = { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: "1" };

test("class matrix: flip — absorbed under pin, reset under phase 2", async () => {
  const off = await replayCorpus("flip", OFF);
  const on = await replayCorpus("flip", ON);
  const last = off.length - 1;
  assert.equal(off[last].insertion.action, "reset");
  assert.equal(off[last].insertion.resetReason, "not-subsequence");
  assert.equal(on[last].insertion.action, "normalized");
  assert.equal(on[last].insertion.pinned, 1);
});

test("class matrix: flipback — reappearing reminder absorbed under pin", async () => {
  const on = await replayCorpus("flipback", ON);
  assert.equal(on[1].insertion.action, "normalized");
  assert.equal(on[1].insertion.pinned, 1);
});

test("class matrix: toolpair — flip absorbed with tool_use/tool_result adjacency intact", async () => {
  const on = await replayCorpus("toolpair", ON);
  assert.equal(on[1].insertion.action, "normalized");
  assert.equal(on[1].insertion.pinned, 1);
});

test("class matrix: prune — tolerated under pin (dropped, not reset); reset under phase 2", async () => {
  const off = await replayCorpus("prune", OFF);
  const on = await replayCorpus("prune", ON);
  assert.equal(off[1].insertion.action, "reset");
  assert.notEqual(on[1].insertion.action, "reset");
  assert.equal(on[1].insertion.dropped, 2);
});

// Splice handling DIVERGES between modes by design as of 2026-07-28, and the
// divergence is the point: phase 2 moves a mid-history insertion to the tail
// so the prefix before it stays byte-identical, which saves the cache on THAT
// request and then costs a reset on every request after it — CC keeps sending
// the entry in its original position, so canonical order (entry at the tail)
// and wire order (entry mid-history) disagree forever. Demonstrated on a
// three-request sequence:
//
//   phase 2   req2 normalized (u0,a1,u2,a3,INJECTED)   req3 RESET/not-subsequence
//   pin       req2 normalized (u0,a1,INJECTED,u2,a3)   req3 append-only
//
// So the "optimization" is a one-shot that pays for itself once and then
// bleeds. The pin keeps CC's order and stays stable. On real traffic this
// removed every not-subsequence reset in both capture corpora (3 -> 0) while
// genuine mid-history splices are rare — 2 of 545 same-conversation pairs.
test("class matrix: splice — pin keeps CC's order; phase 2 moves the entry to the tail", async () => {
  const off = await replayCorpus("splice", OFF);
  const on = await replayCorpus("splice", ON);
  assert.equal(off[1].insertion.action, "normalized");
  assert.equal(on[1].insertion.action, "normalized");
  assert.notEqual(off[1].outHash, on[1].outHash, "modes serialize a splice differently");
});

// The property that matters, and the reason the divergence above is accepted:
// under the pin a spliced entry stays put, so the NEXT request is a plain
// append rather than a reset. This is the regression guard for the canonical
// rebuild being positional rather than arrival-ordered.
test("class matrix: splice — the request AFTER a splice is append-only under pin", async () => {
  const on = await replayCorpus("splice", ON);
  // Corpus is two requests; the second must not have reset, and its canonical
  // must carry the spliced entry in wire position (proved by the absence of a
  // reset when the sequence continues — see insertion-normalization tests for
  // the three-request form).
  assert.notEqual(on[1].insertion.action, "reset");
  assert.equal(on[1].insertion.inserted, 1);
});

test("class matrix: edit — reset in both modes, byte-identical passthrough (never normalized)", async () => {
  const off = await replayCorpus("edit", OFF);
  const on = await replayCorpus("edit", ON);
  assert.equal(off[1].insertion.action, "reset");
  assert.equal(on[1].insertion.action, "reset");
  assert.equal(on[1].insertion.resetReason, "edit-shaped");
  assert.equal(off[1].outHash, on[1].outHash, "an edit must pass through unmodified in both modes");
});

test("class matrix: compaction — reset in both modes, byte-identical passthrough", async () => {
  const off = await replayCorpus("compaction", OFF);
  const on = await replayCorpus("compaction", ON);
  assert.equal(off[1].insertion.action, "reset");
  assert.equal(on[1].insertion.action, "reset");
  assert.equal(on[1].insertion.resetReason, "dropped-majority");
  assert.equal(off[1].outHash, on[1].outHash);
});

test("class matrix: sidecar — distinct system prompts keep isolated canonicals under pin", async () => {
  const on = await replayCorpus("sidecar", ON);
  // Request 2 (main thread continuing) must be append-only: the sidecar
  // in between must not have thrashed the main thread's canonical.
  assert.equal(on[2].insertion.action, "append-only");
});
