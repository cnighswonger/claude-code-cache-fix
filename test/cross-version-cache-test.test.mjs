// tools/cross-version-cache-test.sh spends real quota past its safety gate, so
// only the abort paths are driven here (no case may pass the gate).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "tools", "cross-version-cache-test.sh");

function runWithQuota(account) {
  const home = mkdtempSync(join(tmpdir(), "cvt-"));
  try {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "cc-version"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const v of ["2.1.81", "2.1.83", "2.1.90", "2.1.101"]) {
      const dir = join(home, "cc-versions", v, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cli.js"), "");
    }
    mkdirSync(join(home, ".claude", "quota-status"), { recursive: true });
    writeFileSync(join(home, ".claude", "quota-status", "account.json"), JSON.stringify(account));
    return spawnSync("bash", [SCRIPT, "--output", join(home, "out")], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("aborts on a high 5h window", () => {
  const r = runWithQuota({ five_hour: { utilization: 0.85, pct: 85, resets_at: 1793944800 } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ABORT/);
});

test("aborts on a high 7d window when the account has no 5h window", () => {
  const r = runWithQuota({ seven_day: { utilization: 0.96, pct: 96, resets_at: 1793944800 } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ABORT.*96%/);
});

test("aborts on a high 7d window beside a low 5h window", () => {
  const r = runWithQuota({
    five_hour: { utilization: 0.1, pct: 10, resets_at: 1793944800 },
    seven_day: { utilization: 0.96, pct: 96, resets_at: 1793944800 },
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ABORT.*96%/);
});
