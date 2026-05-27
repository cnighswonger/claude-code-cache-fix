import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

let extension;
let logPath;
let tmpHome;

function readRecords() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("bootstrap-defense extension", () => {
  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "bootstrap-defense-"));
    logPath = join(tmpHome, "cache-fix-bootstrap-log.jsonl");
    process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH = logPath;
    extension = (await import("../proxy/extensions/bootstrap-defense.mjs?t=" + Date.now())).default;
  });

  after(() => {
    delete process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH;
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    try { unlinkSync(logPath); } catch {}
    try { unlinkSync(`${logPath}.1`); } catch {}
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    delete process.env.CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS;
    delete process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE;
    delete process.env.CLAUDE_CODE_REMOTE;
  });

  describe("non-bootstrap routes", () => {
    it("onRequest no-ops when route !== bootstrap", async () => {
      const ctx = { body: { model: "x" }, headers: {}, meta: { route: "messages" } };
      const result = await extension.onRequest(ctx);
      assert.equal(result, undefined);
      assert.equal(readRecords().length, 0);
    });

    it("onResponse no-ops when route !== bootstrap", async () => {
      const ctx = { status: 200, headers: {}, body: { foo: "bar" }, meta: { route: "messages" } };
      await extension.onResponse(ctx);
      assert.equal(readRecords().length, 0);
    });
  });

  describe("audit mode (default)", () => {
    it("onRequest does not short-circuit", async () => {
      const ctx = { body: {}, headers: {}, meta: { route: "bootstrap" } };
      const result = await extension.onRequest(ctx);
      assert.equal(result, undefined);
      assert.equal(ctx.meta._bootstrapDefenseMode, "audit");
    });

    it("onResponse writes one JSONL record per bootstrap response", async () => {
      const ctx = {
        status: 200,
        // ctx.headers on onResponse is the upstream RESPONSE header map and
        // does not carry Host or request-id. The extension reads both from
        // ctx.meta (stashed at forward time by handleBootstrap).
        headers: { "content-type": "application/json" },
        body: { system_prompt_section: "hello" },
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-abc",
        },
      };
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.phase, "response_audited");
      assert.equal(r.mode, "audit");
      assert.equal(r.status, 200);
      assert.equal(r.request_id, "req-abc");
      assert.equal(r.upstream_host, "api.anthropic.com");
      assert.ok(r.body_bytes > 0);
      assert.equal(r.schema_version, 2);
      assert.equal(r.extension_version, "v3.7.1");
      assert.equal(r.baseline_hash, null);
      assert.equal(r.anomaly_status, null);
      // v3.7.1 fields default for no-injection-detected baseline.
      assert.equal(r.surface, "bootstrap");
      assert.equal(r.prompt_key, null);
      assert.equal(r.prompt_value_hash, null);
      assert.equal(r.remote_mode, false);
      assert.deepEqual(r.stripped_keys, []);
      assert.ok(r.timestamp);
    });
  });

  describe("surface detection — audit mode", () => {
    // Helper: full audit record requires _bootstrapUpstreamHost + _bootstrapRequestId
    // on meta, otherwise extractAuditFields nulls them.
    function bootstrapCtx(body, extraMeta = {}) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-surface",
          ...extraMeta,
        },
      };
    }

    it("case 1: response carries tengu_heron_brook only — single bootstrap-surface record", async () => {
      await extension.onResponse(bootstrapCtx({ tengu_heron_brook: "you are claude" }));
      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.surface, "bootstrap");
      assert.equal(r.prompt_key, "tengu_heron_brook");
      assert.ok(r.prompt_value_hash, "hash should be populated when value is present");
      assert.equal(r.prompt_value_hash.length, 16);
      assert.deepEqual(r.stripped_keys, []);
    });

    it("case 2: env var set, response carries the env-selected key — single prompt_injection_gb record", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      await extension.onResponse(bootstrapCtx({ foo_bar: "injected prompt body" }));
      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.surface, "prompt_injection_gb");
      assert.equal(r.prompt_key, "foo_bar");
      assert.ok(r.prompt_value_hash);
      assert.deepEqual(r.stripped_keys, []);
    });

    it("case 3: multi-surface — both tengu_heron_brook AND env-selected key present", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      await extension.onResponse(bootstrapCtx({
        tengu_heron_brook: "legacy prompt",
        foo_bar: "env-selected prompt",
      }));
      const records = readRecords();
      assert.equal(records.length, 2);
      const heron = records.find((r) => r.surface === "bootstrap");
      const inj = records.find((r) => r.surface === "prompt_injection_gb");
      assert.ok(heron, "bootstrap surface record present");
      assert.ok(inj, "prompt_injection_gb surface record present");
      assert.equal(heron.prompt_key, "tengu_heron_brook");
      assert.equal(inj.prompt_key, "foo_bar");
      assert.notEqual(heron.prompt_value_hash, inj.prompt_value_hash, "different values → different hashes");
      // Correlation: both records share request_id and audit-time window.
      assert.equal(heron.request_id, inj.request_id);
    });

    it("case 3a: env-var-aliases-legacy-key — two records with same prompt_key but distinct surfaces", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "tengu_heron_brook";
      await extension.onResponse(bootstrapCtx({ tengu_heron_brook: "you are claude" }));
      const records = readRecords();
      assert.equal(records.length, 2);
      const heron = records.find((r) => r.surface === "bootstrap");
      const inj = records.find((r) => r.surface === "prompt_injection_gb");
      assert.ok(heron && inj);
      assert.equal(heron.prompt_key, "tengu_heron_brook");
      assert.equal(inj.prompt_key, "tengu_heron_brook");
      assert.equal(heron.prompt_value_hash, inj.prompt_value_hash, "same key → same hash");
      assert.notEqual(heron.surface, inj.surface, "operator-visibility signal preserved");
    });

    it("case 4: env var set, response does NOT carry the named key — prompt_injection_gb record with null hash", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      await extension.onResponse(bootstrapCtx({ system_prompt_section: "unrelated" }));
      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.surface, "prompt_injection_gb");
      assert.equal(r.prompt_key, "foo_bar");
      assert.equal(r.prompt_value_hash, null);
      assert.deepEqual(r.stripped_keys, []);
    });

    it("case 5: neither prompt-source key present — single baseline record (no surface fires)", async () => {
      await extension.onResponse(bootstrapCtx({ system_prompt_section: "hello", other_flag: 42 }));
      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.surface, "bootstrap");
      assert.equal(r.prompt_key, null);
      assert.equal(r.prompt_value_hash, null);
      assert.deepEqual(r.stripped_keys, []);
    });

    it("case 6: JSON-unparseable response body (ctx.body=null) — single anomaly record, no multi-surface emission", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      const ctx = {
        status: 500,
        headers: {},
        body: null,
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapBodyBytes: 23,
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-unparseable",
        },
      };
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].surface, "bootstrap");
      assert.equal(records[0].prompt_key, null);
      assert.equal(records[0].prompt_value_hash, null);
      assert.deepEqual(records[0].stripped_keys, []);
    });
  });

  describe("allowlist mode — surface stripping", () => {
    function allowlistCtx(body) {
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "allowlist";
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "allowlist",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-allow",
        },
      };
    }

    it("case 8: env-var-selected key NOT in allowlist — key stripped from body, recorded in stripped_keys", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      const ctx = allowlistCtx({ foo_bar: "injected", other: "kept" });
      await extension.onResponse(ctx);
      const records = readRecords();
      const r = records.find((x) => x.surface === "prompt_injection_gb");
      assert.deepEqual(r.stripped_keys, ["foo_bar"]);
      assert.equal("foo_bar" in ctx.body, false, "key removed from body");
      assert.equal(ctx.body.other, "kept", "non-prompt-source keys preserved");
    });

    it("case 9: env-var-selected key IS in allowlist — key passes through, stripped_keys empty", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      process.env.CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS = "foo_bar,tengu_heron_brook";
      const ctx = allowlistCtx({ foo_bar: "legit" });
      await extension.onResponse(ctx);
      const records = readRecords();
      const r = records.find((x) => x.surface === "prompt_injection_gb");
      assert.deepEqual(r.stripped_keys, []);
      assert.equal(ctx.body.foo_bar, "legit");
    });

    it("case 10: explicit empty CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS — even tengu_heron_brook is stripped", async () => {
      process.env.CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS = "";
      const ctx = allowlistCtx({ tengu_heron_brook: "even-legacy-not-trusted" });
      await extension.onResponse(ctx);
      const records = readRecords();
      const r = records.find((x) => x.surface === "bootstrap");
      assert.deepEqual(r.stripped_keys, ["tengu_heron_brook"]);
      assert.equal("tengu_heron_brook" in ctx.body, false);
    });

    it("case 11: only prompt-source-eligible keys subject to stripping; other GB flags pass through", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      const ctx = allowlistCtx({
        foo_bar: "evil",
        random_feature_flag: "kept",
        tengu_other_thing: "also kept",
      });
      await extension.onResponse(ctx);
      assert.equal("foo_bar" in ctx.body, false);
      assert.equal(ctx.body.random_feature_flag, "kept");
      assert.equal(ctx.body.tengu_other_thing, "also kept");
    });

    it("case 12: multi-surface, only env-selected key non-allowlisted — two records, only one strips", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "foo_bar";
      // default allowlist = ["tengu_heron_brook"]
      const ctx = allowlistCtx({
        tengu_heron_brook: "legacy-allowed",
        foo_bar: "env-selected-blocked",
      });
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 2);
      const heron = records.find((r) => r.surface === "bootstrap");
      const inj = records.find((r) => r.surface === "prompt_injection_gb");
      assert.deepEqual(heron.stripped_keys, []);
      assert.deepEqual(inj.stripped_keys, ["foo_bar"]);
      // Body delivered to CC has only the allowlisted key.
      assert.equal(ctx.body.tengu_heron_brook, "legacy-allowed");
      assert.equal("foo_bar" in ctx.body, false);
    });

    it("alias case in allowlist mode — both surfaces strip the same key idempotently", async () => {
      process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE = "tengu_heron_brook";
      process.env.CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS = "";
      const ctx = allowlistCtx({ tengu_heron_brook: "blocked" });
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 2);
      for (const r of records) {
        assert.deepEqual(r.stripped_keys, ["tengu_heron_brook"]);
      }
      assert.equal("tengu_heron_brook" in ctx.body, false);
    });
  });

  describe("remote_mode signal", () => {
    it("case 13: remote_mode reflects CLAUDE_CODE_REMOTE env var presence/absence", async () => {
      const baseCtx = () => ({
        status: 200,
        headers: {},
        body: {},
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-rm",
        },
      });

      // Unset → false
      delete process.env.CLAUDE_CODE_REMOTE;
      await extension.onResponse(baseCtx());
      let records = readRecords();
      assert.equal(records[records.length - 1].remote_mode, false);

      // Set → true (presence is what matters, value irrelevant)
      process.env.CLAUDE_CODE_REMOTE = "1";
      await extension.onResponse(baseCtx());
      records = readRecords();
      assert.equal(records[records.length - 1].remote_mode, true);

      // Block-mode request_blocked records also carry remote_mode
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      const blockCtx = {
        body: {},
        headers: {},
        meta: {
          route: "bootstrap",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-rm-block",
        },
      };
      await extension.onRequest(blockCtx);
      records = readRecords();
      assert.equal(records[records.length - 1].phase, "request_blocked");
      assert.equal(records[records.length - 1].remote_mode, true);
    });
  });

  describe("hash derivation contract", () => {
    it("prompt_value_hash matches the pinned derivation (sha256 hex, first 16 chars)", async () => {
      const { createHash } = await import("node:crypto");
      const expectedHash = createHash("sha256").update("test value", "utf8").digest("hex").slice(0, 16);
      assert.equal(expectedHash.length, 16);

      const ctx = {
        status: 200,
        headers: {},
        body: { tengu_heron_brook: "test value" },
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-hash",
        },
      };
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records[0].prompt_value_hash, expectedHash);
    });
  });

  describe("block mode", () => {
    it("onRequest returns skip with empty 200 and records request_blocked with upstream_host", async () => {
      // Realistic shape: handleBootstrap pre-populates _bootstrapUpstreamHost
      // and _bootstrapRequestId via the preForward baseMeta param, so even
      // the block path (which short-circuits in onRequest before forwarding)
      // gets a fully-populated audit record.
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      const ctx = {
        body: {},
        headers: {},
        meta: {
          route: "bootstrap",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-block-1",
        },
      };
      const result = await extension.onRequest(ctx);
      assert.deepEqual(result, {
        skip: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: {},
      });
      const records = readRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].phase, "request_blocked");
      assert.equal(records[0].mode, "block");
      assert.equal(records[0].request_id, "req-block-1");
      assert.equal(records[0].upstream_host, "api.anthropic.com");
    });

    it("onRequest falls back to ctx.headers when meta lacks request_id (defense in depth)", async () => {
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      const ctx = {
        body: {},
        headers: { "request-id": "req-fallback-1" },
        meta: { route: "bootstrap" },
      };
      await extension.onRequest(ctx);
      const records = readRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].request_id, "req-fallback-1");
    });

    it("onResponse no-ops in block mode (response never collected)", async () => {
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      const ctx = {
        status: 200,
        headers: {},
        body: {},
        meta: { route: "bootstrap", _bootstrapDefenseMode: "block" },
      };
      await extension.onResponse(ctx);
      assert.equal(readRecords().length, 0);
    });
  });

  describe("mode resolution", () => {
    it("invalid CACHE_FIX_BOOTSTRAP_MODE falls back to audit", async () => {
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "nonsense";
      const ctx = { body: {}, headers: {}, meta: { route: "bootstrap" } };
      const result = await extension.onRequest(ctx);
      assert.equal(result, undefined);
      assert.equal(ctx.meta._bootstrapDefenseMode, "audit");
    });
  });

  describe("PII discipline", () => {
    it("audit record never contains client request header keys other than host/request-id", async () => {
      // Pass headers including Authorization, x-api-key, cookie, x-forwarded-for.
      // Record must extract ONLY host + request-id; no sensitive header should
      // appear anywhere in the JSONL row.
      const ctx = {
        body: {},
        headers: {
          host: "api.anthropic.com",
          "request-id": "req-pii-test",
          authorization: "Bearer sk-ant-secret-token",
          "x-api-key": "sk-ant-api03-extremely-sensitive",
          cookie: "session=secret-cookie-value",
          "x-forwarded-for": "10.0.0.42",
        },
        meta: {
          route: "bootstrap",
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-pii-test",
        },
      };
      // Drive a full audit record via the block-mode path (which logs synchronously).
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      await extension.onRequest(ctx);

      const records = readRecords();
      assert.equal(records.length, 1);
      const r = records[0];
      const serialized = JSON.stringify(r);
      assert.equal(r.upstream_host, "api.anthropic.com");
      assert.equal(r.request_id, "req-pii-test");
      assert.equal(serialized.includes("sk-ant"), false, "API key must not appear in audit record");
      assert.equal(serialized.includes("Bearer"), false, "Authorization token must not appear in audit record");
      assert.equal(serialized.includes("secret-cookie-value"), false, "Cookie must not appear in audit record");
      assert.equal(serialized.includes("10.0.0.42"), false, "X-Forwarded-For must not appear in audit record");
    });
  });

  describe("upstream error path", () => {
    it("onResponse records upstream_error_audited phase when meta carries error", async () => {
      const ctx = {
        status: 502,
        headers: {},
        body: null,
        meta: {
          route: "bootstrap",
          _bootstrapDefenseMode: "audit",
          _bootstrapUpstreamError: "ECONNREFUSED 127.0.0.1:1",
          _bootstrapBodyBytes: 0,
          _bootstrapUpstreamHost: "api.anthropic.com",
          _bootstrapRequestId: "req-err-1",
        },
      };
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].phase, "upstream_error_audited");
      assert.equal(records[0].status, 502);
      assert.equal(records[0].error, "ECONNREFUSED 127.0.0.1:1");
      assert.equal(records[0].body_bytes, 0);
      assert.equal(records[0].upstream_host, "api.anthropic.com");
      assert.equal(records[0].request_id, "req-err-1");
    });
  });

  describe("log rotation", () => {
    it("rotates log file when it exceeds 5MB cap", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(logPath, "x".repeat(5 * 1024 * 1024 + 1));
      const sizeBefore = statSync(logPath).size;
      assert.ok(sizeBefore > 5 * 1024 * 1024);

      const ctx = { status: 200, headers: {}, body: {}, meta: { route: "bootstrap", _bootstrapDefenseMode: "audit" } };
      await extension.onResponse(ctx);

      assert.ok(existsSync(`${logPath}.1`), "rotated log file should exist");
      assert.ok(statSync(logPath).size < sizeBefore, "active log should be smaller after rotation");
    });
  });
});
