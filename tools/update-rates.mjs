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
// FAIL CLOSED. The failure mode that matters for a money-path config is a
// plausible-looking WRONG number, not a crash. Every uncertainty below aborts
// without touching rates.json: a missing required model, a price outside a sane
// range, cache multipliers that don't match the documented formula, or a model
// whose row can't be unambiguously resolved to today's effective pricing.
//
// Exit codes: 0 = wrote a change, 10 = no change (rates already current),
// 1 = fetch/parse/validation failure (rates.json left untouched).

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RATES_PATH = join(__dirname, "rates.json");

// The page is ~1 MB of HTML. 8 MB is generous headroom while still bounding an
// unexpected body (a redirected CDN error page, a mis-served binary).
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Display-name (as shown in the pricing table) → wire model identifier(s) the
// proxy sees on the request. One display row can map to several wire ids (a
// bare alias plus a dated snapshot). Only models we care to price are listed;
// unlisted rows are ignored. Keep this in sync as Anthropic ships models — an
// unmapped new model just won't be priced (fail-open in the breaker).
const NAME_TO_WIRE = {
  "Claude Fable 5": ["claude-fable-5"],
  "Claude Mythos 5": ["claude-mythos-5"],
  "Claude Opus 5": ["claude-opus-5"],
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

// Models whose absence would price CURRENT sessions at zero. That is the
// membership rule — not "every model we know about" and not "every model on the
// page". If one of these is missing from a parse, the run aborts rather than
// writing a file that silently under-counts live traffic.
//
// OWNERSHIP: whoever adds a model to the proxy's live traffic owns adding it
// here, and whoever retires one owns removing it. A rename or retirement
// upstream will hard-fail every refresh until this list is updated in-tree —
// that is the intended trade-off (a loud stop beats a quiet wrong price), but it
// means the list is a maintenance obligation, not a set-and-forget constant.
// Deliberately NOT the full NAME_TO_WIRE set: retired models legitimately drop
// off the page, and requiring them would make the fetcher fail permanently on a
// normal upstream change.
const REQUIRED_WIRE_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

// Sanity band for a per-MTok list price, in dollars. Nothing Anthropic has ever
// published sits outside this; a value that does means we parsed the wrong cell
// (a token count, a percentage, a footnote number) and must not be written.
const MIN_PRICE = 0.01;
const MAX_PRICE = 2000;

// Documented cache multipliers (see the pricing page's prompt-caching section),
// checked per row. This catches a column-order change or cells lifted from the
// wrong row. It is NOT semantic validation: a wrong-but-plausible row that
// happens to satisfy these ratios and the range band below will still pass.
// Treat these as guards against structural misparses, not proof of correctness —
// the human PR review is what confirms the numbers are actually right.
const MULTIPLIERS = { cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 };
// Published prices are rounded to the cent, so an exact multiplier check would
// reject legitimate rows. Allow a cent of slack either way.
const MULTIPLIER_EPSILON = 0.011;

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Parse "August 31, 2026" → UTC ms. Returns null if not a date we recognize.
//
// The page states these dates without a timezone, so UTC midnight is an
// assumption, not a documented fact. Practical effect at the 2026-08-31 →
// 09-01 Sonnet 5 cutover: a run in the hours after 09-01T00:00Z adopts the
// higher rate slightly before a US-business-timezone reading would. That errs
// toward over-estimating spend, which is the safe direction for a ceiling, and
// any such refresh still lands as a reviewable PR diff rather than silently.
function parseDate(monthName, day, year) {
  const m = MONTHS[monthName.toLowerCase()];
  if (m === undefined) return null;
  return Date.UTC(Number(year), m, Number(day));
}

// A model can appear on more than one row when pricing changes on a known date
// (as Claude Sonnet 5 does: introductory pricing through 2026-08-31, standard
// pricing from 2026-09-01). Extract that qualifier from the name cell so the
// right row can be picked for the fetch date. `null` window bound = open-ended.
function effectiveWindow(nameCell) {
  const through = /through\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(nameCell);
  const starting = /starting\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(nameCell);
  const win = { from: null, until: null, qualified: false };
  if (through) {
    // "through August 31, 2026" is inclusive of that day.
    const d = parseDate(through[1], through[2], through[3]);
    if (d === null) return null; // unrecognized date → caller treats as ambiguous
    win.until = d + 24 * 60 * 60 * 1000 - 1;
    win.qualified = true;
  }
  if (starting) {
    const d = parseDate(starting[1], starting[2], starting[3]);
    if (d === null) return null;
    win.from = d;
    win.qualified = true;
  }
  return win;
}

function windowCovers(win, atMs) {
  if (win.from !== null && atMs < win.from) return false;
  if (win.until !== null && atMs > win.until) return false;
  return true;
}

// Split the page into table rows and reduce each to plain-text cells. Tag
// stripping happens per cell, so a footnote link inside a name cell collapses
// into the surrounding text rather than truncating the cell.
function tableRows(html) {
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((c) => c[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

const PRICE_CELL = /^\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*\/\s*MTok$/;

// A model-pricing row is exactly: name cell + the five price columns
// (input | 5m write | 1h write | cache read | output). This shape requirement is
// what keeps the batch-pricing table (two price cells) and the tool-use table
// (token counts, not prices) from being mistaken for pricing rows — the old
// first-match-anywhere scan had no such guard.
function priceRow(cells) {
  if (cells.length !== 6) return null;
  const vals = [];
  for (let i = 1; i < 6; i++) {
    const m = PRICE_CELL.exec(cells[i]);
    if (!m) return null;
    vals.push(parseFloat(m[1].replace(/,/g, "")));
  }
  const [input, w5m, w1h, read, output] = vals;
  return { name: cells[0], input, output, cache_read: read, cache_write_5m: w5m, cache_write_1h: w1h };
}

// Does this row's name cell name this model — as opposed to a longer model whose
// name it prefixes? "Claude Opus 4" must not claim the "Claude Opus 4.8" row, so
// the character after the name may not continue a version number.
function namesModel(nameCell, display) {
  if (!nameCell.startsWith(display)) return false;
  const next = nameCell.charAt(display.length);
  return next === "" || !/[.0-9]/.test(next);
}

// Validate one row's numbers before it can reach rates.json. Returns an error
// string (fail closed) or null when the row is trustworthy.
function validateRates(wireId, r) {
  for (const [field, v] of Object.entries(r)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return `${wireId}.${field} is not a finite number`;
    if (v < MIN_PRICE || v > MAX_PRICE) return `${wireId}.${field}=${v} outside sane range $${MIN_PRICE}–$${MAX_PRICE}`;
  }
  for (const [field, mult] of Object.entries(MULTIPLIERS)) {
    const expected = r.input * mult;
    if (Math.abs(r[field] - expected) > MULTIPLIER_EPSILON) {
      return `${wireId}.${field}=${r[field]} contradicts the documented ${mult}x input multiplier ` +
        `(input=${r.input} → expected ${expected.toFixed(4)})`;
    }
  }
  if (r.output < r.input) return `${wireId} output=${r.output} < input=${r.input} (columns likely swapped)`;
  return null;
}

// Parse the model-pricing table. `atMs` is the effective date used to pick
// between dated variants of the same model. Returns { rates, errors }.
export function parsePricing(html, atMs = Date.now()) {
  const rows = tableRows(html).map(priceRow).filter(Boolean);
  const rates = {};
  const errors = [];

  for (const [display, wireIds] of Object.entries(NAME_TO_WIRE)) {
    const candidates = rows.filter((r) => namesModel(r.name, display));
    if (!candidates.length) continue; // absent from the page → REQUIRED check decides

    // A row's effective-date qualifier is binding regardless of how many rows
    // the model has. A lone "starting September 1, 2026" row read in August is
    // NOT today's price, and accepting it because it had no sibling would be the
    // same silent-wrong-number failure the duplicate branch exists to prevent.
    const windows = candidates.map((r) => ({ row: r, win: effectiveWindow(r.name) }));
    const dated = windows.filter((w) => w.win === null || w.win.qualified);
    const undated = windows.filter((w) => w.win !== null && !w.win.qualified);

    let chosen;
    if (!dated.length) {
      // No row carries a date qualifier. Exactly one is the normal case; more
      // than one is unexplained duplication we refuse to resolve.
      if (undated.length > 1) {
        errors.push(`${display}: ${undated.length} pricing rows and none carries a parseable ` +
          `effective-date qualifier — refusing to guess (rows: ${candidates.map((c) => JSON.stringify(c.name)).join(", ")})`);
        continue;
      }
      chosen = undated[0].row;
    } else if (undated.length) {
      // Mixing a dated row with an undated one for the same model is ambiguous:
      // we cannot tell whether the undated row is the fallback or a stale entry.
      errors.push(`${display}: mixes ${dated.length} dated and ${undated.length} undated pricing ` +
        `row(s) — refusing to guess (rows: ${candidates.map((c) => JSON.stringify(c.name)).join(", ")})`);
      continue;
    } else {
      // Every candidate is dated (or carries a qualifier we could not parse).
      // A qualifier we failed to parse is itself disqualifying — it may well be
      // the one that says this row isn't in effect.
      const unparseable = dated.filter((w) => w.win === null);
      if (unparseable.length) {
        errors.push(`${display}: ${unparseable.length} row(s) carry an effective-date qualifier in a ` +
          `format this parser does not recognize — refusing to guess ` +
          `(rows: ${candidates.map((c) => JSON.stringify(c.name)).join(", ")})`);
        continue;
      }
      const active = dated.filter((w) => windowCovers(w.win, atMs));
      if (active.length !== 1) {
        errors.push(`${display}: ${active.length} of ${dated.length} dated rows are in effect on ` +
          `${new Date(atMs).toISOString().slice(0, 10)} — expected exactly 1 ` +
          `(rows: ${candidates.map((c) => JSON.stringify(c.name)).join(", ")})`);
        continue;
      }
      chosen = active[0].row;
    }

    const { name, ...r } = chosen;
    for (const id of wireIds) {
      const err = validateRates(id, r);
      if (err) { errors.push(err); continue; }
      rates[id] = { ...r };
    }
  }

  for (const id of REQUIRED_WIRE_IDS) {
    if (!rates[id]) errors.push(`required model "${id}" missing from the parse`);
  }
  return { rates, errors };
}

async function fetchPricing() {
  const res = await fetch(PRICING_URL, {
    headers: { "user-agent": "cache-fix-proxy rates-updater (+https://github.com/cnighswonger/claude-code-cache-fix)" },
    signal: AbortSignal.timeout(20000),
    redirect: "error", // a redirect off this host would change what we're trusting
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|text\/markdown/i.test(ctype)) {
    throw new Error(`unexpected content-type ${JSON.stringify(ctype)}`);
  }
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    throw new Error(`body too large (content-length ${len} > ${MAX_BODY_BYTES})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new Error(`body too large (${buf.byteLength} > ${MAX_BODY_BYTES})`);
  }
  return buf.toString("utf8");
}

async function main() {
  let html;
  try {
    html = await fetchPricing();
  } catch (err) {
    process.stderr.write(`[update-rates] fetch failed: ${err.message} — rates.json untouched\n`);
    process.exit(1);
  }

  const { rates, errors } = parsePricing(html);
  if (errors.length) {
    process.stderr.write(`[update-rates] parse validation failed — rates.json untouched:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(RATES_PATH, "utf8"));
  // Merge: update parsed models, preserve any existing entries the parser didn't
  // find (e.g. a model dropped from the page but still referenced), and keep
  // per-entry "note" fields.
  const merged = { ...current.models };
  for (const [id, r] of Object.entries(rates)) {
    const prevNote = merged[id] && merged[id].note;
    merged[id] = prevNote ? { ...r, note: prevNote } : r;
  }

  const n = Object.keys(rates).length;
  const before = JSON.stringify(current.models);
  const after = JSON.stringify(merged);
  if (before === after) {
    process.stderr.write(`[update-rates] no change (${n} models parsed, rates already current)\n`);
    process.exit(10);
  }

  const next = {
    last_updated: new Date().toISOString().slice(0, 10),
    source: PRICING_URL,
    notes: current.notes,
    models: merged,
  };

  // Write-then-rename: an interrupted run must not leave a truncated pricing
  // file behind, since a half-written rates.json is a money-path corruption.
  const tmp = RATES_PATH + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, RATES_PATH);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    process.stderr.write(`[update-rates] write failed: ${err.message} — rates.json untouched\n`);
    process.exit(1);
  }
  process.stderr.write(`[update-rates] wrote rates.json (${n} models parsed; content changed)\n`);
  process.exit(0);
}

// Importable for tests; only fetches when run as a script.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
