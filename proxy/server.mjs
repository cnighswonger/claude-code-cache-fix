import http from "node:http";
import { pathToFileURL, URL } from "node:url";
import config from "./config.mjs";
import { forwardRequest, parseAbsoluteForm } from "./upstream.mjs";
import { streamResponse, createTelemetryRecord } from "./stream.mjs";
import { loadExtensions, snapshotRegistry, runOnRequest, runOnResponseStart, runOnResponse, getFailedExtensions } from "./pipeline.mjs";
import { startWatcher } from "./watcher.mjs";
import { startOAuthRefresher, stopOAuthRefresher } from "./oauth/refresher.mjs";
import { attachForwardProxy, handleDownloadsAbsolute } from "./forward-proxy.mjs";

// Debug logging — writes to ~/.claude/cache-fix-debug.log (override path with
// CACHE_FIX_DEBUG_LOG). Self-gated on CACHE_FIX_DEBUG=1; a no-op otherwise.
// Env is read on every call so tests (and operators flipping the flag at
// runtime) see live behavior — same pattern as image-strip's #98 gate.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import util from "node:util";
import { claudeHome } from "./claude-home.mjs";

function debugLogPath() {
  return process.env.CACHE_FIX_DEBUG_LOG ||
    join(claudeHome(), "cache-fix-debug.log");
}

// Never spread raw headers to the log: Authorization / x-api-key / cookies
// must never persist to disk. Same discipline as bootstrap-defense.mjs's
// audit-record contract — extract named scalars only.
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

function debugLog(...args) {
  if (process.env.CACHE_FIX_DEBUG !== "1") return;
  const path = debugLogPath();
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] ${util.format(...args)}\n`;
  try { appendFileSync(path, line); } catch {}
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Run the pre-forward pipeline stages (collect body, parse, runOnRequest)
// and either short-circuit with an extension-supplied response (block mode,
// auth-failure synth, etc.) or return the inputs the caller needs to drive
// forwarding and the post-response stages.
//
// `routeName` is stashed on ctx.meta.route so route-aware extensions
// (bootstrap-defense, env-flag-detector) can discriminate without each
// route needing its own pipeline hook.
async function preForward(clientReq, clientRes, _abortController, extSnapshot, routeName, baseMeta = {}) {
  const rawBody = await collectBody(clientReq);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  let forwardBody = rawBody;
  // baseMeta lets routes pre-populate audit scalars (e.g. resolved upstream
  // hostname, request_id) so they're available to onRequest hooks BEFORE the
  // upstream call — block-mode short-circuits in onRequest, so a post-call
  // stash would miss the block-path audit record.
  const meta = { ...baseMeta, route: routeName };

  if (extSnapshot.length > 0) {
    const reqCtx = { body: parsed, headers: { ...clientReq.headers }, meta };
    const skipResult = await runOnRequest(reqCtx, extSnapshot);

    if (skipResult && skipResult.skip) {
      const status = skipResult.status || 400;
      const headers = skipResult.headers || { "content-type": "application/json" };
      const body = skipResult.body ?? { error: "blocked_by_extension" };
      clientRes.writeHead(status, headers);
      clientRes.end(typeof body === "string" ? body : JSON.stringify(body));
      return { handled: true };
    }

    if (parsed) {
      forwardBody = Buffer.from(JSON.stringify(reqCtx.body));
    }
  }

  return { handled: false, parsed, forwardBody, meta };
}

async function handleMessages(clientReq, clientRes) {
  const abortController = new AbortController();
  const extSnapshot = snapshotRegistry();

  // Streaming SSE: if the client gives up mid-stream, free the upstream.
  // Bootstrap (handleBootstrap) doesn't install this because its response is
  // a single non-SSE JSON payload — aborting on clientReq close prematurely
  // would race the response write on fast-failure paths (e.g. ECONNREFUSED).
  clientReq.on("close", () => {
    if (!clientRes.writableEnded) abortController.abort();
  });

  const pre = await preForward(clientReq, clientRes, abortController, extSnapshot, "messages");
  if (pre.handled) {
    debugLog("[PROXY] handled internally without upstream request",
             "method:", clientReq.method, "url:", clientReq.url,
             "status:", clientRes.statusCode,
             "response headers:", redactHeaders(clientRes.getHeaders()));
    return;
  }
  const { parsed, forwardBody, meta } = pre;

  const requestedModel = parsed?.model || null;

  let upstreamRes, responseHeaders, statusCode, upstreamConnectionId;

  try {
    ({ upstreamRes, responseHeaders, statusCode, upstreamConnectionId } = await forwardRequest(
      clientReq,
      forwardBody,
      abortController.signal
    ));
  } catch (err) {
    debugLog("[PROXY] forwardRequest error:", err.message);
    if (abortController.signal.aborted) return;
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    return;
  }

  // Stash upstream connection id on meta so downstream extensions
  // (rate-limit-log, future per-connection diagnostics) can record which
  // socket carried the request without each one re-instrumenting upstream.
  meta._upstreamConnectionId = upstreamConnectionId ?? null;

  debugLog("[UPSTREAM -> PROXY -> CLAUDE] RESPONSE",
           "status:", statusCode, "message:", upstreamRes.statusMessage,
           "upstream headers:", redactHeaders(upstreamRes.headers),
           "proxy headers:", redactHeaders(responseHeaders));

  if (extSnapshot.length > 0) {
    const resCtx = { status: statusCode, headers: responseHeaders, meta };
    await runOnResponseStart(resCtx, extSnapshot);
  }

  const isStreaming = (responseHeaders["content-type"] || "").includes("text/event-stream");

  if (!isStreaming) {
    const chunks = [];
    for await (const chunk of upstreamRes) chunks.push(chunk);
    const rawResponse = Buffer.concat(chunks);

    if (extSnapshot.length > 0) {
      let responseBody;
      try {
        responseBody = JSON.parse(rawResponse.toString());
      } catch {
        responseBody = null;
      }
      if (responseBody) {
        const resCtx = { status: statusCode, headers: responseHeaders, body: responseBody, meta };
        await runOnResponse(resCtx, extSnapshot);
        clientRes.writeHead(statusCode, resCtx.headers);
        clientRes.end(JSON.stringify(resCtx.body));
      } else {
        clientRes.writeHead(statusCode, responseHeaders);
        clientRes.end(rawResponse);
      }
    } else {
      clientRes.writeHead(statusCode, responseHeaders);
      clientRes.end(rawResponse);
    }
    return;
  }

  clientRes.writeHead(statusCode, responseHeaders);

  const telemetry = createTelemetryRecord();
  telemetry.requestedModel = requestedModel;

  upstreamRes.on("error", (err) => {
    if (!clientRes.writableEnded) {
      clientRes.destroy(err);
    }
  });

  try {
    await streamResponse(upstreamRes, clientRes, telemetry, extSnapshot, meta, responseHeaders);
  } catch (err) {
    if (!clientRes.writableEnded) {
      clientRes.destroy(err);
    }
  }
}

// Route handler for `/api/claude_cli/bootstrap` (CC v2.1.150+ system-prompt
// injection channel). Same pipeline shape as handleMessages but without
// the streaming branch — bootstrap is a single non-SSE JSON response.
// The bootstrap-defense extension binds to onRequest/onResponse with
// `ctx.meta.route === "bootstrap"` to drive audit/block behavior.
async function handleBootstrap(clientReq, clientRes) {
  const abortController = new AbortController();
  const extSnapshot = snapshotRegistry();

  // Resolve audit-record scalars BEFORE preForward so they're visible to
  // onRequest hooks (block-mode short-circuits there). HTTP responses don't
  // carry a Host header, so the audit log derives upstream_host from
  // config.upstream — the actual destination requests were forwarded to.
  let upstreamHost = null;
  try {
    upstreamHost = new URL(config.upstream).hostname;
  } catch {}
  const baseMeta = {
    _bootstrapUpstreamHost: upstreamHost,
    _bootstrapRequestId:
      clientReq.headers["request-id"] ?? clientReq.headers["x-request-id"] ?? null,
  };

  const pre = await preForward(clientReq, clientRes, abortController, extSnapshot, "bootstrap", baseMeta);
  if (pre.handled) return;
  const { forwardBody, meta } = pre;

  let upstreamRes, responseHeaders, statusCode, upstreamConnectionId;

  try {
    ({ upstreamRes, responseHeaders, statusCode, upstreamConnectionId } = await forwardRequest(
      clientReq,
      forwardBody,
      abortController.signal,
    ));
  } catch (err) {
    // Anomaly audit: bootstrap upstream errors are exactly the kind of event
    // an attacker triggering DNS shenanigans or an outage would produce, so
    // route them through the extension pipeline before responding 502.
    if (extSnapshot.length > 0) {
      meta._bootstrapUpstreamError = err.message;
      meta._bootstrapBodyBytes = 0;
      const errCtx = { status: 502, headers: {}, body: null, meta };
      await runOnResponse(errCtx, extSnapshot);
    }
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    return;
  }

  meta._upstreamConnectionId = upstreamConnectionId ?? null;

  if (extSnapshot.length > 0) {
    const resCtx = { status: statusCode, headers: responseHeaders, meta };
    await runOnResponseStart(resCtx, extSnapshot);
  }

  const chunks = [];
  for await (const chunk of upstreamRes) chunks.push(chunk);
  const rawResponse = Buffer.concat(chunks);

  if (extSnapshot.length > 0) {
    let responseBody = null;
    try {
      responseBody = JSON.parse(rawResponse.toString());
    } catch {}
    // Stash raw byte count so bootstrap-defense (and future audit extensions)
    // can record the on-wire payload size even when the body fails to parse.
    // Non-JSON responses are exactly the anomaly audit mode needs to capture.
    meta._bootstrapBodyBytes = rawResponse.length;
    const resCtx = { status: statusCode, headers: responseHeaders, body: responseBody, meta };
    await runOnResponse(resCtx, extSnapshot);
    if (responseBody !== null) {
      clientRes.writeHead(statusCode, resCtx.headers);
      clientRes.end(JSON.stringify(resCtx.body));
      return;
    }
  }

  clientRes.writeHead(statusCode, responseHeaders);
  clientRes.end(rawResponse);
}

// Set true only after attachForwardProxy() actually succeeds. `config
// .forwardProxy` reflects the REQUESTED mode; this reflects the EFFECTIVE mode.
// They diverge when forward-proxy was requested but attach failed (e.g. openssl
// missing so CA generation threw) and we fell back to reverse-proxy. /health
// reports the effective value so clients/monitoring aren't told forward-proxy
// is on when it silently isn't.
// Count of live, successfully-attached forward-proxy instances in this process
// (embedded/test processes can run several). Routing and /health key on this —
// NOT on config.forwardProxy — so a requested-but-failed attach serves
// reverse-mode semantics, and a closed forward instance retires its vote
// instead of haunting later reverse-only instances in the same process.
let _forwardActive = 0;

function handleHealth(_req, res) {
  // Surface extension-load failures so callers (operators, monitoring) see
  // a degraded proxy state instead of a misleading "ok". See #196: a Node
  // ESM cache stale-import race silently broke thinking-block-sanitize v2
  // for 17 hours post-merge before anyone noticed. /health returning "ok"
  // through that window was load-bearing in the silence.
  const failed = getFailedExtensions();
  if (failed.length > 0) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "degraded",
      failed_extensions: failed,
      hint: "restart the proxy via your supervisor to recover (in-process reload cannot fix stale ESM cache; #196)",
    }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  // Surface the outbound proxy the forward-proxy blind-tunnels CONNECTs through
  // (config.httpsProxy, from HTTPS_PROXY/https_proxy). A supervisor/health probe
  // can then tell a proxy that came up WITH the expected corp proxy from one that
  // came up WITHOUT it — a stale instance started without HTTPS_PROXY still
  // answers forward_proxy:true but silently dials non-MITM hosts directly, which
  // fails behind a corp firewall. Only meaningful in forward-proxy mode; null
  // when no outbound proxy is configured.
  res.end(JSON.stringify({
    status: "ok",
    version: config.version,
    forward_proxy: _forwardActive > 0,
    https_proxy: (_forwardActive > 0 && config.httpsProxy) || null,
  }));
}

function handleNotFound(_req, res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

// Transparent pass-through for forward-proxy mode. When the proxy MITMs the
// whole upstream host (CACHE_FIX_FORWARD_PROXY=on), it sees EVERY request to
// api.anthropic.com, not just /v1/messages. Non-transformed paths (Remote
// Control credential fetch, OAuth, /api/*, ...) must be relayed to upstream
// untouched; otherwise they'd 404 and break RC ("Remote credentials fetch
// failed"). No pipeline, no parsing: collect the body (if any), forward it via
// the same upstream transport (incl. corp-proxy egress), and stream the
// response straight back. Reverse-proxy mode never reaches this (only
// /v1/messages arrives there), so its 404 contract is unchanged.
async function handlePassthrough(clientReq, clientRes) {
  const abortController = new AbortController();
  clientReq.on("close", () => { if (!clientRes.writableEnded) abortController.abort(); });

  const method = (clientReq.method || "GET").toUpperCase();
  const body = (method === "GET" || method === "HEAD") ? null : await collectBody(clientReq);

  let upstreamRes, responseHeaders, statusCode;
  try {
    ({ upstreamRes, responseHeaders, statusCode } = await forwardRequest(
      clientReq, body, abortController.signal));
  } catch (err) {
    debugLog("[PROXY] passthrough forwardRequest error:", err.message, "url:", clientReq.url);
    if (abortController.signal.aborted) return;
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    }
    return;
  }
  // Success-path trace (gated on CACHE_FIX_DEBUG=1, no-op otherwise). Forward
  // mode relays every non-transformed path — RC credential fetches, OAuth,
  // /api/* — verbatim, and those never touched the pipeline's logging. Without
  // this line a working RC relay is invisible server-side, so validating RC
  // required a client in the loop. Method + path + status only; no headers or
  // body (this path carries credentials — see redactHeaders discipline above).
  debugLog("[PROXY] passthrough:", method, clientReq.url, "->", statusCode);
  clientRes.writeHead(statusCode, responseHeaders);
  upstreamRes.on("error", () => { if (!clientRes.writableEnded) clientRes.end(); });
  upstreamRes.pipe(clientRes);
}

/**
 * Builds an http.Server with the proxy's request handler wired in. The
 * returned server is **not** listening and the extension pipeline has not
 * been initialized — callers wanting a one-call setup should use
 * `startProxy()` instead.
 *
 * Exposed so callers can embed the proxy in their own process (e.g.
 * Bun-compiled binaries, test harnesses) without forking a child or
 * shelling out to the `cache-fix-proxy` bin.
 */
export function createProxyServer() {
  return http.createServer((req, res) => {
    // Async IIFE: handleMessages/handleBootstrap return promises, so we have
    // to await them inside the try/catch — a bare return would let rejections
    // escape to unhandledRejection and (on Node 15+) crash the process.
    (async () => {
      try {
        debugLog("[CLAUDE -> PROXY] REQUEST",
                 "method:", req.method, "url:", req.url,
                 "headers:", redactHeaders(req.headers));

        // Wrap res.write/res.end to log chunk-level activity when debug is on.
        // These are sync monkey-patches; the inner debugLog self-gates so the
        // overhead is negligible when CACHE_FIX_DEBUG is unset.
        const originalWrite = res.write;
        const originalEnd = res.end;
        res.write = function (chunk, ...args) {
          debugLog(`[PROXY -> CLAUDE] Send chunk. Size: ${chunk ? chunk.length : 0} bytes`);
          return originalWrite.apply(res, [chunk, ...args]);
        };
        res.end = function (chunk, ...args) {
          debugLog("[PROXY -> CLAUDE] Close connection (res.end)");
          return originalEnd.apply(res, [chunk, ...args]);
        };

        // RFC 7230 §5.3.2 absolute-form request-target. A proxy-configured
        // client does not always tunnel: axios's plain-proxy mode (the CLI's
        // auto-updater / telemetry paths) sends `GET https://host/path` on the
        // proxy connection instead of CONNECT. Only meaningful in forward mode
        // — reverse mode keeps its 404 contract for such targets (see below).
        if (_forwardActive > 0) {
          const abs = parseAbsoluteForm(req.url);
          if (abs) {
            // downloads.claude.ai with the rewrite active: same acceleration
            // as the CONNECT-MITM arrival style.
            if (handleDownloadsAbsolute(req, res, abs)) return;
            // Targets on the upstream reduce to origin-form so the normal
            // routing below (incl. the /v1/messages transform) applies.
            // Compare origins, not hostnames: scheme and port are part of
            // the authority (two servers on one host differ only by port).
            // Foreign targets fall through to handlePassthrough, where
            // buildUpstreamUrl honors the absolute-form authority.
            let upOrigin = "";
            try { upOrigin = new URL(config.upstream).origin; } catch {}
            if (abs.origin === upOrigin) req.url = abs.pathname + abs.search;
          }
        }

        if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);
        if (req.method === "POST" && req.url?.startsWith("/v1/messages")) return await handleMessages(req, res);
        if (req.url?.startsWith("/api/claude_cli/bootstrap")) return await handleBootstrap(req, res);
        // Forward-proxy mode MITMs the whole host, so any other path (RC creds,
        // OAuth, ...) must be relayed to upstream untouched rather than 404'd.
        // Keyed on _forwardProxyActive (attach actually succeeded), NOT
        // config.forwardProxy (the env request): if attachForwardProxy() threw,
        // the proxy is serving reverse-mode only and must keep that mode's 404
        // contract instead of silently relaying non-core paths upstream.
        if (_forwardActive > 0) return await handlePassthrough(req, res);
        debugLog("ERROR: handler not found for req.url=", req.url, "method=", req.method);
        handleNotFound(req, res);
      } catch (error) {
        debugLog("REQUEST HANDLER ERROR:", error?.message, error?.stack);
        // Generic body: do NOT echo error.message (may include internal paths,
        // upstream URLs, or other server state).
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_proxy_error" }));
        }
      }
    })();
  });
}

// The forward-mode self-heal swallowers are process-wide, so they are
// installed once (ref-counted across instances) and — the part the old
// env-var guard got wrong — removed again when the last attached forward
// instance closes. An embedded/shared process that ran forward mode earlier
// must regain Node's default crash-on-uncaught semantics afterwards, not
// keep masking fatal bugs for every later run.
let _selfHealRefs = 0;
let _selfHealHandlers = null;
function installSelfHeal() {
  _selfHealRefs++;
  if (_selfHealHandlers) return;
  const onException = (err) => {
    process.stderr.write(`[cache-fix] self-heal: uncaughtException swallowed (proxy stays up): ${err && err.stack || err}\n`);
  };
  const onRejection = (reason) => {
    process.stderr.write(`[cache-fix] self-heal: unhandledRejection swallowed (proxy stays up): ${reason && reason.stack || reason}\n`);
  };
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  _selfHealHandlers = { onException, onRejection };
}
function removeSelfHeal() {
  if (!_selfHealHandlers || --_selfHealRefs > 0) return;
  process.off("uncaughtException", _selfHealHandlers.onException);
  process.off("unhandledRejection", _selfHealHandlers.onRejection);
  _selfHealHandlers = null;
}

/**
 * Builds the server, loads the extension pipeline, optionally starts the
 * extensions-config file watcher, and starts listening. Returns a handle
 * with the bound port (resolved when port 0 is requested) and a `close`
 * function for graceful shutdown.
 *
 * All options fall back to the same env vars / defaults used by the CLI
 * entrypoint, so existing deployments behave identically.
 *
 *   await startProxy()                               // env-driven, CLI parity
 *   await startProxy({ port: 0 })                    // OS-assigned port
 *   await startProxy({ port: 0, watch: false })      // embedded, no fs.watch
 */
export async function startProxy(options = {}) {
  const port = options.port ?? config.port;
  const bind = options.bind ?? config.bind;
  const extensionsDir = options.extensionsDir ?? config.extensionsDir;
  const extensionsConfig = options.extensionsConfig ?? config.extensionsConfig;
  // Hot-reload is opt-in as of v4.0.0 (#196). The in-process watcher is the
  // only code path that triggers the Node ESM stale-import race; cold starts
  // have an empty module cache and load extensions cleanly. Strict `=== "on"`
  // means any other value (including "true"/"1"/"yes") is treated as off —
  // the safe default. Note this is the opposite stance from
  // CACHE_FIX_THINKING_SANITIZE (default-on; only literal "off" disables):
  // a hot-reload enable is a footgun, so we require the operator to type the
  // exact opt-in token; a sanitize disable is also a footgun (loses the
  // wedge mitigation), so we require the exact disable token there.
  const hotReloadOptIn = process.env.CACHE_FIX_HOT_RELOAD === "on";
  const watch = options.watch !== false && hotReloadOptIn;

  // Boot banner on stderr so the EFFECTIVE hot-reload mode is visible in the
  // supervisor's log (journalctl --user / ~/Library/Logs/) without being
  // noisy for monitoring tools that line-grep stderr. Keyed off the effective
  // `watch` value, not the raw envvar, so an embedder calling startProxy({
  // watch: false }) with the envvar set sees "off" (which is the truth — the
  // watcher is suppressed regardless of envvar in that case). Supervisor-
  // neutral wording — no version pin (lives in CHANGELOG/README instead).
  if (watch) {
    process.stderr.write(
      "[cache-fix] hot-reload: on (CACHE_FIX_HOT_RELOAD=on) — long-running processes can hit a Node ESM stale-import race; see #196. Restart the proxy via your supervisor to recover.\n",
    );
  } else {
    process.stderr.write(
      "[cache-fix] hot-reload: off (set CACHE_FIX_HOT_RELOAD=on to enable). Extension changes require a supervisor-level proxy restart.\n",
    );
  }

  let watcher = null;
  try {
    await loadExtensions(extensionsDir, extensionsConfig);
    if (watch) watcher = startWatcher(extensionsDir, extensionsConfig);
  } catch {}

  const server = createProxyServer();

  // Forward-proxy mode (CACHE_FIX_FORWARD_PROXY=on): also handle CONNECT and
  // MITM only the upstream host, so the client wires HTTPS_PROXY (not
  // ANTHROPIC_BASE_URL) and keeps Remote Control. Attached before listen so the
  // handler is present for the first CONNECT. Failure falls back to
  // reverse-proxy only rather than preventing the proxy from serving.
  let forwardProxyCA = null;
  let forwardAttached = false;
  if (config.forwardProxy) {
    try { forwardProxyCA = attachForwardProxy(server); _forwardActive++; forwardAttached = true; }
    catch (err) { process.stderr.write(`[cache-fix] forward-proxy FAILED (reverse-proxy only): ${err && err.message}\n`); }

    // Self-heal: in forward-proxy mode the proxy MITMs the whole upstream host,
    // so a stray socket/TLS error or a bug in one request must never take the
    // process down: an in-flight CC session is wired to THIS port and cannot
    // fail over. Log and keep serving instead of crashing. Scoped to a
    // SUCCESSFULLY ATTACHED forward proxy — a failed attach serves reverse-mode
    // only and must keep Node's default crash-on-uncaught semantics (its
    // supervisor restarts it), not have them silently swallowed. Removed again
    // when the last attached instance closes (see installSelfHeal).
    if (forwardAttached) installSelfHeal();
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Proxy-owned OAuth refresher — default OFF. Started after the server is
  // listening so a refresher startup failure can never prevent the proxy from
  // serving requests. try/catch wraps the start call per directive §6.
  if (config.oauthRefreshEnabled) {
    try {
      startOAuthRefresher();
      process.stderr.write("[cache-fix] oauth-refresh: on (CACHE_FIX_OAUTH_REFRESH=on)\n");
    } catch (err) {
      process.stderr.write(`[cache-fix] oauth-refresh start FAILED, continuing without it: ${err && err.message}\n`);
    }
  }

  const addr = server.address();
  if (forwardProxyCA) {
    process.stderr.write(
      "[cache-fix] forward-proxy: on. Wire the client (leave ANTHROPIC_BASE_URL UNSET so Remote Control stays enabled):\n" +
      `  export HTTPS_PROXY=http://${addr.address}:${addr.port}\n` +
      `  export NODE_EXTRA_CA_CERTS=${forwardProxyCA}\n`,
    );
  }
  let closed = false;
  return {
    server,
    port: addr.port,
    address: addr.address,
    close: () =>
      new Promise((resolve, reject) => {
        // Retire this instance's forward-mode vote exactly once (guarded
        // against double-close): routing/health stop passthrough behavior and
        // the process-wide self-heal is removed with the last live instance.
        if (!closed) {
          closed = true;
          if (forwardAttached) { _forwardActive--; removeSelfHeal(); }
        }
        try { stopOAuthRefresher(); } catch {}
        try {
          if (watcher) watcher.close();
        } catch {}
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// CLI entrypoint — preserves the v3.x behavior of `node proxy/server.mjs`
// (used by `cache-fix-proxy server` and by `fork(SERVER_PATH)` in the
// wrapper). When this module is imported as a library, none of this runs.
const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  let active;
  startProxy()
    .then((handle) => {
      active = handle;
      process.stdout.write(`proxy listening on ${handle.address}:${handle.port}\n`);
    })
    .catch((err) => {
      process.stderr.write(`proxy failed to start: ${err.message}\n`);
      process.exit(1);
    });

  const shutdown = () => {
    if (!active) {
      process.exit(0);
      return;
    }
    active.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
