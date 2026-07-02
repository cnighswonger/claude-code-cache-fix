// Proxy-owned OAuth refresh — proactive, lock-cooperative single-refresher.
//
// Implements docs/directives/proxy-owned-oauth-refresh.md. The proxy keeps
// the shared ~/.claude/.credentials.json fresh and acquires the client's
// .oauth_refresh.lock during its own refresh, so a waking client finds a
// fresh token and short-circuits without POSTing — exactly one party ever
// reaches the token endpoint, no double-spend, no token-family revocation.
//
// THREAT MODEL (directive §NFR): the access token and refresh token must
// never leave the credential file or reach any generic log writer. This
// module constructs its own token-free event records carrying only event
// name + outcome + status_code + expires_at + error class. The POST body
// and the token-endpoint response body are NEVER passed to debugLog/stderr
// /events; parsed fields are written ONLY to the credential file.
//
// Default OFF: gated by CACHE_FIX_OAUTH_REFRESH === "on" in startProxy().

import {
  readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync,
  lstatSync, statSync, mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import properLockfile from "proper-lockfile";

import { emitOAuthEvent } from "./events.mjs";
import config from "../config.mjs";
import { claudeHome } from "../claude-home.mjs";

const TOKEN_URL_DEFAULT = "https://platform.claude.com/v1/oauth/token";
// The client_id is the public OAuth client id baked into the Claude Code
// binary. It is NOT a secret (it appears in OAuth /authorize redirects);
// hard-coding the default keeps the refresher self-contained, and the
// CACHE_FIX_OAUTH_CLIENT_ID override exists for tests + future binary churn.
const CLIENT_ID_DEFAULT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Last-resort scope set if the credential file is missing the `scopes` array.
// Real installs always carry the full granted set in claudeAiOauth.scopes;
// v4.2.1 reads that array and uses it verbatim. This fallback exists only
// for a malformed-but-otherwise-valid credential file. See the v4.2.1
// incident post-mortem: hardcoding a narrower scope on the refresh grant
// caused the server to issue a narrower token, which then 401'd on
// remote-bridge / code-session calls that required user:sessions:claude_code.
const SCOPE_FALLBACK = "user:inference user:profile";

// proper-lockfile compatibility settings — must match the client's call shape
// byte-for-byte. CRITICAL: lockfilePath points at .oauth_refresh.lock (the
// client's lockfile name), NOT at .credentials.json.lock (proper-lockfile's
// default-derived name). Without lockfilePath set, lock(credPath) would lock
// ${credPath}.lock and silently lose mutual exclusion against the client.
// realpath:false because the credential file is a real regular file (we
// don't need realpath resolution and it adds a stat). stale:10000 matches
// the client's 10s stale-break window.
function lockOpts() {
  return {
    lockfilePath: join(dirname(credPath()), ".oauth_refresh.lock"),
    realpath: false,
    stale: 10_000,
    retries: 0, // we manage retry timing ourselves via the tick interval
  };
}
const CLIENT_STALE_WINDOW_MS = 10_000;

let _interval = null;
let _running = false; // in-process serialize: an ongoing tick blocks the next
let _backoffUntil = 0; // wall-clock ms after which the next tick may attempt
let _ticksFired = 0;
let _lastEvent = null; // exposed for tests
// Test-only seam: fires after lock acquisition, before the in-lock re-read.
// Used to exercise the §3 "another writer rotated between unlocked-read and
// locked-read" idempotent skip path by mutating the credential file from a
// test. Never invoked in production (no caller sets it).
let _testHookAfterLock = null;

function nowMs() { return Date.now(); }

function credPath() {
  return process.env.CACHE_FIX_OAUTH_CRED_PATH ||
    join(claudeHome(), ".credentials.json");
}

function tokenUrl() {
  return process.env.CACHE_FIX_OAUTH_TOKEN_URL || TOKEN_URL_DEFAULT;
}

function clientId() {
  return process.env.CACHE_FIX_OAUTH_CLIENT_ID || CLIENT_ID_DEFAULT;
}

// Determine the scope string for the refresh-token POST.
//
// CRITICAL (v4.2.1): the refresh grant's `scope` field MUST request the same
// set of scopes the credential currently holds. A NARROWER refresh produces
// a NARROWER token — the server happily issues it — and any caller that
// needs a stripped-out scope subsequently 401s. The 2026-06-23 incident hit
// this: v4.2.0 hardcoded `user:inference user:profile`, the refresh succeeded,
// `/v1/messages` kept working (only needs user:inference), but remote-bridge
// / code-session calls 401'd because user:sessions:claude_code was missing
// from the new token.
//
// Resolution order:
//   1. CACHE_FIX_OAUTH_SCOPE env var (operator override; intentional)
//   2. credScopes array from the in-lock-re-read credential file (canonical
//      — the scopes the file already holds is the set we must preserve)
//   3. SCOPE_FALLBACK (only fires on a malformed cred file without scopes)
function scope(credScopes) {
  const envOverride = process.env.CACHE_FIX_OAUTH_SCOPE;
  if (envOverride) return envOverride;
  if (Array.isArray(credScopes) && credScopes.length > 0) {
    // Filter to non-empty strings + dedupe + join space-separated, matching
    // the OAuth 2.0 RFC 6749 §3.3 scope syntax. The credential file's array
    // shape is the source of truth; we just serialize it.
    const valid = [];
    const seen = new Set();
    for (const s of credScopes) {
      if (typeof s !== "string") continue;
      const t = s.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      valid.push(t);
    }
    if (valid.length > 0) return valid.join(" ");
  }
  return SCOPE_FALLBACK;
}

// Validate the credential file before trusting any token material from it.
// Reject symlinks (a symlink swap could redirect us at attacker-controlled
// content), enforce mode 0600 (anyone who can read the token can impersonate
// the user), require owner==uid. On any failure emit a distinct event and
// return null — the caller skips the tick.
function readAndValidateCred(path) {
  let lst;
  try { lst = lstatSync(path); }
  catch (err) {
    emitOAuthEvent("oauth_cred_unreadable", { reason: "stat_failed", err_code: err.code || "unknown" });
    return null;
  }
  if (lst.isSymbolicLink()) {
    emitOAuthEvent("oauth_cred_symlink_rejected", {});
    return null;
  }
  const mode = lst.mode & 0o777;
  if (mode !== 0o600) {
    // The directive treats wrong mode as a warning, not auto-correction —
    // the file may belong to an operator who set it intentionally. Refuse
    // to refresh until they fix it; a refresh write would clobber whatever
    // permissions they chose.
    emitOAuthEvent("oauth_cred_mode_warning", { mode_octal: mode.toString(8) });
    return null;
  }
  if (typeof process.getuid === "function" && lst.uid !== process.getuid()) {
    emitOAuthEvent("oauth_cred_unreadable", { reason: "owner_mismatch" });
    return null;
  }
  let raw, parsed;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) {
    emitOAuthEvent("oauth_cred_unreadable", { reason: "read_failed", err_code: err.code || "unknown" });
    return null;
  }
  try { parsed = JSON.parse(raw); }
  catch {
    emitOAuthEvent("oauth_cred_unreadable", { reason: "json_invalid" });
    return null;
  }
  const oauth = parsed && parsed.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.refreshToken !== "string" || typeof oauth.expiresAt !== "number") {
    emitOAuthEvent("oauth_cred_unreadable", { reason: "shape_invalid" });
    return null;
  }
  return parsed;
}

// Atomic persist: temp-write inside the same directory + fsync the file
// descriptor + atomic rename + fsync the parent directory so the rename
// itself is durable on crash. Mode 0600 on the temp and final paths.
function atomicWriteCred(finalPath, content) {
  const dir = dirname(finalPath);
  const tmp = join(dir, `.credentials.json.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  // fsync the data file
  const fd = openSync(tmp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, finalPath);
  // fsync the parent dir so the rename survives a crash
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {
    // Some platforms (notably Windows) reject opening a directory; the rename
    // is still durable on those filesystems. Don't fail the refresh.
  }
}

// POST to the token endpoint with a hard deadline. Returns one of:
//   { kind: "ok", body }
//   { kind: "timeout" }   — outcome is UNKNOWN (server may have rotated)
//   { kind: "revoked", status, error }  — 401 / invalid_grant → family dead
//   { kind: "error", status, err_class } — clean network/5xx, no rotation
//
// IMPORTANT: this function never logs the body. Callers must NOT pass `body`
// to any generic logger or event writer; only specific parsed fields may be
// persisted (to the credential file) or summarized (status_code, expires_at).
async function postRefresh(refreshToken, deadlineMs, credScopes) {
  const url = new URL(tokenUrl());
  const payload = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
    scope: scope(credScopes),
  });
  // CRITICAL (Codex r1 blocker 2): the AbortController must remain armed
  // across both the response-headers wait AND the body read. A server can
  // flush 200 OK headers in 1 s then stall the body past 10 s — that path
  // would leave the proxy holding the lock while the client stale-breaks,
  // exactly the second-refresher scenario §2a exists to prevent. So we
  // keep `signal: ac.signal` (which the fetch body reader honors) and only
  // clearTimeout after `res.text()` has resolved or rejected.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: payload,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") return { kind: "timeout" };
    return { kind: "error", status: 0, err_class: err && err.code ? err.code : "network_error" };
  }
  const status = res.status;
  let text;
  try {
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") return { kind: "timeout" };
    return { kind: "error", status, err_class: "body_read_error" };
  }
  clearTimeout(timer);
  if (status === 200) {
    let body;
    try { body = JSON.parse(text); } catch {
      return { kind: "error", status, err_class: "parse_error" };
    }
    return { kind: "ok", body };
  }
  if (status === 401 || status === 400) {
    // Cheap inspection of error class WITHOUT logging the body anywhere.
    // The OAuth spec response shape is { error: "...", error_description: "..." }
    // We extract ONLY the error code field (not the description, which can
    // sometimes echo input).
    let errCode = "unknown";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") errCode = parsed.error;
    } catch {}
    if (errCode === "invalid_grant" || status === 401) {
      return { kind: "revoked", status, error: errCode };
    }
    return { kind: "error", status, err_class: errCode };
  }
  return { kind: "error", status, err_class: `http_${status}` };
}

async function runOnce() {
  if (_running) return; // in-process serialize
  if (nowMs() < _backoffUntil) return;
  _running = true;
  _ticksFired += 1;
  try {
    const path = credPath();
    const parsed = readAndValidateCred(path);
    if (!parsed) return;

    const oauth = parsed.claudeAiOauth;
    const marginMs = config.oauthRefreshMarginMs;
    if (oauth.expiresAt - nowMs() > marginMs) return; // not yet due

    // Acquire the client-compatible lock. This is the load-bearing point:
    // proper-lockfile mkdir-protocol exclusion against a waking client.
    let release;
    try {
      release = await properLockfile.lock(path, lockOpts());
    } catch (err) {
      if (err && err.code === "ELOCKED") {
        emitOAuthEvent("oauth_lock_contended", {});
        return;
      }
      emitOAuthEvent("oauth_refresh_error", { err_class: (err && err.code) || "lock_error" });
      return;
    }

    if (_testHookAfterLock) {
      try { await _testHookAfterLock(); } catch {}
    }

    let lockReleased = false;
    const releaseLock = async () => {
      if (lockReleased) return;
      lockReleased = true;
      try { await release(); } catch {}
    };

    try {
      // Re-read inside the lock — another writer (a CC client we excluded
      // for an instant, or a prior proxy iteration) may have already
      // rotated. If so, we're idempotent: release and skip the POST.
      const reread = readAndValidateCred(path);
      if (!reread) return;
      const oauth2 = reread.claudeAiOauth;
      if (oauth2.accessToken !== oauth.accessToken) {
        // Already rotated by someone else.
        emitOAuthEvent("oauth_refresh_skipped", { reason: "already_rotated" });
        return;
      }
      if (oauth2.expiresAt - nowMs() > marginMs) {
        emitOAuthEvent("oauth_refresh_skipped", { reason: "no_longer_due" });
        return;
      }

      const deadlineMs = config.oauthPostTimeoutMs;
      const startedAt = nowMs();
      const result = await postRefresh(oauth2.refreshToken, deadlineMs, oauth2.scopes);
      const elapsedMs = nowMs() - startedAt;

      if (result.kind === "timeout") {
        // §2a UNKNOWN outcome — do NOT write, do NOT retry. Back off ≥
        // one stale window so a racing client's own refresh can settle.
        _backoffUntil = nowMs() + CLIENT_STALE_WINDOW_MS;
        emitOAuthEvent("oauth_refresh_timeout", { elapsed_ms: elapsedMs, deadline_ms: deadlineMs, backoff_ms: CLIENT_STALE_WINDOW_MS });
        return;
      }
      if (result.kind === "revoked") {
        // Family revoked — proxy can't self-heal. Loud distinct event +
        // long back-off so we don't hammer the dead token. The existing
        // credential file is left untouched so a human running /login
        // can recover from a known state.
        _backoffUntil = nowMs() + 60 * 60 * 1000; // 1h
        emitOAuthEvent("oauth_family_revoked", { status_code: result.status, error: result.error, recovery: "human_login_required" });
        try {
          process.stderr.write(
            "[cache-fix oauth] OAUTH FAMILY REVOKED — refresh token rejected. " +
            "Recovery requires interactive `/login` from a Claude Code session. " +
            "Proxy will not retry until that happens.\n",
          );
        } catch {}
        return;
      }
      if (result.kind === "error") {
        emitOAuthEvent("oauth_refresh_error", { status_code: result.status || 0, err_class: result.err_class, elapsed_ms: elapsedMs });
        return;
      }

      // Success — persist the rotated fields, preserving everything else.
      const body = result.body;
      const newAccess = body && typeof body.access_token === "string" ? body.access_token : null;
      const newRefresh = body && typeof body.refresh_token === "string" ? body.refresh_token : null;
      const expiresInSec = body && typeof body.expires_in === "number" ? body.expires_in : null;
      if (!newAccess || !newRefresh || expiresInSec === null) {
        // Server returned 200 but the response shape is wrong. Don't write —
        // a partial write could leave the file in an unreadable state.
        emitOAuthEvent("oauth_refresh_error", { status_code: 200, err_class: "response_shape_invalid" });
        return;
      }
      const newExpiresAt = nowMs() + expiresInSec * 1000;
      const updated = {
        ...parsed,
        claudeAiOauth: {
          ...oauth2,
          accessToken: newAccess,
          refreshToken: newRefresh,
          expiresAt: newExpiresAt,
        },
      };
      try {
        atomicWriteCred(path, JSON.stringify(updated, null, 2));
      } catch (err) {
        emitOAuthEvent("oauth_refresh_error", { status_code: 200, err_class: "persist_failed", err_code: (err && err.code) || "unknown" });
        return;
      }
      emitOAuthEvent("oauth_refreshed", {
        status_code: 200,
        expires_at: new Date(newExpiresAt).toISOString(),
        elapsed_ms: elapsedMs,
      });
    } finally {
      await releaseLock();
    }
  } catch (err) {
    // Last-resort fail-open: never let a refresher bug crash the proxy.
    // Codex r1 attention item: do NOT include err.message in the event —
    // even with the forbidden-key tripwire on emitOAuthEvent, a server-side
    // error message could in theory carry token material. err.code is a
    // bounded class identifier (e.g. "ENOENT", "EACCES") and is safe.
    emitOAuthEvent("oauth_refresh_error", { err_class: "unhandled", err_code: (err && err.code) || "unknown" });
  } finally {
    _running = false;
    _lastEvent = nowMs();
  }
}

export function startOAuthRefresher() {
  if (_interval) return;
  const tickMs = config.oauthTickMs;
  // First tick: schedule it via setTimeout so startup is non-blocking.
  setTimeout(() => { runOnce().catch(() => {}); }, 1000).unref();
  _interval = setInterval(() => { runOnce().catch(() => {}); }, tickMs);
  _interval.unref();
}

export function stopOAuthRefresher() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

// Test seams — used only by test/oauth-refresher.test.mjs. Not part of the
// public API; mirroring the warmer-monitor test-seam pattern.
export async function __runTickForTests() { await runOnce(); }
export function __resetForTests() {
  _running = false;
  _backoffUntil = 0;
  _ticksFired = 0;
  _lastEvent = null;
  _testHookAfterLock = null;
}
export function __setHookAfterLockForTests(fn) { _testHookAfterLock = fn; }
export function __getStateForTests() {
  return { running: _running, backoffUntil: _backoffUntil, ticksFired: _ticksFired, lastEvent: _lastEvent };
}
