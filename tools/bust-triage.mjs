#!/usr/bin/env node
// bust-triage — one command from an observed cache bust to a classified verdict.
//
// Why this exists: on 2026-07-31 a single bust took a six-step hand
// investigation — statusline, worktime ledger, CC transcript, proxy journal,
// capture pair, body diff — before `replay --census` could even be pointed at
// it. Two of the day's most valuable findings came out of steps nobody repeats
// under time pressure, and one of them (an entirely uncovered bust class) was
// found only because a diff happened to be read. The manual pass finds a defect
// once; the mechanism finds it at the moment it occurs, without the reasoning
// that produced it — and that reasoning is exactly what does not survive into
// the next session.
//
// It CHAINS existing tools rather than reimplementing them (dev-loop.md,
// "Never hand-roll identity in a probe"): classification comes from
// replay.mjs's censusPair, the migration byte-test from
// reminder-migration-census.mjs, conversation grouping from the shared
// identity. The only logic new here is the ledger/transcript reconciliation
// and the matrix lookup.
//
// Usage:
//   node tools/bust-triage.mjs                  # newest bust in the ledger
//   node tools/bust-triage.mjs --at 1785498086  # a specific one (epoch or ISO)
//   node tools/bust-triage.mjs --list           # recent ❄ events, newest first
//                                               # (busts AND controlled costs)
//   ... --json
//
// THREE answers, never two (dev-loop.md, "A checker has THREE answers"):
//   MITIGATED     known class, shipped extension, absorbed as designed
//   KNOWN-OPEN    known class, matrix row N, still open — prints the status
//   UNCLASSIFIED  no matrix row matches. THE payload of this tool: an
//                 unrecognised class is the one thing no existing check
//                 reports, and it is how a whole bust class stayed invisible.
// A step that cannot run says so and does not fold into a pass.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { censusPair } from "./replay.mjs";
import { canonical, classify, reminderBlocks, textOf } from "./reminder-migration-census.mjs";

const LEDGER = join(homedir(), ".local/share/claude-worktime/activity.jsonl");
const CAPTURES = join(homedir(), ".claude/cache-fix-captures");
const PROJECTS = join(homedir(), ".claude/projects");
const MATRIX = "docs/directives/robustness-threat-matrix.md";

const j = (line) => { try { return JSON.parse(line); } catch { return null; } };
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);

// The ❄-visible cold classes, and the definition is the statusline's own.
// `claude-worktime` advances the ❄ token on two paths — `cold_hit` (k:"hit")
// and `cold_cost` (k:"cost", plus legacy k:"resume" records) — and its
// `--cold --all` filter is written exactly that way. This tool read only
// k:"hit", so on 2026-07-31 the statusline showed `❄ 55k compact (8m)` while
// `--list` showed nothing newer than 90 minutes earlier and the default run
// silently triaged an older, unrelated event. An event the operator can SEE
// must never be missing from the tool that explains events.
const CONTROLLED = new Set(["cost", "resume"]);

/**
 * Every ❄-visible cold event, newest first, retractions and cause upgrades
 * applied. `cls` splits them: "bust" is a preventable cache loss, "controlled"
 * is a cost the operator (or the auto-compact ceiling) caused — real, visible,
 * and NOT triageable, which is an answer rather than a reason to hide it.
 */
export function coldEvents(ledgerPath = LEDGER) {
  const recs = lines(ledgerPath).map(j).filter((r) => r && r.type === "cold");
  const retracted = new Set(
    recs.filter((r) => r.k === "hit-retract").map((r) => `${r.s}#${r.hit_t}`));
  // A k:"hit-cause" marker carries the cause recovered after a raced read;
  // honoring it here is why this tool and `--cold` cannot disagree.
  const causeFix = new Map(
    recs.filter((r) => r.k === "hit-cause").map((r) => [`${r.s}#${r.hit_t}`, r.cause]));
  return recs
    .filter((r) => (r.k === "hit" || CONTROLLED.has(r.k)) && !retracted.has(`${r.s}#${r.t}`))
    .map((r) => ({ ...r, cls: r.k === "hit" ? "bust" : "controlled",
                   cause: causeFix.get(`${r.s}#${r.t}`) ?? r.cause }))
    .sort((x, y) => y.t - x.t);
}

/** Cold HIT records only — the population that can actually be triaged. */
export function busts(ledgerPath = LEDGER) {
  return coldEvents(ledgerPath).filter((e) => e.cls === "bust");
}

/** The transcript's own diagnostic for a bust, or null when unreadable. */
export function transcriptCause(sid, cc) {
  if (!existsSync(PROJECTS)) return null;
  for (const proj of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, proj, `${sid}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of lines(f)) {
      const r = j(line);
      const d = r?.message?.diagnostics?.cache_miss_reason;
      if (!d) continue;
      if ((r.message?.usage?.cache_creation_input_tokens ?? -1) === cc) {
        return { type: d.type, missed: d.cache_missed_input_tokens ?? null };
      }
    }
  }
  return null;
}

/** The capture request pair straddling a bust, by conversation. */
export function capturePair(sid, tsEpoch) {
  const f = join(CAPTURES, `s-${sid}-requests.jsonl`);
  if (!existsSync(f)) return null;
  const recs = lines(f).map(j).filter((r) => r?.body?.messages && r?.ts);
  if (recs.length < 2) return null;
  // The busting request is the newest one at or before the ledger stamp; its
  // predecessor IN THE SAME CONVERSATION is the comparison. Conversation, not
  // adjacency — interleaved tenants sit several lines apart.
  // STRICTLY at or before the ledger stamp: worktime books the hit from the
  // statusline hook, which runs AFTER the response, so the busting request
  // always precedes the stamp. An earlier version allowed +30s of slack and
  // selected a request 35s LATER than the bust — an append-only pair that
  // classified as UNCLASSIFIED and would have been reported as a new class.
  // ...and it must be a request that could PRODUCE this bust. One session id
  // covers several conversations (main thread, subagents, the 1-message
  // bootstrap/sidecar calls), and the newest request before the stamp is
  // frequently a sidecar. Selecting one made a 44k rewrite classify as
  // "identical" on an n=1->n=1 pair and report a phantom new class. The
  // context the bust re-wrote is the discriminator: require a body at least
  // as large as the ledger's own ctx figure allows, floored at 2 messages
  // since a single-message request has no prefix to bust.
  const cutoff = tsEpoch * 1000;
  const plausible = (r) => (r.body.messages?.length ?? 0) >= 2;
  let after = null;
  for (const r of recs) {
    const t = Date.parse(r.ts);
    if (t <= cutoff && plausible(r) && (!after || t > Date.parse(after.ts))) after = r;
  }
  if (!after) return null;
  const cid = JSON.stringify(after.body.messages[0]);
  let before = null;
  for (const r of recs) {
    if (r === after) continue;
    if (JSON.stringify(r.body.messages[0]) !== cid) continue;
    if (Date.parse(r.ts) >= Date.parse(after.ts)) continue;
    if (!before || Date.parse(r.ts) > Date.parse(before.ts)) before = r;
  }
  return before ? { before, after } : null;
}

/** Does the pair carry the row-4 reminder container migration? */
export function migrationVerdict(pair) {
  const b = pair.before.body.messages, a = pair.after.body.messages;
  const inlineAfter = new Set();
  for (const m of a) for (const t of reminderBlocks(m)) inlineAfter.add(t);
  const sysAfter = a.filter((m) => m?.role === "system").map(textOf);
  for (let i = 0; i < b.length; i++) {
    const blocks = reminderBlocks(b[i]);
    if (!blocks.length || blocks.some((t) => inlineAfter.has(t))) continue;
    const recon = canonical(blocks);
    for (const t of sysAfter) {
      const v = classify(recon, t);
      if (v === "EXACT" || v === "EXTENDED") return { host: i, verdict: v };
    }
    return { host: i, verdict: "DROPPED" };
  }
  return null;
}

/** Matrix rows whose status line we can quote, keyed by the classes we map to. */
export function matrixRow(n) {
  if (!existsSync(MATRIX)) return null;
  for (const line of lines(MATRIX)) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line);
    if (m && Number(m[1]) === n) {
      const cells = line.split("|");
      const status = (cells[cells.length - 2] ?? "").trim();
      return { n, status: status.slice(0, 260), open: /\bOPEN\b|RE-OPENED/.test(status) };
    }
  }
  return null;
}

/**
 * Map an observed shape to a matrix row. Returns null for "no row matches",
 * which is the UNCLASSIFIED verdict — deliberately NOT a default row.
 */
export function classToRow(censusClass, migration) {
  if (migration) return 4;                       // container migration
  if (censusClass === "splice/insert-mid") return 1;
  if (censusClass === "replace/edit") return 4;
  return null;
}

export function triage(bust) {
  const steps = [];
  const tc = transcriptCause(bust.s, bust.cc);
  steps.push(tc
    ? { step: "transcript", ok: true, detail: `${tc.type}${tc.missed ? ` / ${tc.missed}` : ""}` }
    : { step: "transcript", ok: false, detail: "no diagnostic found (older CC, or transcript rotated)" });

  // Reconciliation: the ledger and the transcript must agree. They disagreed
  // live on 2026-07-31 (display upgraded, record left "other") and the
  // divergence was invisible until compared.
  if (tc && bust.cause && bust.cause !== "other" && bust.cause !== tc.type) {
    steps.push({ step: "reconcile", ok: false,
                 detail: `LEDGER says "${bust.cause}", TRANSCRIPT says "${tc.type}" — instrument disagreement` });
  } else if (tc && bust.cause === "other") {
    steps.push({ step: "reconcile", ok: false,
                 detail: `ledger still "other" while transcript has "${tc.type}" — raced read never upgraded` });
  } else if (tc) {
    steps.push({ step: "reconcile", ok: true, detail: "ledger and transcript agree" });
  }

  const pair = capturePair(bust.s, bust.t);
  if (!pair) {
    steps.push({ step: "capture", ok: false, detail: "no capture pair (capture off, or rotated)" });
    return { bust, steps, verdict: "UNVERIFIABLE", why: "no capture pair to classify" };
  }
  steps.push({ step: "capture", ok: true,
               detail: `${pair.before.ts} -> ${pair.after.ts}, n=${pair.before.body.messages.length}->${pair.after.body.messages.length}` });

  const cls = censusPair(pair.before.body.messages, pair.after.body.messages);
  steps.push({ step: "census", ok: true, detail: cls });

  const mig = migrationVerdict(pair);
  steps.push(mig
    ? { step: "migration", ok: true, detail: `row-4 container migration at host ${mig.host} (${mig.verdict})` }
    : { step: "migration", ok: true, detail: "no reminder container migration in this pair" });

  const rowN = classToRow(cls, mig);
  if (rowN === null) {
    return { bust, steps, verdict: "UNCLASSIFIED",
             why: `census class "${cls}" maps to no threat-matrix row — a class nothing currently covers` };
  }
  const row = matrixRow(rowN);
  if (!row) {
    return { bust, steps, verdict: "UNCLASSIFIED",
             why: `mapped to matrix row ${rowN}, but that row could not be read` };
  }
  return {
    bust, steps,
    verdict: row.open ? "KNOWN-OPEN" : "MITIGATED",
    why: `matrix row ${rowN}: ${row.status}`,
  };
}

function fmt(t) { return new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19); }

/** `--list` rows: every ❄-visible event, controlled ones labelled as such. */
export function listRows(events) {
  return events.map((e) => {
    const label = e.cls === "controlled" ? `CONTROLLED(${e.cause ?? "-"})` : (e.cause ?? "-");
    return `  ${fmt(e.t)}  ${String(Math.round((e.cc ?? 0) / 1000)).padStart(4)}k  ` +
           `${label.padEnd(30)} ${e.s.slice(0, 8)}`;
  });
}

/**
 * What the default (no-args) run must say when the NEWEST cold event is not
 * the one it is about to triage. Silence here is the defect: the operator sees
 * a ❄ token, runs the tool, and gets a verdict about a different, older event
 * with nothing marking the substitution.
 */
export function fallbackNote(events) {
  const newest = events[0];
  if (!newest || newest.cls !== "controlled") return [];
  const bust = events.find((e) => e.cls === "bust");
  const head =
    `  NOTE  the newest cold event is ${fmt(newest.t)} ` +
    `CONTROLLED(${newest.cause ?? "-"}), ${Math.round((newest.cc ?? 0) / 1000)}k re-written.\n` +
    "        Cannot triage: a controlled cause (compact/resume) is a cost you\n" +
    "        caused, not a bust — there is no prevented-loss verdict to give.";
  return [head, bust
    ? `        Falling back to the newest BUST: ${fmt(bust.t)} (${(bust.cause ?? "-")}).`
    : "        No bust in the ledger to fall back to."];
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const events = coldEvents();
  const all = events.filter((e) => e.cls === "bust");
  if (args.includes("--list")) {
    if (!events.length) {
      process.stdout.write("no cold events in the worktime ledger.\n");
      return 0;
    }
    for (const row of listRows(events.slice(0, 15))) process.stdout.write(row + "\n");
    return 0;
  }
  const note = fallbackNote(events);
  if (!all.length) {
    // "no busts" and "nothing happened" are different statements, and the
    // controlled events are exactly what distinguishes them.
    for (const line of note) process.stdout.write(line + "\n");
    process.stdout.write("no cold-cache BUSTS in the worktime ledger.\n");
    return 0;
  }
  const atI = args.indexOf("--at");
  const explicit = atI >= 0;
  let bust = all[0];
  if (explicit) {
    const raw = args[atI + 1] ?? "";
    const want = /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
    bust = all.reduce((best, b) =>
      Math.abs(b.t - want) < Math.abs(best.t - want) ? b : best, all[0]);
  }
  const r = triage(bust);
  if (json) {
    // `newest` rides the JSON so a consumer can see the substitution too — the
    // whole failure was that it happened invisibly.
    process.stdout.write(JSON.stringify(
      { ...r, newest: events[0] ?? null, fellBack: !explicit && note.length > 0 }, null, 2) + "\n");
    return 0;
  }

  if (!explicit && note.length) process.stdout.write("\n" + note.join("\n") + "\n");
  process.stdout.write(`\nbust-triage — ${fmt(bust.t)}  ${Math.round(bust.cc / 1000)}k re-written  session ${bust.s.slice(0, 8)}\n\n`);
  for (const s of r.steps) {
    process.stdout.write(`  ${s.ok ? "OK  " : "WARN"}  ${s.step.padEnd(11)} ${s.detail}\n`);
  }
  process.stdout.write(`\n  VERDICT: ${r.verdict}\n  ${r.why}\n`);
  if (r.verdict === "UNCLASSIFIED") {
    process.stdout.write(
      "\n  An unclassified bust is a NEW CLASS until shown otherwise. Book it as a\n" +
      "  threat-matrix row before it is explained away — the matrix records, the\n" +
      "  gate enforces, and a class with no row is a class nothing watches.\n");
  }
  process.stdout.write("\n");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--selftest")) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    // classToRow must NOT invent a row — an unknown class stays unclassified,
    // which is the whole point of the third answer.
    eq(classToRow("append-only", null), null, "append-only maps nowhere");
    eq(classToRow("identical", null), null, "identical maps nowhere");
    eq(classToRow("reorder-only", null), null, "unknown class stays unclassified");
    eq(classToRow("splice/insert-mid", null), 1, "splice -> row 1");
    eq(classToRow("replace/edit", null), 4, "replace/edit -> row 4");
    eq(classToRow("append-only", { host: 3, verdict: "EXACT" }), 4, "migration wins -> row 4");
    // retraction + cause-upgrade handling, on a synthetic ledger
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "bt-"));
    const p = join(d, "a.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "cold", k: "hit", t: 100, s: "S", cc: 1000, cause: "other" }),
      JSON.stringify({ type: "cold", k: "hit-cause", hit_t: 100, s: "S", cause: "messages_changed" }),
      JSON.stringify({ type: "cold", k: "hit", t: 200, s: "S", cc: 2000, cause: "idle" }),
      JSON.stringify({ type: "cold", k: "hit-retract", hit_t: 200, s: "S" }),
    ].join("\n") + "\n");
    const got = busts(p);
    eq(got.length, 1, "retracted hit must not be listed");
    eq(got[0].t, 100, "surviving hit");
    eq(got[0].cause, "messages_changed", "hit-cause marker must upgrade the cause");
    // matrixRow reads a real row and detects OPEN
    const r4 = matrixRow(4);
    eq(r4 !== null, true, "row 4 readable");
    eq(r4.open, true, "row 4 is currently OPEN (re-opened 2026-07-31)");
    process.stdout.write("bust-triage: selftest passed\n");
    process.exit(0);
  }
  process.exit(main(process.argv));
}
