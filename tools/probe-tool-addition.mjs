#!/usr/bin/env node
// probe-tool-addition — measure, per model, whether the API accepts the
// mid-conversation-tool-changes contract (tool_addition blocks).
//
// Exists because the allowlist in deferred-tool-rewrite.mjs is opt-in with
// evidence required, and the evidence was collected the expensive way once:
// the extension announced additions to every model, and on 2026-07-28 a
// sonnet-5 dispatch died with
//
//     API Error: 400 tool_addition/tool_removal is not supported on this model
//
// after which TOOL_ADDITION_MODELS was cut to the one model with wire
// evidence. This script is the cheap way: one minimal real request per model,
// same auth path production uses (the CC OAuth credentials the proxy keeps
// fresh), wire shapes IMPORTED from the extension rather than re-typed here —
// a probe that hand-rolls the shape tests the probe author's memory, not the
// contract (the identity-key lesson, again).
//
// Direct to the API, not through the proxy — deliberately. The question is a
// property of the API endpoint per model, and the proxy would wrap the probe
// in session state, capture records and telemetry that all describe traffic
// no session sent. The directive's "one live request through the proxy"
// acceptance step remains what it is: end-to-end validation of the EXTENSION,
// done once per gate flip. This measures the MODEL support matrix.
//
// Three answers per model, never two:
//   ACCEPTED  — HTTP 200 with the addition block on the wire
//   REJECTED  — HTTP 400 naming tool_addition/tool_removal
//   COULD NOT VERIFY — anything else (auth failure, rate limit, network,
//               unrelated 400); reported verbatim, never classified, and the
//               process exits non-zero so a broken probe cannot read as a
//               clean sweep.
//
// KNOWN LIMIT (measured 2026-07-29): on a subscription OAuth token, this
// direct-API probe gets HTTP 429 for EVERY big model (opus, sonnet, fable)
// regardless of quota state — hand-built requests are refused for those
// models; only haiku answers, because CC itself sends it free-form utility
// traffic. For big models the working probe is a real session: start a
// throwaway proxy with CACHE_FIX_TOOL_ADDITION_EXTRA=<model> on a spare
// port, run `claude --model <model> -p` through it with a prompt that loads
// a tool via ToolSearch, then verify on production's capture that the
// injected block was forwarded byte-identically (replay the pipeline,
// compare against the outcome record's outSha) and that an outcome record
// exists (only written on a streamed 200). That is how fable-5 was measured.
//
// An ACCEPTED verdict is the evidence an allowlist entry cites (prefix +
// probe date); nothing is edited automatically.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  buildToolAdditionMessage,
  injectAdditions,
  forwardedTools,
  anchorHash,
  addBetaToken,
} from "../proxy/extensions/deferred-tool-rewrite.mjs";

const API = "https://api.anthropic.com/v1/messages";

// The current Claude lineup as CC sends it. Override: pass model ids as argv.
const DEFAULT_MODELS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001",
];

async function accessToken() {
  const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf-8");
  const c = JSON.parse(raw);
  const o = c.claudeAiOauth ?? c;
  if (!o.accessToken) throw new Error(".credentials.json carries no accessToken");
  if (o.expiresAt && o.expiresAt < Date.now()) {
    throw new Error("access token expired — start a Claude Code session to refresh it");
  }
  return o.accessToken;
}

function probeBody(model) {
  // Two tools: one present from the start, one "added mid-conversation" via
  // the real builders. forwardedTools marks the added one defer_loading; the
  // addition message is injected at its anchor exactly as onRequest does.
  const toolA = {
    name: "echo_base",
    description: "Echo the input string.",
    input_schema: { type: "object", properties: { s: { type: "string" } }, required: ["s"] },
  };
  const toolB = {
    name: "echo_added",
    description: "Echo the input string (added mid-conversation).",
    input_schema: { type: "object", properties: { s: { type: "string" } }, required: ["s"] },
  };
  const user = { role: "user", content: "Reply with the single word ok. Do not use tools." };
  const additions = [
    {
      names: [toolB.name],
      anchorHash: anchorHash(user),
      message: buildToolAdditionMessage([toolB.name]),
    },
  ];
  const { messages } = injectAdditions([user], additions);
  return {
    model,
    max_tokens: 16,
    messages,
    tools: forwardedTools([toolA, toolB], additions),
  };
}

async function probe(model, token) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    authorization: `Bearer ${token}`,
  };
  addBetaToken(headers); // the same token the extension puts on real traffic
  let res, text;
  try {
    res = await fetch(API, { method: "POST", headers, body: JSON.stringify(probeBody(model)) });
    text = await res.text();
  } catch (e) {
    return { model, verdict: "COULD NOT VERIFY", detail: `network: ${e?.message ?? e}` };
  }
  if (res.status === 200) return { model, verdict: "ACCEPTED", detail: "HTTP 200" };
  if (res.status === 400 && /tool_addition|tool_removal/.test(text)) {
    return { model, verdict: "REJECTED", detail: text.slice(0, 200) };
  }
  return { model, verdict: "COULD NOT VERIFY", detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
const token = await accessToken();
let unverified = 0;
console.log(`probing ${models.length} model(s) against ${API}\n`);
for (const m of models) {
  const r = await probe(m, token);
  if (r.verdict === "COULD NOT VERIFY") unverified++;
  console.log(`${r.verdict.padEnd(18)} ${m}`);
  if (r.verdict !== "ACCEPTED") console.log(`                   ${r.detail}\n`);
}
if (unverified) {
  console.error(`\n${unverified} model(s) COULD NOT be verified — that is not a verdict either way.`);
  process.exit(1);
}
