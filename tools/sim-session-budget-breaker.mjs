// sim-session-budget-breaker.mjs — #68285 fan-out sim (directive merge gate).
//
// Drives the REAL session-budget-breaker extension hooks (onRequest +
// onStreamEvent) through a deterministic discrete-event model of a workflow
// fan-out that shares one session id, and measures the overshoot for the
// cumulative (TOKENS/COST) and rate (RATE_TPM) levers.
//
// Why a model and not a live 700-subagent run: the thing under test is a
// spend-cap; actually firing the #68285 runaway would burn the very credits it
// exists to protect. Instead we replay the fan-out's PATTERN — N legs sharing
// one session, premium-tier token draw per leg, near-simultaneous dispatch with
// a bounded concurrency window — against the actual extension code, with a
// virtual clock so the rate-lever slope math is exercised deterministically.
//
// The model reproduces the concurrency-overshoot mechanism exactly: a request
// is gated at onRequest BEFORE its tokens are known, and its tokens only land
// at onStreamEvent one round-trip later. So every leg already in flight when the
// ceiling is crossed has passed the gate and will still accrue — that in-flight
// batch IS the overshoot. Run: node tools/sim-session-budget-breaker.mjs

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Point the fire-event log at a temp file BEFORE importing the extension. The
// sim provokes thousands of blocks by design, and the extension's default log
// path is the OPERATOR's ~/.claude/session-budget-events.jsonl — a single sim
// run otherwise appends ~12k synthetic "wf-68285-runaway" events to a real
// developer's log, enough to trigger its 5 MB rotation on pure noise and make a
// genuine first fire look like it has history. Diagnostics belong in the
// console output below, not in the operator's event log.
const SIM_EVENT_LOG = join(tmpdir(), `sbb-sim-${process.pid}.jsonl`);
process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG = SIM_EVENT_LOG;
process.on("exit", () => { try { rmSync(SIM_EVENT_LOG, { force: true }); } catch {} });

// Clear every scenario knob between runs, then restore the log override — a bare
// CACHE_FIX_SESSION_BUDGET* wipe would take _EVENT_LOG with it and silently drop
// the next scenario's events back into the operator's default log.
function resetBudgetEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("CACHE_FIX_SESSION_BUDGET")) delete process.env[k];
  process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG = SIM_EVENT_LOG;
}

import ext from "../proxy/extensions/session-budget-breaker.mjs";

// --- Virtual clock: the extension reads Date.now() in both hooks; drive it. ---
let VCLOCK = 0;
Date.now = () => VCLOCK;

// --- #68285-shaped scenario knobs ---
const SID = "wf-68285-runaway";
const MODEL = "claude-opus-4-6"; // known to this branch's rates.json (input $5 / cw1h $10 per M)
const N_LEGS = 700;              // "700+ subagents" (CC#68285)
const LEG_INPUT = 50_000;        // per-leg input tokens (big premium-tier context)
const LEG_CACHE_CREATION = 100_000; // per-leg cache_creation tokens
const LEG_TOTAL = LEG_INPUT + LEG_CACHE_CREATION; // 150k tokens/leg
const LEG_COST = (LEG_INPUT * 5 + LEG_CACHE_CREATION * 10) / 1_000_000; // $1.25/leg at opus-4-6
const LATENCY_MS = 2000;         // response round-trip per leg

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const usd = (n) => "$" + n.toFixed(2);

const legUsage = () => ({
  input_tokens: LEG_INPUT, cache_creation_input_tokens: LEG_CACHE_CREATION,
  output_tokens: 0, cache_read_input_tokens: 0,
});
const reqCtx = (stream = true) => ({
  headers: { "x-claude-code-session-id": SID },
  body: { model: MODEL, stream },
  meta: { route: "messages" },
});
const startEvent = () => ({
  headers: { "x-claude-code-session-id": SID },
  responseHeaders: {},
  event: { type: "message_start", message: { model: MODEL, usage: legUsage() } },
});
// Non-streaming (stream:false) accrual: server.mjs hands the parsed JSON body to
// onResponse with RESPONSE headers and the SAME meta the request carried.
const jsonResCtx = (meta) => ({
  status: 200,
  headers: {},
  body: { type: "message", model: MODEL, usage: legUsage() },
  meta,
});

// Discrete-event sim over a virtual clock. Events: DISPATCH (client sends the
// request → onRequest gate) and ACCRUE (response lands → onStreamEvent tally).
// A slot is reserved at dispatch; released immediately on a block (no upstream),
// or LATENCY_MS later at accrue (the request went upstream and returned).
// `stream` selects which accrual path the sim exercises: true → onStreamEvent
// (SSE), false → onResponse (the stream:false path Codex r1 found unhooked).
async function runFanout({ concurrency, gate = "on", env = {}, stream = true }) {
  ext.__testOnly.reset();
  resetBudgetEnv();
  process.env.CACHE_FIX_SESSION_BUDGET = gate;
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  VCLOCK = 0;
  let inflight = 0, nextLeg = 0, seq = 0;
  let forwarded = 0, blocked = 0, sawBlock = false;
  let firstBlockLegNo = null, tokensAtFirstBlock = null, costAtFirstBlock = null, timeAtFirstBlock = null;
  let maxTokens = 0, maxCost = 0;

  const q = [];
  const push = (time, kind, meta) => q.push({ time, seq: seq++, kind, meta });
  const pop = () => {
    let bi = 0;
    for (let i = 1; i < q.length; i++)
      if (q[i].time < q[bi].time || (q[i].time === q[bi].time && q[i].seq < q[bi].seq)) bi = i;
    return q.splice(bi, 1)[0];
  };
  const dispatchMore = () => {
    while (inflight < concurrency && nextLeg < N_LEGS) { nextLeg++; push(VCLOCK, "DISPATCH"); inflight++; }
  };

  dispatchMore();
  while (q.length) {
    const ev = pop();
    VCLOCK = ev.time;
    if (ev.kind === "DISPATCH") {
      const ctx = reqCtx(stream);
      const r = await ext.onRequest(ctx);
      if (r && r.skip) {
        blocked++;
        inflight--; // immediate local return, no upstream call, slot freed
        if (!sawBlock) {
          sawBlock = true;
          firstBlockLegNo = forwarded + blocked;
          const e = ext.__testOnly.tally(SID);
          tokensAtFirstBlock = e ? e.tokens : 0;
          costAtFirstBlock = ext.__testOnly.costUsd(SID);
          timeAtFirstBlock = VCLOCK;
        }
        dispatchMore();
      } else {
        forwarded++;
        // Carry this request's meta to its own accrual — that's the channel the
        // non-streaming path uses to recover the session id at onResponse time.
        push(VCLOCK + LATENCY_MS, "ACCRUE", ctx.meta);
      }
    } else {
      if (stream) await ext.onStreamEvent(startEvent());
      else await ext.onResponse(jsonResCtx(ev.meta));
      inflight--;
      const e = ext.__testOnly.tally(SID);
      if (e) { maxTokens = Math.max(maxTokens, e.tokens); maxCost = Math.max(maxCost, e.costUsd); }
      dispatchMore();
    }
  }
  return { concurrency, forwarded, blocked, firstBlockLegNo, tokensAtFirstBlock,
    costAtFirstBlock, timeAtFirstBlock, maxTokens, maxCost,
    finalTokens: ext.__testOnly.tally(SID)?.tokens ?? 0 };
}

async function main() {
  const line = "=".repeat(78);
  console.log(line);
  console.log("SESSION-BUDGET-BREAKER — #68285 FAN-OUT SIM");
  console.log(line);
  console.log(`Scenario: ${fmt(N_LEGS)} legs, one session (${SID}), model ${MODEL}`);
  console.log(`Per leg:  ${fmt(LEG_INPUT)} input + ${fmt(LEG_CACHE_CREATION)} cache_creation = ${fmt(LEG_TOTAL)} tok, ${usd(LEG_COST)}`);
  console.log(`Unbounded: ${fmt(N_LEGS * LEG_TOTAL)} tok, ${usd(N_LEGS * LEG_COST)} across the session (round-trip ${LATENCY_MS}ms/leg)`);

  let failures = 0;
  const check = (cond, msg) => { console.log(`   ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

  // ---- 1) Cumulative TOKENS lever: caps the runaway; overshoot = in-flight batch ----
  const TOKENS_CEIL = 3_000_000; // ≈ 20 legs; unbounded would reach 105,000,000
  console.log(`\n[1] Cumulative TOKENS lever  (ceiling ${fmt(TOKENS_CEIL)} tok ≈ ${Math.round(TOKENS_CEIL / LEG_TOTAL)} legs)`);
  console.log("     concurrency │ forwarded │ blocked │ max tokens │ overshoot beyond ceiling");
  for (const C of [1, 8, 16, 64, N_LEGS]) {
    const r = await runFanout({ concurrency: C, env: { CACHE_FIX_SESSION_BUDGET_TOKENS: TOKENS_CEIL } });
    const overshoot = r.maxTokens - TOKENS_CEIL;
    console.log(`     ${String(C).padStart(11)} │ ${String(r.forwarded).padStart(9)} │ ${String(r.blocked).padStart(7)} │ ${fmt(r.maxTokens).padStart(10)} │ +${fmt(overshoot)} tok (${(overshoot / LEG_TOTAL).toFixed(1)} legs)`);
    if (C === 16) {
      check(r.blocked > 0, "runaway is capped (some legs blocked before upstream)");
      check(r.forwarded < N_LEGS, "not all legs reached Anthropic");
      check(overshoot <= C * LEG_TOTAL, `overshoot ≤ one in-flight batch (${C} × leg) — bounded by concurrency`);
    }
  }

  // ---- 2) COST_USD lever: literal dollar ceiling (API-key case) ----
  const COST_CEIL = 25; // $25; unbounded would reach $875
  console.log(`\n[2] COST_USD lever  (ceiling ${usd(COST_CEIL)} ≈ ${Math.round(COST_CEIL / LEG_COST)} legs; unbounded ${usd(N_LEGS * LEG_COST)})`);
  console.log("     concurrency │ forwarded │ blocked │ max cost │ overshoot beyond ceiling");
  for (const C of [8, 16, 64]) {
    const r = await runFanout({ concurrency: C, env: { CACHE_FIX_SESSION_BUDGET_COST_USD: COST_CEIL } });
    const overshoot = r.maxCost - COST_CEIL;
    console.log(`     ${String(C).padStart(11)} │ ${String(r.forwarded).padStart(9)} │ ${String(r.blocked).padStart(7)} │ ${usd(r.maxCost).padStart(8)} │ +${usd(overshoot)} (${(overshoot / LEG_COST).toFixed(1)} legs)`);
    if (C === 16) check(r.maxCost < N_LEGS * LEG_COST, `cost capped far below unbounded ${usd(N_LEGS * LEG_COST)}`);
  }

  // ---- 3) RATE_TPM lever: fires on the slope — earlier than cumulative ----
  // Rate ceiling set to a "this is way too fast" velocity. It should trip after
  // the first accrual wave regardless of how high a cumulative ceiling would be.
  const RATE_CEIL = 5_000_000; // 5M tok/min
  console.log(`\n[3] RATE_TPM lever  (ceiling ${fmt(RATE_CEIL)} tok/min — the early fan-out catch)`);
  console.log("     concurrency │ forwarded │ blocked │ 1st block @ leg │ tokens @ block");
  for (const C of [8, 16, 64]) {
    const r = await runFanout({ concurrency: C, env: {
      CACHE_FIX_SESSION_BUDGET_RATE_TPM: RATE_CEIL, CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS: 60000 } });
    console.log(`     ${String(C).padStart(11)} │ ${String(r.forwarded).padStart(9)} │ ${String(r.blocked).padStart(7)} │ ${String(r.firstBlockLegNo ?? "—").padStart(15)} │ ${fmt(r.tokensAtFirstBlock ?? 0).padStart(12)}`);
    if (C === 16) check(r.blocked > 0, "rate lever trips on the slope and caps the runaway");
  }

  // ---- 4) Rate vs cumulative: same runaway, which cuts earlier? ----
  console.log(`\n[4] Rate-vs-cumulative on the SAME runaway (concurrency 16)`);
  const cumOnly = await runFanout({ concurrency: 16, env: { CACHE_FIX_SESSION_BUDGET_TOKENS: TOKENS_CEIL } });
  const rateOnly = await runFanout({ concurrency: 16, env: {
    CACHE_FIX_SESSION_BUDGET_RATE_TPM: RATE_CEIL, CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS: 60000 } });
  console.log(`     cumulative TOKENS: 1st block @ leg ${cumOnly.firstBlockLegNo}, ${fmt(cumOnly.tokensAtFirstBlock)} tok, t=${cumOnly.timeAtFirstBlock}ms`);
  console.log(`     RATE_TPM:          1st block @ leg ${rateOnly.firstBlockLegNo}, ${fmt(rateOnly.tokensAtFirstBlock)} tok, t=${rateOnly.timeAtFirstBlock}ms`);
  check(rateOnly.firstBlockLegNo <= cumOnly.firstBlockLegNo,
    "rate lever fires no later than cumulative (fires on the slope, before absolute tokens pile up)");

  // ---- 5) dry-run forwards every leg, blocks nothing ----
  console.log(`\n[5] dry-run (gate=dry-run, TOKENS ceiling set)`);
  const dry = await runFanout({ concurrency: 16, gate: "dry-run", env: { CACHE_FIX_SESSION_BUDGET_TOKENS: TOKENS_CEIL } });
  console.log(`     forwarded ${dry.forwarded}/${N_LEGS}, blocked ${dry.blocked}`);
  check(dry.forwarded === N_LEGS && dry.blocked === 0, "dry-run forwards every leg (would_block logged, none stopped)");

  // ---- 6) Fail-open: gate on, ceiling set, but usage corrupted → nothing blocks ----
  console.log(`\n[6] Fail-open: gate=on, TOKENS ceiling set, every response's usage unparseable`);
  ext.__testOnly.reset();
  resetBudgetEnv();
  process.env.CACHE_FIX_SESSION_BUDGET = "on";
  process.env.CACHE_FIX_SESSION_BUDGET_TOKENS = "10";
  VCLOCK = 0;
  let foForwarded = 0, foBlocked = 0;
  for (let i = 0; i < N_LEGS; i++) {
    await ext.onStreamEvent({ headers: { "x-claude-code-session-id": SID },
      event: { type: "message_start", message: { model: MODEL, usage: { input_tokens: "not-a-number" } } } });
    const r = await ext.onRequest(reqCtx());
    if (r && r.skip) foBlocked++; else foForwarded++;
    VCLOCK += 10;
  }
  console.log(`     forwarded ${foForwarded}/${N_LEGS}, blocked ${foBlocked}`);
  check(foForwarded === N_LEGS && foBlocked === 0, "corrupted usage → tally never updates → every leg forwards (fail-open)");

  // Codex review r1 blocker: the breaker originally learned spend only from
  // onStreamEvent, so a stream:false fan-out accrued nothing and every leg
  // forwarded. Same runaway, same ceiling, driven through onResponse instead.
  console.log(`\n[7] Non-streaming fan-out (stream:false → onResponse accrual), TOKENS ceiling`);
  console.log(`     concurrency │ forwarded │ blocked │ max tokens`);
  const nsRows = [];
  for (const c of [1, 16]) {
    const r = await runFanout({ concurrency: c, stream: false,
      env: { CACHE_FIX_SESSION_BUDGET_TOKENS: TOKENS_CEIL } });
    nsRows.push(r);
    console.log(`     ${String(c).padStart(11)} │ ${String(r.forwarded).padStart(9)} │ ${String(r.blocked).padStart(7)} │ ${fmt(r.maxTokens).padStart(10)}`);
  }
  check(nsRows.every((r) => r.blocked > 0), "stream:false runaway is capped too (onResponse accrual wired)");
  check(nsRows.every((r) => r.forwarded < N_LEGS), "not all stream:false legs reached Anthropic");
  // Same ceiling, same runaway, only the accrual hook differs — the two modes
  // must cap at the same leg, or one of them is a bypass.
  const sSerial = await runFanout({ concurrency: 1, stream: true,
    env: { CACHE_FIX_SESSION_BUDGET_TOKENS: TOKENS_CEIL } });
  check(nsRows[0].forwarded === sSerial.forwarded,
    `stream:false caps at the same leg as streaming (${nsRows[0].forwarded} vs ${sSerial.forwarded}) — no mode-dependent bypass`);

  console.log("\n" + line);
  console.log(failures === 0 ? "SIM RESULT: PASS — #68285 fan-out is demonstrably capped." : `SIM RESULT: FAIL — ${failures} check(s) failed.`);
  console.log(line);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
