// Pipeline-level integration tests for the TTL-tier-detect rewire (directive #18-#22).
// Loads the real proxy/extensions/ directory + extensions.json via loadExtensions(),
// then runs runOnRequest() once and asserts on observable end-state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadExtensions, runOnRequest } from "../proxy/pipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, "..", "proxy", "extensions");
const EXT_CONFIG = join(__dirname, "..", "proxy", "extensions.json");

const SYSTEM_PROMPT = "You are Claude Code, Anthropic's CLI";

async function withEnv(envOverrides, fn) {
  const keys = Object.keys(envOverrides);
  const original = {};
  for (const k of keys) {
    original[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = String(envOverrides[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

async function loadAndRun(body, envOverrides = {}) {
  return withEnv(envOverrides, async () => {
    const exts = await loadExtensions(EXT_DIR, EXT_CONFIG);
    const ctx = { body, headers: {}, meta: {} };
    await runOnRequest(ctx, exts);
    return ctx;
  });
}

// --- Test #18: cache-control-normalize regression case ---

test("[pipeline #18] ttl=5m on NON-last user-message block (stripped by normalize, canonical re-applied elsewhere) → still detected, injected as 5m", async () => {
  // Critical geometry: the 5m marker sits on the FIRST block of a user message
  // whose LAST block has no cache_control. cache-control-normalize will:
  //   1. strip the cache_control from the first block,
  //   2. re-apply the canonical { type: "ephemeral" } to the LAST block of the
  //      LAST user message — a different block from where the 5m signal was.
  // Without the rewire, by the time ttl-management ran at order 500 there
  // would be no surviving 5m marker anywhere in body.messages, and detection
  // (if it had been done in ttl-management) would inject 1h. The pre-strip
  // detection at order 75 is what makes this case work.
  const body = {
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "first block (where 5m lived)", cache_control: { type: "ephemeral", ttl: "5m" } },
          { type: "text", text: "last block (no marker on input)" },
        ],
      },
    ],
  };

  const ctx = await loadAndRun(body);

  // Detection captured the signal pre-strip.
  assert.equal(ctx.meta._ttlTier, "5m");

  // System block injected with 5m.
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });

  // Observable proof normalize ran: the FIRST block (where the input 5m
  // marker was) no longer carries cache_control.
  const onlyMsg = ctx.body.messages[0];
  assert.equal(onlyMsg.content[0].cache_control, undefined,
    "cache-control-normalize should have stripped the 5m marker from the first block");

  // Canonical marker re-applied by normalize lands on the LAST block of the
  // last user message — a different block — and now carries ttl=5m (not 1h).
  const lastBlock = onlyMsg.content[onlyMsg.content.length - 1];
  assert.deepEqual(lastBlock.cache_control, { type: "ephemeral", ttl: "5m" },
    "canonical marker on the last block should carry the auto-detected 5m");

  // Exactly one user-message cache_control survives (the canonical).
  let userMarkers = 0;
  for (const msg of ctx.body.messages) {
    if (msg.role !== "user") continue;
    for (const b of msg.content) if (b.cache_control) userMarkers++;
  }
  assert.equal(userMarkers, 1, "normalize should have collapsed to one canonical user-message marker");
});

// --- Test #19: fresh-session-sort regression case (relocatable block carrying ttl=5m) ---

const SKILLS_BLOCK_TEXT =
  "<system-reminder>\n" +
  "The following skills are available for use with the Skill tool:\n\n" +
  "- skill-foo: does foo\n" +
  "- skill-bar: does bar\n" +
  "</system-reminder>";

test("[pipeline #19] ttl=5m on relocatable <skills> block (stripped by fresh-session-sort) → still detected, injected as 5m", async () => {
  const body = {
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      {
        role: "user",
        content: [
          { type: "text", text: SKILLS_BLOCK_TEXT, cache_control: { type: "ephemeral", ttl: "5m" } },
          { type: "text", text: "follow-up" },
        ],
      },
    ],
  };

  const ctx = await loadAndRun(body);

  // Detection captured the 5m signal at order 75, before fresh-session-sort
  // (order 250) destructured cache_control off the relocated block.
  assert.equal(ctx.meta._ttlTier, "5m");

  // System-block ttl is 5m.
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });

  // Observable proof fresh-session-sort ran: the relocated <skills> block now
  // sits in the first user message (index 0), and the original copy is gone
  // from the later message.
  const firstUser = ctx.body.messages[0];
  const relocatedSkills = firstUser.content.find((b) =>
    typeof b.text === "string" && b.text.startsWith("<system-reminder>\nThe following skills are available")
  );
  assert.ok(relocatedSkills, "skills block should be relocated to the first user message");

  // Observable proof fresh-session-sort destructured cache_control off the
  // relocated block (per fresh-session-sort.mjs:140/:164 — destructure-and-discard).
  assert.equal(relocatedSkills.cache_control, undefined,
    "relocated skills block should have no cache_control field — proves fresh-session-sort dropped it");

  const laterUser = ctx.body.messages[2];
  const skillsStillThere = laterUser.content.some((b) =>
    typeof b.text === "string" && b.text.startsWith("<system-reminder>\nThe following skills are available")
  );
  assert.ok(!skillsStillThere, "original copy of skills block should be removed from later user message");

  // Canonical normalize marker carries ttl=5m on whichever user message ended
  // up with the canonical placement.
  for (let i = ctx.body.messages.length - 1; i >= 0; i--) {
    const msg = ctx.body.messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock.cache_control) {
      assert.deepEqual(lastBlock.cache_control, { type: "ephemeral", ttl: "5m" });
      break;
    }
  }
});

// --- Test #20: pure-1h payload (negative case) ---

test("[pipeline #20] no 5m markers anywhere → _ttlTier='1h' and all blocks injected with 1h", async () => {
  const body = {
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  };

  const ctx = await loadAndRun(body);

  assert.equal(ctx.meta._ttlTier, "1h");
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });

  const lastMsg = ctx.body.messages[ctx.body.messages.length - 1];
  const lastBlock = lastMsg.content[lastMsg.content.length - 1];
  assert.deepEqual(lastBlock.cache_control, { type: "ephemeral", ttl: "1h" });
});

// --- Test #21: env override precedence — none suppresses ---

test("[pipeline #21] CACHE_FIX_TTL_MAIN=none + detected 5m → detection still fires, no ttl injected", async () => {
  const body = {
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  };

  const ctx = await loadAndRun(body, { CACHE_FIX_TTL_MAIN: "none" });

  // Detection still fires.
  assert.equal(ctx.meta._ttlTier, "5m");

  // No ttl field injected by ttl-management — env "none" suppresses.
  assert.equal(ctx.body.system[0].cache_control.ttl, undefined,
    "ttl-management must not inject on system when env=none");
});

// --- Test #22: lead-flagged auto-upgrade case (env=1h + detected=5m) ---

test("[pipeline #22] CACHE_FIX_TTL_MAIN=1h + detected 5m → blocks injected with 5m (auto-upgrade)", async () => {
  const body = {
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Hi" },
          { type: "text", text: "follow-up", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  };

  const ctx = await loadAndRun(body, { CACHE_FIX_TTL_MAIN: "1h" });

  assert.equal(ctx.meta._ttlTier, "5m");
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });

  const lastMsg = ctx.body.messages[ctx.body.messages.length - 1];
  const lastBlock = lastMsg.content[lastMsg.content.length - 1];
  assert.deepEqual(lastBlock.cache_control, { type: "ephemeral", ttl: "5m" },
    "auto-detection must upgrade explicit 1h-env to 5m when payload shows 5m markers");
});
