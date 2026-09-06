// insertion-suppression — pin-and-suppress (#76606, decision B; BACKLOG.md
// entry "Reminder-swap (#76606): DECIDED — pin-and-suppress", part (c)).
//
// The defect this closes: insertion-normalization's positional rebuild
// restores a pinned message's first-seen bytes (reminder included) AND
// forwards CC's migrated standalone duplicate of that same reminder as a
// new entry — measured directly on capture s-4b6a435234bf, pair n=26->28:
// message[30]'s <system-reminder>-wrapped block, absent from CC's own
// message[30] on the n=28 side, reappears wrapper-stripped as the entire
// content of CC's new message[31] (role system). The pin restores it
// inline at 30; the extension ALSO forwards the standalone copy at 31 —
// carrying the reminder twice and splicing the array, which moves the
// cache's longest-identical-prefix boundary to right before 31 and
// re-bills everything after it (outcome record: cacheRead 15424 /
// cacheCreation 124025).
//
// The fix: when a NEW entry is standalone (single block after the same
// string->one-block fold canonicalMessageShape already applies) and its
// wrapper-stripped bytes equal a block inside a message this extension is
// currently pinning, suppress it from the forwarded array — the pinned
// inline form already carries those bytes. A standalone message whose
// normalized bytes differ from every pinned block is untouched: existing
// rules (append/splice/edit-shaped reset) apply exactly as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyPinned,
  pinnedBlockHashes,
  findSuppressibleDuplicate,
} from "../proxy/extensions/insertion-normalization.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const EXT_DIR = join(REPO, "proxy", "extensions");
const EXT_CONFIG = join(REPO, "proxy", "extensions.json");

// --- Helpers (mirrors test/insertion-normalization.test.mjs's idiom) ---

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

const REMINDER_INNER = "PreToolUse:Edit hook additional context: file changed";
const REMINDER = `<system-reminder>\n${REMINDER_INNER}\n</system-reminder>`;

function withReminderMsg(text) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "text", text: REMINDER },
    ],
  };
}

function pinCanon(messages) {
  return classifyPinned(messages, null).canonicalEntries;
}

// =====================================================================
// (iii) Unit bites — the identity match itself (wrapper-stripped equality)
// =====================================================================

test("pinnedBlockHashes: a live pinned entry's volatile block is present, wrapper stripped", () => {
  const canon = pinCanon([withReminderMsg("tool result"), assistantMsg("a1")]);
  const hashes = pinnedBlockHashes(canon);
  assert.equal(hashes.size, 1);
});

test("pinnedBlockHashes: a DROPPED entry's block is excluded — its content is not being served anywhere", () => {
  // Build canonical with the reminder-bearing message, then a request that
  // prunes it (context-management removal) so it becomes a dropped entry.
  const canon1 = pinCanon([withReminderMsg("tool result"), assistantMsg("a1"), userMsg("u2"), assistantMsg("a3")]);
  const pruned = classifyPinned(
    [assistantMsg("a1"), userMsg("u2"), assistantMsg("a3"), userMsg("tail")],
    canon1,
  );
  assert.equal(pruned.dropped, 1);
  const hashes = pinnedBlockHashes(pruned.canonicalEntries);
  assert.equal(hashes.size, 0, "a dropped pin must not be treated as currently live");
});

test("findSuppressibleDuplicate: matches a standalone message whose UNWRAPPED bytes equal a pinned block — the wrapper difference is exactly what wrapper-normalization exists to absorb", () => {
  const canon = pinCanon([withReminderMsg("tool result"), assistantMsg("a1")]);
  const hashes = pinnedBlockHashes(canon);
  const standalone = { role: "system", content: [{ type: "text", text: REMINDER_INNER }] };
  const h = findSuppressibleDuplicate(standalone, hashes);
  assert.notEqual(h, null);
});

test("findSuppressibleDuplicate: returns null for a non-standalone (multi-block) message even when one block matches — the definition is STANDALONE only", () => {
  const canon = pinCanon([withReminderMsg("tool result"), assistantMsg("a1")]);
  const hashes = pinnedBlockHashes(canon);
  const inline = {
    role: "system",
    content: [{ type: "text", text: "other" }, { type: "text", text: REMINDER_INNER }],
  };
  assert.equal(findSuppressibleDuplicate(inline, hashes), null);
});

test("findSuppressibleDuplicate: returns null when the normalized bytes genuinely differ — never a fuzzy match", () => {
  const canon = pinCanon([withReminderMsg("tool result"), assistantMsg("a1")]);
  const hashes = pinnedBlockHashes(canon);
  const standalone = { role: "system", content: [{ type: "text", text: "an unrelated system note" }] };
  assert.equal(findSuppressibleDuplicate(standalone, hashes), null);
});

test("findSuppressibleDuplicate: still-wrapped standalone bytes match too (identity is on the UNWRAPPED form on both sides)", () => {
  const canon = pinCanon([withReminderMsg("tool result"), assistantMsg("a1")]);
  const hashes = pinnedBlockHashes(canon);
  const standaloneStillWrapped = { role: "system", content: [{ type: "text", text: REMINDER }] };
  assert.notEqual(findSuppressibleDuplicate(standaloneStillWrapped, hashes), null);
});

// =====================================================================
// (ii) classifyPinned — suppression behavior, and the genuine-change guard
// =====================================================================

test("classifyPinned: a standalone duplicate of a pinned block is suppressed; the pinned inline form still forwards", () => {
  const orig = [withReminderMsg("tool result"), assistantMsg("a1")];
  const canon = pinCanon(orig);

  // CC's next request: the reminder is gone from the tool_result message
  // and reappears, wrapper stripped, as a new standalone message.
  const strippedTail = { role: "user", content: [{ type: "text", text: "tool result" }] };
  const standaloneDuplicate = { role: "system", content: [{ type: "text", text: REMINDER_INNER }] };
  const next = [strippedTail, assistantMsg("a1"), standaloneDuplicate, userMsg("continue")];

  const result = classifyPinned(next, canon);
  assert.equal(result.action, "normalized");
  // Pinned inline form restored at position 0 — reminder included.
  assert.deepEqual(result.messages[0], orig[0]);
  // The standalone duplicate never appears in the forwarded array.
  assert.ok(
    !result.messages.some((m) => JSON.stringify(m) === JSON.stringify(standaloneDuplicate)),
    "the migrated duplicate must not be forwarded a second time",
  );
  assert.equal(result.messages.length, next.length - 1, "the array is one shorter — the duplicate, not a substitution");
  assert.equal(result.suppressed, 1);
  assert.equal(result.suppressions.length, 1);
  assert.equal(result.suppressions[0].index, 2, "the suppressed entry's index in the INCOMING array");
  // "continue" (tail growth after the duplicate) still forwards, at its
  // shifted position — suppression removes only the duplicate, nothing else.
  assert.deepEqual(result.messages[result.messages.length - 1], userMsg("continue"));
});

test("classifyPinned: suppression is stable across a THIRD request — CC keeps resending the duplicate, it keeps getting suppressed, with no persisted marker needed", () => {
  const orig = [withReminderMsg("tool result"), assistantMsg("a1")];
  let canon = pinCanon(orig);

  const strippedTail = { role: "user", content: [{ type: "text", text: "tool result" }] };
  const standaloneDuplicate = { role: "system", content: [{ type: "text", text: REMINDER_INNER }] };
  const r2 = [strippedTail, assistantMsg("a1"), standaloneDuplicate, userMsg("continue")];
  const res2 = classifyPinned(r2, canon);
  assert.equal(res2.suppressed, 1);
  canon = res2.canonicalEntries;

  // CC believes the duplicate is part of history now and keeps sending it,
  // plus new tail growth.
  const r3 = [strippedTail, assistantMsg("a1"), standaloneDuplicate, userMsg("continue"), assistantMsg("a2")];
  const res3 = classifyPinned(r3, canon);
  assert.equal(res3.suppressed, 1, "re-detected and re-suppressed on every later request that still carries it");
  assert.ok(!res3.messages.some((m) => JSON.stringify(m) === JSON.stringify(standaloneDuplicate)));
});

// Genuine change: the brief's own scenario for this is the EXISTING
// drop+co-located-splice "edit-shaped" reset (test/insertion-normalization
// .test.mjs already covers the discriminator itself) — the load-bearing
// property here is that a standalone message whose bytes genuinely differ
// from every pinned block does not get silently swallowed by the
// suppression path; the pre-existing reset rule still applies unchanged.
test("classifyPinned: a standalone message that does NOT match any pinned block still resets when the underlying change is edit-shaped — suppression does not mask a genuine edit (fires-on-non-defect guard)", () => {
  const orig = [withReminderMsg("tool result"), assistantMsg("a1"), userMsg("original"), assistantMsg("a3")];
  const canon = pinCanon(orig);
  // "original" is dropped; "REPLACEMENT" — standalone in SHAPE but
  // textually unrelated to the pinned reminder — lands in the gap it left.
  // Co-location makes this an edit (not an unrelated splice), and its
  // normalized bytes differ from every pinned block.
  const edited = [orig[0], assistantMsg("a1"), userMsg("REPLACEMENT"), assistantMsg("a3")];
  const result = classifyPinned(edited, canon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "edit-shaped");
  assert.equal(result.suppressed ?? 0, 0, "a genuine edit must not be swallowed as a suppression");
});

test("classifyPinned: a standalone message with unrelated content is simply forwarded — no suppression, no special-cased reset", () => {
  const orig = [withReminderMsg("tool result"), assistantMsg("a1")];
  const canon = pinCanon(orig);
  const differentStandalone = { role: "system", content: [{ type: "text", text: "an unrelated system note" }] };
  const next = [orig[0], assistantMsg("a1"), differentStandalone, userMsg("continue")];
  const result = classifyPinned(next, canon);
  assert.notEqual(result.action, "reset");
  assert.equal(result.suppressed, 0);
  assert.ok(result.messages.some((m) => JSON.stringify(m) === JSON.stringify(differentStandalone)));
});

test("classifyPinned: an assistant-role standalone entry is never suppressed, even if it coincidentally matches a pinned block's bytes", () => {
  const orig = [withReminderMsg("tool result"), assistantMsg("a1")];
  const canon = pinCanon(orig);
  // Constructed only to exercise the exclusion — an assistant message never
  // legitimately duplicates a hook reminder this way in practice.
  const assistantDuplicate = { role: "assistant", content: [{ type: "text", text: REMINDER_INNER }] };
  const next = [orig[0], assistantMsg("a1"), assistantDuplicate];
  const result = classifyPinned(next, canon);
  assert.equal(result.suppressed, 0);
  assert.ok(result.messages.some((m) => JSON.stringify(m) === JSON.stringify(assistantDuplicate)));
});

// =====================================================================
// (i) RED-GREEN on the real pair — capture s-4b6a435234bf, n=26->28
// =====================================================================
//
// Mirrors test/mitigation-output-form.test.mjs's real-capture harness
// exactly (same loadExtensions/runOnRequest machinery, same boot-record
// gate set, same scratch CLAUDE_CONFIG_DIR, replayed from the start of the
// file so insertion-normalization's per-conversation canonical state is
// genuine) — not a re-derivation of it. That file's own real-pair test
// asserts the PRE-fix values (outputForm==="edit@31") and is NOT in this
// change's write boundary; running it after this fix is expected to fail,
// and that is surfaced in the closing report rather than fixed here.
//
// Fixture-fallback (BACKLOG.md "READY — harvest --pin freezes evidence
// ranges as fixtures"): capture rotated away -> fall back to the pinned
// fixture at test/fixtures/harvested/pinned-s-4b6a435234bf-26-28.json (`node
// tools/harvest.mjs --pin <key> n..m`); both absent -> skip. Both paths are
// overridable via env for the fallback's own red-green test
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
// path. `sidToken` ships in the tools slice, so it is passed in by the test
// (which loads tools/harvest.mjs dynamically); no tools/ -> no capture
// resolution -> the fixture fallback, then the designed skip.
function resolveRealCapture(fixturePath, sidToken) {
  if (process.env.CACHE_FIX_TEST_CAPTURE_OVERRIDE) return process.env.CACHE_FIX_TEST_CAPTURE_OVERRIDE;
  if (!sidToken) return null;
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

test(
  "real capture n=26->28: pin-and-suppress turns the input-mitigated/output-spliced pair into a clean append, safety gate 0 violations",
  async (t) => {
    // Fixture-fallback: capture present -> unchanged live-capture path;
    // capture absent -> pinned fixture if present; else skip. Both readers
    // yield the same [n, line] tuple shape, so the replay loop below is
    // identical either way. The fixture reader ships in the tools slice
    // (like replayTools below), so it loads dynamically — a tree without
    // tools/ skips instead of failing at module load.
    //
    // ORDINALS. The fixture is MINIMIZED (directive, "Fixture strategy"): it
    // holds capture ordinals replayFrom..m rather than 0..m, since the
    // dropped prefix only ever established pin state. Numbering the replayed
    // entries from `header.replayFrom` instead of from 0 is what keeps
    // "n=26->28" (and the suppressed index 31) the same facts on both paths —
    // the assertions below are untouched by the cut. The live capture starts
    // at 0 by definition.
    let readPinnedFixture;
    let sidToken;
    try {
      ({ readPinnedFixture, sidToken } = await import("../tools/harvest.mjs"));
    } catch {
      readPinnedFixture = null;
      sidToken = null;
    }
    const REAL_CAPTURE = resolveRealCapture(PINNED_FIXTURE, sidToken);
    let source;
    let replayFrom = 0;
    if (REAL_CAPTURE && existsSync(REAL_CAPTURE)) {
      source = null; // resolved below, once readCapture is loaded from tools/replay.mjs
    } else if (existsSync(PINNED_FIXTURE) && readPinnedFixture) {
      source = readPinnedFixture(PINNED_FIXTURE);
      replayFrom = JSON.parse(readFileSync(PINNED_FIXTURE, "utf-8")).header?.replayFrom ?? 0;
    } else {
      t.skip(
        `capture rotated away (no capture on disk hashing to the fixture's key) and no pinned fixture at ${PINNED_FIXTURE} — COULD NOT VERIFY`,
      );
      return;
    }

    // The census/gate helpers ship in the tools slice; in a tree carrying
    // only the extension (upstream PR #272) this check rides #276 instead.
    let replayTools;
    try {
      replayTools = await import("../tools/replay.mjs");
    } catch {
      t.skip("tools/replay.mjs not in this tree — the real-pair check runs where the tools land");
      return;
    }
    const { findMitigationGaps, findSafetyViolations, safetyViolation, readCapture } = replayTools;
    if (source === null) source = readCapture(REAL_CAPTURE);

    const scratch = await mkdtemp(join(tmpdir(), "insertion-suppression-"));
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
              stats: ctx.meta.insertionNormalizeStats ?? null,
            },
          ),
        );
        if (n === TARGET_N) break;
      }

      const rows = findMitigationGaps(entries);
      const row = rows.find((r) => r.n === 28 && r.prevN === 26);
      assert.ok(row, "expected a mitigation row for pair n=26->28");

      // Input-side self-report is untouched by this change.
      assert.equal(row.mitigated, true);
      assert.equal(row.rebilledBytes, 0);
      // Output-side: PARTIALLY fixed, and the residual is independently
      // explained, not left as an unexplained gap. Before this change:
      // outputForm==="edit@31", ~61 kB rebilled (test/mitigation-output-form
      // .test.mjs's real-pair test, unmodified, pins that prior state).
      // After: the suppressed duplicate closes the divergence through index
      // 47 (bytes 31-47 identical to n=26's own output for the first time),
      // but a SECOND, unrelated divergence surfaces at 48 — ttl-management
      // (order 500, a different extension, not touched by this change)
      // relocates the ephemeral cache_control marker to the live tail on
      // every growing turn; n=26's tail (its last message) carried the
      // marker at 48, n=28's tail has grown past it, so the marker is
      // simply gone from that position — a real byte difference this
      // change was never going to close, verified by diffing the two
      // messages directly (identical apart from the `cache_control` key).
      // Residual bytes dropped from ~61 kB to ~5 kB (full-corpus census,
      // both runs pasted in the closing report) — this change's actual,
      // bounded contribution, not the BACKLOG entry's stated "outputForm
      // === append" criterion, which this pair cannot reach while
      // ttl-management's marker relocation exists. Surfaced as a gap.
      // The only remaining delta is ttl-management's cache_control marker
      // relocating off the old tail — since the outputForm metric strips
      // cache_control (903a2be: a moved marker is not a content splice),
      // the suppressed pair now reads fully preserved. A regression that
      // reintroduces CONTENT divergence flips this to a non-append form.
      assert.equal(row.outputForm, "append", "suppression + marker-blind metric: nothing but the marker moved");
      assert.equal(row.outputPreserved, true);
      assert.equal(row.rebilledOutBytes, 0);

      // The n=28 entry itself: exactly one suppression, at the index the
      // fidelity probe named (message[31] in the pre-fix pipeline).
      const e28 = entries.find((e) => e.n === 28);
      assert.equal(e28.stats?.suppressed, 1);
      assert.equal(e28.stats?.suppressions?.[0]?.index, 31);

      // Safety gate: the declared exemption in tools/replay.mjs's
      // safetyViolation must not count this suppression as a length
      // corruption. Checked directly (not just via the aggregate zero) so
      // a false negative elsewhere in findSafetyViolations can't hide a
      // problem here.
      assert.equal(safetyViolation(e28), null, "the exemption must fire on this exact suppression");
      const safety = findSafetyViolations(entries);
      assert.equal(safety.length, 0, "declared exemption applied across the whole replayed prefix");
    } finally {
      process.stderr.write = origStderr;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  },
);
