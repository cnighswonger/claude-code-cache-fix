import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "extensions");

// An APPENDING writer grows without bound unless something bounds it; an
// overwriting one is bounded by one file's content. Only the first class can
// fill a disk, so only the first class is inventoried here.
const APPENDS = /appendFileSync|appendFile\(|flags:\s*"a"/;

const appenders = () =>
  readdirSync(extDir)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => APPENDS.test(readFileSync(join(extDir, f), "utf8")))
    .sort();

// THE INVENTORY IS THE POINT, NOT A CAP CHECK. Whether a writer is bounded is
// semantic -- a retention loop, an env cap, a caller that truncates -- and no
// pattern match can decide it. Grepping for `MAX_BYTES` and friends would answer
// confidently about the wrong thing, which is how a cap that reads 4 MiB in its
// own constant rotated at 64 KiB in a neighbouring component.
//
// So this asserts the one thing a test CAN enforce: the set of appending
// writers is exactly this list. A new one cannot arrive silently. Adding a file
// here is a deliberate act that puts the question -- what bounds this? -- in
// front of a reviewer at the moment it becomes answerable.
//
// Measured when this list was taken: 16 appenders, 9 of them with no cap of any
// kind. That is a fact about today's tree and NOT an approval of those nine; it
// is the population a bound has to be argued for, one at a time, by someone who
// knows what each file is for.
const KNOWN = [
  "bootstrap-defense.mjs",
  "deferred-tool-rewrite.mjs",
  "image-retry-circuit-breaker.mjs",
  "insertion-normalization.mjs",
  "messages-cache-breakpoint.mjs",
  "microcompact-stability.mjs",
  "output-guard.mjs",
  "overage-warning.mjs",
  "rate-limit-log.mjs",
  "request-log.mjs",
  "session-budget-breaker.mjs",
  "upstream-change-detection.mjs",
  "upstream-error-log.mjs",
  "usage-log.mjs",
  "workflow-agent-id-synthesis.mjs",
  "write-owner-only.mjs",
];

test("every extension that appends to a file is in the writer inventory", () => {
  const found = appenders();
  // DENOMINATOR FIRST. An empty scan passes a subset check silently, and this
  // file would then guard nothing while looking green.
  assert.ok(found.length > 0,
    `the scan found no appending extensions at all, so it is measuring nothing. ` +
    `Check that ${extDir} is the right directory and that APPENDS still matches ` +
    `how this tree writes.`);

  const added = found.filter((f) => !KNOWN.includes(f));
  assert.deepEqual(added, [],
    `new appending log writer(s): ${added.join(", ")}. An appending writer grows ` +
    `without bound unless something bounds it. Add it to KNOWN in this file and ` +
    `say in the same change what bounds it -- a retention loop, a size cap, or a ` +
    `deliberate decision that it is small enough to be unbounded.`);
});

test("the writer inventory has no entries that stopped appending", () => {
  const found = appenders();
  const gone = KNOWN.filter((f) => !found.includes(f));
  assert.deepEqual(gone, [],
    `inventory entries that no longer append: ${gone.join(", ")}. A stale list is ` +
    `worse than none -- it reads as coverage while guarding a file that changed ` +
    `shape or was removed. Drop them.`);
});
