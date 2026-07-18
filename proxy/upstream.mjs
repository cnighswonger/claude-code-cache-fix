import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { HttpProxyAgent, HttpsProxyAgent } from "hpagent";
import config from "./config.mjs";

const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function shouldStripRequestHeader(name) {
  const lower = name.toLowerCase();
  return STRIP_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-");
}

function shouldStripResponseHeader(name) {
  return STRIP_RESPONSE_HEADERS.has(name.toLowerCase());
}

function buildUpstreamHeaders(incomingHeaders, upstreamHostname) {
  const headers = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (shouldStripRequestHeader(key)) continue;
    headers[key] = value;
  }
  headers["host"] = upstreamHostname;
  headers["accept-encoding"] = "identity";
  return headers;
}

function filterResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (shouldStripResponseHeader(key)) continue;
    headers[key] = value;
  }
  return headers;
}

// --- HTTP proxy and custom CA support ---

const _agents = new Map();        // cache key → Agent | null
const _loggedProxies = new Set(); // dedupe stderr "using proxy" lines per (url, isHTTPS)
let _warnedTlsDisabled = false;

// --- Upstream connection identity ---
//
// Each underlying TCP socket gets a stable id the first time we see it. The
// id persists across keep-alive reuses of the same socket (WeakMap by socket
// reference) and dies when the socket is GC'd. New sockets — including
// reconnects after a closed connection — get fresh ids.
//
// This lets the rate-limit-log extension (and any future per-connection
// diagnostic) record which upstream connection a response came back on, so
// post-analysis can distinguish per-connection limiter behavior (Lead's H3,
// 2026-05-08 brief) from client-side queue saturation (H4) or genuinely
// account-wide limiting.
//
// Format: "cn-<int>" — opaque to consumers; only the equality and cardinality
// matter for analysis.

let _connectionIdCounter = 0;
const _socketIds = new WeakMap();

export function getOrAssignConnectionId(socket) {
  if (!socket) return null;
  let id = _socketIds.get(socket);
  if (id === undefined) {
    id = `cn-${++_connectionIdCounter}`;
    _socketIds.set(socket, id);
  }
  return id;
}

// Test-only: reset the monotonic counter. The WeakMap entries die with their
// sockets so we don't need to clear them; we just need a predictable start
// for assertions on id values across cases.
export function __resetConnectionIdsForTests() {
  _connectionIdCounter = 0;
}

function shouldBypassProxy(hostname) {
  if (!config.noProxy) return false;
  const list = config.noProxy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  for (const pattern of list) {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) {
      // ".example.com" matches "foo.example.com" and "example.com"
      const bare = pattern.slice(1);
      if (host === bare || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith("." + pattern)) {
      return true;
    }
  }
  return false;
}

function loadCa() {
  if (!config.caFile) return undefined;
  try {
    return readFileSync(config.caFile);
  } catch (err) {
    process.stderr.write(`[upstream] CACHE_FIX_PROXY_CA_FILE read failed: ${err.message}\n`);
    return undefined;
  }
}

// Pick the proxy URL for an upstream, matching curl/Python/Go semantics:
//   https upstream → HTTPS_PROXY, falling back to HTTP_PROXY if unset
//   http  upstream → HTTP_PROXY only (HTTPS_PROXY does NOT apply to plain HTTP)
//
// Exported for direct unit testing — tests against the live forwardRequest path
// can't easily reload a fresh config across cases (config is a single module
// instance), so we expose the pure function for table-driven coverage.
export function selectProxyUrl(isHTTPS) {
  if (isHTTPS) return config.httpsProxy || config.httpProxy || "";
  return config.httpProxy || "";
}

function buildAgent(isHTTPS, proxyUrl) {
  const ca = loadCa();
  if (proxyUrl) {
    const opts = {
      keepAlive: true,
      proxy: proxyUrl,
      rejectUnauthorized: config.rejectUnauthorized,
      ...(ca ? { ca } : {}),
    };
    return isHTTPS ? new HttpsProxyAgent(opts) : new HttpProxyAgent(opts);
  }
  // No proxy. Only build a custom agent when CA or insecure mode warrants it;
  // otherwise return null so Node uses its global default agent (preserves the
  // pre-change behavior end-to-end, including connection pooling).
  if (ca || !config.rejectUnauthorized) {
    if (isHTTPS) {
      return new https.Agent({
        keepAlive: true,
        rejectUnauthorized: config.rejectUnauthorized,
        ...(ca ? { ca } : {}),
      });
    }
    return new http.Agent({ keepAlive: true });
  }
  return null;
}

// Exported so other egress paths (e.g. the forward-proxy's download rewrite to
// storage.googleapis.com) reuse the SAME proxy/NO_PROXY/CA/TLS policy instead of
// reimplementing a subset of it.
export function getAgent(isHTTPS, hostname) {
  if (!_warnedTlsDisabled && !config.rejectUnauthorized) {
    _warnedTlsDisabled = true;
    process.stderr.write(
      `[upstream] WARNING: TLS verification disabled (CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0). This is insecure!\n`
    );
  }

  const bypass = shouldBypassProxy(hostname);
  const proxyUrl = bypass ? "" : selectProxyUrl(isHTTPS);
  const cacheKey = `${isHTTPS ? "https" : "http"}|${proxyUrl}|${config.caFile}|${config.rejectUnauthorized}`;

  let agent = _agents.get(cacheKey);
  if (agent === undefined) {
    agent = buildAgent(isHTTPS, proxyUrl);
    _agents.set(cacheKey, agent);
    if (proxyUrl && !_loggedProxies.has(`${proxyUrl}|${isHTTPS}`)) {
      _loggedProxies.add(`${proxyUrl}|${isHTTPS}`);
      process.stderr.write(
        `[upstream] using proxy ${proxyUrl} for ${isHTTPS ? "https" : "http"} upstream ` +
        `(rejectUnauthorized=${config.rejectUnauthorized}, ca=${config.caFile || "default"})\n`
      );
    }
  }
  return agent;
}

// RFC 7230 §5.3.2 absolute-form request-target. A client configured with
// HTTP(S)_PROXY does not always tunnel: axios's built-in proxy mode (which the
// Claude Code CLI's auto-updater and telemetry paths use) sends
// `GET https://host/path HTTP/1.1` on the plain proxy connection instead of
// issuing CONNECT. The authority inside that URI is the routing instruction.
// Returns a URL for absolute-form targets, null for origin-form ones.
export function parseAbsoluteForm(target) {
  if (!/^https?:\/\//i.test(target || "")) return null;
  try { return new URL(target); } catch { return null; }
}

// Build the upstream URL by concatenating the configured base (with any path
// component preserved) with the client request URL. The historical
// `new URL(clientReq.url, base)` approach is RFC 3986 relative-resolution,
// which drops the base's path component when the relative is path-absolute
// (`/v1/messages`). That breaks corp-proxy / mirror setups where the
// configured upstream is `https://corp-proxy.example.net/anthropic-mirror`
// — the request would land at `https://corp-proxy.example.net/v1/messages`
// with `/anthropic-mirror` silently dropped. See PR #188 / @nisqatsi.
export function buildUpstreamUrl(base, clientUrl) {
  // Absolute-form carries its own authority — honor it. Concatenating it onto
  // the base misroutes the request to the upstream host
  // (`api.anthropic.com/https://downloads.claude.ai/...` → the upstream CDN
  // answers 404), which surfaces to the user as a permanent
  // "✘ Auto-update failed" banner plus failed telemetry exports.
  const abs = parseAbsoluteForm(clientUrl);
  if (abs) return abs;
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const relative = clientUrl.startsWith("/") ? clientUrl : "/" + clientUrl;
  return new URL(trimmedBase + relative);
}

export function forwardRequest(clientReq, body, signal) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = buildUpstreamUrl(config.upstream, clientReq.url);

    const headers = buildUpstreamHeaders(clientReq.headers, upstreamUrl.hostname);
    if (body) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    const isHTTPS = upstreamUrl.protocol === "https:";
    const transport = isHTTPS ? https : http;
    const defaultPort = isHTTPS ? 443 : 80;

    const options = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || defaultPort,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: clientReq.method,
      headers,
      timeout: config.timeout,
      agent: getAgent(isHTTPS, upstreamUrl.hostname),
    };

    let upstreamConnectionId = null;
    // The 'socket' event fires when a socket is assigned to this request,
    // synchronously after transport.request() returns for both new and
    // pooled-keep-alive sockets. By the time the response callback runs we
    // already know which connection carried the request.
    const captureSocket = (sock) => {
      upstreamConnectionId = getOrAssignConnectionId(sock);
    };

    const upstreamReq = transport.request(options, (upstreamRes) => {
      const responseHeaders = filterResponseHeaders(upstreamRes.headers);
      resolve({
        upstreamRes,
        responseHeaders,
        statusCode: upstreamRes.statusCode,
        upstreamConnectionId,
      });
    });
    upstreamReq.on("socket", captureSocket);

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        upstreamReq.destroy(new Error("Request aborted"));
      }, { once: true });
    }

    if (body) {
      upstreamReq.end(body);
    } else {
      upstreamReq.end();
    }
  });
}
