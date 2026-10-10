import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// cost-report.mjs runs main() at import and does not export lookupRates(), so
// the only way to exercise its rates lookup end-to-end is to run it as a
// subprocess with usage telemetry piped on stdin.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "tools", "cost-report.mjs");

// Cost of 1M input + 1M output + 1M cache-read tokens on `model`, from the bundled rates.json.
function costOf(model) {
  const usage = JSON.stringify({
    model,
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  }) + "\n";

  const result = spawnSync(process.execPath, [SCRIPT, "--format", "json"], {
    input: usage,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `cost-report exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout).calls[0].cost;
}

test("prices a claude-opus-5-5 call from the bundled rates.json", () => {
  assert.equal(costOf("claude-opus-5-5"), 24.2,
    "1M input + 1M output + 1M cache-read at Opus 5.5's own rates (4/20/0.2 $ per MTok)");
});

test("prices a claude-sonnet-5-5 call from the bundled rates.json", () => {
  assert.equal(costOf("claude-sonnet-5-5"), 12.1,
    "1M input + 1M output + 1M cache-read at Sonnet 5.5's own rates (2/10/0.1 $ per MTok)");
});
