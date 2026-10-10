import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePricing } from "../tools/update-rates.mjs";

// tools/rates.json prices the session-budget-breaker _COST_USD lever, which for
// direct-API-key users is a literal dollar ceiling. The failure mode that
// matters is a plausible-looking WRONG number, so these tests are mostly about
// what the parser REFUSES to emit. Fixture is the <table> blocks of the real
// pricing page as of 2026-07-27, with the Claude Opus 5.5 and Claude Sonnet 5.5
// rows copied in from the later live page — neither had shipped on 2026-07-27.
//
// pricing-page-2026-09-28.html is the model-pricing <table> of the live page as
// of 2026-09-28, fetched through update-rates' own fetchPricing (817995 bytes,
// sha256 94e6c8aca38da16741bb160c8339b34d6164b8de954a6f4225927da22f5bc91a) with
// every other block dropped. It has TWO header rows and a different column
// order from the 2026-07-27 page (Output right after Input, before the cache
// columns).
//
// pricing-page-2026-10-10.html is the model-pricing <table> of the live page as
// of 2026-10-10, fetched through the proxy (1135336 bytes, sha256
// 919f8fcf0e1d280c2a0df977ab7319c0b71d7e110cf9f01f1c2cb074e7e3fa6e) with every
// other block dropped. It is the newest page, so the checked-in rates.json is
// compared against it. The older fixtures keep what their pages said: Sonnet
// 5.5 cache reads at $0.20/MTok there, $0.10/MTok here.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, "fixtures", "pricing-page-2026-07-27.html"), "utf8");
const LIVE_0928 = readFileSync(join(__dirname, "fixtures", "pricing-page-2026-09-28.html"), "utf8");
const LIVE_1010 = readFileSync(join(__dirname, "fixtures", "pricing-page-2026-10-10.html"), "utf8");
const D1010 = Date.parse("2026-10-10T12:00:00Z");

// Prices are read in the column order the table's own header names, so every
// inline table below carries a header row (a table without one yields no rows).
const HEAD = "<tr><th>Model</th><th>Input</th><th>5m</th><th>1h</th><th>Hits</th><th>Output</th></tr>";

const AUG = Date.parse("2026-08-15T12:00:00Z"); // introductory Sonnet 5 window
const SEP = Date.parse("2026-09-15T12:00:00Z"); // standard Sonnet 5 window

test("parses the real pricing page with no validation errors", () => {
  const { rates, errors } = parsePricing(FIXTURE, AUG);
  assert.deepEqual(errors, [], "real markup must parse clean");
  assert.ok(Object.keys(rates).length >= 15, "should price every mapped model on the page");
});

test("prices the models live traffic actually uses", () => {
  const { rates } = parsePricing(FIXTURE, AUG);
  // claude-opus-5 was absent from the original NAME_TO_WIRE map, so the cost
  // lever silently priced it at zero while it was serving real traffic.
  assert.deepEqual(rates["claude-opus-5"],
    { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 });
  assert.deepEqual(rates["claude-opus-4-7"],
    { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 });
  assert.deepEqual(rates["claude-fable-5"],
    { input: 10, output: 50, cache_read: 1, cache_write_5m: 12.5, cache_write_1h: 20 });
  assert.deepEqual(rates["claude-haiku-4-5"], rates["claude-haiku-4-5-20251001"],
    "alias and dated snapshot must price identically");
});

test("prices Claude Opus 5.5, footnoted cache-read discount included", () => {
  // The pricing page marks Opus 5.5's cache-read cell with a footnote
  // (<sup>2</sup>, "0.05x on Claude Opus 5.5") instead of the usual 0.1x.
  const { rates } = parsePricing(FIXTURE, AUG);
  assert.deepEqual(rates["claude-opus-5-5"],
    { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 });
});

test("prices Claude Sonnet 5.5 as its own row, not as Claude Sonnet 5's", () => {
  // In the September window Sonnet 5 stands at $3/$15 while Sonnet 5.5 stays at
  // $2/$10, so a 5.5 id resolved onto Sonnet 5's dated rows would read wrong.
  const { rates } = parsePricing(FIXTURE, SEP);
  assert.deepEqual(rates["claude-sonnet-5-5"],
    { input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4 });
  assert.equal(rates["claude-sonnet-5"].input, 3);
});

test("Claude Haiku 5.5: a flat row prices to the shipped entry, the live tiered row is not read", () => {
  // The live page tiers Haiku 5.5 (a "for prompts up to 100,000 tokens" price cell, then a nameless
  // continuation row for the over-100K tier), so the parser sees no row and update-rates keeps the
  // hand-written rates.json entry. A flat row (the page dropping the tier) must price identically.
  const row = (...c) => `<tr>${c.map((x) => `<td>${x}</td>`).join("")}</tr>`;
  const prices = ["$0.125 / MTok", "$0.20 / MTok", "$0.01 / MTok", "$0.50 / MTok"];
  const flat = `<table>${HEAD}${row("Claude Haiku 5.5", "$0.10 / MTok", ...prices)}</table>`;
  const tiered = `<table>${HEAD}${row("Claude Haiku 5.5", "$0.10 / MTok for prompts up to 100,000 tokens", ...prices)}` +
    `${row("$0.50 / MTok for prompts over 100,000 tokens", "$0.625 / MTok", "$1 / MTok", "$0.05 / MTok", "$2.50 / MTok")}</table>`;
  const shipped = JSON.parse(readFileSync(join(__dirname, "..", "tools", "rates.json"), "utf8")).models["claude-haiku-5-5"];
  const want = JSON.stringify({ input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 });
  assert.equal(JSON.stringify(parsePricing(flat, AUG).rates["claude-haiku-5-5"]), want);
  assert.equal(JSON.stringify(shipped), want, "rates.json carries the hand-written lower-tier entry");
  const { rates, errors } = parsePricing(tiered, AUG);
  assert.equal(rates["claude-haiku-5-5"], undefined, "a tiered price is not the flat price");
  assert.ok(!errors.some((e) => /haiku-5-5/.test(e)), JSON.stringify(errors));
});

// --- column order comes from the header, not from a fixed position ---

test("the two-header-row page of 2026-09-28 parses every required model with no errors", () => {
  const { rates, errors } = parsePricing(LIVE_0928, Date.parse("2026-09-28T12:00:00Z"));
  assert.deepEqual(errors, [], "a name-cell tagline must not read as a date qualifier either");
  // Output follows Input on this page; read by position it landed in cache_write_5m.
  assert.deepEqual(rates["claude-opus-5-5"],
    { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 });
});

test("the 2026-10-10 page prices Claude Sonnet 5.5 cache reads at $0.10, 0.05x input, with no errors", () => {
  const { rates, errors } = parsePricing(LIVE_1010, D1010);
  assert.deepEqual(errors, []);
  assert.deepEqual(rates["claude-sonnet-5-5"],
    { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 });
  // From that date the 2026-09-28 page's $0.20 is a stale price, not a 0.1x row to accept.
  assert.ok(parsePricing(LIVE_0928, D1010).errors.some((e) => /claude-sonnet-5-5\.cache_read=0\.2 /.test(e)));
});

test("a header that does not name each price column once is refused, not read by position", () => {
  // Old-order prices that the pre-header parser accepted whatever the header said.
  const row = `<tr><td>Claude Fable 5</td><td>$10 / MTok</td><td>$12.50 / MTok</td><td>$20 / MTok</td><td>$1 / MTok</td><td>$50 / MTok</td></tr>`;
  for (const cols of [["A", "B", "C", "D", "E"], ["Input", "Input", "5m", "1h", "Hits"]]) {
    const head = `<tr><th>Model</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;
    const { rates, errors } = parsePricing(`<table>${head}${row}</table>`, AUG);
    assert.equal(rates["claude-fable-5"], undefined, `header ${cols} must not be guessed`);
    assert.ok(errors.some((e) => /required model "claude-fable-5" missing/.test(e)), JSON.stringify(errors));
  }
});

// --- dated-variant disambiguation (Codex r1 blocker 1) ---

test("Claude Sonnet 5 resolves to the window in effect on the fetch date", () => {
  const before = parsePricing(FIXTURE, AUG).rates["claude-sonnet-5"];
  const after = parsePricing(FIXTURE, SEP).rates["claude-sonnet-5"];
  assert.equal(before.input, 2, "through 2026-08-31 → introductory $2");
  assert.equal(before.output, 10);
  assert.equal(after.input, 3, "from 2026-09-01 → standard $3");
  assert.equal(after.output, 15);
});

test("the introductory window is inclusive of its final day and flips the next", () => {
  const lastDay = Date.parse("2026-08-31T23:59:00Z");
  const firstDay = Date.parse("2026-09-01T00:00:00Z");
  assert.equal(parsePricing(FIXTURE, lastDay).rates["claude-sonnet-5"].input, 2);
  assert.equal(parsePricing(FIXTURE, firstDay).rates["claude-sonnet-5"].input, 3);
});

test("a date before the dated rows still resolves to exactly one active row", () => {
  // Read at a 2025 date, the two Sonnet 5 rows split cleanly: "through
  // August 31, 2026" covers it, "starting September 1, 2026" does not. Exactly
  // one active row means this must SUCCEED — it guards against over-rejecting a
  // legitimately unambiguous page, which would make refreshes impossible and let
  // rates.json rot. The fail-closed direction is covered by the refusal tests
  // further down.
  const { rates, errors } = parsePricing(FIXTURE, Date.parse("2025-01-01T00:00:00Z"));
  assert.deepEqual(errors, []);
  assert.equal(rates["claude-sonnet-5"].input, 2, "the through-Aug-2026 row is the active one");
});

test("duplicate rows with no date qualifier are refused, not guessed", () => {
  // Two rows naming the same model with different prices and nothing to
  // disambiguate them: the old first-match parser would have taken row one.
  const html = `<table><tr><th>Model</th><th>Base Input Tokens</th><th>5m</th><th>1h</th><th>Hits</th><th>Output</th></tr>
    <tr><td>Claude Fable 5</td><td>$10 / MTok</td><td>$12.50 / MTok</td><td>$20 / MTok</td><td>$1 / MTok</td><td>$50 / MTok</td></tr>
    <tr><td>Claude Fable 5</td><td>$99 / MTok</td><td>$123.75 / MTok</td><td>$198 / MTok</td><td>$9.90 / MTok</td><td>$495 / MTok</td></tr>
    </table>`;
  const { rates, errors } = parsePricing(html, AUG);
  assert.equal(rates["claude-fable-5"], undefined, "must not pick either row");
  assert.ok(errors.some((e) => /Claude Fable 5.*none carries a parseable effective-date qualifier/.test(e)),
    `expected an ambiguity error, got: ${JSON.stringify(errors)}`);
});

test("two dated rows both in effect on the same date are refused", () => {
  const html = `<table><tr><th>Model</th><th>Input</th><th>5m</th><th>1h</th><th>Hits</th><th>Output</th></tr>
    <tr><td>Claude Fable 5 through December 31, 2026</td><td>$10 / MTok</td><td>$12.50 / MTok</td><td>$20 / MTok</td><td>$1 / MTok</td><td>$50 / MTok</td></tr>
    <tr><td>Claude Fable 5 starting January 1, 2026</td><td>$20 / MTok</td><td>$25 / MTok</td><td>$40 / MTok</td><td>$2 / MTok</td><td>$100 / MTok</td></tr>
    </table>`;
  const { rates, errors } = parsePricing(html, Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /2 of 2 dated rows are in effect/.test(e)),
    `expected an overlap error, got: ${JSON.stringify(errors)}`);
});

// --- required-model floor (Codex r1 blocker 2) ---

test("a partial parse aborts instead of writing a plausible-looking file", () => {
  // Five models parse cleanly — enough to satisfy the old `n >= 5` floor — but
  // live-traffic models are missing. That must fail, not merge-and-stamp.
  const html = `<table><tr><th>Model</th><th>Input</th><th>5m</th><th>1h</th><th>Hits</th><th>Output</th></tr>
    <tr><td>Claude Opus 4.1</td><td>$15 / MTok</td><td>$18.75 / MTok</td><td>$30 / MTok</td><td>$1.50 / MTok</td><td>$75 / MTok</td></tr>
    <tr><td>Claude Opus 4</td><td>$15 / MTok</td><td>$18.75 / MTok</td><td>$30 / MTok</td><td>$1.50 / MTok</td><td>$75 / MTok</td></tr>
    <tr><td>Claude Sonnet 4.6</td><td>$3 / MTok</td><td>$3.75 / MTok</td><td>$6 / MTok</td><td>$0.30 / MTok</td><td>$15 / MTok</td></tr>
    <tr><td>Claude Sonnet 4.5</td><td>$3 / MTok</td><td>$3.75 / MTok</td><td>$6 / MTok</td><td>$0.30 / MTok</td><td>$15 / MTok</td></tr>
    <tr><td>Claude Haiku 3.5</td><td>$0.80 / MTok</td><td>$1 / MTok</td><td>$1.60 / MTok</td><td>$0.08 / MTok</td><td>$4 / MTok</td></tr>
    </table>`;
  const { errors } = parsePricing(html, AUG);
  assert.ok(errors.length >= 5, "every missing required model should be reported");
  for (const id of ["claude-fable-5", "claude-opus-5", "claude-opus-4-7", "claude-sonnet-5", "claude-haiku-4-5"]) {
    assert.ok(errors.some((e) => e.includes(`"${id}" missing`)), `expected a missing-model error for ${id}`);
  }
});

test("markup with no parseable rows at all reports every required model missing", () => {
  const { rates, errors } = parsePricing("<html><body><p>pricing moved</p></body></html>", AUG);
  assert.deepEqual(rates, {});
  assert.equal(errors.length, 9, "one error per required wire id");
});

// --- silent-corruption guards ---

test("a price outside the sane range is rejected", () => {
  // Multipliers are internally consistent, so only the range check catches this
  // 1000x transcription error.
  const html = `<table>${HEAD}<tr><td>Claude Fable 5</td><td>$10000 / MTok</td><td>$12500 / MTok</td><td>$20000 / MTok</td><td>$1000 / MTok</td><td>$50000 / MTok</td></tr></table>`;
  const { rates, errors } = parsePricing(html, AUG);
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /outside sane range/.test(e)), JSON.stringify(errors));
});

test("cache prices that contradict the documented multipliers are rejected", () => {
  // Plausible-looking numbers, wrong relationship — the exact class of quiet
  // corruption a column-order change would produce.
  const html = `<table>${HEAD}<tr><td>Claude Fable 5</td><td>$10 / MTok</td><td>$11 / MTok</td><td>$13 / MTok</td><td>$4 / MTok</td><td>$50 / MTok</td></tr></table>`;
  const { rates, errors } = parsePricing(html, AUG);
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /contradicts the documented/.test(e)), JSON.stringify(errors));
});

test("the Opus 5.5 cache-read override does not loosen the guard for other models", () => {
  // Claude Fable 5 at the 0.05x rate Opus 5.5 uses would be $0.20/MTok, not the
  // documented 0.1x ($0.40/MTok) — must still be rejected as a misparse.
  const html = `<table>${HEAD}<tr><td>Claude Fable 5</td><td>$4 / MTok</td><td>$5 / MTok</td><td>$8 / MTok</td><td>$0.20 / MTok</td><td>$20 / MTok</td></tr></table>`;
  const { rates, errors } = parsePricing(html, AUG);
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /contradicts the documented/.test(e)), JSON.stringify(errors));
});

test("a footnote-shaped suffix with no space or too many digits fails closed", () => {
  // tableRows() always leaves exactly one literal space where a stripped tag
  // was, so a real footnote marker reads "$4 / MTok 2" (one space, 1-2
  // digits). "$4 / MTok2026" has no such space — not a footnote, a misparse —
  // and must be dropped rather than read as a $4 price.
  const html = `<table>${HEAD}<tr><td>Claude Fable 5</td><td>$4 / MTok2026</td><td>$5 / MTok</td><td>$8 / MTok</td><td>$0.40 / MTok</td><td>$20 / MTok</td></tr></table>`;
  const { rates, errors } = parsePricing(html, AUG);
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /required model "claude-fable-5" missing/.test(e)), JSON.stringify(errors));
});

test("published cent-rounding still passes the multiplier check", () => {
  // Haiku 3.5: input $0.80 → 1.25x = $1.00, 2x = $1.60, 0.1x = $0.08. Exact
  // here, but the epsilon must be wide enough that rounded rows aren't rejected.
  const { rates, errors } = parsePricing(FIXTURE, AUG);
  assert.deepEqual(errors, []);
  assert.equal(rates["claude-haiku-3-5-20241022"].cache_write_5m, 1);
});

test("rows from the batch and tool-use tables are not mistaken for pricing rows", () => {
  // Both live in the same fixture. Batch rows have 2 price cells, tool-use rows
  // carry token counts — the 6-cell/5-price shape requirement excludes both.
  // If either leaked through, Fable 5 would price at the batch $5/$25.
  const { rates } = parsePricing(FIXTURE, AUG);
  assert.equal(rates["claude-fable-5"].input, 10, "batch $5 must not win");
  assert.equal(rates["claude-fable-5"].output, 50, "batch $25 must not win");
  assert.equal(rates["claude-sonnet-5"].output, 10, "tool-use token counts must not be read as prices");
});

test("a shorter model name cannot claim a longer model's row", () => {
  // "Claude Opus 4" prefixes "Claude Opus 4.8"; both are on the page at
  // different prices ($15 vs $5).
  const { rates } = parsePricing(FIXTURE, AUG);
  assert.equal(rates["claude-opus-4-20250514"].input, 15, "Claude Opus 4 keeps its own row");
  assert.equal(rates["claude-opus-4-8"].input, 5, "Claude Opus 4.8 keeps its own row");
});

test("a name-only footnote link does not break the name cell", () => {
  // Mythos 5 carries a "(limited availability)" link inside its name cell.
  const { rates } = parsePricing(FIXTURE, AUG);
  assert.equal(rates["claude-mythos-5"].input, 10);
});

// --- determinism ---

test("parsing is deterministic for a fixed input and date", () => {
  const a = parsePricing(FIXTURE, AUG);
  const b = parsePricing(FIXTURE, AUG);
  assert.equal(JSON.stringify(a.rates), JSON.stringify(b.rates),
    "stable key order and values, so an unchanged page yields a byte-identical no-op");
});

// --- the shipped file matches the parser ---

test("checked-in rates.json agrees with the newest page's parse for required models", () => {
  const shipped = JSON.parse(readFileSync(join(__dirname, "..", "tools", "rates.json"), "utf8")).models;
  const { rates } = parsePricing(LIVE_1010, D1010);
  for (const id of ["claude-fable-5", "claude-opus-5", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7",
                    "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-4-5"]) {
    assert.ok(shipped[id], `rates.json is missing ${id} — the cost lever prices it at zero`);
    const { note, ...s } = shipped[id];
    // Compared as JSON so key order counts: an unchanged page must stay a byte-identical no-op.
    assert.equal(JSON.stringify(rates[id]), JSON.stringify(s), `rates.json ${id} disagrees with the 2026-10-10 table`);
  }
});

// --- dated qualifiers bind regardless of candidate count (Codex r2 blocker) ---
// Round 2 found that effectiveWindow() was only consulted when a model had
// MULTIPLE rows, so a lone row was accepted whatever its qualifier said. A sole
// "starting September 1, 2026" row read in August is not today's price.

const soleRow = (name, input) =>
  `<table>${HEAD}<tr><td>${name}</td><td>$${input} / MTok</td><td>$${input * 1.25} / MTok</td>` +
  `<td>$${input * 2} / MTok</td><td>$${(input * 0.1).toFixed(2)} / MTok</td><td>$${input * 5} / MTok</td></tr></table>`;

test("a sole not-yet-effective row is refused, not adopted", () => {
  const { rates, errors } = parsePricing(soleRow("Claude Fable 5 starting September 1, 2026", 99), AUG);
  assert.equal(rates["claude-fable-5"], undefined, "a future row is not today's price");
  assert.ok(errors.some((e) => /0 of 1 dated rows are in effect/.test(e)), JSON.stringify(errors));
});

test("a sole already-expired row is refused", () => {
  const { rates, errors } = parsePricing(soleRow("Claude Fable 5 through June 30, 2026", 99), AUG);
  assert.equal(rates["claude-fable-5"], undefined, "an expired row is not today's price");
  assert.ok(errors.some((e) => /0 of 1 dated rows are in effect/.test(e)), JSON.stringify(errors));
});

test("a sole dated row that IS in effect is accepted", () => {
  const { rates, errors } = parsePricing(soleRow("Claude Fable 5 through December 31, 2026", 10), AUG);
  assert.equal(rates["claude-fable-5"].input, 10);
  assert.ok(!errors.some((e) => /in effect/.test(e)), JSON.stringify(errors));
});

test("a sole undated row is still accepted (the normal case)", () => {
  const { rates } = parsePricing(soleRow("Claude Fable 5", 10), AUG);
  assert.equal(rates["claude-fable-5"].input, 10);
});

test("a qualifier in an unrecognized date format is refused, not ignored", () => {
  // The unparseable qualifier may be the very thing saying "not yet in effect",
  // so it must disqualify rather than fall through to acceptance.
  const { rates, errors } = parsePricing(soleRow("Claude Fable 5 starting Fructidor 1, 2026", 99), AUG);
  assert.equal(rates["claude-fable-5"], undefined);
  assert.ok(errors.some((e) => /format this parser does not recognize/.test(e)), JSON.stringify(errors));
});

test("a model mixing a dated and an undated row is refused", () => {
  const two =
    `<table>${HEAD}<tr><td>Claude Fable 5 starting September 1, 2026</td><td>$20 / MTok</td><td>$25 / MTok</td><td>$40 / MTok</td><td>$2 / MTok</td><td>$100 / MTok</td></tr>` +
    `<tr><td>Claude Fable 5</td><td>$10 / MTok</td><td>$12.50 / MTok</td><td>$20 / MTok</td><td>$1 / MTok</td><td>$50 / MTok</td></tr></table>`;
  const { rates, errors } = parsePricing(two, AUG);
  assert.equal(rates["claude-fable-5"], undefined, "cannot tell which row is authoritative");
  assert.ok(errors.some((e) => /mixes 1 dated and 1 undated/.test(e)), JSON.stringify(errors));
});
