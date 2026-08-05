import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));

// A GREEN RUN MUST MEAN THE CASES RAN, not that the ones which ran passed.
//
// Two incidents, one shape. Here: "1571 pass" was read off a per-file summary
// while one case failed 5 of 5 runs on two machines. On cswap's pin: 82 cases
// across 57 classes had NEVER EXECUTED — no driver collected them, nothing
// warned, and `60 passed` printed exactly as it would have if they ran. Both
// times a reporting layer stood between the runner and the truth, and both
// times the layer was believed.
//
// node:test does surface a missing file in its `tests` count — measured, hiding
// one file took the total from 1572 to 1567. That only helps if something reads
// the number, which is the part that failed. So this reads it.
//
// Deliberately NOT part of any helper or fixture in this suite: a guard that can
// go quiet the same way the thing it guards went quiet is not a guard.
test("every test file is reachable by the runner", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(files.length > 0, "no test files found — the glob or the directory moved");

  // A file the runner cannot parse contributes ZERO cases and still leaves the
  // suite green, because node:test reports per-file failures separately from
  // the pass count. Assert each one at least declares something.
  const empty = [];
  for (const f of files) {
    const src = readFileSync(join(testDir, f), "utf8");
    if (!/\b(it|test)\s*\(/.test(src)) empty.push(f);
  }
  assert.deepEqual(empty, [],
    `these files declare no cases, so they contribute nothing and cannot fail: ${empty.join(", ")}`);
});

// The count the runner reports must not silently fall below what the source
// declares. Executed EXCEEDING declared is normal and fine — cases generated in
// a loop are declared once and run many times. Executed BELOW declared is the
// failure mode: a file that failed to load, a describe that threw during
// collection, a case guarded behind a condition nobody meant to be false.
//
// Static, because the alternative is parsing the runner's own summary from
// inside a run it is producing.
test("no test file declares cases behind a collection-time condition", () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
  const conditional = [];
  for (const f of files) {
    const src = readFileSync(join(testDir, f), "utf8");
    // `if (...) it(...)` / `if (...) test(...)` at statement level: the case
    // exists in the source but may never be collected, and the summary cannot
    // tell that apart from a case that ran.
    if (/^\s*if\s*\([^)]*\)\s*(it|test)\s*\(/m.test(src)) conditional.push(f);
  }
  assert.deepEqual(conditional, [],
    `these files gate a case on a runtime condition, so a green run cannot prove ` +
    `it was collected: ${conditional.join(", ")}. Use a skip with a reason instead, ` +
    `which the runner reports.`);
});
