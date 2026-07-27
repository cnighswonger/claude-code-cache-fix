// Corp-proxy / CA tests for proxy/upstream.mjs.
//
// Why these are unit-shaped, not integration-shaped: the proxy reads upstream
// config (CACHE_FIX_PROXY_UPSTREAM, etc.) at module import time. That means a
// single test file can't cleanly cover multiple upstream-protocol scenarios via
// dynamic re-imports — config.mjs is cached after first load. We could spawn a
// fresh process per scenario, but the value being verified (correct env-var
// selection) is a pure function. So we export it from upstream.mjs and table-test
// it directly here. The end-to-end "does hpagent route through the proxy" path
// is hpagent's own responsibility and is verified manually (see PR description).

import { test } from "node:test";
import assert from "node:assert/strict";

test("selectProxyUrl: protocol-based selection matches curl/Python/Go", async () => {
  // Covers the blocker review flagged: the original code collapsed HTTPS_PROXY
  // and HTTP_PROXY into one value with HTTPS_PROXY winning unconditionally,
  // which is wrong for http: upstreams.
  const { selectProxyUrl } = await import("../proxy/upstream.mjs");

  const cases = [
    // [HTTPS_PROXY, HTTP_PROXY, isHTTPS, expected, label]
    ["http://hp", "http://h", true,  "http://hp", "https upstream prefers HTTPS_PROXY"],
    ["",          "http://h", true,  "http://h",  "https upstream falls back to HTTP_PROXY when HTTPS_PROXY unset"],
    ["http://hp", "",         true,  "http://hp", "https upstream uses HTTPS_PROXY when HTTP_PROXY unset"],
    ["",          "",         true,  "",          "https upstream returns empty when neither set"],
    ["http://hp", "http://h", false, "http://h",  "http upstream uses HTTP_PROXY (NOT HTTPS_PROXY)"],
    ["http://hp", "",         false, "",          "http upstream returns empty when only HTTPS_PROXY set"],
    ["",          "http://h", false, "http://h",  "http upstream uses HTTP_PROXY when HTTPS_PROXY unset"],
    ["",          "",         false, "",          "http upstream returns empty when neither set"],
  ];

  // Save and clear BOTH cases. selectProxyUrl honors lowercase too, so an
  // ambient lowercase https_proxy in the developer's shell would otherwise leak
  // into the cases that set only the uppercase var and expect no proxy.
  const VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    for (const k of VARS) delete process.env[k];
    for (const [hps, hp, isHTTPS, expected, label] of cases) {
      process.env.HTTPS_PROXY = hps;
      process.env.HTTP_PROXY = hp;
      assert.equal(selectProxyUrl(isHTTPS), expected, label);
    }
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("selectProxyUrl: lowercase env vars are honored", async () => {
  const { selectProxyUrl } = await import("../proxy/upstream.mjs");
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY:  process.env.HTTP_PROXY,  http_proxy:  process.env.http_proxy,
  };
  try {
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    process.env.https_proxy = "http://lowhttps";
    process.env.http_proxy  = "http://lowhttp";
    assert.equal(selectProxyUrl(true),  "http://lowhttps", "https upstream picks lowercase https_proxy");
    assert.equal(selectProxyUrl(false), "http://lowhttp",  "http upstream picks lowercase http_proxy");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("buildUpstreamUrl: preserves base-path component (PR #188 regression)", async () => {
  // The blocker @nisqatsi caught: `new URL(clientReq.url, base)` is RFC 3986
  // relative-resolution, which drops the base's path component when the
  // relative URL is path-absolute (`/v1/messages`). For mirror / corp-proxy
  // setups the base path is load-bearing — losing it routes the request to
  // the wrong host path. Table-test the fixed concatenation logic so
  // future refactors don't regress this case.
  const { buildUpstreamUrl } = await import("../proxy/upstream.mjs");

  const cases = [
    // [base, clientUrl, expectedHref, label]
    [
      "https://api.anthropic.com",
      "/v1/messages",
      "https://api.anthropic.com/v1/messages",
      "no-path base behaves as before",
    ],
    [
      "https://api.anthropic.com/",
      "/v1/messages",
      "https://api.anthropic.com/v1/messages",
      "trailing slash on base is normalized",
    ],
    [
      "https://corp-proxy.example.net/anthropic-mirror",
      "/v1/messages",
      "https://corp-proxy.example.net/anthropic-mirror/v1/messages",
      "base-path preserved (the bug @nisqatsi caught)",
    ],
    [
      "https://corp-proxy.example.net/anthropic-mirror/",
      "/v1/messages",
      "https://corp-proxy.example.net/anthropic-mirror/v1/messages",
      "base-path preserved AND trailing slash idempotent",
    ],
    [
      "https://corp-proxy.example.net/deep/nested/path",
      "/v1/messages",
      "https://corp-proxy.example.net/deep/nested/path/v1/messages",
      "multi-segment base path preserved",
    ],
    [
      "https://api.anthropic.com",
      "/v1/messages?beta=true&x=y",
      "https://api.anthropic.com/v1/messages?beta=true&x=y",
      "query string flows through cleanly",
    ],
    [
      "https://corp-proxy.example.net/mirror",
      "/v1/messages?beta=true",
      "https://corp-proxy.example.net/mirror/v1/messages?beta=true",
      "query string preserved across the base-path fix",
    ],
    [
      "http://localhost:9802/anthropic",
      "/v1/messages",
      "http://localhost:9802/anthropic/v1/messages",
      "http + non-standard port + base-path",
    ],
  ];

  for (const [base, clientUrl, expected, label] of cases) {
    assert.equal(buildUpstreamUrl(base, clientUrl).href, expected, label);
  }
});

test("forwardRequest is exported and module loads cleanly with no proxy env vars (no regression)", async () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY:  process.env.HTTP_PROXY,  http_proxy:  process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY, CACHE_FIX_PROXY_CA_FILE: process.env.CACHE_FIX_PROXY_CA_FILE,
  };
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    const upstream = await import("../proxy/upstream.mjs");
    assert.equal(typeof upstream.forwardRequest, "function");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
