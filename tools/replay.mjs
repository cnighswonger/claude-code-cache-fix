#!/usr/bin/env node
// replay — run captured request bodies through the extension pipeline
// offline. Directive: docs/directives/proxy-request-capture-replay.md
// (stage 2).
//
// Usage:
//   node tools/replay.mjs <captures.jsonl> [--env FLAG=1 ...] [--json]
//
// Loads the extension pipeline exactly as server.mjs does (same loader,
// same extensions.json ordering), sets the given env flags, and feeds
// each captured body through runOnRequest in file order. State-writing
// extensions are pointed at a scratch CLAUDE_CONFIG_DIR so the live
// ~/.claude/cache-fix-snapshots is never touched.
//
// Per request it reports which extensions changed the body (measured by
// hashing the body between every pipeline stage — not by trusting
// telemetry) and the summary telemetry the pipeline itself emitted
// (insertion-normalization action and reset reason).
//
// Acceptance gate for a pipeline change (directive): replay the same
// corpus with the flag OFF and ON; the reports must differ only in the
// intended mutations.
//
// --- Cross-request byte stability (the self-inflicted-bust check) ---
//
// The per-request mutation report above answers "which extension changed
// THIS body". It cannot answer "did we forward the SAME bytes for the
// same message we already forwarded once" — and that second question is
// the one a cache bills. Three validators existed before this one and
// all three miss it: replay (post-pipeline, within ONE request),
// cache-sim (across requests, but PRE-pipeline — it never loads the
// pipeline at all), and output-guard (single-request invariants only).
// The empty cell is cross-request x post-pipeline.
//
// A bug that lived in exactly that cell shipped and billed real tokens:
// thinking-block-sanitize drops CC's omitted-thinking blocks from PRIOR
// assistant turns but preserves them on the LATEST turn when it is an
// active tool-continuation. So one byte-identical message is forwarded
// one way while it is the tail, another way once a turn lands after it
// — a mid-history mutation WE cause, every time such a turn ages out.
// Measured 2026-07-28 (session 58c979ce, 119k cc): CC's raw bytes at
// index 171 were identical across the pair; our output diverged there.
//
// The invariant, assumption-free (it needs no semantic identity of our
// own devising, which is what made the earlier probes unreliable):
//
//     if CC's own bytes for the message sequence first diverge at index
//     R, our forwarded bytes must not diverge before R.
//
// An output divergence EARLIER than the input divergence is ours by
// construction, and it is exactly what costs cache: the API keys on the
// longest byte-identical prefix, so moving the divergence point earlier
// re-writes everything from there. Attribution re-runs the pair one
// extension at a time and names the first stage that pulls the output
// divergence below R.
//
// Pairs are compared only within one key AND one conversation (same
// first message); co-tenant sidecar traffic sharing a session-id header
// is skipped rather than reported as churn (runbook's known artifact).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { readLines } from "./read-lines.mjs";
import { hashMessageContent } from "../proxy/extensions/message-hash.mjs";
import { isClearArtifact } from "../proxy/extensions/fresh-session-sort.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, "..", "proxy", "extensions");
const EXT_CONFIG = join(__dirname, "..", "proxy", "extensions.json");

function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

// First index at which two message arrays differ byte-wise, or null when
// one is a pure prefix of the other (the append-only case: nothing that
// was already sent changed).
export function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return null;
}

// Conversation identity. Co-tenant traffic (subagents, title-generation)
// shares the session-id header and therefore the capture key, but starts
// from a different first message. Comparing across those is the
// prefix-diff "sidecar churn" artifact, not a finding.
//
// Grouping on this — rather than only comparing ADJACENT capture lines —
// is load-bearing: live traffic interleaves tenants (main, subagent,
// sidecar), so two consecutive requests of the SAME conversation are
// usually several lines apart. An adjacent-only scan silently skips those
// pairs, which is exactly where the cache is won or lost. Measured while
// building this: adjacent-only found 0 violations on a full 602-request
// capture while a 40-request main-thread-only slice of the same session
// found 2 — the difference was entirely the interleaving, not the bytes.
// The identity itself is `conversationOf` below — the first message's byte
// hash, read off the compact entry rather than recomputed from the message.

// The check itself. Entries are grouped by (capture key, conversation) and
// compared pairwise in arrival order WITHIN each group. A violation is an
// output divergence strictly earlier than the input's — except a divergence
// with a matching telemetry-keyed exemption (see freshSessionSortExemption
// below), which is reported separately by findStabilityExemptions rather
// than silently dropped.
function scanAllGroups(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const violations = [];
  const exemptions = [];
  for (const group of groups.values()) {
    const scanned = scanGroup(group);
    violations.push(...scanned.violations);
    exemptions.push(...scanned.exemptions);
  }
  return {
    violations: violations.sort((a, b) => a.n - b.n),
    exemptions: exemptions.sort((a, b) => a.n - b.n),
  };
}

export function findStabilityViolations(entries) {
  return scanAllGroups(entries).violations;
}

// Exempted divergences, annotated with their basis — not silently dropped.
// See freshSessionSortExemption for the only exemption currently declared.
export function findStabilityExemptions(entries) {
  return scanAllGroups(entries).exemptions;
}

// Declared suppressions (insertion-normalization's pin-and-suppress,
// #76606 decision B) shrink the OUTPUT array by one entry, permanently,
// relative to CC's own raw array — every request from the first
// suppression on. `inHash`/`outHash` then no longer share a common index
// space: OUR array is one slot ahead of CC's from the suppressed index on,
// forever, so a plain positional compare reports a divergence exactly one
// index earlier than CC's own — every single turn — even though nothing
// extra was actually re-billed (the missing message is missing
// IDENTICALLY on both sides of the pair, so the shared prefix is exactly
// as long as it would be without the shift). Measured while adding this:
// UNADJUSTED, this pair's fix produced 67 new "violations" across a single
// conversation's remaining 60-odd turns, each showing the exact signature
// `outDiv === inDiv - 1` with CC identical at outDiv — a check firing on
// its own unadjusted index space, not a defect.
//
// Realign the reference: filter each entry's OWN suppressed indices out of
// its `inHash` before comparing, using the extension's own report
// (`stats.suppressions`) — never a re-derived guess — the same source
// safetyViolation's declared exemption already reads.
// Only the REMOVING suppressions shift the index space (see
// wireRemovedIndices): a join-move keeps its slot, filled with the re-served
// bytes, so filtering it here would over-correct by one and manufacture the
// very off-by-one signature this adjustment exists to remove.
function adjustedInHash(e) {
  const removed = wireRemovedIndices(e.stats);
  if (removed.size === 0) return e.inHash;
  return e.inHash.filter((_, i) => !removed.has(i));
}

// fresh-session-sort's relocate branch reports what it did
// (ctx.meta.freshSessionSortStats, compactEntry's freshSessionSortStats):
// a first-appearance relocation deliberately prepends content to the
// message at `targetIndex` that CC never had there before — exactly the
// shape this check flags, by design (module doc at the top of this file,
// the n=2024->2025 case named above). Exempt ONLY when:
//   1. the CURRENT entry (the one whose output changed) carries the
//      telemetry at all, and
//   2. its targetIndex equals the violation's outDiv (the change landed
//      exactly where the extension says it relocated to), and
//   3. at least one relocated block is reported as a first appearance.
// Never re-derived from outDiv/shape alone — mirrors suppressedIndices'
// "never a re-derived guess" discipline. A relocation reported WITHOUT
// telemetry (a stale build) or reported as a RECURRING (non-first-
// appearance) relocation both stay violations — the second guards against
// exempting a genuine repeat/thrash at the same index.
function freshSessionSortExemption(cur, outDiv) {
  const stats = cur.freshSessionSortStats;
  if (!stats || stats.targetIndex !== outDiv) return null;
  const hit = (stats.relocated ?? []).find((r) => r.firstAppearance);
  if (!hit) return null;
  return { type: hit.type, targetIndex: stats.targetIndex };
}

function scanGroup(entries) {
  const violations = [];
  const exemptions = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];

    // Per-message byte hashes, not the messages: firstDivergence compares
    // JSON.stringify of each element, and stringifying a hash of the bytes
    // yields the same first-difference index as stringifying the bytes.
    const prevInHash = adjustedInHash(prev);
    const curInHash = adjustedInHash(cur);
    const inDiv = firstDivergence(prevInHash, curInHash);
    const outDiv = firstDivergence(prev.outHash, cur.outHash);
    // Input append-only (inDiv === null) sets the bar at "output must be
    // append-only too": ANY output divergence is then self-inflicted.
    const bar = inDiv === null ? Infinity : inDiv;
    if (outDiv !== null && outDiv < bar) {
      // Was CC's OWN byte at the index we diverged on identical across the
      // pair? If yes the divergence is ours by construction — nothing
      // upstream changed there — and no probe is needed to establish it.
      //
      // Hand-derived three times on 2026-07-28 (rows 21 and 22, plus the
      // deferred-tool-rewrite pair), each time by writing a throwaway script
      // to print in[i] and out[i] for both requests. The throwaway probe is
      // the tell that a check is missing; both arrays are already in hand
      // here, so the answer costs one comparison.
      const ccSame = prevInHash[outDiv] === curInHash[outDiv];
      const record = {
        n: cur.n,
        prevN: prev.n,
        ts: cur.ts,
        key: cur.key,
        inDiv,
        outDiv,
        // true  => CC sent the same bytes there; the change is OURS.
        // false => CC also changed that message; ours may be amplification.
        ccIdenticalAtOutDiv: ccSame,
      };
      const exemption = freshSessionSortExemption(cur, outDiv);
      if (exemption) {
        exemptions.push({
          ...record,
          exemptReason: "fresh-session-sort:first-appearance-relocation",
          exemptBasis: exemption,
        });
      } else {
        violations.push(record);
      }
    }
  }
  return { violations, exemptions };
}

// --- Safety invariants (always on) ---
//
// The stability check answers "did we cost cache". These answer "did we
// corrupt the conversation" — a different and strictly worse failure. The
// proxy's licence is to change BYTES, never the message sequence the model
// sees: same count, same roles, same order, tool_results still answering the
// tool_use immediately before them.
//
// This existed only as a throwaway probe during the 2026-07-28 session: every
// fix that day was verified by an ad-hoc script checking roles and length
// across 771 requests, and nothing in the tool itself would have caught a
// silent corruption. output-guard enforces comparable invariants on the LIVE
// path; replay — where the experimenting actually happens — enforced none.
// A message the proxy DECLARES it injected. deferred-tool-rewrite announces a
// newly-loaded tool with a {"role":"system"} message carrying a tool_addition
// block — the documented mid-conversation-tool-changes contract, and the whole
// point of holding tools[] stable. Counting that as corruption made the gate
// report 243 violations on a corpus where nothing was corrupted; a check that
// forbids a designed behaviour trains its reader to ignore it.
//
// Narrow on purpose: ONLY a system message whose content is entirely
// tool_addition blocks. Anything else appearing in messages[] is still a
// violation.
function isDeclaredInjection(msg) {
  if (!msg || msg.role !== "system" || !Array.isArray(msg.content) || !msg.content.length) return false;
  return msg.content.every((b) => b && b.type === "tool_addition");
}

// Per-entry, so it is evaluated as each request is replayed and nothing is
// retained. Exported on its own because the streaming caller wants one
// verdict at a time and findSafetyViolations wants the whole list — one
// implementation, two shapes, rather than a tested one and a shipped one.
// Declared SUPPRESSIONS (insertion-normalization's pin-and-suppress,
// #76606 decision B) are the mirror case of a declared injection: a
// message CC sent that the extension deliberately never forwards, because
// the pinned inline form at another position already carries its bytes.
// Filtered from the INPUT side only — there is nothing on the output side
// to filter, by definition, since the whole point is that it never
// appears there. The incoming index comes from the extension's OWN report
// (`stats.suppressions`, set by insertion-normalization's onRequest),
// never a re-derived "looks like a duplicate" guess — mirroring
// isDeclaredInjection's shape-based declaration with a telemetry-based one
// because a removed message, unlike an added one, carries no shape of its
// own to detect after the fact.
function suppressedIndices(stats) {
  return new Set((stats?.suppressions ?? []).map((s) => s.index));
}

// Not every declared suppression REMOVES a message from the wire. A join-move
// suppression is a SUBSTITUTION: insertion-normalization forwards the
// re-served first-seen bytes in the merged message's own slot, so the array
// keeps its length and the index spaces stay aligned. Only the removing kind
// may be filtered out to realign them.
//
// The distinction is load-bearing in both directions, and getting it wrong is
// how the first build of the move failed: treating a substitution as a removal
// shortens the input by one against an output that never shrank, which reads
// as a role mismatch on every subsequent message.
function wireRemovedIndices(stats) {
  return new Set((stats?.suppressions ?? []).filter((s) => s.kind !== "join-move").map((s) => s.index));
}

export function safetyViolation(e) {
  // Declared injections are removed from BOTH sides before comparing. The
  // filter was output-side only until 2026-07-29, which was correct while
  // injections could only ever originate in our pipeline — but an input can
  // carry an injection-shaped message too (a chained proxy feeding this
  // pipeline its own output; the fable acceptance-probe capture is the live
  // case). One-sided, the filter stripped the echoed injection from out and
  // not from in, and the first census-enabled sweep failed a capture over a
  // message nobody dropped — a check firing on a non-defect, found by
  // rule-out-the-instrument within the hour.
  const removed = wireRemovedIndices(e.stats);
  const inM = e.inMsgs.filter((m, i) => !isDeclaredInjection(m) && !removed.has(i));
  const outM = e.outMsgs.filter((m) => !isDeclaredInjection(m));
  if (outM.length !== inM.length) {
    return { n: e.n, ts: e.ts, kind: "length", detail: `${inM.length} -> ${outM.length}` };
  }
  for (let i = 0; i < inM.length; i++) {
    if (inM[i]?.role !== outM[i]?.role) {
      return {
        n: e.n,
        ts: e.ts,
        kind: "role",
        detail: `idx ${i}: ${inM[i]?.role} -> ${outM[i]?.role}`,
      };
    }
  }
  const adj = firstAdjacencyBreak(outM);
  if (adj >= 0) return { n: e.n, ts: e.ts, kind: "tool-adjacency", detail: `idx ${adj}` };
  return null;
}

export function findSafetyViolations(entries) {
  const out = [];
  for (const e of entries) {
    const v = safetyViolation(e);
    if (v) out.push(v);
  }
  return out;
}

// A user message carrying tool_result blocks must be immediately preceded by
// the assistant message whose tool_use ids it answers. Mirrors the live
// extension's own invariant so replay fails the same way the proxy would.
function firstAdjacencyBreak(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const ids = msg.content
      .filter((b) => b && b.type === "tool_result" && typeof b.tool_use_id === "string")
      .map((b) => b.tool_use_id);
    if (!ids.length) continue;
    const prev = messages[i - 1];
    if (!prev || prev.role !== "assistant" || !Array.isArray(prev.content)) return i;
    const have = new Set(
      prev.content.filter((b) => b && b.type === "tool_use" && typeof b.id === "string").map((b) => b.id),
    );
    for (const id of ids) if (!have.has(id)) return i;
  }
  return -1;
}

// --- Sequence invariants (always on) ---
//
// Pairwise checks miss the class that costs the most: a mitigation that
// "works" on the request where it fires and then bleeds on every request
// after. Measured 2026-07-28 — phase-2 insertion-normalization converts a
// mid-history splice into a tail append, which saves the prefix on THAT
// request and then resets forever after, because CC keeps sending the entry
// in its original position. Two requests looked like a win; three showed the
// truth.
//
// The invariant: once a conversation has been normalized, later requests must
// settle into append-only. A normalization followed by a RESET in the same
// conversation means our reconstruction and CC's serialization disagree, and
// that disagreement recurs for the life of the session.
export function findSequenceViolations(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const out = [];
  for (const group of groups.values()) {
    let normalizedAt = null;
    for (let i = 0; i < group.length; i++) {
      const e = group[i];
      const act = e.action;
      if (act === "normalized") normalizedAt = e.n;
      else if (act === "reset" && normalizedAt !== null && e.resetReason !== "no-prior-canonical") {
        // A reset is only OUR failure if CC's own history was append-only
        // across the pair. When CC genuinely rewrote history, resetting is
        // the correct response and flagging it is a check firing on a
        // non-defect — which trains its reader to ignore the ones that
        // matter.
        //
        // Same bar the stability gate already uses: `inDiv === null` means CC
        // changed nothing that was already sent. Measured 2026-07-28 on
        // one capture, request 109: CC replaced message 196 in place
        // ("yes lest do it all!" -> "lets do it all 13.x shuodl be ..."), so
        // reset(edit-shaped) was right and the sequence flag was noise. The
        // real cost of that event — our bytes moving at 177 while CC's were
        // identical — is the STABILITY gate's job, and it caught it.
        const prev = group[i - 1];
        const ccRewrote = prev ? firstDivergence(prev.inHash, e.inHash) !== null : false;
        if (!ccRewrote) {
          out.push({ n: e.n, ts: e.ts, normalizedAt, reason: e.resetReason });
        }
        normalizedAt = null; // report once per normalize/reset cycle
      }
    }
  }
  return out;
}

// --- Census ---
//
// Classify what CC actually does to the message array between consecutive
// requests of one conversation, under SEMANTIC identity (decoration removed:
// volatile system-reminder blocks, cache_control, and the single-text-block
// <-> string shape flip). Everything that is not `append-only` is either a
// known threat-matrix row or an undiscovered class.
//
// This is the discovery instrument, and it earned its place: run over two
// real captures on 2026-07-28 it showed 94.5% of traffic is append-only once
// decoration is ignored — which shrank a planned "total reconciliation"
// rewrite down to one ordering fix — and it revealed that the shape-flip
// class lands predominantly on SYSTEM messages, catching a fix that had been
// written user-role-only and therefore fixed none of the real cases.
const VOLATILE_WRAP = /^<system-reminder>\n[\s\S]*\n<\/system-reminder>\s*$/;

function isVolatileTextBlock(b) {
  return (
    b &&
    typeof b === "object" &&
    b.type === "text" &&
    typeof b.text === "string" &&
    (b.text === "" || VOLATILE_WRAP.test(b.text))
  );
}

// Model-visible content, decoration stripped. Single-text-block arrays and
// bare strings collapse to one form so a re-serialization is not mistaken for
// a different message.
export function semanticCore(msg) {
  const c = msg?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  const kept = [];
  for (const b of c) {
    if (isVolatileTextBlock(b)) continue;
    if (b && typeof b === "object") {
      const { cache_control, ...rest } = b;
      kept.push(rest);
    } else kept.push(b);
  }
  if (kept.length === 1 && kept[0]?.type === "text") return [{ type: "text", text: kept[0].text }];
  return kept;
}

// Semantic identity WITH an occurrence ordinal, computed per array.
//
// Without the ordinal this collapsed repeats of the same message into one
// identity, and repeats are not rare: one measured history carried the
// recurring "The task tools haven't been used recently" reminder 44 times,
// byte-identical. Set- and index-based reasoning then treats 44 distinct
// entries as one, so a plain tail append can read as a mid-history splice.
//
// That is not a hypothetical either — it made findMitigationGaps report two
// `splice/insert-mid` misses on 2026-07-28 where the extension had correctly
// reported `append-only`. The extension was right and the census was wrong,
// because insertion-normalization's own `identityKey` is `hash|role|occurrence`
// and has carried the ordinal all along. This makes the two agree.
export function semanticIds(msgs) {
  const seen = new Map();
  return msgs.map((m) => {
    const base = `${m?.role ?? "?"}:${sha(JSON.stringify(semanticCore(m)))}`;
    const o = seen.get(base) ?? 0;
    seen.set(base, o + 1);
    return `${base}#${o}`;
  });
}

// --- Compact retention ---
//
// Streaming the READ was only half the problem. Every entry used to retain
// its full inMsgs and outMsgs, and since each request re-sends the whole
// history, that is the entire capture resident as objects: measured 3.2 GB
// peak on a 955 MB capture, which is within sight of V8's default old-space
// ceiling. The read no longer throws, but the wall had only moved.
//
// harvest.mjs already learned this and says so in its own comment ("retaining
// every parsed record turned a 555 MB capture into a 2.1 GB memory peak").
// The lesson did not travel to its sibling — the tools were fixed one at a
// time, by whichever one happened to fall over.
//
// Nothing downstream actually wants the messages. Stability compares BYTES
// (a per-message hash decides every divergence index identically), census
// compares SEMANTIC IDS, trace reads only telemetry, and safety is per-entry
// so it never needed retention at all. So each entry keeps three string
// arrays instead of two message arrays.
//
// The checkers still accept full-message entries: the gate self-check builds
// them that way, and those tests are the safety net this refactor rests on.
// `asCompact` converts on the fly when it sees one, so both callers share one
// code path rather than one being tested and the other shipped.
// tools[] renders BEFORE system and messages, so a change to it invalidates
// the whole prefix and no breakpoint can survive one. Three fingerprints,
// because the distinction between them IS threat-matrix row 6's question: a
// pure ADDITION (membership grows, existing order preserved) is what
// Anthropic's docs say should not disturb the cache, while a REORDER of
// entries already present is a different event the docs do not cover.
export function toolsFingerprints(tools) {
  if (!Array.isArray(tools)) return { sig: null, order: null, set: null, count: null, byName: null };
  const names = tools.map((t) => t?.name ?? "?");
  // Per-name hash, not the schema itself — same byte-conservation discipline
  // as compactEntry's inHash/outHash. This is what lets heldStable (below)
  // compare the SHARED-name subset of a pair without retaining either side's
  // full tool bodies.
  const byName = {};
  for (const t of tools) byName[t?.name ?? "?"] = sha(JSON.stringify(t));
  return {
    sig: sha(JSON.stringify(tools)), // full schemas — catches a description edit
    order: sha(JSON.stringify(names)), // names in wire order
    set: sha(JSON.stringify([...names].sort())), // membership, order-blind
    count: tools.length,
    byName,
  };
}

// Output-side identity for findMitigationGaps' outputForm/outputPreserved/
// rebilledOutBytes ONLY. `outHash` below (used by the STABILITY check,
// `scanGroup`) stays byte-raw and untouched — byte-stability is the wire
// truth, and weakening it would let a real re-billed byte hide behind this
// strip.
//
// DEFINITION: cache_control designates a cache breakpoint, not conversation
// content. A pair of forwarded messages that differ ONLY in whether/where a
// cache_control block is attached carries identical model-visible bytes;
// counting that as a splice prices a cost nothing actually incurred.
// Measured (flap-probe, capture s-4b6a435234bf-...): CC itself sends an
// identical 32,140-char text as a cache_control-bearing block while it is
// the tail, then as a bare string once it is not, in its own pre-pipeline
// bytes (n=678->681 and four siblings: 564->565, 354->356, 267->268,
// 566->568 — deferredToolRewriteStats inert on all five,
// findStabilityViolations 0 on the whole capture — CC's own shape choice,
// not ours). `compactEntry`'s `outHash` (below) hashes raw
// `JSON.stringify(message)` with no strip, unlike the input-side identity
// path (`semanticCore`, above) — the same input-side blind-spot class,
// unfixed on the output side until now.
//
// Strips cache_control via the shared primitive (`hashMessageContent`,
// imported) — never a second hand-rolled variant, per dev-loop.md's "never
// hand-roll identity in a probe" — promoting bare-string content to the
// same single-block array form `semanticCore` already uses for the
// identical reason (a bare string and a one-block text array are the same
// message under any of this file's identity notions). Deliberately NOT
// `semanticCore`: that also drops volatile system-reminder blocks, a
// broader normalization this question does not ask for — only the
// cache_control removal mirrors "the input side" here.
function outputContentHash(m) {
  const c = m?.content;
  const content = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
  return sha(JSON.stringify([m?.role ?? null, hashMessageContent({ content })]));
}

export function compactEntry(e) {
  const inMsgs = e.inMsgs ?? [];
  const outMsgs = e.outMsgs ?? [];
  return {
    n: e.n,
    ts: e.ts,
    key: e.key,
    inHash: inMsgs.map((m) => sha(JSON.stringify(m))),
    // Byte length per message. Numbers, not content — this is what lets a
    // missed mitigation be priced (everything from the divergence index on is
    // re-billed) without retaining a single message body.
    inBytes: inMsgs.map((m) => JSON.stringify(m).length),
    // Index of the last HUMAN-TYPED message, computed here because compact
    // entries carry no content. This is what turned row 4 from "mystery
    // swaps" into "reminder re-stamping at the anchor" (2026-07-29: 20 of 22
    // human-anchored mid-history edits within +/-2 of this index) — the
    // census could name WHAT and WHERE, but WHY needed the edit position
    // related to conversation STRUCTURE, and that relation was derived by a
    // throwaway script before it lived here.
    inLastHuman: inMsgs.reduce((acc, m, i) => (isHumanTurn(m) ? i : acc), -1),
    outHash: outMsgs.map((m) => sha(JSON.stringify(m))),
    // cache_control-stripped twin of outHash, for findMitigationGaps'
    // outputForm ONLY (see outputContentHash above) — never read by the
    // stability check.
    outHashSem: outMsgs.map(outputContentHash),
    // Byte length per FORWARDED message, the output-side twin of inBytes —
    // what lets rebilledOutBytes be priced without retaining a message body.
    outBytes: outMsgs.map((m) => JSON.stringify(m).length),
    inSem: semanticIds(inMsgs),
    inBlocks: inMsgs.map(blockUnits),
    msgs: inMsgs.length,
    inTools: toolsFingerprints(e.inTools),
    outTools: toolsFingerprints(e.outTools),
    action: e.action ?? null,
    resetReason: e.resetReason ?? null,
    stats: e.stats ?? null,
    // fresh-session-sort's own report of a relocation (telemetry-keyed
    // exemption for the stability check below) — never re-derived from
    // outHash shape, same discipline as `stats.suppressions`.
    freshSessionSortStats: e.freshSessionSortStats ?? null,
  };
}

// Threat-matrix row 6, asked of the corpus directly.
//
// The 175k event that opened the row carried TWO independent causes in one
// request — a tools reorder AND messages@165(user) — so it never established
// which invalidated the prefix. The row states what would settle it: a
// tools-only delta, i.e. tools changed while the message history did not.
//
// For every consecutive same-conversation pair this classifies the tools delta
// (none / addition-only / reorder / schema-edit / removal) against the message
// delta, and reports the pairs where tools moved and messages did not. It also
// records what WE forwarded, which is the other half — deferred-tool-rewrite
// exists to hold tools[] byte-stable across exactly these events, so an
// incoming change with an unchanged outgoing signature is the mitigation
// working, not a miss.
export function findToolsDeltas(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const rows = [];
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const p = group[i - 1];
      const c = group[i];
      if (p.inTools.sig === null || c.inTools.sig === null) continue;
      if (p.inTools.sig === c.inTools.sig) continue;
      // What KIND of tools change: membership vs order vs schema text.
      let kind;
      if (p.inTools.set !== c.inTools.set) {
        kind = c.inTools.count > p.inTools.count ? "membership+" : "membership-";
      } else if (p.inTools.order !== c.inTools.order) {
        kind = "reorder";
      } else {
        kind = "schema-edit";
      }
      const msgKind = censusIds(p.inSem, c.inSem);
      // forwardedStable is a whole-array claim: a genuine new tool announced
      // between p and c always moves the signature, so it reads "unstable"
      // even when everything CC already knew about round-tripped untouched.
      // heldStable narrows to what deferred-tool-rewrite actually guarantees
      // — the SHARED-name subset (present on both sides) stays byte-stable —
      // so a real addition is excluded from the comparison, not counted
      // against it (BACKLOG "forwardedStable was a census framing gap").
      let heldStable;
      if (p.outTools.byName === null || c.outTools.byName === null) {
        heldStable = false; // no forwarded-tools data — same "not proven stable" stance as forwardedStable's null guard
      } else {
        const sharedNames = Object.keys(p.outTools.byName)
          .filter((n) => Object.prototype.hasOwnProperty.call(c.outTools.byName, n))
          .sort();
        heldStable = sharedSig(p.outTools.byName, sharedNames) === sharedSig(c.outTools.byName, sharedNames);
      }
      rows.push({
        n: c.n,
        prevN: p.n,
        ts: c.ts,
        kind,
        msgKind,
        // The isolating case row 6 asks for: tools moved, history did not.
        toolsOnly: msgKind === "identical" || msgKind === "append-only",
        forwardedStable: p.outTools.sig !== null && p.outTools.sig === c.outTools.sig,
        heldStable,
        count: `${p.inTools.count}->${c.inTools.count}`,
        outCount: `${p.outTools.count}->${c.outTools.count}`,
      });
    }
  }
  return rows.sort((a, b) => a.n - b.n);
}

// heldStable's comparison, factored out: the byte signature of one side's
// tool bodies restricted to `names` (already the shared-name subset,
// pre-sorted by the caller so both sides hash in the same order).
const sharedSig = (byName, names) => sha(JSON.stringify(names.map((n) => byName[n])));

const asCompact = (e) => (e.inHash ? e : compactEntry(e));

// Conversation identity from the compact form: the first message's byte hash
// is exactly what conversationId hashed before.
// Exported: any tool comparing two requests of one conversation MUST use
// this identity rather than capture adjacency or index alignment. Both
// alternatives are silently wrong on interleaved traffic (see the note
// above), and a second tool restating the rule is how the two drift.
export const conversationOf = (e) => (e.inHash.length ? e.inHash[0] : null);

// The threat-matrix coverage note ("hidden duplicate request", CC#78420,
// v2.1.209+) was answered 2026-07-29 by a throwaway python scan over raw
// capture bytes ("adjacent byte-identical bodies: one instance total ...
// across 3,446 requests in seven captures") — exactly the shape dev-loop.md
// calls the tell that a classification is missing from the tools.
// Mechanized here per BACKLOG's "Duplicate-request probe -> census check
// (Q1)" so the same falsifier re-answers on every sweep instead of being
// re-derived by hand.
//
// DEFINITION: a duplicate is an ADJACENT same-conversation pair whose
// incoming message arrays are byte-identical — same length, same
// per-message hash at every index (inHash, the raw wire-byte hash
// compactEntry already computes — unstripped, unlike the semantic ids
// censusIds uses elsewhere, because "byte-identical" is the wire claim
// #78420 makes). A genuine conversation turn always changes SOMETHING in
// the sent history (a new message, an edited tail); an unchanged array
// crossing the wire twice is a resend, not a turn. An empty array pair
// (no content sent) is excluded — it is not evidence of anything resent.
export function findDuplicateRequests(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const rows = [];
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      if (prev.inHash.length === 0 || prev.inHash.length !== cur.inHash.length) continue;
      const identical = prev.inHash.every((h, idx) => h === cur.inHash[idx]);
      if (!identical) continue;
      rows.push({ n: cur.n, prevN: prev.n, ts: cur.ts, msgs: cur.inHash.length });
    }
  }
  return rows.sort((a, b) => a.n - b.n);
}

export function censusPair(a, b) {
  return censusIds(semanticIds(a), semanticIds(b));
}

// The classification itself, on semantic ids — what the compact entries carry.
export function censusIds(ia, ib) {
  let p = 0;
  while (p < Math.min(ia.length, ib.length) && ia[p] === ib[p]) p++;
  if (p === ia.length) return p === ib.length ? "identical" : "append-only";
  const setA = new Set(ia);
  const setB = new Set(ib);
  const missing = ia.filter((h) => !setB.has(h)).length;
  const added = ib.filter((h) => !setA.has(h)).length;
  if (missing === 0 && added === 0) return "reorder-only";
  if (missing === 0 && added > 0) {
    // Every prior entry survives and new ones appeared. Whether that is a
    // mid-history SPLICE or a plain append hinges on where the new entries
    // sit relative to the last surviving one — not on the divergence point
    // `p`, which only says where the arrays stop agreeing positionally.
    // (Comparing `p` against ia.length - 1 misfiled a splice one slot before
    // the tail as an append; caught by the gate self-check.)
    const lastKeptIn = ib.reduce((acc, h, j) => (setA.has(h) ? j : acc), -1);
    const splicedAfterKept = ib.some((h, j) => !setA.has(h) && j < lastKeptIn);
    return splicedAfterKept ? "splice/insert-mid" : "append-after-change";
  }
  if (missing > 0 && added === 0) return "drop-only";
  return "replace/edit";
}

// --- State trace ---
//
// The verdict-level report (action, resetReason) says WHAT happened; this says
// what the extension BELIEVED at the time. That distinction found the
// append-vs-position defect: every downstream signal looked explicable, and
// the giveaway was a canonical grown to 92 entries for an 84-message history —
// state drifting from the wire, one entry per mid-history splice.
//
// Rendered per conversation in arrival order, because a state model is only
// legible as a sequence. Pairwise views cannot show accumulation, and the
// bug that motivated this was invisible in every pairwise view we had.
export function buildTrace(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const out = [];
  for (const [g, group] of groups) {
    // One-request conversations have no state history worth showing.
    if (group.length < 2) continue;
    const rows = group.map((e) => {
      const st = e.stats ?? {};
      // Canonical live-entry count should track the message count. A widening
      // gap is the drift signal — flagged rather than left for the reader to
      // notice.
      const drift = st.canonLive != null && st.msgs != null ? st.canonLive - st.msgs : null;
      return {
        n: e.n,
        ts: e.ts,
        msgs: st.msgs ?? e.msgs,
        action: st.action ?? null,
        resetReason: st.resetReason ?? null,
        canonSize: st.canonSize ?? null,
        canonLive: st.canonLive ?? null,
        drift,
        inserted: st.inserted ?? 0,
        pinned: st.pinned ?? 0,
        dropped: st.dropped ?? 0,
      };
    });
    out.push({ group: g, rows });
  }
  return out;
}

// --- Mitigation gaps: did we actually HELP, not just "not make it worse"? ---
//
// The gates ask whether we made things WORSE — output diverging earlier than
// CC's input, a corrupted sequence, content lost off the wire. They are all
// silent on the opposite failure: CC did something this proxy exists to
// absorb, and the extension declined to act. A reset forwards CC's bytes
// faithfully, so it is invisible to every gate while costing the full rewrite.
//
// That blind spot cost a real answer on 2026-07-28. A 484k `messages_changed`
// bust (event 14) had all four gates green, and establishing that we had NOT
// mitigated it took hand-reading extension telemetry. Fifteen seconds before
// the bust, insertion-normalization had reset with `not-subsequence`.
//
// Both halves of the answer already existed and nothing joined them: the
// census classifies what CC did, and the extension records per request whether
// it normalized or reset. This is the join.
//
// MITIGABLE is deliberately narrow — only classes this proxy claims to absorb.
// A `replace/edit` is an honest history rewrite (threat-matrix row 4/22) and
// `drop-only` is a prune; counting either as a miss would inflate the number
// with events no mitigation should touch.
const MITIGABLE = new Set(["splice/insert-mid", "append-after-change", "reorder-only"]);

// `mitigated` above is an INPUT-side fact and nothing more: it trusts
// insertion-normalization's own self-report that it re-serialised CC's
// splice into an append, and prices the miss from CC's OWN divergence
// index (`prev.inHash` vs `cur.inHash`). It never looks at what we actually
// forwarded. That is a real, narrower claim than "the cache was preserved" —
// an extension can correctly stabilise the shared input prefix (earning
// `mitigated: true`, `rebilledBytes: 0`) and still choose to forward the
// new content by SPLICING it mid-array instead of appending it at the tail.
// The API keys its cache on the longest byte-identical PREFIX of the
// message array, so a mid-array splice moves that boundary earlier and
// re-bills everything after it — the exact cost `mitigated` claims was
// avoided. Measured: capture s-4b6a435234bf, pair n=26->28 — input-side
// `mitigated: true`, `rebilledBytes: 0`, while the forwarded array kept a
// byte-stable prefix through index 30 and then spliced a standalone system
// message in at index 31, re-billing everything from there (outcome record:
// cacheRead 15424 / cacheCreation 124025 — a splice/insert-mid signature on
// the WIRE, invisible to the input-only check).
//
// `outputForm` names that OUTPUT-side relation directly, reusing the same
// census primitive already used for input (`censusIds`/`firstDivergence`)
// against `outHash`/`outBytes` instead of `inHash`/`inBytes` — never a new
// notion of identity, per "never hand-roll identity in a probe":
//   "append"     — cur's forwarded array is a strict positional prefix
//                  extension of prev's (censusIds "identical" /
//                  "append-only"): nothing already sent moved position, so
//                  the cache's longest-identical-prefix boundary is
//                  unaffected. `outputPreserved` is exactly this case.
//   "splice@N"   — censusIds "splice/insert-mid" on the output arrays: every
//                  message we already forwarded still exists, but new
//                  content lands BEFORE the last surviving one, at index N —
//                  content shifted, cache broken from N on even though
//                  nothing was dropped. This is the class `mitigated: true`
//                  can hide, because insertion-normalization's own
//                  self-report is about the INPUT reconstruction, not about
//                  where the result got serialised in the output.
//   "edit@N"     — any other non-append output relation (reorder, drop,
//                  replace) with the output arrays first diverging at N,
//                  before the tail.
// `mitigated` keeps its existing input-side meaning unchanged; a pair can
// be `mitigated: true` and `outputPreserved: false` at once, and that
// combination — not `mitigated` alone — is what determines whether the
// cache was actually preserved.
export function findMitigationGaps(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const rows = [];
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const kind = censusIds(prev.inSem, cur.inSem);
      if (!MITIGABLE.has(kind)) continue;
      // "normalized" is the only action that re-serialises the splice into an
      // append. append-only and reset both forward CC's array as it came.
      const mitigated = cur.action === "normalized";
      // What a passthrough costs: the cache keys on the longest identical
      // prefix, so every message from CC's own divergence index onward is
      // re-billed.
      const inDiv = firstDivergence(prev.inHash, cur.inHash);
      const from = inDiv === null ? cur.inBytes.length : inDiv;
      const rebilled = cur.inBytes.slice(from).reduce((a, b) => a + b, 0);

      // Output-side classification — see the block comment above. Uses
      // outHashSem (cache_control stripped, see outputContentHash), not the
      // stability check's raw outHash — a cache_control-only relocation is
      // not a content splice (outputContentHash's definitional comment).
      const outKind = censusIds(prev.outHashSem, cur.outHashSem);
      const outDiv = firstDivergence(prev.outHashSem, cur.outHashSem);
      let outputForm;
      if (outKind === "identical" || outKind === "append-only") {
        outputForm = "append";
      } else if (outKind === "splice/insert-mid") {
        outputForm = `splice@${outDiv}`;
      } else {
        outputForm = `edit@${outDiv}`;
      }
      const outputPreserved = outputForm === "append";
      const outFrom = outDiv === null ? cur.outBytes.length : outDiv;
      const rebilledOutBytes = outputPreserved
        ? 0
        : cur.outBytes.slice(outFrom).reduce((a, b) => a + b, 0);

      rows.push({
        n: cur.n,
        prevN: prev.n,
        ts: cur.ts,
        kind,
        mitigated,
        action: cur.action,
        resetReason: cur.resetReason,
        rebilledBytes: mitigated ? 0 : rebilled,
        outputForm,
        outputPreserved,
        rebilledOutBytes,
      });
    }
  }
  return rows.sort((a, b) => b.rebilledBytes - a.rebilledBytes);
}

// Where does a `replace/edit` actually land — the TAIL, or mid-history?
//
// Threat-matrix row 4 was closed on 2026-07-28 as ACCEPTED-cheap because every
// measured instance mutated the LAST message: CC appends content blocks into
// the final user message on an interruption, and a cache keys on the longest
// identical prefix, so rewriting the final message re-bills that message
// alone. A MID-history edit is a different animal — everything after it is
// re-billed — and the row says in as many words to re-open if a non-tail
// instance is ever measured.
//
// That verdict rested on census numbers taken BEFORE semanticIds carried an
// occurrence ordinal, and the ordinal changed the replace/edit population
// (16 -> 20 on one session). So the question needs asking mechanically rather
// than re-derived by hand each time the corpus moves.
// Local-only content excerpt for a flagged edit position. The census is
// content-blind by design (hashes scale and are publishable) — which is why
// row 4 sat unexplained while the bytes that named the mechanism were one
// read away. When the far-from-anchor tripwire fires, the human output now
// DELIVERS the evidence instead of leaving its extraction to a throwaway
// script. Stdout of a local run only: this never enters the JSON output,
// the gate status file, or anything committed.
export function excerptMessage(msg, cap = 180) {
  if (!msg) return "(missing)";
  const c = msg.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .map((b) =>
        b?.type === "text" ? b.text : b?.type ? `[${b.type}]` : "[?]",
      )
      .join(" ");
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return `${msg.role ?? "?"}: ${flat.length > cap ? flat.slice(0, cap) + "…" : flat || "(no text)"}`;
}

// A message the human actually typed: user role carrying at least one text
// block that is neither a tool_result nor a tagged injection (reminders,
// notifications, caveats all start with "<"). Computed at compaction time
// because the census itself sees only hashes.
export function isHumanTurn(m) {
  if (m?.role !== "user") return false;
  const c = m.content;
  if (typeof c === "string") return !c.trimStart().startsWith("<");
  if (!Array.isArray(c)) return false;
  return c.some((b) => {
    if (b?.type !== "text" || typeof b.text !== "string") return false;
    const t = b.text.trimStart();
    return t.length > 0 && !t.startsWith("<");
  });
}

export function findEditPositions(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const rows = [];
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      if (censusIds(prev.inSem, cur.inSem) !== "replace/edit") continue;
      // First position where the two histories stop agreeing semantically.
      let at = 0;
      const lim = Math.min(prev.inSem.length, cur.inSem.length);
      while (at < lim && prev.inSem[at] === cur.inSem[at]) at++;
      const lastIdx = cur.inSem.length - 1;
      // Everything from the edit onward is re-billed.
      const rebilled = cur.inBytes.slice(at).reduce((a, b) => a + b, 0);
      rows.push({
        n: cur.n,
        prevN: prev.n,
        ts: cur.ts,
        at,
        lastIdx,
        tail: at >= lastIdx,
        rebilledBytes: rebilled,
        // Structural context (see compactEntry's inLastHuman note): where the
        // edit sits relative to the last human-typed message. anchorDelta 0
        // means the anchor message itself was re-stamped; small negative
        // values are the injected-block zone just before it; null means no
        // human turn exists (subagent/sidecar conversation).
        lastHumanAt: cur.inLastHuman >= 0 ? cur.inLastHuman : null,
        anchorDelta: cur.inLastHuman >= 0 ? at - cur.inLastHuman : null,
      });
    }
  }
  return rows.sort((a, b) => b.rebilledBytes - a.rebilledBytes);
}

// --- Block migration ---
//
// semanticIds/semanticCore reduce a message to a hash and, for a
// system-reminder-wrapped text block, drop it outright as decoration
// (isVolatileTextBlock) — correct for the ordinary case where a hook
// reminder is pure noise, and exactly what leaves census blind to the case
// where the same bytes are NOT noise: they leave one message's content array
// and reappear as a message of their own. That is the reminder-swap shape —
// measured directly in capture s-4b6a435234bf,
// n=26->28: message[30]'s 5th block, `<system-reminder>\nPreToolUse:Edit
// hook additional context...\n</system-reminder>`, is gone from message[30]
// on the n=28 side, and its inner text — wrapper stripped — is the entire
// content of the new message[31] (role system).
//
// DEFINITION: a block migration exists, for a same-conversation pair
// classified replace/edit or splice/insert-mid, when a content block present
// inside one message's content array on one side of the pair (PREV) is
// ABSENT from that message at the same position on the other side (CUR),
// while a message on CUR, within +/-3 indices of the block's index in PREV,
// carries that same block's bytes — either as the entirety of its content
// ("standalone") or as one block among several in its content array
// ("inline"). Identity of block bytes is the shared message-hash primitive's
// hashing (hashMessageContent, imported — never re-derived); a
// system-reminder wrapper is stripped before hashing on BOTH sides, because
// that is the one normalization already established in this file
// (semanticCore's VOLATILE_WRAP) for recognising the wrapper — undoing only
// the wrapper, not inventing a new comparison, is what keeps identity
// assumption-free. Direction is temporal, PREV(source) -> CUR(target):
// "inline->standalone" when the block sat among other blocks in PREV and
// stands alone in CUR; "standalone->inline" for the reverse. A block that is
// still present at the SAME position on the other side is not a migration —
// only its disappearance from that position is what makes the ±3 search
// meaningful.
//
// CANDIDACY (2026-07-30, measured on the real flap bytes — capture
// the flap capture, pair n=102->104, fixture flap-s-0dc8ac87c43d-86.json): the block
// must appear <system-reminder>-WRAPPED on whichever side it is INLINE.
// Without that condition the definition above over-reports, because both of
// its guards can be true of a block that never moved:
//
//   PREV[92] user [tool_result, text(<system-reminder> 720 chars)]
//   CUR [93] user [tool_result]        <- PREV[92] having SHED its reminder
//   CUR [94] system "…" (683 chars)    <- PREV[92]'s reminder, unwrapped
//
// Two messages were inserted above, so the host's own index moved and the
// same-position guard compares against an unrelated message; and `standalone`
// is `blocks.length === 1`, which a message that SHRANK to one block
// satisfies. So the tool_result was reported as migrating 92->93 when it had
// not left its message at all — the host had merely lost a neighbour and
// shifted. The census reported 6 migrations on this capture where 3 exist,
// and each phantom carried a `flap` tag, which is worse: a reader is being
// told two blocks oscillate when one does. The wrapper is what makes a block
// the decoration CC relocates, and it is the class this section names
// ("reminder-swap shape") — so requiring it narrows the check back to its
// own declared subject rather than adding a new rule.
const REMINDER_WRAP = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>\s*$/;

function unwrapReminder(block) {
  if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
    const m = REMINDER_WRAP.exec(block.text);
    if (m) return { type: "text", text: m[1] };
  }
  return block;
}

// One identity unit per content block in a message. String content promotes
// to a single text block first (the same shape fold semanticCore does for
// bare-string messages), then each block is hashed via hashMessageContent —
// the shared primitive, applied to a one-block wrapper so it still strips
// only cache_control, nothing more. `standalone` records whether this unit IS
// the message's entire content (length 1), which is the "consisting of" half
// of the definition above — note it says nothing about WHY the message has
// one block, which is exactly why `wrapped` is needed beside it: `wrapped`
// records whether this block carried the <system-reminder> wrapper before
// hashing, and it is the candidacy condition (see CANDIDACY above).
// `text` rides on the full form only, never on what compactEntry RETAINS:
// `inBlocks` keeps one of these per block of every request, and each request
// re-sends the whole history, so carrying the bytes there is the O(file)
// retention class this file has already paid for three times. The
// conservation gate below wants the text (a join is a concatenation, and
// hashes do not concatenate), and it runs per-request on live messages that
// become garbage at the end of the iteration — so it takes the full form and
// keeps nothing. One derivation, two projections, rather than a second notion
// of "the same block".
function blockUnitsFull(msg) {
  const c = msg?.content;
  let blocks;
  if (typeof c === "string") blocks = [{ type: "text", text: c }];
  else if (Array.isArray(c)) blocks = c;
  else return [];
  return blocks
    .map((b) => {
      const unwrapped = unwrapReminder(b);
      return {
        hash: hashMessageContent({ content: [unwrapped] }),
        wrapped: unwrapped !== b,
        standalone: blocks.length === 1,
        // The UNWRAPPED text, which is the unit a migration moves and a join
        // concatenates. null for any non-text block (tool_result, tool_use,
        // thinking, image) — those never participate in either shape.
        text: unwrapped && unwrapped.type === "text" && typeof unwrapped.text === "string" ? unwrapped.text : null,
      };
    })
    .filter((u) => u.hash !== null);
}

function blockUnits(msg) {
  return blockUnitsFull(msg).map(({ hash, wrapped, standalone }) => ({ hash, wrapped, standalone }));
}

const BLOCK_MIGRATION_KINDS = new Set(["replace/edit", "splice/insert-mid"]);
const BLOCK_MIGRATION_WINDOW = 3;

function scanBlockMigrations(prev, cur) {
  const found = [];
  for (let i = 0; i < prev.inBlocks.length; i++) {
    const units = prev.inBlocks[i];
    if (units.length < 1) continue;
    const inline = units.length >= 2;
    const standalone = units.length === 1;
    const samePos = new Set((i < cur.inBlocks.length ? cur.inBlocks[i] : []).map((d) => d.hash));
    for (const u of units) {
      if (samePos.has(u.hash)) continue; // still there at the same position: not a migration
      const lo = Math.max(0, i - BLOCK_MIGRATION_WINDOW);
      const hi = Math.min(cur.inBlocks.length - 1, i + BLOCK_MIGRATION_WINDOW);
      for (let j = lo; j <= hi; j++) {
        const dstUnits = cur.inBlocks[j];
        if (!dstUnits || !dstUnits.length) continue;
        // `hash` rides on the row because it is the only thing that says
        // WHICH block moved — the flap scan below needs that identity and
        // must not recompute one of its own (dev-loop: never hand-roll
        // identity in a probe; the unit hash here IS hashMessageContent's).
        // Candidacy, both directions: the block must be reminder-WRAPPED on
        // its INLINE side — as the source unit when it is leaving a
        // multi-block message, as the destination unit when it is joining
        // one. Anything else alone in a message is a message that shed
        // siblings, not a block that emerged.
        if (inline && u.wrapped && dstUnits.some((d) => d.hash === u.hash && d.standalone)) {
          found.push({ n: cur.n, prevN: prev.n, ts: cur.ts, direction: "inline->standalone", sourceIdx: i, targetIdx: j, hash: u.hash });
          break;
        }
        if (standalone && dstUnits.length >= 2 && dstUnits.some((d) => d.hash === u.hash && d.wrapped)) {
          found.push({ n: cur.n, prevN: prev.n, ts: cur.ts, direction: "standalone->inline", sourceIdx: i, targetIdx: j, hash: u.hash });
          break;
        }
      }
    }
  }
  return found;
}

// --- Flap: a block migration that REVERSES a recent one ---
//
// A single migration is a one-way move and the volatile pin can absorb it.
// An OSCILLATION cannot be absorbed by a pin that classifies only one of the
// two shapes: the block keeps leaving and returning, so it busts on every
// second flip at best. That is what the 2026-07-30 221k event was (threat
// matrix row 4, session 0d6f38ba, n=102->104->105->108 in 11 seconds), and
// it was visible only by reading three adjacent census lines and noticing the
// direction column alternate — a hand-derivation, which is what this makes
// mechanical.
//
// DEFINITION: a block migration row R is a FLAP when an earlier row E exists
// such that (a) E and R are in the SAME conversation group — cache prefixes
// are per-conversation, so requests of any other conversation are not part of
// this clock; (b) E and R carry the same block bytes, meaning an identical
// block `hash` — the unit hash scanBlockMigrations already computed, never a
// second notion of sameness; (c) E.direction is the OPPOSITE of R.direction;
// (d) E and R are at most FLAP_WINDOW requests of that conversation apart,
// counted between their later (cur) sides, and at least 1 apart — two rows of
// the SAME pair are not a reversal over time, they are one moment. Only R is
// marked: the first leg of an oscillation is a plain migration until
// something reverses it, and R names the row it reverses so the pair reads
// off one line.
const FLAP_WINDOW = 5;

function markFlaps(items) {
  // `items` are {row, pos} for one conversation, in ascending pos (pos is the
  // index of the row's cur entry within the conversation group), so the
  // backward scan can stop as soon as the window is exceeded.
  for (let i = 0; i < items.length; i++) {
    const { row, pos } = items[i];
    for (let j = i - 1; j >= 0; j--) {
      const span = pos - items[j].pos;
      if (span > FLAP_WINDOW) break;
      if (span < 1) continue; // same pair — one moment, not a reversal
      const e = items[j].row;
      if (e.hash !== row.hash || e.direction === row.direction) continue;
      row.flap = { reversesPrevN: e.prevN, reversesN: e.n, span };
      break;
    }
  }
}

const flapTag = (b) =>
  b.flap ? ` [flap reverses n=${b.flap.reversesPrevN}->${b.flap.reversesN}, ${b.flap.span} req]` : "";

export function findBlockMigrations(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const rows = [];
  for (const group of groups.values()) {
    const inGroup = [];
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const kind = censusIds(prev.inSem, cur.inSem);
      if (!BLOCK_MIGRATION_KINDS.has(kind)) continue;
      for (const row of scanBlockMigrations(prev, cur)) inGroup.push({ row, pos: i });
    }
    markFlaps(inGroup);
    for (const { row } of inGroup) rows.push(row);
  }
  return rows.sort((a, b) => a.n - b.n);
}

export function runCensus(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const e = asCompact(raw);
    const cid = conversationOf(e);
    if (cid === null) continue;
    const g = `${e.key}|${cid}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const tally = new Map();
  const examples = new Map();
  let pairs = 0;
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const kind = censusIds(group[i - 1].inSem, group[i].inSem);
      pairs++;
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
      if (!examples.has(kind)) examples.set(kind, { n: group[i].n, prevN: group[i - 1].n, ts: group[i].ts });
    }
  }
  return { pairs, conversations: groups.size, tally, examples };
}

function parseArgs(argv) {
  const args = {
    file: null,
    env: {},
    json: false,
    census: false,
    restartAt: null,
    wipeStateAt: null,
    trace: false,
    gatesFromCapture: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) {
        process.stderr.write(`bad --env value: ${kv} (want FLAG=value)\n`);
        process.exit(2);
      }
      args.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--census") {
      args.census = true;
    } else if (a === "--trace") {
      args.trace = true;
    } else if (a === "--gates-from-capture") {
      args.gatesFromCapture = true;
    } else if (a === "--restart-at" || a === "--wipe-state-at") {
      const v = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(v) || v < 1) {
        process.stderr.write(`${a} wants a positive request index\n`);
        process.exit(2);
      }
      if (a === "--restart-at") args.restartAt = v;
      else args.wipeStateAt = v;
    } else if (!args.file) {
      args.file = a;
    } else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (!args.file) {
    process.stderr.write(
      "usage: node tools/replay.mjs <captures.jsonl> [--env FLAG=1 ...] [--gates-from-capture] [--census] [--trace] [--restart-at N] [--wipe-state-at N] [--json]\n",
    );
    process.exit(2);
  }
  return args;
}

// Captures are read line-by-line, never slurped. One session's capture
// reaches ~1 GB — each request re-sends the whole history, so the file grows
// quadratically — and `readFile(f, "utf-8")` throws `RangeError: Invalid
// string length` once the file passes V8's max string size. That made the
// GATE unrunnable on exactly the largest and most interesting corpus, while
// staying green on every small one. Found 2026-07-28 by pointing it at a
// live 955 MB session capture.
//
// Conversation SUCCESSION — the census's cross-conversation blind spot,
// closed. Every within-conversation classifier above compares pairs INSIDE
// one conversation identity, so a boundary (compaction, resume, fork)
// structurally never forms a pair: the compaction note documented the blind
// spot, and the resume-exposure question was first answered by a throwaway
// probe — the tell, again, that a classification was missing.
//
// A SUCCESSION is an identity change where the earlier conversation never
// returns later in the capture; conversations that reappear are ordinary
// sidecar INTERLEAVING (hundreds per busy capture, the co-tenant normal) and
// are deliberately not reported — a boundary class that fired on every
// sidecar switch would train its reader to ignore it. Kinds:
//   compaction/new-thread — opener <= 6 messages (summary or fresh start);
//   resume-shaped         — deep opener sharing >50% of message bodies with
//                           the predecessor (the CC#51764 family);
//   fork/other            — deep opener, low overlap: worth eyes.
// Each carries the opener's full byte size — a succession re-bills its
// whole prefix by construction.
export function findSuccessions(entries) {
  const compact = entries.map(asCompact);
  const lastSeen = new Map(); // conversation id -> last entry index
  const firstSeen = new Map(); // conversation id -> first entry index
  for (let i = 0; i < compact.length; i++) {
    const cid = conversationOf(compact[i]);
    if (cid === null) continue;
    lastSeen.set(cid, i);
    if (!firstSeen.has(cid)) firstSeen.set(cid, i);
  }
  const out = [];
  for (let i = 1; i < compact.length; i++) {
    const prev = compact[i - 1];
    const cur = compact[i];
    const prevCid = conversationOf(prev);
    const curCid = conversationOf(cur);
    if (prevCid === null || curCid === null || prevCid === curCid) continue;
    if (lastSeen.get(prevCid) > i - 1) continue; // interleave: it returns
    // The successor must be OPENING here: a one-shot sidecar handing back
    // to a continuing main thread ends a conversation but starts nothing —
    // without this condition every such handback minted a phantom
    // "fork/other" (caught while writing the interleave bite).
    if (firstSeen.get(curCid) !== i) continue;
    const openerBytes = cur.inBytes.reduce((a, b) => a + b, 0);
    let kind;
    let shared = 0;
    if (cur.msgs <= 6) {
      kind = "compaction/new-thread";
    } else {
      const prevHashes = new Set(prev.inHash);
      shared = cur.inHash.filter((h) => prevHashes.has(h)).length;
      kind = shared / cur.msgs > 0.5 ? "resume-shaped" : "fork/other";
    }
    out.push({
      n: cur.n,
      prevN: prev.n,
      ts: cur.ts,
      kind,
      openerMsgs: cur.msgs,
      shared,
      rebilledBytes: openerBytes,
    });
  }
  return out;
}

// --- Content conservation: the fifth gate ---
//
// NAME COLLISION, stated once so neither reader is misled: `classifyFidelity`
// below is REPLAY fidelity — "did this offline run reproduce the bytes the
// proxy really forwarded". This is CONTENT-conservation fidelity — "did the
// proxy forward every byte CC sent, or account for the ones it did not". The
// first is about the instrument, the second about the pipeline. The JSON key
// here is `conservation` for that reason; the four existing gates are
// untouched.
//
// WHY IT IS NEEDED. The four gates all ask a positional question: did our
// bytes move earlier than CC's, did we change the message sequence, did a
// normalize get followed by a reset, does canonical order track the wire.
// None of them can see a message CC sent that we simply never forwarded and
// whose content exists nowhere else — because a DELETION that leaves the
// surviving array positionally consistent is invisible to all four. The
// pin-and-suppress mechanism (#76606 decision B) deletes messages on purpose,
// and the mitigation this gate is a precondition for (a recognized reminder
// MOVE, served from its first-seen form) deletes one more. Safety outranks
// cache: a suppression whose copy is not actually on the wire is a silently
// truncated conversation, which is strictly worse than a cache miss.
//
// DEFINITION, written before any assertion (dev-loop "Adding a check"), for
// ONE request — CC's raw array R and the forwarded array F:
//
//   R-side. Every content unit of a non-assistant message of R is either
//     (a) present in F byte-identically (as the same unit, anywhere in F —
//         the question is whether the content is still on the wire, not
//         where), or
//     (b) part of a DECLARED suppression (stats.suppressions, the
//         extension's own report — never a re-derived "looks dropped"
//         guess) whose content is RECONSTRUCTIBLE from F: its unwrapped
//         bytes equal either a unit present in F, or the "\n\n" join of all
//         volatile blocks of one message present in F (the merged-standalone
//         shape, 78940a0).
//   F-side. Every content unit of a non-assistant message of F is either
//     (a) present in R, or
//     (b) present in an EARLIER request of the same conversation — this is
//         what "the pin forwards the FIRST-SEEN bytes" means, stated as a
//         checkable property rather than trusted: a re-served byte must be a
//         byte CC itself once sent here, and one we invented is red, or
//     (c) a declared injection (isDeclaredInjection — deferred-tool-rewrite's
//         tool_addition announcement, already exempt in the safety gate).
//
// POPULATION — non-assistant messages, and the reason is definitional rather
// than convenient. Every mechanism that can delete or re-serve content in
// this pipeline is confined to that population by construction:
// classifyPinned skips `e.r === "assistant"` before suppressing, and
// pinnedForwardForm returns the incoming message unchanged unless
// `stored.r === "user"`. Assistant content is transformed by a different and
// separately-gated class of extension. That class is not hypothetical —
// measured over 936 requests of four live captures the fixtures derive
// from, the ONLY blocks the pipeline does not conserve
// byte-identically are `assistant/tool_use` (rewritten in place by
// tool-input-normalize: 3,145 lost and 3,145 gained on one of them alone) and
// `assistant/thinking` (dropped by thinking sanitization); non-assistant
// blocks were conserved in every one of those requests. So the exclusion
// costs no coverage of THIS class and would otherwise fire on two declared
// behaviours with no telemetry to key an exemption on — a check firing on a
// non-defect, which trains its reader to ignore red.
//
// The residue is COUNTED and reported rather than silently dropped
// (`assistantResidue`): a reader can see how much this gate did not look at,
// which is the three-answer rule applied to a population boundary instead of
// to an empty corpus.
const CONSERVATION_JOIN = "\n\n";

function conservationUnits(msg) {
  return blockUnitsFull(msg);
}

// The "\n\n" join of ALL volatile (reminder-wrapped) blocks of one message,
// hashed the same way a single unit is. Mirrors the extension's own
// pinnedJoinHashes — same separator, same "all blocks of the entry, wire
// order, no subset merges" rule — but computed over the FORWARDED array,
// which is where a suppressed message's copy has to be for the suppression to
// have been honest.
function joinUnitHash(units) {
  const texts = units.filter((u) => u.wrapped && u.text !== null).map((u) => u.text);
  if (texts.length < 2) return null;
  return hashMessageContent({ content: [{ type: "text", text: texts.join(CONSERVATION_JOIN) }] });
}

// The CROSS-MESSAGE join — the definition's "including as a join constituent"
// clause, and the shape the single-message join above cannot express. Measured
// (fixture flap-s-0dc8ac87c43d-86.json, request n=104, message 91): CC merged one
// message's reminder with the WHOLE of the standalone message that followed
// it, "\n\n"-joined, and sent the two as a single message. A copy of that
// message on the wire is therefore split across two forwarded messages, and is
// reconstructible only by reading them together.
//
// Restricted to ADJACENT forwarded messages, in wire order, reminder side
// first. That is the measured shape, and it is also what keeps this O(n) per
// request rather than O(n^2): pairing every forwarded message with every other
// would cost a million hashes on a thousand-message history to answer a
// question about one.
function crossJoinUnitHash(leftUnits, rightUnits) {
  const left = leftUnits.filter((u) => u.wrapped && u.text !== null).map((u) => u.text);
  if (!left.length) return null;
  if (rightUnits.length !== 1 || rightUnits[0].text === null) return null;
  const text = left.join(CONSERVATION_JOIN) + CONSERVATION_JOIN + rightUnits[0].text;
  return hashMessageContent({ content: [{ type: "text", text }] });
}

const isAssistant = (m) => m?.role === "assistant";

// DECLARED TRANSFORM — the definition's clause (c), and the registry it names.
// fresh-session-sort deletes the echo a slash command leaves in the first user
// message (`<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`
// — fresh-session-sort.mjs, "Strip /clear artifacts from first user message").
// Those bytes really do leave the wire, and they are meant to: they are the
// harness quoting its own command back, never conversation content.
//
// Found by this gate rather than by reading: the first sweep reported 645
// violations on capture s-4b6a435234bf, ALL of kind `lost`, ALL at message 0, and
// stage-by-stage replay of request 822 named the extension — RAW 6 units,
// after fresh-session-sort 3, the three removed being exactly a /compact
// caveat, its `<command-name>`, and its `<local-command-stdout>`. Left
// unexempted this would fail the daily sweep forever on a declared behaviour,
// which is the check-fires-on-a-non-defect failure that trains a reader to
// ignore red.
//
// The predicate is IMPORTED from the extension that performs the strip, never
// restated here: a second copy of "what counts as a clear artifact" is a
// second truth, and this file's own rule is to import an identity rather than
// re-derive it. Accepted residue, named because the exemption is slightly
// wider than the transform: the extension strips these blocks only from the
// first user message, while this exempts them wherever they appear. A
// harness-echo block elsewhere is not content either, so the widening cannot
// mask a conversation byte — but it is a widening, not an equality.
const isDeclaredStrip = (u) => u.text !== null && isClearArtifact(u.text);

// Per-request verdict, `seen` being the per-conversation set of unit hashes CC
// has sent in ANY earlier request of this conversation. Per-entry for the same
// reason safetyViolation is: it runs in the replay loop where the messages are
// live and retains nothing but the verdict. `seen` is bounded by the
// conversation's own history (each request re-sends all of it, so the union
// converges on the largest request's block set) rather than by request count —
// the distinction that keeps this off the O(file) retention path.
export function conservationViolations(e, seen) {
  const out = [];
  const inMsgs = e.inMsgs ?? [];
  const outMsgs = e.outMsgs ?? [];
  const suppressed = suppressedIndices(e.stats);

  const fUnitsByMsg = outMsgs.map(conservationUnits);
  const fHashes = new Set();
  for (const units of fUnitsByMsg) for (const u of units) fHashes.add(u.hash);
  const fJoinHashes = new Set();
  for (let i = 0; i < fUnitsByMsg.length; i++) {
    const j = joinUnitHash(fUnitsByMsg[i]);
    if (j !== null) fJoinHashes.add(j);
    if (i + 1 < fUnitsByMsg.length) {
      const x = crossJoinUnitHash(fUnitsByMsg[i], fUnitsByMsg[i + 1]);
      if (x !== null) fJoinHashes.add(x);
    }
  }

  const rHashes = new Set();
  let assistantResidue = 0;
  for (let i = 0; i < inMsgs.length; i++) {
    const msg = inMsgs[i];
    const units = conservationUnits(msg);
    if (isAssistant(msg)) {
      for (const u of units) if (!fHashes.has(u.hash)) assistantResidue++;
      continue;
    }
    for (const u of units) rHashes.add(u.hash);
    if (suppressed.has(i)) {
      // A declared suppression must leave its content behind. Both matchable
      // shapes are the extension's own: a per-block copy, or the merged join.
      const unaccounted = units.filter((u) => !fHashes.has(u.hash) && !fJoinHashes.has(u.hash));
      if (unaccounted.length) {
        out.push({
          n: e.n,
          ts: e.ts,
          kind: "suppressed-without-copy",
          detail: `in[${i}] (${msg?.role}): ${unaccounted.length} of ${units.length} unit(s) reconstructible from neither a forwarded block nor a forwarded join`,
        });
      }
      continue;
    }
    const lost = units.filter((u) => !fHashes.has(u.hash) && !isDeclaredStrip(u));
    if (lost.length) {
      out.push({
        n: e.n,
        ts: e.ts,
        kind: "lost",
        detail: `in[${i}] (${msg?.role}): ${lost.length} of ${units.length} unit(s) present in CC's request and in no forwarded message`,
      });
    }
  }

  for (let i = 0; i < outMsgs.length; i++) {
    const msg = outMsgs[i];
    if (isAssistant(msg) || isDeclaredInjection(msg)) continue;
    const invented = fUnitsByMsg[i].filter((u) => !rHashes.has(u.hash) && !(seen && seen.has(u.hash)));
    if (invented.length) {
      out.push({
        n: e.n,
        ts: e.ts,
        kind: "invented",
        detail: `out[${i}] (${msg?.role}): ${invented.length} of ${fUnitsByMsg[i].length} unit(s) CC never sent in this conversation`,
      });
    }
  }

  if (seen) for (const h of rHashes) seen.add(h);
  return { violations: out, assistantResidue };
}

// Whole-corpus shape, grouped by conversation so `seen` means what the
// definition says — bytes CC sent EARLIER IN THIS CONVERSATION, never a
// co-tenant's. One implementation, two shapes (the streaming caller wants one
// verdict at a time), rather than a tested one and a shipped one.
export function findConservationViolations(entries) {
  const seenByGroup = new Map();
  const out = [];
  for (const raw of entries) {
    const inMsgs = raw.inMsgs ?? [];
    const cid = inMsgs.length ? sha(JSON.stringify(inMsgs[0])) : null;
    if (cid === null) continue;
    const g = `${raw.key}|${cid}`;
    if (!seenByGroup.has(g)) seenByGroup.set(g, new Set());
    out.push(...conservationViolations(raw, seenByGroup.get(g)).violations);
  }
  return out.sort((a, b) => a.n - b.n);
}

// Fidelity classification, pure so the population boundaries are testable.
// FIVE populations, never collapsed into one ratio:
//   comparable/matched      — unmutated with a recorded outSha; a mismatch
//                             here fails the gate (the replay is not
//                             reproducing the real request).
//   mutatedComparable/-Matched — mutated with a recorded outSha;
//                             INFORMATIONAL ONLY, because state divergence
//                             makes a mismatch legitimate. On busy sessions
//                             every request is mutated, so this is the only
//                             fidelity signal there is.
//   noOutcome               — no outcome record at all (predates the feature,
//                             or no usage ever arrived).
//   outcomeWithoutSha       — outcome present but written by the pre-outSha
//                             recorder (14 such in one capture, all between
//                             the two 2026-07-28 restarts). Distinct from
//                             noOutcome because this population never shrinks
//                             by itself and must not read as "records
//                             missing, will fill in".
export function classifyFidelity(report, outcomes) {
  const fidelity = {
    comparable: 0,
    matched: 0,
    mutatedComparable: 0,
    mutatedMatched: 0,
    notComparableMutated: 0, // kept: gate-live and its consumers read this name
    noOutcome: 0,
    outcomeWithoutSha: 0,
    mismatches: [],
  };
  for (const e of report) {
    if (e.error) continue;
    const oc = outcomes.get(e.captureId);
    if (!oc || !e.outBodySha) {
      fidelity.noOutcome++;
      continue;
    }
    if (!oc.outSha) {
      fidelity.outcomeWithoutSha++;
      continue;
    }
    if ((e.mutatedBy ?? []).length > 0) {
      fidelity.notComparableMutated++;
      fidelity.mutatedComparable++;
      if (oc.outSha === e.outBodySha) fidelity.mutatedMatched++;
      continue;
    }
    fidelity.comparable++;
    if (oc.outSha === e.outBodySha) fidelity.matched++;
    else fidelity.mismatches.push({ n: e.n, recorded: oc.outSha, replayed: e.outBodySha });
  }
  return fidelity;
}

// Blank lines are skipped WITHOUT consuming an index, matching the previous
// `.filter()` — `n` must keep the meaning that `--restart-at`,
// `--wipe-state-at` and every violation report already use.
//
// readLines, not readline.createInterface: the consumer awaits per request,
// and readline's push-based iterator buffers the entire remaining file during
// those awaits — measured 3.27 GB peak on a 1.5 GB capture while this
// function was called "streaming". tools/read-lines.mjs carries the measured
// failure and the bite test pinning the pull-based mechanism.
export async function* readCapture(path) {
  let n = 0;
  for await (const line of readLines(path)) {
    if (!line.trim()) continue;
    yield [n++, line];
  }
}

// --gates-from-capture needs every boot record BEFORE loadExtensions runs
// (several extensions read their gate env at load or first-call time), but
// main()'s own `boots` array is only complete once the whole capture has
// been read — a chicken-and-egg the flag resolves with a lightweight
// PRE-pass: same pull-based reader as `readCapture` (never slurped, so this
// costs one extra streamed parse of the file, not a second copy of it in
// memory), keeping only the rare `type:"boot"` lines rather than every
// request body.
export async function readBootRecords(path) {
  const boots = [];
  for await (const line of readLines(path)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "boot") boots.push(rec);
  }
  return boots;
}

// --- Gate provenance (BACKLOG.md: "replay warns on gateless runs of gated
// captures") ---
//
// A capture's boot record(s) name the CACHE_FIX_* gates the traffic was
// served under (buildBootRecord, proxy/extensions/request-capture.mjs).
// Replaying that capture under a DIFFERENT gate set compares two worlds and
// reports the difference as a finding — the same class of error
// gate-live.mjs's own comment documents for the daily sweep (extension
// defaults replayed against production's 11 gates, 0 violations vs 2 on the
// same corpus). Grounding for mechanizing rather than trusting prose here:
// the SAME operator-side instrument error happened three times in one day
// (2026-07-29 default-gates census), each time with the dev-loop warning
// already loaded.
//
// declaredGateEnv: union across every boot record in the capture, not just
// the first — a capture can span a restart under a different unit file, and
// any boot's declared gates are relevant to what the traffic after it saw.
// `CACHE_FIX_CAPTURE_MAX_MB` is capture retention, not a mitigation gate
// (excluded the same way the existing provenance printout already
// excludes it). Later boots win on VALUE (object insertion order tracks
// file order, since boots is built by streaming the capture forward) — the
// same rule `--gates-from-capture` (below) needs and `declaredGateNames`
// (names only, no values) did not.
export function declaredGateEnv(boots) {
  const env = {};
  for (const b of boots ?? []) {
    for (const [k, v] of Object.entries(b?.gates ?? {})) {
      if (k !== "CACHE_FIX_CAPTURE_MAX_MB") env[k] = v;
    }
  }
  return env;
}

export function declaredGateNames(boots) {
  return new Set(Object.keys(declaredGateEnv(boots)));
}

// --gates-from-capture (BACKLOG.md: "and READY, the mechanized form: a
// --gates-from-capture replay flag applying the union"). The union's
// VALUES, not just its names, with explicit --env overrides winning
// per-key — the same combination `main()` used to hand-extract from a
// boot record and pass back in as `--env` flags, now mechanized so no
// operator does that by hand (the standing cause of the 2026-07-29
// default-gates incidents, dev-loop.md "Replay the configuration that is
// SERVING"). Exported so a test asserts the SAME merge the CLI performs,
// never a re-derived one (dev-loop.md, "never hand-roll identity in a
// probe").
export function resolveGatesFromCapture(boots, envOverrides) {
  return { ...declaredGateEnv(boots), ...(envOverrides ?? {}) };
}

// Which of the declared gates are set in the effective replay env. "Set"
// mirrors buildBootRecord's own inclusion rule exactly — presence as an own
// key of the env object, any value — never a re-derived truthiness guess,
// so a --env override and an inherited process.env variable count
// identically, the same way they did when the boot record was written.
export function gateSourceSummary(boots, env) {
  const declared = declaredGateNames(boots);
  const set = [...declared].filter((k) => Object.prototype.hasOwnProperty.call(env ?? {}, k));
  return {
    declaredCount: declared.size,
    setCount: set.length,
    // Only the NONE-set case warns; partial visibility (some but not all
    // declared gates set) is a legitimate configuration (a --env override
    // naming a subset) and is surfaced by the header stamp, not the
    // warning.
    warn: declared.size > 0 && set.length === 0,
  };
}

export function formatGateSource({ declaredCount, setCount }) {
  if (declaredCount === 0) return "no gates declared in capture";
  if (setCount === 0) return `none (capture declares ${declaredCount})`;
  return `${setCount} of ${declaredCount} declared set`;
}

async function main() {
  const args = parseArgs(process.argv);

  // Scratch state dir BEFORE loading extensions: several read env at
  // module scope is not the idiom here (all gates are read per-call),
  // but claude-home is read per-call too — set it first anyway so no
  // load-order surprise can leak a write to the live ~/.claude.
  const scratch = await mkdtemp(join(tmpdir(), "cache-fix-replay-"));
  process.env.CLAUDE_CONFIG_DIR = scratch;
  // --gates-from-capture: resolve the capture's own ALL-BOOTS gate union
  // (values, later boots winning) via a pre-pass BEFORE extensions load —
  // the same merge point --env alone used, now with the capture as the
  // base and --env as the override. Without the flag, behaviour is
  // unchanged (args.env applied directly). See resolveGatesFromCapture.
  const gateEnv = args.gatesFromCapture
    ? resolveGatesFromCapture(await readBootRecords(args.file), args.env)
    : args.env;
  for (const [k, v] of Object.entries(gateEnv)) process.env[k] = v;

  const { loadExtensions, runOnRequest } = await import(
    new URL("../proxy/pipeline.mjs", import.meta.url).href
  );

  let extensions = await loadExtensions(EXT_DIR, EXT_CONFIG);

  const report = [];
  const stability = [];
  const safety = [];
  const conservation = [];
  // Per-conversation first-seen registry for the conservation gate (see its
  // DEFINITION). Hashes only, keyed by (capture key, conversation), so it is
  // bounded by history size rather than by request count.
  const conservationSeen = new Map();
  let conservationResidue = 0;
  const outcomes = new Map();
  const boots = [];

  // `n` counts REQUEST records only. Outcome records (what the API charged)
  // share the file but carry no body, and letting them consume an index would
  // shift every request number — so --restart-at N and every violation report
  // would silently point at the wrong request.
  let reqN = -1;
  for await (const [, line] of readCapture(args.file)) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      report.push({ n: reqN + 1, error: "unparseable capture line" });
      continue;
    }
    if (rec.type === "outcome") {
      outcomes.set(rec.id, rec);
      continue;
    }
    // Boot records mark a restart boundary and the gate set in force. They
    // carry no body and must not consume a request index.
    if (rec.type === "boot") {
      boots.push({ afterRequest: reqN, ...rec });
      continue;
    }
    const n = ++reqN;
    const body = structuredClone(rec.body);
    // The capture record stores the session id under "session-id", but
    // resolveSessionId (cache-telemetry) reads x-session-id /
    // x-claude-code-session-id — reconstruct under a key it actually
    // reads, or every extension keys by content-hash fallback and the
    // replay silently loses session identity.
    const headers = {
      "anthropic-beta": rec.headers?.["anthropic-beta"] ?? undefined,
      "x-session-id": rec.headers?.["session-id"] ?? rec.sid ?? undefined,
    };
    const ctx = { body, headers, meta: { route: "messages" } };

    // Restart transparency probe (threat-matrix row 3). Row 3 asserts a
    // mid-session restart is OUR artifact rather than physics; this makes the
    // claim testable offline instead of by restarting a live proxy and
    // watching the bill.
    //
    // What a restart actually loses matters, and it is NOT the persisted
    // state: insertion-normalization (saveCanonical) and
    // deferred-tool-rewrite write their state to
    // ~/.claude/cache-fix-snapshots and re-read it per request, so a fresh
    // process finds it intact. Only MODULE-SCOPE memory dies — and re-loading
    // the extension modules is exactly what this simulates: fresh module
    // registry, same state directory, same corpus position.
    //
    // `--wipe-state-at` is the pessimistic sibling: state directory gone too,
    // which models losing the snapshots rather than restarting the process.
    // Keeping the two separate matters — conflating them measures a disaster
    // and calls it a restart.
    if (args.restartAt === n || args.wipeStateAt === n) {
      if (args.wipeStateAt === n) await rm(scratch, { recursive: true, force: true });
      // loadExtensions cache-busts its imports per call (pipeline.mjs
      // `_loadCounter`), so re-calling it gives genuinely fresh module scope
      // — the same thing a new process gets.
      extensions = await loadExtensions(EXT_DIR, EXT_CONFIG);
      process.stderr.write(
        `[replay] simulated ${args.wipeStateAt === n ? "state loss" : "proxy restart"} before request ${n}\n`,
      );
    }

    // Measure per-extension mutation by hashing between stages: run the
    // pipeline one extension at a time (same order — loadExtensions
    // already sorted) instead of trusting each extension's telemetry.
    const mutatedBy = [];
    let prevHash = sha(JSON.stringify(ctx.body));
    for (const ext of extensions) {
      if (!ext.onRequest) continue;
      await runOnRequest(ctx, [ext]);
      const h = sha(JSON.stringify(ctx.body));
      if (h !== prevHash) mutatedBy.push(ext.name);
      prevHash = h;
    }

    report.push({
      n,
      ts: rec.ts,
      key: rec.key,
      captureId: rec.id ?? null,
      // Hash of the body THIS replay produced, in the same form the proxy
      // hashes what it forwards (JSON.stringify of the mutated body).
      outBodySha: createHash("sha256").update(JSON.stringify(ctx.body)).digest("hex").slice(0, 16),
      msgs: Array.isArray(rec.body?.messages) ? rec.body.messages.length : 0,
      mutatedBy,
      insertion: ctx.meta.insertionNormalizeStats ?? null,
      outHash: prevHash,
    });
    // Both sides of the stability check: what CC sent, and what we
    // forwarded. `rec.body` was cloned before the pipeline ran, so it
    // still holds the captured bytes.
    const full = {
      n,
      ts: rec.ts,
      key: rec.key,
      inMsgs: Array.isArray(rec.body?.messages) ? rec.body.messages : [],
      outMsgs: Array.isArray(ctx.body?.messages) ? ctx.body.messages : [],
      // What CC sent vs what we forwarded — deferred-tool-rewrite's whole job
      // is to make the second stable while the first moves (row 6).
      inTools: rec.body?.tools,
      outTools: ctx.body?.tools,
      action: ctx.meta.insertionNormalizeStats?.action ?? null,
      resetReason: ctx.meta.insertionNormalizeStats?.resetReason ?? null,
      stats: ctx.meta.insertionNormalizeStats ?? null,
      freshSessionSortStats: ctx.meta.freshSessionSortStats ?? null,
    };
    // Safety is a per-request question, so answer it now and keep only the
    // verdict; the messages become garbage as soon as this iteration ends.
    const sv = safetyViolation(full);
    if (sv) safety.push(sv);
    // Content conservation is per-request too, but carries one piece of
    // cross-request state: what CC has already sent in THIS conversation (the
    // first-seen registry the pin re-serves from). Grouped on the same
    // conversation identity every other checker uses — msgs[0]'s byte hash.
    {
      const cid = full.inMsgs.length ? sha(JSON.stringify(full.inMsgs[0])) : null;
      if (cid !== null) {
        const g = `${full.key}|${cid}`;
        if (!conservationSeen.has(g)) conservationSeen.set(g, new Set());
        const cv = conservationViolations(full, conservationSeen.get(g));
        conservation.push(...cv.violations);
        conservationResidue += cv.assistantResidue;
      }
    }
    // Everything else keeps hashes, not bodies — see compactEntry.
    stability.push(compactEntry(full));
  }

  // Gate provenance check — see the block comment above `declaredGateEnv`.
  // `process.env` here already carries the `--env`/`--gates-from-capture`
  // merge applied above (before extensions loaded), so it IS the effective
  // replay env.
  // Computed once, after the read loop (boots is only complete once the
  // whole capture has been read), and printed once — not per request.
  const gateSource = gateSourceSummary(boots, process.env);
  if (gateSource.warn) {
    process.stderr.write(
      `WARNING: replaying under DEFAULT gates — this traffic was served with ${gateSource.declaredCount} gate(s). Pass --gates-from-capture, --env, or use gate-live.\n`,
    );
  }

  // FIDELITY: did the replay actually reproduce what went on the wire?
  //
  // This gate rests on an assumption nothing has ever checked — that
  // re-running the pipeline offline reproduces the bytes the proxy really
  // forwarded. Captures are pre-pipeline by design, so the output was never
  // recorded and the assumption was unfalsifiable. Outcome records now carry
  // `outSha`, the hash of the actual outbound body, so the reconstruction can
  // be compared against it.
  //
  // A mismatch does not mean the proxy misbehaved; it means the REPLAY is not
  // modelling the proxy, and therefore that every verdict in this run is about
  // a system that never ran. That is worth knowing loudly and is reported
  // separately from the four invariant gates for exactly that reason.
  //
  // Scoped to requests NO EXTENSION MUTATED, and that scoping is the whole
  // difference between a check and a permanently-red light. A replay starts
  // from an empty state directory while the live proxy carried accumulated
  // canonicals and tools baselines, so a MUTATED request legitimately differs
  // from what went on the wire — measured 0/8 on a mid-session corpus even
  // under the exact production gate set. Reporting that as failure would be a
  // check firing on a non-defect, which trains its reader to ignore it.
  //
  // An UNMUTATED request has no such excuse: the proxy forwarded
  // JSON.stringify(body) with nothing changed, and so did the replay. A
  // mismatch there means the replay is not reproducing the real request, and
  // every verdict in the run is about a different system.
  // Three populations, reported separately and never collapsed into one
  // ratio. "0/0" is indistinguishable from "checked and clean", which is the
  // same absence-of-evidence-as-evidence-of-absence that let a broken --cold
  // reader print "No cold rewrites recorded" over 26 real records.
  // The mutated pair is INFORMATIONAL, never a gate: state divergence makes a
  // mismatch there legitimate, so it cannot fail anything. It exists because
  // on a busy session every request is mutated (insertion-normalization and
  // tool-rewrite touch essentially all of them), so `comparable` can stay 0
  // forever on exactly the traffic that matters — measured across all nine
  // captures of 2026-07-29's scheduled sweep. A high mutatedMatched says the
  // replay's reconstruction converges on the real wire bytes anyway; a
  // permanent 0/large would be the only available hint that it models a
  // different system, downgraded to a hint precisely because it cannot be
  // distinguished from honest state divergence.
  const fidelity = classifyFidelity(report, outcomes);

  // Canonical order invariant, reported by the extension itself: reading live
  // canonical entries in canonical order, their wire indices must be strictly
  // increasing. This is the MECHANISM behind the reset classes, checked at the
  // state model rather than inferred from a downstream reset three requests
  // later. A size/drift statistic cannot substitute — a split adds one entry
  // and one message, so counts stay equal while order diverges (bite-tested).
  const orderViolations = stability
    .filter((e) => e.stats?.canonOrderViolation)
    .map((e) => ({ n: e.n, ts: e.ts, ...e.stats.canonOrderViolation }));

  const sequence = findSequenceViolations(stability);
  const census = args.census ? runCensus(stability) : null;
  // Self-describing: a census output should name what produced it without
  // requiring the reader to cross-reference the boot record by hand.
  if (census) census.gateSource = formatGateSource(gateSource);
  const toolsDeltas = args.census ? findToolsDeltas(stability) : null;
  const mitigation = args.census ? findMitigationGaps(stability) : null;
  const edits = args.census ? findEditPositions(stability) : null;
  const blockMigrations = args.census ? findBlockMigrations(stability) : null;
  const successions = args.census ? findSuccessions(stability) : null;
  const duplicateRequests = args.census ? findDuplicateRequests(stability) : null;
  const trace = args.trace ? buildTrace(stability) : null;

  // Attribute each violation by replaying the corpus once per extension
  // and asking which stage FIRST pulls the divergence below the bar.
  //
  // Naive attribution (re-run just the offending pair) does not work for
  // stateful extensions: insertion-normalization, deferred-tool-rewrite and
  // both carry per-session canonical state built by every request
  // before this one, so a two-request replay puts them in a different state
  // than the run that produced the violation, and they legitimately behave
  // differently. That yields UNATTRIBUTED on exactly the stateful
  // extensions most worth attributing — measured while building this.
  //
  // Instead: replay the whole corpus with the pipeline truncated after a
  // given stage (cumulative prefix), and compare the same pair's outputs.
  // "Does the violation appear by stage k" is MONOTONE in k — a prefix that
  // produces it keeps producing it as later stages are added — so the first
  // offending stage is found by BISECTION, not a linear scan: ~log2(35) ≈ 6
  // corpus replays instead of up to 35. Measured on the 602-request capture:
  // 58s linear -> ~11s bisected, and the linear form was slow enough to blow
  // a 2-minute command timeout mid-run.
  //
  // Only the replay COUNT is optimised; each replay is still a full-corpus,
  // stateful run, which is what makes the attribution trustworthy.
  const violations = findStabilityViolations(stability);
  // Telemetry-keyed exemptions (fresh-session-sort's first-appearance
  // relocations, currently the only declared one) — kept out of `violations`
  // but reported alongside it, annotated with their basis, so an exempted
  // divergence stays visible rather than silently dropped.
  const exemptions = findStabilityExemptions(stability);
  if (violations.length) {
    const mutators = extensions.filter((e) => e.onRequest);

    // Replay the corpus through mutators[0..cut) and report, per violation,
    // whether its output divergence has already dropped below the bar.
    const replayThrough = async (cut) => {
      const prefix = mutators.slice(0, cut);
      const scratch2 = await mkdtemp(join(tmpdir(), "cache-fix-attr-"));
      const savedHome = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = scratch2;
      const outs = new Map();
      const needed = new Set(violations.flatMap((v) => [v.prevN, v.n]));
      let bReqN = -1;
      for await (const [, line] of readCapture(args.file)) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        // Same numbering rule as the main loop — attribution replays must
        // land on the same request indices the violations were reported in.
        if (rec.type === "outcome" || rec.type === "boot") continue;
        const n = ++bReqN;
        const ctx = {
          body: structuredClone(rec.body),
          headers: {
            "anthropic-beta": rec.headers?.["anthropic-beta"] ?? undefined,
            "x-session-id": rec.headers?.["session-id"] ?? rec.sid ?? undefined,
          },
          meta: { route: "messages" },
        };
        await runOnRequest(ctx, prefix);
        // Every request must run (state), but only the pairs under
        // investigation need their bodies retained.
        if (needed.has(n)) outs.set(n, ctx.body.messages ?? []);
      }
      process.env.CLAUDE_CONFIG_DIR = savedHome;
      await rm(scratch2, { recursive: true, force: true });
      const hit = new Map();
      for (const v of violations) {
        const d = firstDivergence(outs.get(v.prevN) ?? [], outs.get(v.n) ?? []);
        const bar = v.inDiv === null ? Infinity : v.inDiv;
        hit.set(v.n, d !== null && d < bar ? d : null);
      }
      return hit;
    };

    // One bisection per violation would re-replay the corpus per violation;
    // instead bisect once over the union and let each violation record the
    // first cut at which it appears. Cache results by cut so repeated
    // probes of the same depth are free.
    const cache = new Map();
    const probe = async (cut) => {
      if (!cache.has(cut)) cache.set(cut, await replayThrough(cut));
      return cache.get(cut);
    };
    for (const v of violations) {
      let lo = 1;
      let hi = mutators.length;
      if ((await probe(hi)).get(v.n) === null) {
        v.attribution = null; // not reproducible through the full pipeline
        continue;
      }
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await probe(mid)).get(v.n) !== null) hi = mid;
        else lo = mid + 1;
      }
      v.attribution = { ext: mutators[lo - 1].name, outDiv: (await probe(lo)).get(v.n) };
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ report, violations, exemptions, safety, conservation, conservationResidue, sequence, orderViolations, census, toolsDeltas, mitigation, edits, blockMigrations, successions, duplicateRequests, fidelity, boots, trace }, null, 2) + "\n");
  } else {
    const counts = new Map();
    for (const r of report) {
      for (const name of r.mutatedBy ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
      process.stdout.write(`replayed ${report.length} requests from ${args.file}\n`);
    if (boots.length) {
      // Provenance the corpus now carries about itself: where the proxy
      // restarted, and under which gates the traffic was recorded. Replaying
      // under a DIFFERENT gate set is comparing two worlds — the mistake the
      // gate runner made against production for a whole day.
      process.stdout.write(`capture provenance: ${boots.length} proxy boot(s) in this corpus\n`);
      for (const b of boots.slice(0, 4)) {
        const on = Object.keys(b.gates ?? {}).filter((k) => k !== "CACHE_FIX_CAPTURE_MAX_MB").length;
        process.stdout.write(
          `  after request ${b.afterRequest} — pid ${b.pid}, tree ${b.proxyTree ?? "?"}, ${on} gate(s) — replay with --restart-at ${b.afterRequest + 1}\n`,
        );
      }
    }
    process.stdout.write(`mutating extensions (requests touched):\n`);
    for (const [name, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${name}: ${c}\n`);
    }
    const resets = report.filter((r) => r.insertion?.action === "reset");
    process.stdout.write(`insertion-normalization resets: ${resets.length}\n`);
    for (const r of resets.slice(0, 20)) {
      process.stdout.write(`  n=${r.n} ts=${r.ts} reason=${r.insertion.resetReason}\n`);
    }
    process.stdout.write(
      `\ncross-request byte-stability violations (self-inflicted busts): ${violations.length}\n`,
    );
    for (const v of violations.slice(0, 20)) {
      const who = v.attribution ? `${v.attribution.ext} (outDiv=${v.attribution.outDiv})` : "UNATTRIBUTED";
      process.stdout.write(
        // prevN is NOT optional detail. Pairs are compared within a
        // CONVERSATION, so the predecessor is usually not the previous capture
        // line — printing only `n` invites the reader to diff n-1 against n,
        // a different pair and often unrelated traffic. Cost exactly that
        // mistake once (2026-07-28): the violating pair was 44->47, the probe
        // compared 46->47, and the two requests it diffed were different
        // subagent conversations that looked like wholesale corruption. The
        // JSON carried prevN the whole time; the human line did not.
        `  n=${v.prevN}->${v.n} ts=${v.ts} inDiv=${v.inDiv ?? "append-only"} outDiv=${v.outDiv}` +
          `${v.ccIdenticalAtOutDiv ? " [CC bytes at outDiv IDENTICAL -> ours]" : " [CC also changed outDiv]"}` +
          ` <- ${who}\n`,
      );
    }

    // Exempted, not silently dropped: same divergence shape as a violation
    // above, but the extension's own telemetry accounts for it (currently
    // only fresh-session-sort's first-appearance relocations).
    process.stdout.write(`\nstability exemptions (telemetry-backed, not counted as violations): ${exemptions.length}\n`);
    for (const x of exemptions.slice(0, 20)) {
      process.stdout.write(
        `  n=${x.prevN}->${x.n} ts=${x.ts} inDiv=${x.inDiv ?? "append-only"} outDiv=${x.outDiv}` +
          ` <- ${x.exemptReason} (${x.exemptBasis.type})\n`,
      );
    }

    process.stdout.write(`\ncanonical order violations (state model vs wire): ${orderViolations.length}\n`);
    for (const o of orderViolations.slice(0, 20)) {
      process.stdout.write(
        `  n=${o.n} ts=${o.ts} canon#${o.at} sits at wire ${o.wireIdx} after wire ${o.prevWireIdx}\n`,
      );
    }

    process.stdout.write(`\nsafety violations (conversation corrupted): ${safety.length}\n`);
    for (const s of safety.slice(0, 20)) {
      process.stdout.write(`  n=${s.n} ts=${s.ts} ${s.kind}: ${s.detail}\n`);
    }

    process.stdout.write(
      `\ncontent-conservation violations (CC bytes neither forwarded nor accounted for): ${conservation.length}\n`,
    );
    for (const c of conservation.slice(0, 20)) {
      process.stdout.write(`  n=${c.n} ts=${c.ts} ${c.kind}: ${c.detail}\n`);
    }
    // The population boundary, said out loud rather than left implicit: this
    // gate looks at non-assistant messages only (see its DEFINITION), and
    // this is how much it therefore did not look at.
    process.stdout.write(
      `  not examined: ${conservationResidue} assistant-role block(s) the pipeline rewrote or dropped (tool_use normalization, thinking sanitization — a separately-gated class)\n`,
    );

    process.stdout.write(`\nsequence violations (normalize then reset): ${sequence.length}\n`);
    for (const s of sequence.slice(0, 20)) {
      process.stdout.write(`  n=${s.n} ts=${s.ts} reset(${s.reason}) after normalize at n=${s.normalizedAt}\n`);
    }

    if (trace) {
      for (const { group, rows } of trace) {
        process.stdout.write(`\nstate trace — ${group}  (${rows.length} requests)\n`);
        process.stdout.write(`  ${"n".padStart(5)} ${"msgs".padStart(5)} ${"canon".padStart(6)} ${"live".padStart(5)} ${"drift".padStart(6)}  action\n`);
        for (const r of rows) {
          const flag = r.drift !== null && r.drift !== 0 ? " <<<" : "";
          const act = r.action === "reset" ? `reset/${r.resetReason}` : (r.action ?? "-");
          const extra = r.pinned || r.dropped || r.inserted
            ? `  (ins=${r.inserted} pin=${r.pinned} drop=${r.dropped})`
            : "";
          process.stdout.write(
            `  ${String(r.n).padStart(5)} ${String(r.msgs).padStart(5)} ` +
              `${String(r.canonSize ?? "-").padStart(6)} ${String(r.canonLive ?? "-").padStart(5)} ` +
              `${String(r.drift ?? "-").padStart(6)}  ${act}${extra}${flag}\n`,
          );
        }
      }
    }

    if (census) {
      process.stdout.write(
        `\ncensus: ${census.pairs} same-conversation pairs across ${census.conversations} conversations\n`,
      );
      process.stdout.write(`  gates: ${census.gateSource}\n`);
      const total = census.pairs || 1;
      for (const [kind, c] of [...census.tally.entries()].sort((a, b) => b[1] - a[1])) {
        const ex = census.examples.get(kind);
        const pct = ((100 * c) / total).toFixed(1).padStart(5);
        const where = kind === "append-only" || kind === "identical" ? "" : `   e.g. n=${ex.prevN}->${ex.n}`;
        process.stdout.write(`  ${String(c).padStart(5)}  ${pct}%  ${kind}${where}\n`);
      }
    }
    {
      const bad = fidelity.mismatches.length;
      process.stdout.write(
        `\nreplay fidelity: ${fidelity.matched}/${fidelity.comparable} comparable` +
          `  |  ${fidelity.notComparableMutated} mutated (replay starts from empty state)` +
          `  |  ${fidelity.noOutcome} without an outcome record` +
          (fidelity.outcomeWithoutSha
            ? `  |  ${fidelity.outcomeWithoutSha} outcome predates outSha`
            : "") +
          "\n",
      );
      if (fidelity.mutatedComparable > 0) {
        // Informational: a mutated mismatch is legitimate (state divergence),
        // so this can never fail anything — but on busy sessions it is the
        // only fidelity signal there is, since every request is mutated.
        process.stdout.write(
          `  mutated, informational: ${fidelity.mutatedMatched}/${fidelity.mutatedComparable} reconstruction matched the wire\n`,
        );
      }
      if (fidelity.comparable === 0) {
        process.stdout.write(
          `  NOTHING COMPARABLE — this run proves nothing about replay fidelity.` +
            `${fidelity.noOutcome ? " Outcome records are missing; they are written from proxy tree 8a0d995 onward." : ""}\n`,
        );
      }
      if (bad) {
        process.stdout.write(
          `  ${bad} MISMATCH on requests no extension touched — the replay is not reproducing the real request,\n` +
            `  so every other verdict in this run describes a different system\n`,
        );
        for (const m of fidelity.mismatches.slice(0, 5)) {
          process.stdout.write(`    n=${m.n} recorded=${m.recorded} replayed=${m.replayed}\n`);
        }
      }
    }
    if (edits && edits.length) {
      // Threat-matrix row 4: tail edits are cheap, mid-history edits are not.
      const mid = edits.filter((e) => !e.tail);
      process.stdout.write(
        `\nreplace/edit positions: ${edits.length} total, ${edits.length - mid.length} TAIL, ${mid.length} MID-HISTORY\n`,
      );
      const midBytes = mid.reduce((a, e) => a + e.rebilledBytes, 0);
      if (mid.length) {
        process.stdout.write(`  mid-history re-bills ~${(midBytes / 1e6).toFixed(1)} MB — row 4 says RE-OPEN on any of these\n`);
        for (const e of mid.slice(0, 6)) {
          const anchor =
            e.anchorDelta === null ? "no-human-anchor" : `anchor${e.anchorDelta >= 0 ? "+" : ""}${e.anchorDelta}`;
          // blockMigration rides beside anchorDelta: same n/prevN pair, source
          // index within the edit's neighbourhood — the reminder-swap shape
          // the anchor alone cannot name.
          const bm = (blockMigrations ?? []).filter((b) => b.n === e.n && b.prevN === e.prevN);
          const bmTag = bm.length
            ? " " + bm.map((b) => `[blockMigration ${b.direction} ${b.sourceIdx}->${b.targetIdx}]${flapTag(b)}`).join(" ")
            : "";
          process.stdout.write(
            `    n=${e.prevN}->${e.n} edit@${e.at} of ${e.lastIdx} [${anchor}]${bmTag} ~${(e.rebilledBytes / 1e3).toFixed(0)} kB ${e.ts}\n`,
          );
        }
        // The measured norm (2026-07-29): edits cluster at the anchor. An
        // edit FAR from any anchor would be a NEW mechanism, worth a look —
        // so deliver the bytes with the flag (LOCAL stdout only; the class
        // was only ever named by reading content, and extraction friction is
        // what let row 4 sit unexplained for a day).
        const far = mid.filter((e) => e.anchorDelta !== null && Math.abs(e.anchorDelta) > 30);
        if (far.length) {
          process.stdout.write(
            `  ${far.length} edit(s) >30 from the human anchor — NOT the known reminder-anchoring class:\n`,
          );
          const want = new Map(); // request index -> [{at, side, rowKey}]
          for (const e of far.slice(0, 3)) {
            if (!want.has(e.prevN)) want.set(e.prevN, []);
            if (!want.has(e.n)) want.set(e.n, []);
            want.get(e.prevN).push({ at: e.at, label: `n=${e.prevN} (before)` });
            want.get(e.n).push({ at: e.at, label: `n=${e.n} (after)` });
          }
          for await (const [idx, line] of readCapture(args.file)) {
            const asks = want.get(idx);
            if (!asks) continue;
            let body;
            try {
              body = JSON.parse(line).body;
            } catch {
              continue;
            }
            for (const a of asks) {
              process.stdout.write(`    @${a.at} ${a.label}  ${excerptMessage(body?.messages?.[a.at])}\n`);
            }
            want.delete(idx);
            if (want.size === 0) break;
          }
        }
      }
    }
    if (blockMigrations && blockMigrations.length) {
      const flaps = blockMigrations.filter((b) => b.flap);
      process.stdout.write(
        `\nblock migrations (reminder-swap shape): ${blockMigrations.length}, ${flaps.length} FLAP\n`,
      );
      if (flaps.length) {
        process.stdout.write(
          `  a FLAP reverses a migration of the SAME block within ${FLAP_WINDOW} requests of one conversation —\n` +
            `  a pin that classifies only one of the two shapes absorbs one leg, so an oscillation busts on\n` +
            `  every second flip at best (threat matrix row 4, 2026-07-30)\n`,
        );
        // Flaps first, so the truncation below can never drop them: the whole
        // point is that they were previously findable only by reading adjacent
        // lines and noticing the direction column alternate.
        for (const b of flaps.slice(0, 10)) {
          process.stdout.write(
            `    n=${b.prevN}->${b.n} ${b.direction} ${b.sourceIdx}->${b.targetIdx}${flapTag(b)} ${b.ts}\n`,
          );
        }
      }
      for (const b of blockMigrations.filter((r) => !r.flap).slice(0, 10)) {
        process.stdout.write(
          `    n=${b.prevN}->${b.n} ${b.direction} ${b.sourceIdx}->${b.targetIdx}${flapTag(b)} ${b.ts}\n`,
        );
      }
    }
    if (mitigation) {
      // The question the four gates cannot ask: of the events this proxy
      // exists to absorb, how many did it actually absorb?
      const total = mitigation.length;
      const hit = mitigation.filter((m) => m.mitigated).length;
      const pct = total ? ((100 * hit) / total).toFixed(0) : "--";
      process.stdout.write(`\nmitigation: ${hit}/${total} mitigable events absorbed (${pct}%)\n`);
      // `mitigated` is input-side only (see the definitional comment on
      // findMitigationGaps) — a pair can pass it and still splice on the
      // OUTPUT, moving the cache's prefix boundary earlier than the input
      // check ever sees. Flagged separately from the "missed" list below
      // because these pairs are NOT misses by the input-side count.
      const inputMitigatedOutputSpliced = mitigation.filter(
        (m) => m.mitigated && !m.outputPreserved,
      );
      if (inputMitigatedOutputSpliced.length) {
        process.stdout.write(
          `  ${inputMitigatedOutputSpliced.length} pair(s) input-mitigated but NOT output-preserved:\n`,
        );
        for (const m of inputMitigatedOutputSpliced) {
          process.stdout.write(
            `    n=${m.prevN}->${m.n} ${m.kind} ${m.outputForm} [INPUT-MITIGATED, OUTPUT-SPLICED] ~${(m.rebilledOutBytes / 1e3).toFixed(0)} kB ${m.ts}\n`,
          );
        }
      }
      if (total > hit) {
        const missedBytes = mitigation.reduce((a, m) => a + m.rebilledBytes, 0);
        process.stdout.write(`  passed through: ~${(missedBytes / 1e6).toFixed(1)} MB re-billed\n`);
        const byReason = new Map();
        for (const m of mitigation) {
          if (m.mitigated) continue;
          const k = m.resetReason ? `reset(${m.resetReason})` : m.action;
          const cur = byReason.get(k) ?? { n: 0, bytes: 0 };
          cur.n++;
          cur.bytes += m.rebilledBytes;
          byReason.set(k, cur);
        }
        for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
          process.stdout.write(`  ${String(v.n).padStart(5)}  ${k} — ~${(v.bytes / 1e6).toFixed(1)} MB\n`);
        }
        for (const m of mitigation.filter((x) => !x.mitigated).slice(0, 5)) {
          // blockMigration beside the mitigation row for the same reason it
          // rides beside anchorDelta on edit rows: splice/insert-mid is where
          // the reminder-swap shape actually lands (n=26->28 is a splice, not
          // a replace/edit, so it never reaches the edits-array printout).
          const bm = (blockMigrations ?? []).filter((b) => b.n === m.n && b.prevN === m.prevN);
          const bmTag = bm.length
            ? " " + bm.map((b) => `[blockMigration ${b.direction} ${b.sourceIdx}->${b.targetIdx}]`).join(" ")
            : "";
          process.stdout.write(
            `    n=${m.prevN}->${m.n} ${m.kind} ${m.resetReason ? `reset(${m.resetReason})` : m.action}${bmTag} ~${(m.rebilledBytes / 1e3).toFixed(0)} kB ${m.ts}\n`,
          );
        }
      }
    }
    if (toolsDeltas) {
      // Threat-matrix row 6. `tools-only` is the isolating case the row asks
      // for: tools[] moved while the message history did not, so nothing else
      // could have invalidated the prefix.
      const only = toolsDeltas.filter((d) => d.toolsOnly);
      process.stdout.write(`\ntools[] deltas: ${toolsDeltas.length} (${only.length} tools-ONLY)\n`);
      const byKind = new Map();
      for (const d of toolsDeltas) {
        const k = `${d.kind}${d.toolsOnly ? " [tools-only]" : ` +${d.msgKind}`}`;
        byKind.set(k, (byKind.get(k) ?? 0) + 1);
      }
      for (const [k, c] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`  ${String(c).padStart(5)}  ${k}\n`);
      }
      const leaked = toolsDeltas.filter((d) => !d.forwardedStable);
      const heldUnstable = toolsDeltas.filter((d) => !d.heldStable);
      process.stdout.write(
        `  forwarded tools[] held stable across: ${toolsDeltas.length - leaked.length}/${toolsDeltas.length} (whole array)\n`,
      );
      process.stdout.write(
        `  shared-name subset held stable across: ${toolsDeltas.length - heldUnstable.length}/${toolsDeltas.length} (the guarantee actually made)\n`,
      );
      for (const d of only.slice(0, 8)) {
        process.stdout.write(
          `    n=${d.prevN}->${d.n} ${d.kind} in=${d.count} out=${d.outCount} msgs=${d.msgKind} forwardedStable=${d.forwardedStable} heldStable=${d.heldStable}\n`,
        );
      }
    }
    if (duplicateRequests) {
      // BACKLOG "Duplicate-request probe -> census check (Q1)" — the
      // CC#78420 falsifier (adjacent byte-identical bodies), re-answered
      // per sweep instead of a throwaway scan.
      process.stdout.write(`\nduplicate-request pairs (adjacent, byte-identical): ${duplicateRequests.length}\n`);
      for (const d of duplicateRequests.slice(0, 8)) {
        process.stdout.write(`    n=${d.prevN}->${d.n} msgs=${d.msgs} ${d.ts}\n`);
      }
    }
  }

  await rm(scratch, { recursive: true, force: true });
  // Exit non-zero on any violation so this is a gate, not just a report.
  // Safety first in the message ordering because a corrupted conversation is
  // a worse outcome than an expensive one: cache costs money, a mangled
  // history costs correctness.
  if (safety.length) {
    process.stderr.write(`\nFAIL: ${safety.length} safety violation(s) — the pipeline altered the conversation\n`);
  }
  // Same rank as safety, and for the same reason: losing content CC sent is a
  // corrupted conversation, not an expensive one.
  if (conservation.length) {
    process.stderr.write(
      `\nFAIL: ${conservation.length} content-conservation violation(s) — bytes CC sent are neither on the wire nor accounted for\n`,
    );
  }
  // A replay-fidelity mismatch is not a further invariant — it is a statement
  // that the five above were measured on a system that never ran. It fails the
  // gate for that reason. "Nothing comparable" does NOT fail: it is an honest
  // absence of evidence, reported as such rather than dressed up as a pass.
  if (
    violations.length ||
    safety.length ||
    conservation.length ||
    sequence.length ||
    orderViolations.length ||
    fidelity.mismatches.length
  ) {
    process.exitCode = 1;
  }
}

// Run only when invoked as a script. The checkers above are exported and
// unit-tested (test/replay-gate-selfcheck.test.mjs); importing this module
// must not execute a replay.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`replay failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
