import https from "node:https";
import http from "node:http";
import { connect as netConnect } from "node:net";
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

// The hops BELOW the one we normally dial, nearest first, so a hop that is off
// can be routed around instead of answering 502.
//
// A session bakes HTTPS_PROXY at exec and never re-reads it, so it cannot fail
// over itself: when the hop it names goes away the session is stranded for its
// whole life. We are the one process in the chain that CAN re-decide, because
// `config.httpsProxy` is a getter read per request.
//
// Configured, never guessed: CACHE_FIX_FALLBACK_PROXIES is a comma-separated
// list of proxy URLs. Empty (the default) keeps the old behaviour exactly —
// one hop, 502 when it is down — so nothing changes for anyone who has not
// asked for this.
export function fallbackProxyUrls() {
  // OUR OWN ADDRESS IS NEVER A FALLBACK. A request routed there comes straight
  // back to us, and with both hops in this chain carrying a list (the agreed
  // symmetric design) that is how a request ping-pongs until the socket dies.
  // The pin guards the same shape in its _ambient_proxy, which skips a value
  // pointing at its own daemon.
  // config.port, not the raw env: the env may be unset (the default applies) or
  // "0" (the OS picked one), and a self-address we fail to compute is a self-
  // address we fail to exclude.
  const mine = new Set();
  // CACHE_FIX_HELD_PORT too, and it is the one that matters: the holder tells
  // its child CACHE_FIX_PROXY_PORT=0 (take the descriptor, do not bind), so the
  // two names above exclude 127.0.0.1:0 while the address the child actually
  // serves stays in the list. A fallback list that begins with self then routes
  // the child into itself.
  for (const p of [config.port, process.env.CACHE_FIX_PROXY_PORT,
                   process.env.CACHE_FIX_HELD_PORT].filter(Boolean))
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) mine.add(`${h}:${p}`);
  return (process.env.CACHE_FIX_FALLBACK_PROXIES || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .filter((u) => { try { return !mine.has(new URL(u).host); } catch { return false; } });
}

// The chain grace, matched to the pin's _CHAIN_HEAL_GRACE_S / _CHAIN_HEAL_POLL_S
// rather than chosen independently. One window for one chain: two components
// each waiting their own amount is how a request gets abandoned by one while
// the other is still hopeful. Both numbers were measured against the same
// event — a hop killed and restarted is back in ~1s and REFUSES throughout.
const CHAIN_GRACE_MS = Number(process.env.CACHE_FIX_CHAIN_GRACE_MS) || 2500;
const CHAIN_POLL_MS = Number(process.env.CACHE_FIX_CHAIN_POLL_MS) || 200;

// The hop to dial for this request: the configured one when it answers, else
// the first fallback that does, else "" (a direct dial). Retries the WHOLE list
// for the grace window before giving up on it — a hop that is restarting is
// back within it, and waiting beats routing around a hop that never left.
//
// Logged per episode, not per request, and in the string the pin also emits so
// one probe greps both: `hop <addr> unusable`.
let _lastHopReport = "";
export async function resolveHop(isHTTPS) {
  const primary = selectProxyUrl(isHTTPS);
  const chain = [primary, ...fallbackProxyUrls()].filter(Boolean);
  if (!chain.length) return "";
  const deadline = Date.now() + CHAIN_GRACE_MS;
  for (;;) {
    for (const hop of chain) {
      if (await hopAlive(hop)) {
        if (hop !== primary) {
          const note = `hop ${addrOf(primary)} unusable — routing via ${addrOf(hop)}`;
          if (note !== _lastHopReport) { _lastHopReport = note; process.stderr.write(`[upstream] ${note}\n`); }
        } else if (_lastHopReport) {
          _lastHopReport = "";
          process.stderr.write(`[upstream] hop ${addrOf(primary)} is back\n`);
        }
        return hop;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, CHAIN_POLL_MS));
  }
  // Nothing in the chain answered. A direct dial is the pin's fail-open stance
  // too ("egress DIRECT — no chain hop reachable"), and it beats 502: the
  // request goes out unpinned rather than not at all.
  const note = `hop ${addrOf(primary)} unusable — no chain hop reachable, dialling direct`;
  if (note !== _lastHopReport) { _lastHopReport = note; process.stderr.write(`[upstream] ${note}\n`); }
  return "";
}

const addrOf = (u) => { try { return new URL(u).host; } catch { return u || "direct"; } };

// Is a hop answering right now? A refused dial is the cheap, immediate signal —
// measured across a holder restart, a hop that is down REFUSES rather than
// accepting and hanging, so this costs a syscall and never a timeout.
export function hopAlive(proxyUrl, timeoutMs = 700) {
  return new Promise((res) => {
    let u;
    try { u = new URL(proxyUrl); } catch { return res(false); }
    const sock = netConnect({ host: u.hostname, port: Number(u.port) || 80 });
    const done = (ok) => { sock.destroy(); res(ok); };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
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
export function getAgent(isHTTPS, hostname, hop) {
  if (!_warnedTlsDisabled && !config.rejectUnauthorized) {
    _warnedTlsDisabled = true;
    process.stderr.write(
      `[upstream] WARNING: TLS verification disabled (CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0). This is insecure!\n`
    );
  }

  const bypass = shouldBypassProxy(hostname);
  // `hop` is the address resolveHop() picked for THIS request. Absent (every
  // caller that has not opted in) it falls back to the configured one, so the
  // signature change is invisible to them.
  const proxyUrl = bypass ? "" : (hop !== undefined ? hop : selectProxyUrl(isHTTPS));
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

export async function forwardRequest(clientReq, body, signal) {
  const upstreamUrl0 = buildUpstreamUrl(config.upstream, clientReq.url);
  // Resolve the hop BEFORE building the request: a hop that is off gets routed
  // around here, so a session wired to this proxy never sees the outage. With
  // no fallbacks configured this returns the configured hop unchanged and costs
  // one loopback dial.
  const hop = fallbackProxyUrls().length && !shouldBypassProxy(upstreamUrl0.hostname)
    ? await resolveHop(upstreamUrl0.protocol === "https:")
    : undefined;
  return new Promise((resolve, reject) => {
    const upstreamUrl = upstreamUrl0;

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
      agent: getAgent(isHTTPS, upstreamUrl.hostname, hop),
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
