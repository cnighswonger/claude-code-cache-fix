// OAuth-refresher operator-visible events log. Append-only JSONL at
// ~/.claude/cache-fix-oauth-events.jsonl (override CACHE_FIX_OAUTH_EVENTS_LOG).
//
// CRITICAL — see directive §NFR threat-model: records here must NEVER carry
// raw token strings, POST bodies, or token-endpoint response bodies. Callers
// build records explicitly with non-secret scalars only (event name, outcome,
// status_code, expires_at, error class). This file refuses to serialize any
// field whose key matches the token allowlist as a tripwire — but the
// primary discipline is at the call site.

import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeHome } from "../claude-home.mjs";

const FORBIDDEN_KEYS = new Set([
  "accessToken", "refreshToken", "access_token", "refresh_token",
  "token", "authorization", "Authorization", "bearer", "Bearer",
  "credentials", "cred",
]);

const MAX_BYTES = 1_000_000;

function eventsPath() {
  return process.env.CACHE_FIX_OAUTH_EVENTS_LOG ||
    join(claudeHome(), "cache-fix-oauth-events.jsonl");
}

function rotateIfLarge(path) {
  try {
    if (statSync(path).size >= MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {}
}

export function emitOAuthEvent(event, fields = {}) {
  for (const k of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.has(k)) {
      // Tripwire: drop the whole record rather than risk a token reaching disk.
      try { process.stderr.write(`[cache-fix oauth] refused to emit event with forbidden key: ${k}\n`); } catch {}
      return;
    }
  }
  const record = { ts: new Date().toISOString(), event, ...fields };
  const path = eventsPath();
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}
  rotateIfLarge(path);
  try { appendFileSync(path, JSON.stringify(record) + "\n"); } catch {}
}
