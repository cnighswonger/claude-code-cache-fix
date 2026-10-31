// preload.mjs writes ~/.claude/quota-status.json and a usage.jsonl row from a
// reply's rate-limit headers. A header the reply does not carry must stay
// absent: not a previous account's value in the file, not 0 in the row.
//
// The interceptor is driven in a child process (it patches globalThis.fetch at
// import, and reads HOME at load). ASSUMPTION: a real reply without the 5h
// header still carries the 7d and status headers; no such reply was captured,
// so the fixture is built from the header names the 5h-bearing replies use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD = resolve(fileURLToPath(import.meta.url), "..", "..", "preload.mjs");

const CHILD = `
import { existsSync } from "node:fs";
const sse = [
  { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
  { type: "message_delta", usage: { output_tokens: 3 } },
].map((e) => "data: " + JSON.stringify(e) + "\\n\\n").join("");
globalThis.fetch = async () => new Response(sse, { headers: JSON.parse(process.env.REPLY_HEADERS) });
await import(${JSON.stringify(PRELOAD)});
await (await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST" })).text();
// The usage row is appended by a drain that nothing awaits.
for (let i = 0; i < 200 && !existsSync(process.env.CACHE_FIX_USAGE_LOG); i++) await new Promise((r) => setTimeout(r, 25));
`;

// Left behind by a previous account that did have both windows.
const SEEDED = JSON.stringify({
  five_hour: { utilization: 0.9, pct: 90, resets_at: 1700000000 },
  seven_day: { utilization: 0.5, pct: 50, resets_at: 1700500000 },
  status: "allowed",
});

function reply(replyHeaders) {
  const home = mkdtempSync(join(tmpdir(), "preload-quota-"));
  const quotaFile = join(home, ".claude", "quota-status.json");
  const usageFile = join(home, "usage.jsonl");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(quotaFile, SEEDED);
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
      env: { ...process.env, HOME: home, CACHE_FIX_USAGE_LOG: usageFile, REPLY_HEADERS: JSON.stringify(replyHeaders) },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return {
      quota: JSON.parse(readFileSync(quotaFile, "utf8")),
      row: JSON.parse(readFileSync(usageFile, "utf8").trim().split("\n")[0]),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const SEVEN_DAY = {
  "anthropic-ratelimit-unified-7d-utilization": "0.15",
  "anthropic-ratelimit-unified-7d-reset": "1700600000",
  "anthropic-ratelimit-unified-status": "allowed",
};

test("a reply with no 5h header drops the stale five_hour from the quota file", () => {
  const { quota } = reply(SEVEN_DAY);
  assert.ok(!("five_hour" in quota), "five_hour is removed, not kept from the previous account");
  assert.equal(quota.seven_day.pct, 15);
  assert.equal(quota.status, "allowed");
});

test("a reply with no 5h header logs no 5h reading", () => {
  const { row } = reply(SEVEN_DAY);
  assert.equal(row.q5h_pct, null, "an absent 5h header is not logged as 0");
  assert.equal(row.q7d_pct, 15);
});

test("a reply with both windows still writes both", () => {
  const { quota, row } = reply({
    ...SEVEN_DAY,
    "anthropic-ratelimit-unified-5h-utilization": "0",
    "anthropic-ratelimit-unified-5h-reset": "1700100000",
  });
  assert.deepEqual(quota.five_hour, { utilization: 0, pct: 0, resets_at: 1700100000 });
  assert.equal(row.q5h_pct, 0, "a 5h reading of 0 is a reading");
});

test("a reply with a 5h window and no 7d drops the stale seven_day", () => {
  const { quota } = reply({
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
    "anthropic-ratelimit-unified-5h-reset": "1700100000",
    "anthropic-ratelimit-unified-status": "allowed",
  });
  assert.ok(!("seven_day" in quota), "seven_day is removed, not kept from the previous account");
  assert.equal(quota.five_hour.pct, 20);
});

test("a reply with status and overage headers but neither window drops both stale windows", () => {
  const { quota } = reply({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-overage-reset": "1780272000",
  });
  assert.ok(!("five_hour" in quota), "five_hour is removed");
  assert.ok(!("seven_day" in quota), "seven_day is removed");
  assert.equal(quota.status, "allowed_warning");
  assert.equal(quota.overage_status, "allowed");
});

test("a reply with no rate-limit headers (an error reply) leaves the quota file as it was", () => {
  // The TTL drain adds its own cache block; every other key is the header writer's.
  const { cache, ...rest } = reply({}).quota;
  assert.deepEqual(rest, JSON.parse(SEEDED));
});
