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
        headers: { "request-id": "req-abc", host: "api.anthropic.com" },
        body: { system_prompt_section: "hello" },
        meta: { route: "bootstrap", _bootstrapDefenseMode: "audit" },
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
      assert.equal(r.schema_version, 1);
      assert.equal(r.baseline_hash, null);
      assert.equal(r.anomaly_status, null);
      assert.ok(r.timestamp);
    });
  });

  describe("block mode", () => {
    it("onRequest returns skip with empty 200", async () => {
      process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
      const ctx = { body: {}, headers: { host: "api.anthropic.com" }, meta: { route: "bootstrap" } };
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
        meta: { route: "bootstrap" },
      };
      // Drive a full audit record via the block-mode path (which logs request headers).
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
        },
      };
      await extension.onResponse(ctx);
      const records = readRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].phase, "upstream_error_audited");
      assert.equal(records[0].status, 502);
      assert.equal(records[0].error, "ECONNREFUSED 127.0.0.1:1");
      assert.equal(records[0].body_bytes, 0);
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
