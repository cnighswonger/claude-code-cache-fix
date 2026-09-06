// PR #369 (71063fa) threw out 8 copies of an unthrottled /health readiness
// spin — zero delay between failed connect attempts, burning the whole
// ceiling against a closed port instead of leaving the holder CPU to boot in
// — for one throttled waitForHolder() in proc-helpers.mjs. That fix's own
// guard, wait-for-holder-throttle.test.mjs, drives waitForHolder() itself and
// so can only ever prove the HELPER throttles; it cannot see a hand-rolled
// copy of the old loop pasted into some OTHER test file, which is exactly the
// shape of the defect the same round then found five more of in
// test/proxy-held-port.test.mjs. This scans every test file for that shape
// directly.
//
// Shape: a `while` loop whose ceiling is `Date.now()` and whose span (its
// condition plus its body) awaits something, with no `setTimeout` anywhere
// in that span — an awaiting loop bounded by a wall clock with no delay is a
// spin, whatever it polls. That excludes: samplers with no ceiling
// (`while (!stop) …`) and every throttled wait (a `setTimeout` sits in its
// span already). Not scoped to "ERR:"-tagged probes: that was only ever a
// proxy for "this is a readiness poll", and it hid a spin whose body checked
// `!== "pong"` instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function findUnthrottledPolls(src) {
  const findings = [];
  const whileRe = /while\s*\(/g;
  let m;
  while ((m = whileRe.exec(src))) {
    const condStart = m.index + m[0].length;
    let depth = 1, i = condStart;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    const cond = src.slice(condStart, i - 1);
    if (!/Date\.now\(\)/.test(cond)) continue;

    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    let body;
    if (src[j] === "{") {
      let bd = 1, k = j + 1;
      while (k < src.length && bd > 0) {
        if (src[k] === "{") bd++;
        else if (src[k] === "}") bd--;
        k++;
      }
      body = src.slice(j, k);
    } else {
      const semi = src.indexOf(";", j);
      body = src.slice(j, semi === -1 ? src.length : semi + 1);
    }

    const span = cond + body;
    if (/\bawait\b/.test(span) && !/setTimeout/.test(span)) {
      findings.push({ line: src.slice(0, m.index).split("\n").length, span });
    }
  }
  return findings;
}

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (f.endsWith(".mjs")) out.push(p);
  }
  return out;
}

test("no test file spins an unthrottled Date.now()-bounded await loop", () => {
  const unexpected = [];
  for (const p of walk(TEST_DIR)) {
    const rel = relative(TEST_DIR, p);
    const src = readFileSync(p, "utf-8");
    for (const { line } of findUnthrottledPolls(src)) unexpected.push(`${rel}:${line}`);
  }
  assert.deepEqual(unexpected, [], "unthrottled await-poll(s) with no throttle between attempts " +
    `— burns the whole ceiling spinning with no delay: ${unexpected.join(", ")}`);
});
