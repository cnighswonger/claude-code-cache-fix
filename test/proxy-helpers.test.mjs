// Unit tests for the systemd / launchd escape helpers in proxy/helpers.mjs.
//
// Why these are unit-shaped: the install-service render tests exercise the
// helpers indirectly via the rendered output, but each helper has its own
// edge cases (specifier expansion, C-string escapes, XML entities) that
// deserve direct coverage so future refactors of the helper can't silently
// regress the per-character semantics.
//
// Each case in `systemdEscape` was empirically verified 2026-06-07 against
// `systemd --user` on a Linux host: the unit file rendered by the expected
// output delivers the original input to the spawned process byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";

import { systemdEscape, xmlEscape } from "../proxy/helpers.mjs";

// --- systemdEscape ---
//
// Per systemd.exec(5) Environment= and systemd.unit(5) Specifier Expansion:
//   - literal % must be written %% (otherwise systemd tries specifier
//     expansion, logs "Invalid slot", and silently drops the variable)
//   - literal \ must be written \\ (otherwise systemd applies C-string
//     escapes; \b → backspace, \n → newline, etc.)
//   - literal " must be written \"
//   - whitespace requires the value to be quoted

test("systemdEscape: plain ASCII value with no special chars passes through unchanged", () => {
  assert.equal(systemdEscape("plain"), "plain");
  assert.equal(systemdEscape("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(systemdEscape("/etc/ssl/ca.pem"), "/etc/ssl/ca.pem");
  assert.equal(systemdEscape("0"), "0");
  assert.equal(systemdEscape("1"), "1");
});

test("systemdEscape: bare % is escaped to %% even without quoting (PR #189 regression — specifier expansion)", () => {
  // Reproduced 2026-06-07: an Environment= line containing bare % causes
  // systemd-analyze verify to report "Failed to resolve specifiers ...
  // Invalid slot" and the variable to be silently dropped.
  assert.equal(systemdEscape("a%20b"), "a%%20b");
  assert.equal(systemdEscape("100%"), "100%%");
  assert.equal(systemdEscape("%%"), "%%%%");
});

test("systemdEscape: whitespace triggers quoting", () => {
  assert.equal(systemdEscape("a b"), '"a b"');
  assert.equal(systemdEscape("/path with spaces/ca.pem"), '"/path with spaces/ca.pem"');
  // Tabs and newlines also count as whitespace.
  assert.equal(systemdEscape("a\tb"), '"a\tb"');
});

test("systemdEscape: literal \" triggers quoting and is escaped to \\\"", () => {
  assert.equal(systemdEscape('a"b'), '"a\\"b"');
});

test("systemdEscape: literal \\ is escaped to \\\\ inside quoted strings (PR #189 regression — C-string escape)", () => {
  // Reproduced 2026-06-07: Environment=X=/path/with\backslash.pem causes
  // systemd to deliver /path/with<0x08>ackslash.pem (the \b becomes a
  // backspace byte) because Environment= values pass through the C-string
  // unescape.
  assert.equal(
    systemdEscape("/path/with\\backslash.pem"),
    '"/path/with\\\\backslash.pem"',
  );
  // A bare backslash anywhere triggers quoting (it's a special char even
  // without whitespace or other special chars present).
  assert.equal(systemdEscape("a\\b"), '"a\\\\b"');
});

test("systemdEscape: combined %, space, \\, \" all in one value", () => {
  assert.equal(
    systemdEscape('mixed%and spaces and \\ and " all'),
    '"mixed%%and spaces and \\\\ and \\" all"',
  );
});

test("systemdEscape: order is %-escape first, then quote-wrap with \\ and \" escaped together", () => {
  // % escaping must happen BEFORE the quoting branch's backslash escape,
  // otherwise `%` in a value that also needs quoting would be missed.
  // (Empirically observed during PR #189 round 1 — the prior helper
  // didn't escape % at all, regardless of quoting state.)
  assert.equal(systemdEscape("has% and space"), '"has%% and space"');
});

test("systemdEscape: empty string passes through unchanged", () => {
  assert.equal(systemdEscape(""), "");
});

// --- xmlEscape ---
//
// For launchd plist <string> values. The five XML predefined entities.

test("xmlEscape: plain ASCII passes through unchanged", () => {
  assert.equal(xmlEscape("plain"), "plain");
  assert.equal(xmlEscape("/etc/ssl/ca.pem"), "/etc/ssl/ca.pem");
});

test("xmlEscape: all five predefined entities", () => {
  assert.equal(xmlEscape("&"), "&amp;");
  assert.equal(xmlEscape("<"), "&lt;");
  assert.equal(xmlEscape(">"), "&gt;");
  assert.equal(xmlEscape("'"), "&apos;");
  assert.equal(xmlEscape('"'), "&quot;");
});

test("xmlEscape: combined all five in one value", () => {
  assert.equal(
    xmlEscape("/etc/ssl/ca & < > ' \" file.pem"),
    "/etc/ssl/ca &amp; &lt; &gt; &apos; &quot; file.pem",
  );
});

test("xmlEscape: empty string passes through unchanged", () => {
  assert.equal(xmlEscape(""), "");
});

test("xmlEscape: does NOT touch % or \\ — those have no XML special meaning", () => {
  assert.equal(xmlEscape("a%20b"), "a%20b");
  assert.equal(xmlEscape("/path/with\\backslash.pem"), "/path/with\\backslash.pem");
});
