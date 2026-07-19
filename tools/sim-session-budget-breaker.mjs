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

const reqCtx = () => ({ headers: { "x-claude-code-session-id": SID }, body: { model: MODEL, stream: true } });
const startEvent = () => ({
  headers: { "x-claude-code-session-id": SID },
  responseHeaders: {},
  event: { type: "message_start", message: { model: MODEL, usage: {
    input_tokens: LEG_INPUT, cache_creation_input_tokens: LEG_CACHE_CREATION,
    output_tokens: 0, cache_read_input_tokens: 0,
  } } },
});

// Discrete-event sim over a virtual clock. Events: DISPATCH (client sends the
// request → onRequest gate) and ACCRUE (response lands → onStreamEvent tally).
// A slot is reserved at dispatch; released immediately on a block (no upstream),
// or LATENCY_MS later at accrue (the request went upstream and returned).
async function runFanout({ concurrency, gate = "on", env = {} }) {
  ext.__testOnly.reset();
  for (const k of Object.keys(process.env)) if (k.startsWith("CACHE_FIX_SESSION_BUDGET")) delete process.env[k];
  process.env.CACHE_FIX_SESSION_BUDGET = gate;
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  VCLOCK = 0;
  let inflight = 0, nextLeg = 0, seq = 0;
  let forwarded = 0, blocked = 0, sawBlock = false;
  let firstBlockLegNo = null, tokensAtFirstBlock = null, costAtFirstBlock = null, timeAtFirstBlock = null;
  let maxTokens = 0, maxCost = 0;

  const q = [];
  const push = (time, kind) => q.push({ time, seq: seq++, kind });
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
      const r = await ext.onRequest(reqCtx());
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
        push(VCLOCK + LATENCY_MS, "ACCRUE");
      }
    } else {
      await ext.onStreamEvent(startEvent());
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
  for (const k of Object.keys(process.env)) if (k.startsWith("CACHE_FIX_SESSION_BUDGET")) delete process.env[k];
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

  console.log("\n" + line);
  console.log(failures === 0 ? "SIM RESULT: PASS — #68285 fan-out is demonstrably capped." : `SIM RESULT: FAIL — ${failures} check(s) failed.`);
  console.log(line);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
