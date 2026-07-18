#!/usr/bin/env node
// update-rates.mjs — refresh tools/rates.json from Anthropic's public pricing page.
//
// Fetches the pricing doc, parses the model-pricing table (input / 5m-write /
// 1h-write / cache-read / output, all $/MTok), maps display names to the wire
// model identifiers the proxy actually sees, and rewrites tools/rates.json.
//
// This is a DOLLAR-billing input for the session-budget-breaker cost lever, so
// the intended workflow is fetch → write → open a PR for human review, NOT a
// silent auto-commit to main. The companion cron does the fetch + PR; this
// script only writes the file locally and reports what changed.
//
// Standalone (no Claude-harness tools): plain HTTPS via fetch(). Fast mode and
// batch pricing are deliberately NOT captured — the proxy can't see the speed
// flag from the usage block (see the fast-mode-cost tracking issue). This
// records STANDARD, non-batch, global list pricing only.
//
// Exit codes: 0 = wrote a change, 10 = no change (rates already current),
// 1 = fetch/parse failure (rates.json left untouched).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RATES_PATH = join(__dirname, "rates.json");

// Display-name (as shown in the pricing table) → wire model identifier(s) the
// proxy sees on the request. One display row can map to several wire ids (a
// bare alias plus a dated snapshot). Only models we care to price are listed;
// unlisted rows are ignored. Keep this in sync as Anthropic ships models — an
// unmapped new model just won't be priced (fail-open in the breaker).
const NAME_TO_WIRE = {
  "Claude Fable 5": ["claude-fable-5"],
  "Claude Mythos 5": ["claude-mythos-5"],
  "Claude Opus 4.8": ["claude-opus-4-8"],
  "Claude Opus 4.7": ["claude-opus-4-7"],
  "Claude Opus 4.6": ["claude-opus-4-6"],
  "Claude Opus 4.5": ["claude-opus-4-5-20251101"],
  "Claude Opus 4.1": ["claude-opus-4-1-20250805"],
  "Claude Opus 4": ["claude-opus-4-20250514"],
  "Claude Sonnet 5": ["claude-sonnet-5"],
  "Claude Sonnet 4.6": ["claude-sonnet-4-6"],
  "Claude Sonnet 4.5": ["claude-sonnet-4-5-20250929"],
  "Claude Sonnet 4": ["claude-sonnet-4-20250514"],
  "Claude Haiku 4.5": ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  "Claude Haiku 3.5": ["claude-haiku-3-5-20241022"],
  "Claude 3 Opus": ["claude-3-opus-20240229"],
  "Claude 3 Haiku": ["claude-3-haiku-20240307"],
};

function money(s) {
  const m = /\$([0-9]+(?:\.[0-9]+)?)/.exec(s);
  return m ? parseFloat(m[1]) : null;
}

// Parse the HTML model-pricing table. Rows look like:
//   ...>Claude Fable 5</td><td ...>$10 / MTok</td><td ...>$12.50 / MTok</td>
//      <td ...>$20 / MTok</td><td ...>$1 / MTok</td><td ...>$50 / MTok</td>
// Columns in order: Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output.
function parsePricing(html) {
  const out = {};
  for (const [display, wireIds] of Object.entries(NAME_TO_WIRE)) {
    // Find the model name in a <td>, then grab the next five $-bearing cells.
    // Tolerate a trailing footnote link Anthropic appends to some names, but
    // the char right after the name must NOT be a version continuation
    // ([.0-9]) — otherwise "Claude Opus 4" would prefix-match the "Claude Opus
    // 4.8" row and steal its prices (real bug caught in review). So require the
    // name to be followed by whitespace, "<" (tag/footnote), or "/" (retired),
    // never a digit or dot.
    // Anchor on the name (NOT followed by [.0-9], so "Claude Opus 4" can't grab
    // the "Claude Opus 4.8" row), then allow the rest of the name cell —
    // including any footnote <a>…</a> link and the closing </td> — up to the
    // first price cell. Capture from the first "$…/ MTok" cell through the next
    // five cells (input | 5m | 1h | read | output). Non-greedy on the gap so we
    // stop at THIS row's first price, not a later row's.
    const escaped = display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      escaped + "(?![.0-9]).*?<td[^>]*>\\s*(\\$[^<]*<\\/td>(?:\\s*<td[^>]*>[^<]*<\\/td>){4})",
    );
    const m = re.exec(html);
    if (!m) continue; // unmatched model → skip (leaves existing entry untouched)
    // Extract the five $-values from the captured span, in column order:
    // input | 5m-write | 1h-write | cache-read | output.
    const vals = [...m[1].matchAll(/\$([0-9][0-9.]*)/g)].map((s) => parseFloat(s[1]));
    const [input, w5m, w1h, read, output] = vals;
    if (vals.length !== 5 || [input, w5m, w1h, read, output].some((v) => v === undefined)) continue;
    for (const id of wireIds) {
      out[id] = { input, output, cache_read: read, cache_write_5m: w5m, cache_write_1h: w1h };
    }
  }
  return out;
}

async function main() {
  let html;
  try {
    const res = await fetch(PRICING_URL, {
      headers: { "user-agent": "cache-fix-proxy rates-updater (+https://github.com/cnighswonger/claude-code-cache-fix)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    process.stderr.write(`[update-rates] fetch failed: ${err.message} — rates.json untouched\n`);
    process.exit(1);
  }

  const parsed = parsePricing(html);
  const n = Object.keys(parsed).length;
  if (n < 5) {
    // Sanity floor: the page always lists well over 5 models. A tiny count means
    // the markup changed and our parser is broken — do NOT overwrite good data.
    process.stderr.write(`[update-rates] only parsed ${n} models (markup likely changed) — rates.json untouched\n`);
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(RATES_PATH, "utf8"));
  // Merge: update parsed models, preserve any existing entries the parser didn't
  // find (e.g. a model dropped from the page but still referenced), and keep
  // per-entry "note" fields.
  const merged = { ...current.models };
  for (const [id, rates] of Object.entries(parsed)) {
    const prevNote = merged[id] && merged[id].note;
    merged[id] = prevNote ? { ...rates, note: prevNote } : rates;
  }

  const next = {
    last_updated: new Date().toISOString().slice(0, 10),
    source: PRICING_URL,
    notes: current.notes,
    models: merged,
  };

  const before = JSON.stringify(current.models);
  const after = JSON.stringify(merged);
  if (before === after) {
    process.stderr.write(`[update-rates] no change (${n} models parsed, rates already current)\n`);
    process.exit(10);
  }

  writeFileSync(RATES_PATH, JSON.stringify(next, null, 2) + "\n");
  process.stderr.write(`[update-rates] wrote rates.json (${n} models parsed; content changed)\n`);
  process.exit(0);
}

main();
