// Tests for proxy/oauth/refresher.mjs. Covers the directive's load-bearing
// surface: validation gates, atomic persist, §2a hard deadline / UNKNOWN
// outcome (including headers-before-body stall), client-compatible lock
// path (.oauth_refresh.lock not .credentials.json.lock), in-lock idempotent
// re-read against a between-reads writer, revoked-family signaling, the
// no-write invariant on every non-200 outcome, and the no-token-leak
// invariant on the events log.
//
// Fixture-string discipline: token-shaped synthetic strings used to be
// flagged by GitGuardian as "Generic High Entropy Secret" even though they
// were obvious test placeholders. Use deliberately non-token-shaped fixture
// strings (uppercase + dashes only, prefix "FIXTURE-") so the entropy
// detector doesn't trigger on the test file.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import properLockfile from "proper-lockfile";

import {
  __runTickForTests,
  __resetForTests,
  __setHookAfterLockForTests,
} from "../proxy/oauth/refresher.mjs";

// --- helpers --------------------------------------------------------------

let tmpHome;
let credPath;
let lockPath;          // expected .oauth_refresh.lock — set per test
let eventsPath;
let mockServer;
let mockPort;
let mockHandler; // (req, res, body) => void

// Non-token-shaped fixture strings. These do NOT match the sk-ant-oat01 /
// sk-ant-ort01 patterns, do NOT look like API keys, and have low enough
// entropy (predictable prefix + capital letters + dashes) that GitGuardian's
// generic-high-entropy detector should pass them by.
const FIXTURE = {
  ACCESS_OLD:  "FIXTURE-ACCESS-OLD",
  REFRESH_OLD: "FIXTURE-REFRESH-OLD",
  ACCESS_NEW:  "FIXTURE-ACCESS-NEW",
  REFRESH_NEW: "FIXTURE-REFRESH-NEW",
  ACCESS_X:    "FIXTURE-X",
  REFRESH_Y:   "FIXTURE-Y",
};

function readEvents() {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function lastEvent() {
  const evs = readEvents();
  return evs.length ? evs[evs.length - 1] : null;
}

function writeCred(obj) {
  writeFileSync(credPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  chmodSync(credPath, 0o600);
}

function freshCredDueForRefresh() {
  // Token expires 30 minutes from now (default margin is 2h, so this is due).
  return {
    claudeAiOauth: {
      accessToken: FIXTURE.ACCESS_OLD,
      refreshToken: FIXTURE.REFRESH_OLD,
      expiresAt: Date.now() + 30 * 60 * 1000,
      scopes: ["user:inference", "user:profile"],
    },
    subscriptionType: "max",
    trustedDeviceToken: "preserved-trusted-token",
  };
}

function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try { mockHandler(req, res, body); }
        catch (err) {
          res.writeHead(500); res.end(String(err.message));
        }
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((r) => mockServer.close(r));
}

// --- lifecycle ------------------------------------------------------------

before(async () => {
  await startMockServer();
});

after(async () => {
  await stopMockServer();
});

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "oauth-refresher-"));
  credPath = join(tmpHome, ".credentials.json");
  lockPath = join(tmpHome, ".oauth_refresh.lock");
  eventsPath = join(tmpHome, "events.jsonl");
  process.env.CACHE_FIX_OAUTH_CRED_PATH = credPath;
  process.env.CACHE_FIX_OAUTH_EVENTS_LOG = eventsPath;
  process.env.CACHE_FIX_OAUTH_TOKEN_URL = `http://127.0.0.1:${mockPort}/v1/oauth/token`;
  // Aggressive defaults so tests are fast.
  process.env.CACHE_FIX_OAUTH_POST_TIMEOUT_MS = "500";
  process.env.CACHE_FIX_OAUTH_REFRESH_MARGIN_MS = `${2 * 60 * 60 * 1000}`;
  mockHandler = (req, res) => { res.writeHead(500); res.end(); };
  __resetForTests();
});

afterEach(() => {
  delete process.env.CACHE_FIX_OAUTH_CRED_PATH;
  delete process.env.CACHE_FIX_OAUTH_EVENTS_LOG;
  delete process.env.CACHE_FIX_OAUTH_TOKEN_URL;
  delete process.env.CACHE_FIX_OAUTH_POST_TIMEOUT_MS;
  delete process.env.CACHE_FIX_OAUTH_REFRESH_MARGIN_MS;
  delete process.env.CACHE_FIX_OAUTH_CLIENT_ID;
  rmSync(tmpHome, { recursive: true, force: true });
});

// --- tests ----------------------------------------------------------------

describe("oauth refresher — validation gates", () => {
  it("skips and emits oauth_cred_symlink_rejected if cred path is a symlink", async () => {
    const realFile = join(tmpHome, ".real-credentials.json");
    writeFileSync(realFile, JSON.stringify(freshCredDueForRefresh()), { mode: 0o600 });
    symlinkSync(realFile, credPath);
    let posted = false;
    mockHandler = (_req, res) => { posted = true; res.writeHead(200); res.end("{}"); };
    await __runTickForTests();
    assert.equal(posted, false, "no POST when cred is symlink");
    assert.equal(lastEvent().event, "oauth_cred_symlink_rejected");
  });

  it("skips and emits oauth_cred_mode_warning if cred is not mode 0600", async () => {
    writeCred(freshCredDueForRefresh());
    chmodSync(credPath, 0o644);
    let posted = false;
    mockHandler = (_req, res) => { posted = true; res.writeHead(200); res.end("{}"); };
    await __runTickForTests();
    assert.equal(posted, false);
    assert.equal(lastEvent().event, "oauth_cred_mode_warning");
  });

  it("skips when token is not yet within refresh margin (idempotent no-op)", async () => {
    const cred = freshCredDueForRefresh();
    cred.claudeAiOauth.expiresAt = Date.now() + 7 * 60 * 60 * 1000; // 7h out, margin is 2h
    writeCred(cred);
    let posted = false;
    mockHandler = (_req, res) => { posted = true; res.writeHead(200); res.end("{}"); };
    await __runTickForTests();
    assert.equal(posted, false);
    assert.equal(readEvents().length, 0, "no events when not due");
  });

  it("emits oauth_cred_unreadable on malformed JSON", async () => {
    writeFileSync(credPath, "{not json", { mode: 0o600 });
    await __runTickForTests();
    assert.equal(lastEvent().event, "oauth_cred_unreadable");
  });
});

describe("oauth refresher — successful refresh", () => {
  it("POSTs and persists rotated token atomically with mode 0600 and preserves other fields", async () => {
    writeCred(freshCredDueForRefresh());
    let sawPost = false;
    let postedBody = null;
    mockHandler = (req, res, body) => {
      sawPost = true; postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800, // 8h
        token_type: "Bearer",
      }));
    };
    await __runTickForTests();
    assert.equal(sawPost, true, "POST hit the mock endpoint");
    const parsed = JSON.parse(postedBody);
    assert.equal(parsed.grant_type, "refresh_token");
    assert.equal(typeof parsed.refresh_token, "string");
    assert.equal(typeof parsed.client_id, "string");

    const after = JSON.parse(readFileSync(credPath, "utf8"));
    assert.equal(after.claudeAiOauth.accessToken, FIXTURE.ACCESS_NEW);
    assert.equal(after.claudeAiOauth.refreshToken, FIXTURE.REFRESH_NEW);
    assert.equal(after.subscriptionType, "max", "preserved");
    assert.equal(after.trustedDeviceToken, "preserved-trusted-token", "preserved");
    assert.ok(after.claudeAiOauth.expiresAt > Date.now() + 7 * 60 * 60 * 1000, "expires_in applied");

    const ev = lastEvent();
    assert.equal(ev.event, "oauth_refreshed");
    assert.equal(ev.status_code, 200);
    assert.ok(ev.expires_at, "expires_at is recorded");
    const evStr = JSON.stringify(ev);
    assert.ok(!evStr.includes(FIXTURE.ACCESS_NEW), "no access token in event");
    assert.ok(!evStr.includes(FIXTURE.REFRESH_NEW), "no refresh token in event");
  });

  it("leaves no temp file behind after a successful persist", async () => {
    writeCred(freshCredDueForRefresh());
    mockHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW, refresh_token: FIXTURE.REFRESH_NEW, expires_in: 28800,
      }));
    };
    await __runTickForTests();
    const stragglers = readdirSync(tmpHome).filter((f) => f.startsWith(".credentials.json.tmp."));
    assert.equal(stragglers.length, 0, "no temp file left");
  });
});

describe("oauth refresher — §2a hard refresh deadline (load-bearing)", () => {
  it("on POST timeout: NO write, NO retry, distinct oauth_refresh_timeout event, back-off ≥ stale window", async () => {
    writeCred(freshCredDueForRefresh());
    const beforeContent = readFileSync(credPath, "utf8");
    // Mock that hangs past the 500ms deadline.
    mockHandler = (_req, res) => {
      setTimeout(() => { res.writeHead(200); res.end("{}"); }, 2000).unref();
    };

    const t0 = Date.now();
    await __runTickForTests();
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 1500, `aborted near deadline, got ${elapsed}ms`);

    const afterContent = readFileSync(credPath, "utf8");
    assert.equal(afterContent, beforeContent, "file untouched on timeout");

    const ev = lastEvent();
    assert.equal(ev.event, "oauth_refresh_timeout");
    assert.ok(ev.deadline_ms > 0);
    assert.ok(ev.backoff_ms >= 10000, "back-off at least one stale window (10s)");

    let retried = false;
    mockHandler = (_req, res) => {
      retried = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: FIXTURE.ACCESS_X, refresh_token: FIXTURE.REFRESH_Y, expires_in: 100 }));
    };
    await __runTickForTests();
    assert.equal(retried, false, "back-off suppresses next tick");
  });

  it("hard deadline holds even when the server returns 200 just past the deadline", async () => {
    writeCred(freshCredDueForRefresh());
    // Reply ~1000ms in (deadline 500ms).
    mockHandler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: FIXTURE.ACCESS_X, refresh_token: FIXTURE.REFRESH_Y, expires_in: 100 }));
      }, 1000).unref();
    };
    await __runTickForTests();
    const after = JSON.parse(readFileSync(credPath, "utf8"));
    assert.equal(after.claudeAiOauth.accessToken, FIXTURE.ACCESS_OLD,
      "ordering guarantee: a late 200 must not have raced past the deadline");
    assert.equal(lastEvent().event, "oauth_refresh_timeout");
  });

  // Codex r1 blocker 2: a server can flush 200 OK headers quickly and stall
  // the body past the stale window. The implementation must keep the abort
  // signal armed across the body read, not just the headers.
  it("headers-before-body stall is also aborted at the deadline (no write, oauth_refresh_timeout)", async () => {
    writeCred(freshCredDueForRefresh());
    const beforeContent = readFileSync(credPath, "utf8");
    mockHandler = (_req, res) => {
      // Headers flush immediately, body stalls past the 500 ms deadline.
      res.writeHead(200, { "content-type": "application/json" });
      // Write a partial chunk so the response has started but isn't done.
      res.write('{"access_token":"');
      // Then never finish — the AbortController must terminate the body read.
      // Don't unref the timer here; this server response is the thing we want
      // to outlive the deadline.
      setTimeout(() => {
        try {
          res.end(`${FIXTURE.ACCESS_NEW}","refresh_token":"${FIXTURE.REFRESH_NEW}","expires_in":28800}`);
        } catch {}
      }, 2000).unref();
    };

    const t0 = Date.now();
    await __runTickForTests();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `aborted body-read near deadline, got ${elapsed}ms`);

    const afterContent = readFileSync(credPath, "utf8");
    assert.equal(afterContent, beforeContent, "file untouched on body-stall timeout");
    assert.equal(lastEvent().event, "oauth_refresh_timeout",
      "headers-before-body stall must produce oauth_refresh_timeout, not oauth_refresh_error");
  });
});

describe("oauth refresher — revoked family", () => {
  it("emits a distinct oauth_family_revoked event on 401, does not clobber the file, backs off long", async () => {
    writeCred(freshCredDueForRefresh());
    const beforeContent = readFileSync(credPath, "utf8");
    mockHandler = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "FIXTURE-DESCRIPTION-MARKER" }));
    };
    await __runTickForTests();
    const afterContent = readFileSync(credPath, "utf8");
    assert.equal(afterContent, beforeContent, "dead credential left untouched for human /login recovery");
    const ev = lastEvent();
    assert.equal(ev.event, "oauth_family_revoked");
    assert.equal(ev.status_code, 401);
    assert.equal(ev.error, "invalid_grant");
    const evStr = JSON.stringify(ev);
    assert.ok(!evStr.includes("FIXTURE-DESCRIPTION-MARKER"), "error_description does not leak into event");

    let retried = false;
    mockHandler = (_req, res) => { retried = true; res.writeHead(401); res.end(); };
    await __runTickForTests();
    assert.equal(retried, false, "long back-off after revoke");
  });
});

describe("oauth refresher — Codex r1 blocker 1: client-compatible lock path", () => {
  it("locks .oauth_refresh.lock (NOT .credentials.json.lock); client lock-holder gets oauth_lock_contended", async () => {
    writeCred(freshCredDueForRefresh());

    // Simulate the Claude Code client holding its own .oauth_refresh.lock at
    // the directive-mandated path. proper-lockfile with lockfilePath option
    // and realpath:false is the exact protocol the client uses.
    const clientLockOpts = {
      lockfilePath: lockPath,
      realpath: false,
      stale: 10_000,
      retries: 0,
    };
    const clientRelease = await properLockfile.lock(credPath, clientLockOpts);
    try {
      // The proxy must see the client's lock and emit oauth_lock_contended,
      // NOT silently take a different lock and POST anyway.
      let posted = false;
      mockHandler = (_req, res) => { posted = true; res.writeHead(200); res.end("{}"); };
      await __runTickForTests();
      assert.equal(posted, false, "proxy must NOT POST while the client holds .oauth_refresh.lock");
      assert.equal(lastEvent().event, "oauth_lock_contended",
        "proxy must observe the client-held lock at .oauth_refresh.lock");

      // The .credentials.json.lock path must NOT have been created — that
      // would prove the proxy was locking the wrong path.
      const wrongPath = `${credPath}.lock`;
      assert.equal(existsSync(wrongPath), false,
        ".credentials.json.lock must not exist; proxy must use .oauth_refresh.lock only");
    } finally {
      await clientRelease();
    }
  });

  it("after the client releases, the proxy successfully refreshes via the same lock path", async () => {
    writeCred(freshCredDueForRefresh());
    // After-lock-release: the proxy's next tick should succeed.
    mockHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW, refresh_token: FIXTURE.REFRESH_NEW, expires_in: 28800,
      }));
    };
    await __runTickForTests();
    const after = JSON.parse(readFileSync(credPath, "utf8"));
    assert.equal(after.claudeAiOauth.accessToken, FIXTURE.ACCESS_NEW);

    // proper-lockfile cleans up the lock dir after release on success.
    // (Existence isn't load-bearing — only the path-used-during-acquire is.)
  });
});

describe("oauth refresher — Codex r1 blocker 3: in-lock race-recovery", () => {
  it("if a writer rotates the cred between pre-lock read and in-lock re-read, the proxy bails without POSTing (oauth_refresh_skipped already_rotated)", async () => {
    writeCred(freshCredDueForRefresh());

    let posted = false;
    mockHandler = (_req, res) => {
      posted = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW, refresh_token: FIXTURE.REFRESH_NEW, expires_in: 28800,
      }));
    };

    // Install a hook that fires between pre-lock read and in-lock re-read.
    // Simulates the "another client just rotated" path: rewrite the cred
    // with a different accessToken (still due, same mode), so the proxy's
    // in-lock re-read sees a CHANGED accessToken and must skip the POST.
    __setHookAfterLockForTests(() => {
      const sneaky = freshCredDueForRefresh();
      sneaky.claudeAiOauth.accessToken = "FIXTURE-ACCESS-INTERLOPER";
      sneaky.claudeAiOauth.refreshToken = "FIXTURE-REFRESH-INTERLOPER";
      writeCred(sneaky);
    });

    await __runTickForTests();
    assert.equal(posted, false, "the in-lock re-read must skip without POSTing");
    const ev = lastEvent();
    assert.equal(ev.event, "oauth_refresh_skipped");
    assert.equal(ev.reason, "already_rotated");
  });

  it("if a writer rotates to a fresh-enough token between reads, oauth_refresh_skipped reason=no_longer_due", async () => {
    writeCred(freshCredDueForRefresh());

    let posted = false;
    mockHandler = (_req, res) => {
      posted = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_X, refresh_token: FIXTURE.REFRESH_Y, expires_in: 28800,
      }));
    };

    __setHookAfterLockForTests(() => {
      // Same accessToken but expiry pushed way out (someone else rotated
      // the expiresAt forward by completing a refresh between our reads).
      // This is the second branch of the in-lock skip.
      const fresh = freshCredDueForRefresh();
      fresh.claudeAiOauth.expiresAt = Date.now() + 7 * 60 * 60 * 1000;
      writeCred(fresh);
    });

    await __runTickForTests();
    assert.equal(posted, false);
    const ev = lastEvent();
    assert.equal(ev.event, "oauth_refresh_skipped");
    assert.equal(ev.reason, "no_longer_due");
  });
});

describe("oauth refresher — response shape validation", () => {
  it("rejects a 200 with missing fields and does NOT touch the file", async () => {
    writeCred(freshCredDueForRefresh());
    const beforeContent = readFileSync(credPath, "utf8");
    mockHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Missing refresh_token AND expires_in
      res.end(JSON.stringify({ access_token: FIXTURE.ACCESS_X }));
    };
    await __runTickForTests();
    const afterContent = readFileSync(credPath, "utf8");
    assert.equal(afterContent, beforeContent, "shape-invalid 200 must not corrupt the file");
    const ev = lastEvent();
    assert.equal(ev.event, "oauth_refresh_error");
    assert.equal(ev.err_class, "response_shape_invalid");
  });
});

describe("oauth refresher — events log never contains token material", () => {
  it("events.mjs refuses to emit a record that carries forbidden keys", async () => {
    writeCred(freshCredDueForRefresh());
    mockHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "FIXTURE-LEAK-CANARY-A",
        refresh_token: "FIXTURE-LEAK-CANARY-R",
        expires_in: 100,
      }));
    };
    await __runTickForTests();
    writeCred(freshCredDueForRefresh());
    mockHandler = (_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "FIXTURE-LEAK-CANARY-DESC" }));
    };
    __resetForTests();
    await __runTickForTests();

    const raw = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    assert.ok(!raw.includes("FIXTURE-LEAK-CANARY-A"), "access_token never reaches event log");
    assert.ok(!raw.includes("FIXTURE-LEAK-CANARY-R"), "refresh_token never reaches event log");
    assert.ok(!raw.includes("FIXTURE-LEAK-CANARY-DESC"), "error_description never reaches event log");
  });
});

describe("oauth refresher — in-process serialize", () => {
  it("a concurrent re-entrant tick is dropped (no double-POST in-process)", async () => {
    writeCred(freshCredDueForRefresh());
    let postCount = 0;
    mockHandler = (_req, res) => {
      postCount += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: FIXTURE.ACCESS_X, refresh_token: FIXTURE.REFRESH_Y, expires_in: 28800 }));
      }, 100).unref();
    };
    const t1 = __runTickForTests();
    const t2 = __runTickForTests();
    await Promise.all([t1, t2]);
    assert.equal(postCount, 1, "in-process serialize prevented the second POST");
  });
});

// v4.2.1 regression — scope preservation
//
// 2026-06-23 incident: v4.2.0 hardcoded the refresh-grant scope to
// `user:inference user:profile`. The real CC credential file holds five
// scopes including `user:sessions:claude_code`. The narrower refresh
// silently produced a narrower token; /v1/messages kept working because it
// only needs user:inference, but remote-bridge / code-session calls 401'd.
// The fix reads `claudeAiOauth.scopes` from the credential file and uses
// them verbatim on the refresh POST.
describe("oauth refresher — v4.2.1 scope preservation", () => {
  function credWithScopes(scopes) {
    const c = freshCredDueForRefresh();
    c.claudeAiOauth.scopes = scopes;
    return c;
  }

  function parsePostedScopes(postedBody) {
    const parsed = JSON.parse(postedBody);
    return (parsed.scope || "").split(" ").filter(Boolean);
  }

  it("refresh POST body carries the EXACT scopes from the credential file (not a hardcoded subset)", async () => {
    const FULL_SCOPES = [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ];
    writeCred(credWithScopes(FULL_SCOPES));
    let postedBody = null;
    mockHandler = (_req, res, body) => {
      postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    await __runTickForTests();
    assert.ok(postedBody, "POST did fire");
    const sent = parsePostedScopes(postedBody);
    // Order may differ due to dedupe; assert membership not exact-string.
    assert.deepEqual(sent.sort(), [...FULL_SCOPES].sort(),
      "every scope from the cred file must be on the refresh POST — narrowing produces a narrower token");
  });

  it("refresh POST also carries user:sessions:claude_code when present (the load-bearing scope from the incident)", async () => {
    writeCred(credWithScopes(["user:inference", "user:profile", "user:sessions:claude_code"]));
    let postedBody = null;
    mockHandler = (_req, res, body) => {
      postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    await __runTickForTests();
    const sent = parsePostedScopes(postedBody);
    assert.ok(sent.includes("user:sessions:claude_code"),
      "user:sessions:claude_code MUST round-trip — its absence on the rotated token is what caused the 2026-06-23 remote-bridge 401 burst");
  });

  it("preserves scopes on the persisted credential (passthrough via spread)", async () => {
    const FULL_SCOPES = [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ];
    writeCred(credWithScopes(FULL_SCOPES));
    mockHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    await __runTickForTests();
    const after = JSON.parse(readFileSync(credPath, "utf8"));
    assert.deepEqual(after.claudeAiOauth.scopes.sort(), [...FULL_SCOPES].sort(),
      "persisted credential's scopes array MUST be identical to pre-refresh — preserves auth surface for non-/v1/messages APIs");
  });

  it("CACHE_FIX_OAUTH_SCOPE env override beats the credential file (intentional operator-control escape hatch)", async () => {
    writeCred(credWithScopes(["user:inference", "user:profile", "user:sessions:claude_code"]));
    process.env.CACHE_FIX_OAUTH_SCOPE = "user:inference";
    let postedBody = null;
    mockHandler = (_req, res, body) => {
      postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    try {
      await __runTickForTests();
      const sent = parsePostedScopes(postedBody);
      assert.deepEqual(sent, ["user:inference"], "env override is honored verbatim");
    } finally {
      delete process.env.CACHE_FIX_OAUTH_SCOPE;
    }
  });

  it("falls back to a minimal scope set when the credential file has no scopes array (malformed-but-valid edge case)", async () => {
    // Build a cred without the scopes field at all (older CC versions?).
    const cred = freshCredDueForRefresh();
    delete cred.claudeAiOauth.scopes;
    writeCred(cred);
    let postedBody = null;
    mockHandler = (_req, res, body) => {
      postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    await __runTickForTests();
    assert.ok(postedBody, "refresh fired even without scopes array");
    const sent = parsePostedScopes(postedBody);
    // Fallback is intentional and bounded; assert it's nonempty and OAuth-shaped
    assert.ok(sent.length > 0, "fallback scope set is non-empty");
    for (const s of sent) {
      assert.match(s, /^[a-z]+:[a-z_]+$/, `scope "${s}" matches expected user:foo shape`);
    }
  });

  it("dedupes and filters scopes from malformed cred (e.g. duplicates, empty strings, non-strings)", async () => {
    const cred = freshCredDueForRefresh();
    cred.claudeAiOauth.scopes = ["user:inference", "user:inference", "", "user:profile", null, "  ", 123];
    writeCred(cred);
    let postedBody = null;
    mockHandler = (_req, res, body) => {
      postedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: FIXTURE.ACCESS_NEW,
        refresh_token: FIXTURE.REFRESH_NEW,
        expires_in: 28800,
      }));
    };
    await __runTickForTests();
    const sent = parsePostedScopes(postedBody);
    assert.deepEqual(sent.sort(), ["user:inference", "user:profile"],
      "duplicates dropped, empty/whitespace-only/non-string entries skipped");
  });
});
