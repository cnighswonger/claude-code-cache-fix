import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The git-status recommendation used to claim CC re-renders `git status` into
// the system prompt on every call, so any file edit busts the entire prefix
// cache. Since Claude Code 2.1.267 the system prompt is recorded once per
// session and reused (CHANGELOG 2.1.267/2.1.269), measured frozen across a
// tracked-file edit on 2.1.268 and 2.1.270. The section must carry the version
// qualifier and drop the unqualified present-tense claim.
const files = [
  "README.md",
  "README.ko.md",
  "README.fr.md",
  "README.zh.md",
  "docs/extension-impact-guide.md",
];

// Fenced code blocks are exempt: they may legitimately show old flag output,
// not the prose claim under test.
const prose = (t) => t.replace(/```[\s\S]*?```/g, "");

function gitStatusSection(text) {
  const lines = text.split("\n");
  const headingRe = /^#{1,6}\s/;
  const start = lines.findIndex((l) => headingRe.test(l) && /git-status/i.test(l));
  assert.ok(start >= 0, "no heading matching /git-status/i found");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("the git-status section names the 2.1.267 version qualifier and drops the unqualified per-edit-bust claim", () => {
  for (const f of files) {
    const text = prose(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    const section = gitStatusSection(text);
    assert.ok(section.includes("2.1.267"),
      `${f}: git-status section does not mention 2.1.267`);
    assert.ok(!section.includes("which busts the entire prefix cache"),
      `${f}: git-status section still carries the unqualified present-tense claim`);
  }
});

// Measured on CC 2.1.301: the git context is written once per session into the
// first user message (~650 tokens, plus 147 shared in the Bash tool
// description), not ~1,800 tokens on every call.
const perCall = /1[,.\s]?800/;

test("the git-status section states the per-session cost, not a per-call 1,800", () => {
  for (const f of files) {
    const text = prose(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    const section = gitStatusSection(text);
    assert.ok(!perCall.test(section), `${f}: git-status section still carries the per-call 1,800 figure`);
    for (const n of ["650", "147", "2.1.301"]) {
      assert.ok(section.includes(n), `${f}: git-status section does not name ${n}`);
    }
  }
});

// The injection into the system prompt is the 2.1.267-2.1.270 history; the
// 2.1.301 first-user-message sentence is the present. One paragraph must not
// state both in the present tense.
test("the English git-status sections put the system-prompt injection in the past", () => {
  for (const f of ["README.md", "docs/extension-impact-guide.md"]) {
    const section = gitStatusSection(prose(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));
    assert.ok(!/injects a `git status` block into the system prompt/.test(section),
      `${f}: git-status section states the system-prompt injection in the present tense`);
  }
});

test("the CHANGELOG git-status entry does not carry the per-call 1,800 figure", () => {
  const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const entry = text.split("\n").find((l) => l.includes("The git-status recommendation no longer claims"));
  assert.ok(entry, "CHANGELOG git-status entry not found");
  assert.ok(!perCall.test(entry), "CHANGELOG git-status entry still carries the per-call 1,800 figure");
});
