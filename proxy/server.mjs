import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import https from "node:https";
import { pathToFileURL, URL } from "node:url";
import config from "./config.mjs";
import { forwardRequest, parseAbsoluteForm, getAgent, fallbackProxyUrls, lastHop, directLast, defaultPort } from "./upstream.mjs";
import { streamResponse, createTelemetryRecord } from "./stream.mjs";
import { loadExtensions, snapshotRegistry, runOnRequest, runOnResponseStart, runOnResponse, getFailedExtensions } from "./pipeline.mjs";
import { startWatcher } from "./watcher.mjs";
import { startOAuthRefresher, stopOAuthRefresher } from "./oauth/refresher.mjs";
import { attachForwardProxy, handleDownloadsAbsolute } from "./forward-proxy.mjs";
import { sourceFingerprint, PROXY_ROOT } from "./source-fingerprint.mjs";

import { publishableGates } from "./gate-allowlist.mjs";

// Debug logging — writes to ~/.claude/cache-fix-debug.log (override path with
// CACHE_FIX_DEBUG_LOG). Self-gated on CACHE_FIX_DEBUG=1; a no-op otherwise.
// Env is read on every call so tests (and operators flipping the flag at
// runtime) see live behavior — same pattern as image-strip's #98 gate.
import { appendFileSync, fstatSync, ftruncateSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { homedir } from "node:os";
import util from "node:util";
import { claudeHome } from "./claude-home.mjs";

// The ceiling on this layer's one shell-out, snapshotted at load so it means the
// same thing here as the launcher's identically-named const does there.
// bin/ and proxy/ share no module; a new one carrying three values would exist
// only to avoid restating them, so they are restated and cross-referenced.
const PROBE_TIMEOUT_MS = Number(process.env.CACHE_FIX_PROBE_TIMEOUT_MS) || 2_000;

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
//
// Returns `headers`: the (possibly extension-mutated) outbound header
// object. Extensions read/mutate `reqCtx.headers` — added, changed, AND
// deleted keys — expecting those mutations to reach the real outbound
// request (auto-1m-guard's strip mode, deferred-tool-rewrite's beta-token
// addition). Prior to this fix only `reqCtx.body` was serialized back into
// `forwardBody`; `reqCtx.headers` was built for extensions to read/mutate
// but the mutated object was discarded — forwardRequest still read the
// ORIGINAL `clientReq.headers`, so header mutations never reached the wire
// (see docs/audits/restart-state-audit.md-adjacent gap notes in
// deferred-tool-rewrite.mjs's file header). Returning the object here (not
// a copy) is what makes deletions visible to the caller too: `{ ...x }`
// followed by `delete copy.k` naturally drops `k` from the copy, so no
// special-casing is needed for add/change/delete — plain object semantics
// carry all three.
async function preForward(clientReq, clientRes, _abortController, extSnapshot, routeName, baseMeta = {}) {
  const rawBody = await collectBody(clientReq);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  let forwardBody = rawBody;
  let headers = clientReq.headers;
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
      // Fingerprint of what we ACTUALLY send. Captures are recorded
      // pre-pipeline — that is what makes attribution possible — so nothing
      // anywhere records our own output. tools/replay.mjs RECONSTRUCTS it by
      // re-running the pipeline and then assumes the reconstruction is
      // faithful; nothing has ever checked that assumption, and every verdict
      // the gate produces rests on it.
      //
      // Recorded here rather than in an extension because this is the single
      // point where the outbound bytes exist, after every extension has run.
      // A hash, not the body: the corpus already grows quadratically, and the
      // question is only ever "did the replay reproduce this", which equality
      // answers.
      meta._forwardedSha = createHash("sha256").update(forwardBody).digest("hex").slice(0, 16);
      meta._forwardedBytes = forwardBody.length;
    }
    headers = reqCtx.headers;
  }

  return { handled: false, parsed, forwardBody, headers, meta };
}

async function handleMessages(clientReq, clientRes) {
  const abortController = new AbortController();
  const extSnapshot = snapshotRegistry();

  // Streaming SSE: if the client gives up mid-stream, free the upstream.
  // Bootstrap (handleBootstrap) doesn't install this because its response is
  // a single non-SSE JSON payload — aborting on clientReq close prematurely
  // would race the response write on fast-failure paths (e.g. ECONNREFUSED).
  // THE RESPONSE'S close, NOT THE REQUEST'S. Node emits "close" on an
  // IncomingMessage when the request BODY has been consumed — which is every
  // request, immediately, not only the ones where the client left. So this
  // aborted while the client was still sitting there waiting, and the catch
  // below opens with `if (aborted) return`, so nothing was ever written back.
  //
  // Measured in reverse mode against an upstream that refuses instantly, which
  // is what a dead local hop does: POST /v1/messages HUNG for the client's full
  // 6s timeout instead of answering 502. Both body shapes, sent-at-once and
  // sent-delayed. That is a live session stalling on the most ordinary upstream
  // failure there is.
  //
  // clientRes's close fires when the response is finished OR the connection is
  // destroyed, so pairing it with writableEnded separates the two: ended means
  // we answered, not-ended means the client hung up and the upstream should go.
  clientRes.on("close", () => {
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
  const { parsed, forwardBody, headers, meta } = pre;

  const requestedModel = parsed?.model || null;

  let upstreamRes, responseHeaders, statusCode, upstreamConnectionId;

  try {
    // Forward the (possibly extension-mutated) headers, not clientReq
    // directly — forwardRequest only reads .url/.method/.headers off its
    // first argument, so a minimal wrapper carrying the mutated headers is
    // sufficient and avoids touching upstream.mjs's signature.
    ({ upstreamRes, responseHeaders, statusCode, upstreamConnectionId } = await forwardRequest(
      { url: clientReq.url, method: clientReq.method, headers },
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
  const { forwardBody, headers, meta } = pre;

  let upstreamRes, responseHeaders, statusCode, upstreamConnectionId;

  try {
    // See handleMessages' matching comment: forward the (possibly
    // extension-mutated) headers rather than clientReq.headers directly.
    ({ upstreamRes, responseHeaders, statusCode, upstreamConnectionId } = await forwardRequest(
      { url: clientReq.url, method: clientReq.method, headers },
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
// sha256 over the proxy source tree as loaded at startup; null when it could
// not be computed. Set once by startProxy, never after — the point is that it
// describes the code THIS process is running, not the code on disk now.
let _sourceTree = null;
// Every CACHE_FIX_* variable this process was started with, snapshotted once
// for the same reason: it describes what is SERVING, not what is declared.
let _gates = {};
// The port actually bound, set once listen() resolves. 0 until then.

// THE PORT THIS REQUEST ARRIVED ON, not a module global. startProxy() is an
// embeddable API (package.json exports "./proxy/server"), so a consumer may run
// more than one — and `_listenPort` was written by whichever start ran last.
// Measured with two starts in one process:
//     A real port=32845  /health says listen_port=41851   WRONG
//     B real port=41851  /health says listen_port=41851   ok
// The FIRST server reported the SECOND's port, and computed upstream_is_self
// against a socket that was not its own — the observability this branch added,
// answering about the wrong proxy. req.socket.localPort needs no state and
// cannot go stale.
function handleHealth(req, res) {
  const listenPort = req?.socket?.localPort ?? 0;
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
  // Surface the outbound proxy the forward-proxy blind-tunnels CONNECTs through.
  // A supervisor/health probe can then tell a proxy that came up WITH the
  // expected corp proxy from one that came up WITHOUT it — a stale instance
  // started without one still answers forward_proxy:true but silently dials
  // direct, which fails behind a corp firewall.
  //
  // THE FALLBACK COUNTS, and reading only config.httpsProxy is why this field
  // was a lie on every machine we run: the shipped wiring configures
  // CACHE_FIX_FALLBACK_PROXIES and nothing else, so the getter is empty and this
  // published null while CONNECTs left through :8118 all day, so a hop that
  // moved would not have been noticed by anything.
  //
  // This used to name cswap's pin as the consumer that "reads exactly this
  // field". MEASURED, and it does not: their chain check dials pin's own :36301
  // and reads chain/egress/direct_last, every one of them produced by pin. Only
  // direct_last exists on both endpoints, and theirs is pin's. The field is
  // still worth getting right — it is simply ours, with no external contract.
  //
  // Address only, never the credentials. A hop URL may carry them (the pin
  // publishes its own as cswap:<token>@127.0.0.1:53749) and this field is
  // readable by anything that can reach /health.
  res.end(JSON.stringify({
    status: "ok",
    version: config.version,
    forward_proxy: _forwardActive > 0,
    // THE HOP IN USE ONCE THERE IS ONE. resolveHop() falls THROUGH the chain
    // and can end at a direct dial, so naming candidate #1 published ":8118"
    // while CONNECTs left via the second fallback — or via nothing at all. Same
    // class of lie as the config.httpsProxy-only read above it, one step
    // further along.
    //
    // The three states are distinct and only two of them are a claim about a
    // dial: a URL is the hop the last one took; "" is "we checked the whole
    // chain and nothing answered", which must publish null rather than a
    // candidate; `undefined` is a proxy that has dialled nothing yet — every
    // successor is in that state for its first request — and there the
    // configured candidate is the only thing known and asserts nothing false.
    https_proxy: (_forwardActive > 0 && hopAddress(
      lastHop() ?? (config.httpsProxy || fallbackProxyUrls()[0]))) || null,
    // MEASURED OR MERELY CONFIGURED. The line above publishes a URL in two
    // different situations — the hop a resolve actually used, and the first
    // candidate on a proxy that has dialled nothing yet — and a reader cannot
    // tell them apart from the string. cswap's pin raised exactly this against
    // the fix above: one field carrying two meanings is the same defect as the
    // one being fixed, and its confirm logic would have to guess.
    //
    // So: true = that address was used, false = it is a candidate. `null` in
    // https_proxy needs no flag; it already means "checked, nothing reachable".
    https_proxy_measured: _forwardActive > 0 && !!lastHop(),
    // Sticky: when the chain last fell through to a direct dial (never = null).
    // See directLast() — a point-in-time field cannot report a flap.
    direct_last: directLast(),
    // Content fingerprint of the source this process LOADED. Hot-reload is
    // off, so after an edit without a restart this stays at the old value
    // while the working tree moves on — which is precisely the drift an
    // external checker needs to see, and cannot infer from mtimes without
    // false-firing on every touch that changes no bytes.
    proxy_tree: _sourceTree,
    // The layer ABOVE, published by the holder that spawned us. Empty when
    // nothing is holding this port, which is itself the answer to "is anyone
    // supervising" for an external checker.
    holder_tree: process.env.CACHE_FIX_HOLDER_TREE || "",
    // The gate set this process is ACTUALLY running, snapshotted at startup.
    //
    // Same argument as proxy_tree, one layer over: checking the unit file
    // answers "what is declared", not "what is serving". Edit the unit and
    // skip the restart and the two diverge silently — every extension reads
    // its gate from process.env, which is fixed for the life of the process.
    //
    // It also gives the offline gate (tools/gate-live.mjs) something better
    // than the unit to replay against: on 2026-07-28 the gate ran with
    // extension DEFAULTS while production ran 11 gates, so CACHE_FIX_TOOL_REWRITE
    // was off in every verification run and on in every served request. The
    // sweep reported 0 violations; the same corpus under the real gate set
    // reported 2.
    gates: _gates,
    // The port we are ACTUALLY listening on. Both outages were invisible
    // because every field above reports what is CONFIGURED: one proxy bound
    // 9801 while the fleet dialled 9901, and `status: ok` was true of it the
    // whole time. A checker cannot compare an address to the one sessions were
    // given unless we say which one we took.
    listen_port: listenPort,
    // Whether our own upstream points back at us — the other outage, where the
    // chain looped and never reached the internet with every field still green.
    // Refused at startup now, so this should always be false; it is here so a
    // checker can prove that rather than assume it.
    upstream_is_self: Boolean(
      upstreamPointsAtSelf(config.httpsProxy, listenPort, config.bind)
      || upstreamPointsAtSelf(config.httpProxy, listenPort, config.bind)),
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
  // clientRes, not clientReq — see handleMessages' matching comment. The request
  // object's "close" fires when its body is consumed, so this aborted every
  // request the instant it arrived and the catch below then returned without
  // writing anything.
  clientRes.on("close", () => { if (!clientRes.writableEnded) abortController.abort(); });

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
// Responses still open, so a forced shutdown can FIN them instead of RST.
// PER SERVER, not per module. Both of these were module state, and
// handleHealth was moved off a `_listenPort` global earlier in this same PR
// for the reason written above it: a consumer may run more than one. Two
// instances sharing one Set means a forced close in A ends B's in-flight
// responses and reports B's cuts as A's; sharing one flag means draining A
// stamps Connection: close on B's replies, telling B's clients to reconnect
// away from a proxy that is not leaving.
//
// Hung off the server object rather than threaded through, because shutdown
// already holds `active.server` and the handler already closes over the one it
// belongs to — no new plumbing, and no way to reach the wrong instance's set.

/**
 * What the 5s force-close actually cut, and what it could not see.
 *
 * `liveResponses` is filled by the request handler ONLY (see below), so it is
 * blind to the two things forward mode — our production mode — actually holds
 * open: blind-tunnelled CONNECTs and upgrades, both attached to this same
 * server by attachForwardProxy(). Measured 2026-08-18 with one live CONNECT,
 * on every supported major:
 *     18.20.8 / 20.20.2 / 24.11.1   close resolved: FALSE
 *                                   liveResponses: 0   server connections: 1
 * So a zero count does NOT mean nothing was in flight, and a line that says
 * "idle" on the strength of it is lying in the mode we ship. `held` is the
 * server's own connection count and is what keeps the zero case honest: we
 * report that we cut no responses AND that N connections were still held,
 * without pretending to know which kind they were.
 *
 * The same shape covers the Node 18 keep-alive case — there close() also stays
 * unresolved with liveResponses 0 and one connection held — which is why this
 * needs no separate wording.
 *
 * Split by headersSent because the close path below splits on it: a response
 * that has written headers is FIN'd, one that has not is destroyed. NOTE that
 * headersSent goes true at writeHead(), which handleMessages calls as soon as
 * upstream headers arrive — so `mid-response` is an UPPER BOUND on user-visible
 * truncations, not a count of them. Measured: after writeHead and before the
 * first chunk, headersSent=true with socket.bytesWritten=0.
 */
// NEW FIELDS GO AT THE END. This line is a published interface -- it is read by
// tooling outside this repo -- so the order of what is already in it is part of
// the contract, not a formatting choice.
//
// Measured: putting a field between the budget and `(<n> mid-response,` broke a
// case in test/shutdown-exit-code.test.mjs that pins that adjacency as a literal
// regex. That case looks over-specified and a reviewer would trim it; its
// brittleness IS the contract check, which is why it stays.
//
// Appending is not automatically safe either -- it is safe here only because no
// known reader anchors on the end of the line. A future field should ask the
// same question rather than assume the tail is free.
// COARSE, AND NO QUERY STRING. Two path segments, nothing after `?`: the proxy
// sees whole request URLs and this rides a log line, so the grouping is what
// keeps an identifier in a path out of a file that outlives the process. It also
// bounds the cardinality -- a per-URL tally on a passthrough route would print
// one entry per request.
//
// AND THE AUTHORITY, WHICH THE QUERY RULE DOES NOT COVER. A foreign absolute-form
// target reaches handlePassthrough un-normalised, so the raw request-target
// renders as `/http:/user:pass@host` -- a credential, in the log, from the rule
// written to keep credentials out of it.
// `Number(x) || fallback` is wrong in both directions for a millisecond budget:
// it discards an explicit 0, which asks to cut now, and it passes a NEGATIVE
// through. A negative stall budget makes `now - rec.at < stallMs` false on the
// first tick, ending every owed connection at once -- the guillotine this drain
// replaced, one typo away.
export function drainBudgetMs(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  // A PLAIN NON-NEGATIVE DECIMAL, matched before `Number()` sees it. `Number()`
  // reads whitespace as 0 -- `" "`, `"\t"`, `"\n"` all coerce -- so a value
  // that is only whitespace in an env file or a unit becomes an explicit
  // budget of zero, which is the guillotine this drain exists to remove. It
  // also lets `-0` through, and `now - at < -0` is false on every tick just as
  // `< -1` is. Exotic spellings (`1e3`, `0x10`, `Infinity`) fall back rather
  // than being guessed at; none is a documented form.
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export function drainRoute(url) {
  if (typeof url !== "string") return "?";
  const abs = parseAbsoluteForm(url);
  // parseAbsoluteForm knows http and https. Every other authority-first shape
  // -- a protocol-relative `//host/path`, a scheme it does not carry, the
  // authority-form a CONNECT sends -- would otherwise fall to the raw target
  // and render the authority verbatim. Origin-form is a SINGLE leading slash,
  // which is what separates `/v1/messages` from `//host/v1/messages`.
  if (!abs && !(url.startsWith("/") && !url.startsWith("//"))) return "?";
  const path = abs?.pathname ?? url;
  const route = "/" + path.split("?")[0].split("/").filter(Boolean).slice(0, 2).join("/");
  // THE SHAPE TEST ABOVE CANNOT ENFORCE THIS. `/http://user:pass@host/v1`,
  // `/\user:pass@host/x` and a percent-encoded `//` are all a single leading
  // slash, and `#` survives the `?` split. Judge what is about to be WRITTEN:
  // neither character belongs in a route label, and either one means an
  // authority or a fragment came through.
  return /[@#]/.test(route) ? "?" : route;
}

export function forcedCloseLine(ended, destroyed, held, budgetMs = 5_000, why = "", routes = "", quiet = "", owedAtStart = null) {
  const cut = ended + destroyed;
  // THE BUDGET IT ACTUALLY USED, not the constant this line was written against.
  // The two diverged the moment the handover path got its own, and a log that
  // says "after 5s" about a 1800s wait is the kind of wrong that survives for
  // months because it reads like it was checked.
  //
  // `why` exists because the number alone stopped being the discriminator. Three
  // things can end a drain now and two of them are opposite outcomes, so the
  // line names which rather than leaving it to be inferred from a shape. It goes
  // at the TAIL, like every other field added here: appended to the budget it sat
  // between `after <n>s` and `(<n> mid-response`, which is the one adjacency the
  // block above records as a contract -- and it took that position only on the
  // backstop arm, which no pinned case rendered.
  const after = budgetMs % 1000 === 0 ? `${budgetMs / 1000}s` : `${budgetMs}ms`;
  if (cut > 0) {
    // The route tally rides the CUT line only. On the no-cut line there is
    // nothing to attribute, and an empty `routes: ` there would read as "no
    // routes" rather than "nothing was cut".
    return `[cache-fix] shutdown: forcing close, cut ${cut} in-flight request(s) after ${after} `
         + `(${ended} mid-response, ${destroyed} before headers)`
         + (quiet ? ` quiet ${quiet}` : "")
         + (routes ? ` routes: ${routes}` : "")
         + (owedAtStart === null ? "" : `, owed ${owedAtStart} at the start`)
         + why + `\n`;
  }
  // Not "idle": we did not measure idleness, we measured that no RESPONSE was
  // open. Naming the held count is what stops a reader concluding the stop was
  // clean when it severed a tunnel.
  //
  // THE PARENTHETICAL QUALIFIES `held`, SO IT MUST DESCRIBE `held`. It read
  // "CONNECT tunnels and upgrades are not counted", which is true of
  // liveResponses and FALSE of this number: attachForwardProxy binds connect and
  // upgrade to this same server, so getConnections counts them. An operator
  // reading "3 connections held, tunnels not counted" would infer three
  // non-tunnel things PLUS an unknown number of tunnels — the opposite of what
  // the number says, and the number is the only thing this redesign added.
  return `[cache-fix] shutdown: forcing close after ${after}, cut no responses`
       + `${held === null ? "" : `, ${held} connection(s) still held`}`
       + ` (kind unknown; may include CONNECT tunnels and upgrades)` + why + `\n`;
}

// SHUTTING DOWN, read by the request handler. server.close() stops ACCEPTS; it
// does not stop a client that already holds a connection from sending more
// requests down it, and we answer them. Measured against this proxy, SIGTERM
// sent while a POST /v1/messages was in flight:
//     the in-flight reply completes   200 ... Connection: keep-alive
//     a SECOND request after it       200 ... Connection: keep-alive
// so the client is told to keep a connection to a process that has stopped being
// the front door. It never reconnects, so it never reaches the successor already
// serving on the inherited fd. A peer daemon in this stack shipped a fix for
// the same phenomenon on its own layer; a count it first offered as
// corroboration was withdrawn as unverifiable, so nothing here rests on it —
// the reproduction above is this proxy's own.
//
// An IDLE keep-alive is not affected — node closes those itself at close(),
// measured on 18.20.8 / 20.20.2 / 24.11.1 / 25.8.0 / 26.5.1. The exposure is
// exactly the connection that was BUSY when the drain began, which on every
// one of those majors goes on to serve another request. That is node's
// behaviour, not ours, so a test asserts it rather than a comment claiming it
// — see "relies on node closing idle keep-alives at close()".
export function createProxyServer() {
  const live = new Set();
  const srv = http.createServer((req, res) => {
    live.add(res);
    // The drain's stall test dates a connection from here ONLY while nothing
    // has left it since it arrived — one that has written must be dated from
    // its last byte, or its own age reads as the time it was silent.
    // `_bornBytes` and not `n === 0`: `bytesWritten` belongs to the SOCKET, so
    // the second request on a keep-alive connection starts nonzero.
    res._bornAt = Date.now();
    res._bornBytes = res.socket?.bytesWritten ?? 0;
    res.on("close", () => live.delete(res));
    // BEFORE the handler, so a writeHead() that names its own headers keeps this
    // one — setHeader values survive writeHead unless writeHead repeats the name.
    // The in-flight reply still finishes normally; this only stops the NEXT
    // request from entering a process on its way out, and the client's fresh
    // connection lands on the successor through the shared listener.
    if (srv._draining) res.setHeader("Connection", "close");
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
  // The two pieces of per-instance state the drain path needs. `_live` is read
  // off a SNAPSHOT at force-close time (see there), `_draining` is set by
  // shutdown() the moment it begins.
  srv._live = live;
  // A reply whose end() has been CALLED is IDLE to Node, so server.close()
  // severs one that is complete but still flushing. Both close paths ask this
  // before unbinding; it lives here so there is one spelling of the question.
  srv._unflushed = () =>
    [...live].filter((r) => r.writableEnded && !r.writableFinished).length;
  // UNBIND WITHOUT THE IDLE SWEEP. `http.Server.close()` runs the sweep first and
  // the sweep is what severs an unflushed reply; net's close only stops
  // accepting. Both close paths go through here, so the unbind never waits.
  srv._unbind = (cb) => net.Server.prototype.close.call(srv, cb);
  srv._draining = false;
  return srv;
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
  // AN EPIPE ON STDIO MUST NOT REACH uncaughtException, because the handlers
  // below answer uncaughtException BY WRITING TO STDERR — so a dead stderr
  // makes them re-enter themselves for ever.
  //
  // say() below is necessary and NOT sufficient: its try/catch covers a
  // synchronous throw on a destroyed stream, but a write to a pipe whose last
  // reader is gone does not throw synchronously — it surfaces as an
  // asynchronous 'error' event, and with no listener Node promotes that to
  // uncaughtException. Both halves are needed, hence the listeners here.
  //
  // Measured on a live proxy whose `| tee` was killed out from under it: 100%
  // CPU, 22 minutes of CPU time burned, 18 connections accepted and none
  // answered — while /health still returned 200 with every self-reported field
  // green. `sample` showed the cycle: TriggerUncaughtException ->
  // ReportMessage -> ErrorStackGetter -> FormatStackTrace ->
  // PrepareStackTraceCallback -> the next stderr write -> EPIPE.
  //
  // Losing a log reader is ordinary — a closed terminal, a rotated file, a
  // killed `tee`. It must cost the log line and nothing else.
  // ONCE, AND NEVER FROM INSIDE ITSELF. say() catches a SYNCHRONOUS throw, and
  // the premise of this whole block is that stream faults arrive as ASYNC
  // 'error' events — so reporting a stderr fault by writing to stderr feeds the
  // handler its own next event. Reproduced: one isolated ENOSPC re-enters once
  // and stops, but a stderr whose every write raises ENOSPC (a full disk, the
  // case worth surviving) ran past 50 re-entries in under 500 ms. That is the
  // same self-feeding shape as the measured 22-minute 100% CPU
  // TriggerUncaughtException loop this block was added to break, reached
  // THROUGH the guard rather than around it.
  //
  // A latch, not a rate limit: the message is worth saying once, and after
  // that the only useful behaviour is to keep serving in silence. EPIPE and
  // ERR_STREAM_DESTROYED still return before it, so a departed reader does not
  // even spend the latch.
  let saidStreamError = false;
  const onStreamError = (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
    if (saidStreamError) return;
    saidStreamError = true;
    say(process.stderr, `[cache-fix] stdio error (proxy stays up, reported once): ${(err && err.code) || err}\n`);
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
  // Through say(), for the same reason it exists: a handler whose own log line
  // can throw is a handler that turns one fault into a loop.
  const onException = (err) => {
    say(process.stderr, `[cache-fix] self-heal: uncaughtException swallowed (proxy stays up): ${err && err.stack || err}\n`);
  };
  const onRejection = (reason) => {
    say(process.stderr, `[cache-fix] self-heal: unhandledRejection swallowed (proxy stays up): ${reason && reason.stack || reason}\n`);
  };
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  _selfHealHandlers = { onException, onRejection, onStreamError };
}
function removeSelfHeal() {
  if (!_selfHealHandlers || --_selfHealRefs > 0) return;
  process.off("uncaughtException", _selfHealHandlers.onException);
  process.off("unhandledRejection", _selfHealHandlers.onRejection);
  // The stdio listeners go too, for the same reason the two above do: a host
  // process that ran forward mode earlier must get Node's default behaviour
  // back, not keep an EPIPE swallower installed by a proxy that has closed.
  process.stdout.off("error", _selfHealHandlers.onStreamError);
  process.stderr.off("error", _selfHealHandlers.onStreamError);
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
// A socket a supervisor bound and still holds, via the systemd socket-activation
// convention (LISTEN_FDS, first fd is 3). We never bind and never close it, so
// the port stays bound across a restart.
//
// The env reaches every descendant, so it is read and CLEARED here, at module
// load, before anything can spawn. The clearing is what stops a grandchild
// serving on whatever its own fd 3 happens to be — not the pid check below.
//
// At load rather than inside startProxy(): a guard that works because "nobody
// has spawned yet" is state, and state has an ordering. Clearing it before any
// of our code runs leaves no window with code in it to spawn from. cswap's pin
// named this, from the other side of the same problem — their guard is a FACT
// checked at use time (does this variable name my actual parent), which needs
// no ordering at all.
const HANDED_DOWN = {
  fds: Number(process.env.LISTEN_FDS),
  // Set by systemd, never by us: our holder cannot know the child's pid before
  // the child exists. So on our own launch path this is undefined and the check
  // below never fires — it is here for the convention, not for our protection.
  pid: process.env.LISTEN_PID,
};
delete process.env.LISTEN_FDS;
delete process.env.LISTEN_PID;

// RELEASING IS A LINEAGE-WIDE FACT, and this guard is DEFENCE IN DEPTH rather
// than the fix for a live defect — the first version of this comment said
// otherwise and was wrong.
//
// What was measured: nine stray holders on the work Mac were told to release and
// nine were back on the same ports in 23 seconds. I attributed that to this
// timer not seeing `releasing`. Re-measured afterwards and the attribution does
// not hold: on current code the child ALWAYS dies before its holder (0 samples
// of the reverse across 200 at 50ms), because forward() signals the child and
// the holder only settles on its exit. The nine were 4-27h old and predate
// today's SIGHUP handler, so SIGHUP took node's DEFAULT and killed them without
// telling their children — the orphans then self-healed, correctly.
//
// Kept anyway, and the reason is cswap's pin's: ordering is only as good as its
// invariant, and ANY future teardown path that drops a holder without first
// stopping its child re-opens the race silently. A flag survives new call sites;
// an ordering does not.
let releasingPort = false;
// A SUCCESSOR ALREADY HOLDS THE SOCKET — set only by SIGUSR2, which no other
// caller sends. `releasingPort` cannot answer this: the holder rewrites every
// stop to SIGHUP (see its `forward()`), so SIGHUP means both "a redeploy handed
// the port on" and "the supervisor is stopping us", and those want opposite
// budgets.
let handoverRelease = false;

function inheritedFd() {
  if (!(HANDED_DOWN.fds >= 1)) return null;
  if (HANDED_DOWN.pid && Number(HANDED_DOWN.pid) !== process.pid) return null;
  return 3;
}

// The upstream address, when it names this very proxy; "" otherwise.
//
// Compared by PORT, and by host only loosely: the loop is created by the port,
// and `localhost`, `127.0.0.1` and `0.0.0.0` all reach us on it. A hostname we
// cannot resolve here is left alone — refusing on a guess would block a
// legitimate upstream that merely looks local.
export function upstreamPointsAtSelf(upstream, port, bind) {
  if (!upstream) return "";
  let u;
  try { u = new URL(upstream); } catch { return ""; }
  const theirPort = defaultPort(u);
  if (theirPort !== Number(port)) return "";
  const local = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", ""]);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!local.has(host)) return "";
  // Bound to one interface, and they name a different local alias for it: still
  // us. Bound to 0.0.0.0 we answer on every alias, so any local host matches.
  if (bind && !local.has(bind) && host !== bind) return "";
  // Credentials in the address are wiring, not evidence — strip them so the
  // error we print cannot leak a token into a log.
  u.username = ""; u.password = "";
  return u.toString();
}

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

  // Fingerprint the source we are ABOUT TO RUN, before serving anything, so
  // /health can answer "which bytes is this process actually running" instead
  // of leaving an external checker to guess from mtimes. Computed here rather
  // than at module load: this is the moment the answer becomes true, and a
  // failure to read our own source must not take the proxy down — an unknown
  // fingerprint reports as null, which a checker can distinguish from a
  // mismatch.
  // Allowlisted gate VALUES, every other CACHE_FIX_* key by name only. /health
  // is served to anything that can reach the port, and the environment holds an
  // OAuth client id, a token endpoint and a dozen machine paths alongside the
  // switches. See proxy/gate-allowlist.mjs for why the default is name-only.
  _gates = publishableGates(process.env);
  try {
    _sourceTree = await sourceFingerprint(PROXY_ROOT);
    // Publish via the environment, NOT via a module export. loadExtensions
    // cache-busts its imports (pipeline.mjs `_loadCounter`), so the module
    // instance the pipeline runs is not the one a dynamic import here would
    // return — module-scope state does not cross that boundary, and a setter
    // called on the wrong instance leaves the field silently null. Extensions
    // already read their gates from process.env for the same reason.
    if (_sourceTree) process.env.CACHE_FIX_PROXY_TREE = _sourceTree;
  } catch (err) {
    process.stderr.write(`[cache-fix] source fingerprint unavailable: ${err?.message ?? err}\n`);
    _sourceTree = null;
  }

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

  // REFUSE TO BE OUR OWN UPSTREAM.
  //
  // The upstream is read from HTTPS_PROXY, so it is decided by whatever shell
  // launched us. Start `run-service` from a shell that already exports the
  // chain and we adopt a hop that points back here: 9901 -> 36301 -> 9901,
  // which never reaches privoxy and hangs every CONNECT.
  //
  // Measured twice on <linux-host> in one day. Both times every health field was
  // green — `status: ok`, `forward_proxy: true`, port bound — because they
  // report what is CONFIGURED, not what works. The only field that showed it
  // was the VALUE of https_proxy.
  //
  // Refuse rather than silently drop the variable: a proxy that quietly picks a
  // different upstream than it was told is the same class of bug one layer
  // down. The operator's own recovery command is the fix (`env -u HTTPS_PROXY
  // … cache-fix-proxy run-service`), so the message names it.
  // BOTH variables, because both can become the upstream: selectProxyUrl falls
  // through to httpProxy when httpsProxy is empty, so HTTP_PROXY alone is
  // enough to build the loop. The polluted process measured on <linux-host> had
  // exactly that split — HTTPS_PROXY/ALL_PROXY on the pin, HTTP_PROXY on 9901
  // itself — so a guard reading only https would have passed it.
  // EVERY PORT WE WILL ANSWER ON, not just the one we were asked to bind. A
  // holder hands its child the socket on fd 3 and spawns it with
  // CACHE_FIX_PROXY_PORT=0, so `port` here is 0 and every real upstream compares
  // unequal — the guard could never fire on the deployment shape it was written
  // for, which is the measured 9901 -> 36301 -> 9901 loop it cites. The
  // advertised port is the address the fleet actually dials.
  const answersOn = [...new Set([port, Number(process.env.CACHE_FIX_HELD_PORT) || 0])]
    .filter((n) => Number.isInteger(n) && n > 0);
  const selfUpstream = answersOn
    .map((p) => upstreamPointsAtSelf(config.httpsProxy, p, bind)
             || upstreamPointsAtSelf(config.httpProxy, p, bind))
    .find(Boolean) || "";
  if (selfUpstream) {
    throw new Error(
      `refusing to start: upstream proxy ${selfUpstream} is this proxy's own ` +
      `address (${bind}:${port}) — requests would loop instead of reaching the ` +
      `internet. Clear the inherited wiring, e.g. ` +
      `env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy ` +
      `HTTPS_PROXY=<the hop BELOW this one> cache-fix-proxy run-service`,
    );
  }

  // `let`, because the fallback below clears it: after a refused handover this
  // must read "we are not on an inherited socket", not "we tried to be".
  let listenFd = options.fd ?? inheritedFd();

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

  // Serving an inherited socket leaves the port bound across the handover, so
  // no request lands on an unbound port. Binding ourselves is the direct-run
  // path. SO_REUSEPORT is not used: measured, macOS throws ENOTSUP on the first
  // listen and node 18/20 ignore the flag, so it co-binds on Linux only.
  const listenOnce = (opts) => new Promise((resolve, reject) => {
    const onError = (err) => { server.off("error", onError); reject(err); };
    server.once("error", onError);
    server.listen(opts, () => { server.off("error", onError); resolve(); });
  });
  if (listenFd === null) {
    await listenOnce({ port, host: bind });
  } else {
    // fd 3 may not be servable — in an IPC-forked child it is the IPC channel
    // and listen fails EEXIST. Binding our own port is degraded; no proxy at
    // all is not.
    try {
      await listenOnce({ fd: listenFd });
    } catch (err) {
      process.stderr.write(
        `[cache-fix] socket handover refused (${err?.code || err?.message}); binding ${bind}:${port} instead\n`);
      // CLEARED, because everything downstream reads it as "we are ON that
      // socket" and from here we are not. `inheritedSocket` decides
      // askForSuccessor, which hands fd 3 to a child and exits 75 — telling the
      // supervisor a successor holds the socket while the port we actually
      // served is released with nobody on it. Measured on the unfixed code:
      // exit 75 plus an orphaned successor on the same unservable fd.
      listenFd = null;
      await listenOnce({ port, host: bind });
    }
  }

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
  // What we BOUND, not what was asked for: with port 0 (the holder hands us an
  // ephemeral one) the configured value says nothing, and an inherited fd means
  // the number came from a supervisor we cannot see.
  if (forwardProxyCA) {
    // Recipe only when the OPERATOR is wiring. Under --remote-control the
    // launcher already wired claude via ca-trust.d and relays this stderr, so
    // printing `export NODE_EXTRA_CA_CERTS=<our ca.pem>` would tell them to undo
    // it — that variable takes one file, so pinning our CA untrusts every other
    // MITM on the host.
    //
    // An explicit signal, NOT `process.channel`: a channel only proves some
    // parent opened an IPC descriptor, and measured, a plain `fork()` (which the
    // suite does) got the suppressed banner and no wiring instructions at all.
    // Internal handshake, not an operator knob — it asserts "my parent wired
    // me", which nothing but the launcher can truthfully say.
    const wiredByLauncher = process.env.CACHE_FIX_WIRED_BY_LAUNCHER === "1";
    process.stderr.write(wiredByLauncher
      ? "[cache-fix] forward-proxy: on. Client wired by the launcher (ca-trust.d).\n"
      : "[cache-fix] forward-proxy: on. Wire the client (leave ANTHROPIC_BASE_URL UNSET so Remote Control stays enabled):\n" +
        `  export HTTPS_PROXY=http://${addr.address}:${addr.port}\n` +
        `  export NODE_EXTRA_CA_CERTS=${forwardProxyCA}\n` +
        "  (if anything else on this host also MITMs api.anthropic.com, use\n" +
        "   `claude-via-proxy --remote-control` instead — that variable takes\n" +
        "   one file, so setting it here would untrust the other CA)\n");
  }
  let closed = false;
  return {
    server,
    port: addr.port,
    address: addr.address,
    // Whether we are serving a socket a supervisor handed down. Only then can
    // shutdown hand the SAME socket to a successor: a proxy that bound its own
    // port has nothing to pass on.
    // `listenFd === 3` alone: the fallback above nulls it on a refused handover,
    // so this is the whole question. It read `listenFd !== null && listenFd === 3`
    // — two conjuncts for one fact, the first unable to be false when the second
    // is true. That shape is what made the original bug readable as correct.
    inheritedSocket: listenFd === 3,
    close: () =>
      new Promise((resolve, reject) => {
        try { stopOAuthRefresher(); } catch {}
        try {
          if (watcher) watcher.close();
        } catch {}
        // ERR_SERVER_NOT_RUNNING is not a failure HERE. shutdown() unbinds
        // first — announcing while we still hold the socket makes the
        // supervisor race a bind it must lose — and then drains through this,
        // so the second close always reports "not running" and this promise
        // ALWAYS rejected on the one path that calls it. Nothing handles that
        // rejection; only the process.exit() inside .finally() beat the
        // unhandled-rejection report to it. Both callbacks fire on the same
        // 'close' event, after the drain, so resolving is the true answer.
        // Measured through this proxy: 4,217,623 bytes delivered of a declared
        // 16,777,216, with `drained clean` printed for it. The agent is the IDLE
        // SWEEP, which `http.Server.close()` runs BEFORE it unbinds: Node counts a
        // reply whose end() has been CALLED as idle. Discriminated on plain Node,
        // four arms -- no close 100%, http close() 24.9%, http close() plus an
        // explicit sweep 24.9%, net close() 100%, all four refusing new
        // connections after. The three-arm version of this could not separate the
        // two because every arm that closed also swept.
        //
        // So the unbind is free and only the sweep waits. Deferring the unbind
        // instead holds the LISTENING socket for the whole drain -- and the
        // release is announced before the drain, with a holder settling on it.
        server._unbind((err) => {
          // WHEN THE DRAIN HAS ENDED, NOT WHEN IT STARTED. This used to run
          // synchronously in the executor above, so the moment a stop was
          // signalled `_forwardActive` fell to zero and the two readers of it —
          // the absolute-form rewrite and the passthrough — sent every path
          // that is not /health, POST /v1/messages or the bootstrap to
          // handleNotFound. A connection still in flight then got a
          // well-formed 404 the client cannot tell from a real one and will not
          // retry, which is the failure the passthrough exists to prevent.
          //
          // The window was 5s while a stop under a live holder shared the
          // standalone ceiling. It is the drain budget now, so the same line
          // that widens the drain widens this: measured 200 before the stop and
          // 404 on the same socket 1.4s into it.
          //
          // Retired on BOTH outcomes and exactly once: the server is going away
          // either way, and the guard keeps a double close from double
          // decrementing.
          if (!closed) {
            closed = true;
            if (forwardAttached) { _forwardActive--; removeSelfHeal(); }
          }
          return err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve();
        });
        // NODE 18 DOES NOT DO THIS FOR US, and ba2375b silently assumed it did.
        // From 19 on, close() closes idle keep-alives itself; 18.20.8 does not --
        // measured, close never fires where 20.20.2 and 24.11.1 report 1-2 ms.
        // Optional-call because engines is ">=18" and closeIdleConnections
        // landed in 18.2.
        //
        // THE SWEEP IS THE ONLY HALF THAT WAITS, because it is the only half that
        // severs.
        if (server._unflushed() === 0) return server.closeIdleConnections?.();
        const flushTick = setInterval(() => {
          if (server._unflushed() > 0) return;
          clearInterval(flushTick);
          server.closeIdleConnections?.();
        }, 50);
        flushTick.unref?.();
      }),
  };
}

// CLI entrypoint — preserves the v3.x behavior of `node proxy/server.mjs`
// (used by `cache-fix-proxy server` and by `fork(SERVER_PATH)` in the
// wrapper). When this module is imported as a library, none of this runs.
// Claude Code's update poll writes .last-update-result.json when it fails and
// NEVER rewrites it on a later success, so one transient miss pins
// "Auto-update failed" on the status line for good. A restart of this proxy is
// one such miss: the poll lands while the port is down and records it.
//
// We made it, so we clear it — but only when it is provably a fossil: the
// record says failed AND the version on disk already equals the channel's
// latest, i.e. there was nothing to install. A genuinely pending update, or a
// channel we cannot reach, is left alone and still surfaces.
//
// Deferred, because the poll happens seconds AFTER we come up: sweeping at
// startup would run before the failure it is meant to clear.
function sweepUpdateFossil() {
  if (process.env.CACHE_FIX_UPDATE_SWEEP === "off") return;
  setTimeout(async () => {
    const record = join(claudeHome(), ".last-update-result.json");
    let body;
    try { body = readFileSync(record, "utf8"); } catch { return; }
    try { if (JSON.parse(body).outcome !== "failed") return; } catch { return; }

    // The version on disk, from the launcher symlink Claude Code maintains.
    let disk;
    try { disk = basename(readlinkSync(join(homedir(), ".local", "bin", "claude"))); } catch { return; }
    if (!disk) return;

    // Through getAgent, the same egress the proxy forwards on: a bare fetch
    // ignores HTTPS_PROXY and simply fails on a network that requires one,
    // which would read as "channel unreachable" and sweep nothing. Never
    // through OURSELVES — our MITM leaf is signed by a CA only the client
    // trusts. The URL is overridable so a test can stand one up locally.
    // GUARDED, like every other failure in this callback. It runs from an async
    // setTimeout, so a malformed CACHE_FIX_UPDATE_CHANNEL_URL throws into an
    // unhandledRejection: in forward mode installSelfHeal swallows it, but in
    // reverse mode nothing does and Node >=15 kills the process 25s after start.
    let url;
    try {
      url = new URL(process.env.CACHE_FIX_UPDATE_CHANNEL_URL ||
        "https://downloads.claude.ai/claude-code-releases/latest");
    } catch { return; }
    const isHTTPS = url.protocol === "https:";
    const latest = await new Promise((res) => {
      const req = (isHTTPS ? https : http).get({
        host: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        agent: getAgent(isHTTPS, url.hostname),
        timeout: 8_000,
      }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return res(""); }
        let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b.trim()));
      });
      req.on("error", () => res(""));
      req.on("timeout", () => { req.destroy(); res(""); });
    });
    if (!latest || latest !== disk) return;   // unreachable or genuinely behind

    try {
      rmSync(record);
      process.stderr.write(`[cache-fix] cleared a stale auto-update failure record (on ${disk})\n`);
    } catch {}
  }, Number(process.env.CACHE_FIX_UPDATE_SWEEP_DELAY_MS) || 25_000).unref();
}

const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

// THE STDIO GUARD BELONGS TO THE PROCESS, NOT TO FORWARD MODE.
//
// installSelfHeal() carries an identical pair of listeners, and 94e1953 is
// usually described as having fixed this file. It fixed it in ONE OF TWO MODES:
// installSelfHeal runs only `if (forwardAttached)`, and forward mode is opt-in.
// Measured on the default (reverse) path — start startProxy() with
// CACHE_FIX_FORWARD_PROXY unset and read process.stderr.listenerCount("error"):
// forward gives 1/1, reverse gives 0/0.
//
// Reverse mode is not a quiet mode. The proxy child is spawned by the holder
// with stdio ["inherit","pipe","inherit", fd], so its stderr IS the shared pipe
// this whole change is about, and it writes to that pipe on ordinary paths —
// startup banners, `[upstream] using proxy …`, the oauth refresher. The
// measured 27-minute outage needs exactly one such write after the last reader
// dies.
//
// Installed here rather than inside installSelfHeal because it answers a
// different question: not "is forward mode attached" but "am I a process".
// Gated on invokedAsScript so importing this module as a library — which the
// suite does constantly — never alters the host process's stream semantics,
// which is the same reason removeSelfHeal() exists.
if (invokedAsScript) {
  for (const s of [process.stdout, process.stderr]) {
    s.on("error", () => { /* the reader left; serving requests is the job */ });
  }
  // ONCE, AT STARTUP, and only when the descriptor is a real file — see
  // capOwnLog. A deploy restarts this process, so "at startup" is the natural
  // cadence: the check costs one fstat and the file cannot outgrow the cap by
  // more than one proxy lifetime. Doing it on a timer would mean truncating a
  // file underneath a reader who is tailing it.
  capOwnLog();
}

// A proxy started by the port holder must not outlive it. SIGKILL cannot be
// forwarded, so the holder's own signal handlers do not cover the case that
// actually happens in the field — an OOM kill, a container stop, an operator's
// kill -9. The child then keeps an ephemeral port that nothing will ever
// reclaim: measured, 37 such orphans had accumulated on one box.
//
// Polled rather than PR_SET_PDEATHSIG: that prctl is Linux-only and needs a
// native binding, while getppid() is portable and this check costs one syscall
// a second. Gated on being spawned by the holder (CACHE_FIX_PROXY_PORT=0 is how
// it tells the child to take an ephemeral port), so a proxy an operator runs
// directly from a shell is never killed by its parent exiting.
// Is a DIFFERENT process serving the advertised port? Used only while handing
// over to a replacement holder: we still hold the socket, so "is the port up"
// would answer yes about ourselves. Ownership by pid is the question.
// scheme://host:port of a hop URL, with any credentials dropped. Empty for
// anything unparseable, so a malformed value publishes nothing rather than
// itself — and empty for anything that is not http(s), because `URL` reads
// `user:pass@host:port` as the scheme `user:` and would otherwise publish the
// username back out as `user://`.
function hopAddress(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? `${x.protocol}//${x.host}` : "";
  } catch { return ""; }
}

// BOUND OUR OWN LOG, because a default install has nothing else bounding it.
//
// The launchd plist this repo ships sends both streams to files
// ({LOG_DIR}/cache-fix-proxy.log and .err) and nothing here ever truncates
// them. Measured on this fleet: 8.3 MB over 37 days on one Mac (~224 KB/day),
// 968 KB over 47 days on another. The rate tracks traffic, so the bound is the
// disk. The systemd unit sets no Standard* at all and goes to journald, which
// the system already caps — this is the macOS path only, and it is the DEFAULT
// one, not a debug opt-in.
//
// THROUGH fd 2 ALONE, because launchd hands us a descriptor and not a path, and
// there is no portable way back (Linux has /proc/self/fd, macOS needs fcntl
// F_GETPATH, which node does not expose). Measured what that leaves:
//     fstatSync(2)      works — isFile and size
//     readSync(2, ...)  EBADF: the fd is write-only (O_WRONLY|O_APPEND)
//     ftruncateSync(2)  works, and later writes land at 0
// So a tail cannot be preserved and the cap is a truncate. It keeps the NEWEST
// lines, which is the half worth keeping — after this fires the file holds
// everything since, bounded, rather than everything ever, unbounded.
//
// NON-FILES NEED NO GUARD OF THEIR OWN, and I wrote one before checking.
// Two of the three machines here have fd 2 on /dev/null, one has a socket, and
// a pipe is what the test runner gives — so an isFile() check looked obviously
// required. Measured: ftruncate throws EINVAL on /dev/null and /dev/zero, and
// their fstat size is 0 anyway, so BOTH the size arm and the catch already
// return false. No input exists that the isFile() check could decide, which is
// why no mutation could kill it — and a guard nothing can kill is a guard the
// next reader deletes without knowing what it was for. The catch is the guard.
export function capOwnLog(fd = 2, cap = Number(process.env.CACHE_FIX_LOG_CAP_BYTES) || 4 * 1024 * 1024) {
  try {
    if (fstatSync(fd).size <= cap) return false;
    ftruncateSync(fd, 0);
    // SAY IT, or the file reads as one that was never written — which is the
    // exact misreading this session spent the day on from the other side.
    writeSync(fd, `[cache-fix] log passed ${cap} bytes and was truncated; older lines are gone\n`);
    return true;
  } catch { return false; }   // unwritable, or a platform that refuses: not a reason to fail startup
}

// IS THIS PID A PROXY, or just something holding the same socket?
//
// Measured in production 2026-08-18: THREE of our processes hold one LISTEN
// inode on fd 3 simultaneously — the holder (claude-via-proxy.mjs run-service),
// the standby (gap-relay.mjs) and the proxy (proxy/server.mjs). successorServing
// below excluded only process.pid, so the standby that was already there
// answered for the successor that had not started yet.
//
// Holding the socket is not the claim being made. "A successor is serving" is,
// and only a proxy can serve. Both branches of successorServing ask this, or
// fixing one leaves the other lying on the platform it owns.
function isProxyPid(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("proxy/server.mjs");
  } catch { /* no /proc, or it went away between listing and reading */ }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="],
                        { encoding: "utf8", timeout: 2_000 }).includes("proxy/server.mjs");
  } catch { return false; }
}

export function successorServing(port) {
  // The /proc attempt is skippable so the lsof path below can be exercised on a
  // machine that HAS /proc. Without it the fallback is only reachable by running
  // the suite on a mac, which is exactly the "skip the platform we do not run
  // on" that left it untested in the first place — cswap's pin simulates Darwin
  // rather than skipping it, and this is the seam that lets us do the same.
  try {
    if (process.env.CACHE_FIX_NO_PROC === "1") throw new Error("proc disabled");
    const hex = Number(port).toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set();
    for (const line of readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1]?.endsWith(":" + hex) && f[3] === "0A") inodes.add(f[9]);
    }
    // NO MATCH IS NOT AN ANSWER — fall through to the lsof branch below.
    // /proc/net/tcp is IPv4-ONLY; an IPv6 listener lives in /proc/net/tcp6, so
    // with CACHE_FIX_PROXY_BIND=::1 (or a proxy on ::) this found nothing and
    // reported "no successor", and the handover wait burned its full 30s
    // ceiling every time. Same defect class as the macOS lsof one this branch
    // pair already fixed: when one instrument is blind, ask the other.
    if (!inodes.size) throw new Error("no IPv4 listener on this port; try lsof");
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      let fds;
      try { fds = readdirSync(`/proc/${p}/fd`); } catch { continue; }
      for (const fd of fds) {
        let t;
        try { t = readlinkSync(`/proc/${p}/fd/${fd}`); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(t);
        if (m && inodes.has(m[1]) && isProxyPid(p)) return true;
      }
    }
  } catch { /* no /proc: ask lsof below instead of waiting out the ceiling */ }
  // MACS HAVE NO /proc, and this is the self-heal's exit condition — without an
  // answer it returns false forever and the outgoing proxy waits out its whole
  // 30s ceiling instead of leaving as soon as the successor serves. Two of our
  // three machines are macs, so the Linux-only path was the exception rather
  // than the rule. The launcher already reaches for lsof one file over, for
  // exactly this reason and with that reason written down.
  //
  // Same question, different instrument: is any OTHER pid listening here.
  try {
    // BY PORT, like the /proc branch above — not by 127.0.0.1. The two branches
    // answered the same question differently: /proc matches on the port alone
    // (f[1] ends with :hexport, any local address), while this one pinned the
    // loopback literal. So on a mac — the only platform that reaches this
    // branch, and two of our three machines — a proxy bound anywhere else
    // matched nothing, successorServing() returned false forever, and the
    // outgoing proxy waited out its whole 30s ceiling on every handover
    // instead of leaving as soon as its successor served.
    //
    // Matching /proc, rather than teaching /proc the address: a wildcard
    // listener (0.0.0.0) serves loopback traffic but does NOT match an
    // `-iTCP@127.0.0.1` query, so an address filter has its own blind spot, and
    // the one that errs toward "a successor exists" would let a proxy leave an
    // unowned port behind.
    // BOUNDED, for the same reason the launcher's probes are: `lsof` costs what
    // the process table costs, and this runs on a user's machine. A timeout is
    // safe here because the catch below already falls back to the ceiling.
    // SIGKILL because a probe wedged on a sick box will not honour SIGTERM.
    //
    // READ ONCE, AT LOAD, like the launcher's PROBE_TIMEOUT_MS — see the const
    // near the top of this file. It was read from process.env on every call,
    // inside a 100 ms setInterval, while the launcher snapshots at import: the
    // same knob then meant two different things in the two layers the moment
    // anything mutated the env mid-run. The two copies of these three values
    // are deliberate (no module is shared between bin/ and proxy/, and one
    // would exist solely to carry them) — so they are named on both sides and
    // this comment is the link.
    const out = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
                             { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
                               timeout: PROBE_TIMEOUT_MS,
                               killSignal: "SIGKILL", maxBuffer: 1 << 20 });
    for (const line of out.trim().split("\n")) {
      const pid = Number(line);
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && isProxyPid(pid)) return true;
    }
  } catch { /* lsof absent or nobody listening: the ceiling is the fallback */ }
  return false;
}

// stdout/stderr belong to the SUPERVISOR, and it can die first.
//
// When the holder is SIGKILLed its pipe goes with it, and the next write throws
// EPIPE. That is not cosmetic: the throw happened mid-shutdown, so the drain
// never ran and the process died with a connection still open — the client saw
// RST. Measured, holder SIGKILLed under load: "self-heal: uncaughtException
// swallowed: Error: write EPIPE ... at proxy/server.mjs:1079" and exactly 1
// request lost, every run.
//
// A log line must never be able to end the process it is describing.
function say(stream, text) {
  try { stream.write(text); } catch { /* supervisor's pipe is gone; keep serving */ }
}

function exitWithParent() {
  // TWO BEHAVIOURS, AND ONLY ONE IS OPTIONAL. Noticing the parent is gone and
  // EXITING must always happen; putting a new holder back on the port is what
  // an operator may want off.
  //
  // They used to be one switch, and that left orphans: every case that sets
  // CACHE_FIX_SELF_HEAL=off — which is most of the suite, deliberately, so a
  // killed holder stays dead — also disabled the exit, so the proxy child
  // outlived its holder forever. Measured: three of them at ppid 1, 7 minutes
  // old, holding the test runner's stdout pipe and stalling the whole suite at
  // 568 cases until they were reaped by hand.
  if (process.env.CACHE_FIX_PROXY_PORT !== "0") return;
  // The advertised port, which the holder passed down so we can put a new
  // holder back on it. Without it we can only exit, and the port stays dead
  // until a human opens a shell — which is exactly the outage this exists for.
  // A SUCCESSOR IS NOT THE HOLDER'S CHILD. During a handover the OUTGOING
  // proxy spawns us, so our ppid is its pid — never the holder's. "ppid
  // changed" therefore says nothing about the holder here, and acting on it
  // starts a RIVAL holder on a port that already has one.
  //
  // Measured on <linux-host>, live 9901, in this exact order:
  //   proxy listening on 127.0.0.1:9901
  //   proxy releasing the listening socket (handed off)
  //   proxy listening on 127.0.0.1:9901      <- successor is up and serving
  //   [cache-fix] holder died; started a new one on 9901   <- rival, 1s later
  // and the churn cost 1,970 then 6,528 requests, twice taking the port down.
  //
  // REACHABILITY, measured rather than argued, because I got this wrong twice.
  // The successor is spawned with detached:true, and I assumed that meant born
  // with ppid 1 — in which case `born === process.ppid` holds forever and this
  // branch could never run for it. It does not: detached creates a new SESSION,
  // not an orphan. Measured — successor born ppid=4094730, then 4094730 -> 1
  // the moment the predecessor exited, which it always does right after handing
  // over. So the branch IS reached, on every single handover.
  //
  // I also removed this guard once because mutating it out changed nothing.
  // That mutation ran on an isolated port where the branch never fired at all
  // (0 "holder died" events across 4 runs), so it exercised a path the
  // condition cannot reach there. A mutation that cannot trip the guard proves
  // nothing about the guard — "no difference" was "no measurement".
  // NO BLANKET EXEMPTION ANY MORE. This used to return outright for a handover
  // successor, and a successor is what every proxy becomes the first time
  // anything redeploys — so the whole lineage permanently lost the ability to
  // put a holder back. Measured on the fleet: <linux-host> orphaned 30 days, the
  // personal Mac 48, both serving 200 the entire time with nobody above the
  // listener.
  //
  // What replaces it is the marker, not the ppid. CACHE_FIX_HELD_BY is set by a
  // HOLDER ONLY, naming itself; a predecessor handing over clears it. So a
  // successor is not "held" and can never be "orphaned", which is what the
  // blanket return was protecting against — a rival holder started off a ppid
  // that legitimately changes on every handover.
  const heldBy = process.env.CACHE_FIX_HELD_BY;
  const advertised = process.env.CACHE_FIX_HELD_PORT;
  setInterval(() => {
    // Two facts, both free, and no probe: the marker outlives the holder
    // because it is our own environment, while our ppid moves to 1 the instant
    // the holder dies. The two disagreeing IS the orphaning. `born` is no
    // longer consulted — it could not tell a dead holder from a predecessor
    // that exited on purpose.
    if (releasingPort) return;          // asked to let go: do not resurrect the lineage
    if (!heldBy || heldBy === String(process.ppid)) return;
    // The holder is gone and every session on this box has HTTPS_PROXY baked at
    // exec — they cannot be re-pointed, so the address must get an owner back.
    // Measured on <linux-host>: the holder died, nothing revived it, and every session
    // fell into attempt N/300 until someone woke up and started one by hand.
    //
    // Detached and re-exec'd rather than adopted: a new holder must outlive us,
    // and it is the holder that knows how to supervise a proxy. We hand the
    // port over by exiting right after — the successor takes it the same way a
    // deploy does.
    // The respawn is the part `off` turns off. We still exit below.
    if (advertised && process.env.CACHE_FIX_SELF_HEAL !== "off") {
      try {
        spawn(process.execPath, [join(__dirname, "..", "bin", "claude-via-proxy.mjs"), "run-service"], {
          // fd2 INHERITED, NOT DISCARDED. `stdio: "ignore"` sent all three to
          // /dev/null, which silences the holder this becomes, every proxy it
          // supervises, and every handover successor below it — those inherit,
          // so one self-heal makes the whole lineage mute permanently. Measured
          // on both Macs: the live 9901 launcher and proxy sit on /dev/null and
          // the forced-close drain count has been written into the void there
          // since it landed, while <linux-host>'s identical code writes a readable log.
          // The only difference was which spawn started the lineage.
          //
          // The very next line reports this spawn on OUR stderr, which is the
          // wrong way round on its own: the departing process speaks and the
          // arriving one cannot.
          //
          // fd0 and fd1 stay closed. The holder parses its child's "proxy
          // listening" chatter over a pipe of its own, so inheriting stdout
          // would duplicate it into whatever the operator was looking at.
          // Errors are the half that has to survive.
          //
          // Inheriting a pipe that later breaks is safe: the EPIPE /
          // ERR_STREAM_DESTROYED swallower above keeps a write to a dead
          // stderr out of uncaughtException.
          detached: true, stdio: ["ignore", "ignore", "inherit"],
          // HELD_BY is cleared with HELD_PORT. It named OUR holder, which is the
          // one that just died; carrying it into the replacement makes a live
          // holder look "held" by a pid that is not its parent. Nothing acts on
          // it there today — the holder overwrites it for its own child — but a
          // stale marker riding along is the exact shape that cost us the
          // successor's inherited EXIT_WITH_PARENT and the rival holder before
          // it. Clear it where it stops being true.
          env: { ...process.env, CACHE_FIX_PROXY_PORT: advertised,
                 CACHE_FIX_HELD_PORT: undefined, CACHE_FIX_HELD_BY: undefined },
        }).unref();
        process.stderr.write(`[cache-fix] holder died; started a new one on ${advertised}\n`);
        // KEEP SERVING UNTIL THE SUCCESSOR IS UP. Exiting the instant we have
        // spawned a holder leaves the port with no owner for that holder's
        // whole boot — measured, 133-138 refused per holder death while we sat
        // idle waiting to die. We already hold the socket; there is no reason
        // to stop answering with it before someone else can.
        //
        // Poll, do not guess a delay: a boot takes what it takes, and a fixed
        // sleep is either an outage or a stall. When the new holder's proxy has
        // the port, our own accept attempts stop winning connections and we can
        // go. Bounded so a successor that never starts cannot pin us forever —
        // at the ceiling we exit anyway and the holder's own restart ladder
        // takes over, which is the pre-existing behaviour.
        const until = Date.now() + 30_000;
        const wait = setInterval(() => {
          if (Date.now() < until && !successorServing(advertised)) return;
          clearInterval(wait);
          process.exit(0);
        }, 100);
        wait.unref();
        return;
      } catch (e) {
        process.stderr.write(`[cache-fix] holder died and the respawn failed: ${e.message}\n`);
      }
    }
    process.exit(0);
    // Test seam: the poll interval. The guard above is only reachable when a
    // release is still in flight AT a tick, and at one second a fast release
    // finishes between ticks — so the case that pins it passed with the guard
    // REMOVED. Same seam style as CACHE_FIX_RESTART_BASE_MS and
    // CACHE_FIX_WATCH_DEPLOY_MS, and it makes a timing race deterministic
    // rather than hoping for it, which is what cswap's pin did with tgkill.
  }, Number(process.env.CACHE_FIX_SELF_HEAL_MS) || 1000).unref();
}

if (invokedAsScript) {
  let active;
  exitWithParent();
  // Signals FIRST, before the await. `startProxy()` is async — it loads
  // extensions, merges the CA bundle and binds — and until it settles there is
  // no handler, so a SIGTERM in that window gets node's DEFAULT action and the
  // process dies by signal instead of running `shutdown`.
  //
  // `shutdown` already handles the not-yet-listening case (`if (!active)` ->
  // exit 0), so the intent was there; only the registration was late, and the
  // code could never be reached. Measured on this box: SIGTERM at +0/+5/+20/+50
  // ms gave exit=null (killed), +150 ms onwards gave exit=0. Boot here is ~100
  // ms, so the window is invisible locally and opens wide on a loaded CI runner
  // — which is why `shuts down cleanly on SIGTERM` asserts code 0 and failed
  // there, not here: 3 of 5 node-20 runs, always in a file that forks a proxy.
  //
  // Registering before the boot also means the SIGKILL-forcing watchdog below
  // is armed for the whole life of the process rather than only after it is
  // serving.
  const onSignal = () => shutdown();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  // Set before any handler can read it: `releasing` is declared here rather
  // than beside shutdown() because SIGHUP arrives from the line below.
  let releasing = false;
  // The supervisor is stopping US, not redeploying: leave without putting a
  // successor on the socket. See the holder's `forward()`.
  process.on("SIGHUP", () => { releasing = true; releasingPort = true; onSignal(); });
  // The holder handed the listening socket to a successor that is already
  // serving it, then asked us to go. Nothing waits on this exit: the holder
  // settles the moment it signals us, so we drain detached.
  process.on("SIGUSR2", () => {
    releasing = true; releasingPort = true; handoverRelease = true; onSignal();
  });
  startProxy()
    .then((handle) => {
      active = handle;
      say(process.stdout, `proxy listening on ${handle.address}:${handle.port}\n`);
      sweepUpdateFossil();
    })
    .catch((err) => {
      process.stderr.write(`proxy failed to start: ${err.message}\n`);
      process.exit(1);
    });

  // A supervised stop is a SUCCESS, however it ends. server.close() waits for
  // in-flight requests, and a live Claude Code session always has one (the
  // streaming /v1/messages response), so the graceful path alone never
  // resolves — the watchdog is the normal exit under systemd, not the
  // exception. Exiting 1 there made every `systemctl stop` log
  // "status=1/FAILURE", which (a) makes a crash and a clean stop
  // indistinguishable in the journal and (b) trips Restart=on-failure on a
  // deliberate stop. Force the laggards, report the forcing on stderr, exit 0.
  // ONCE. SIGTERM, SIGINT and SIGHUP all land here, and a supervised stop
  // delivers more than one: systemd SIGTERMs the whole control group, so the
  // proxy gets it directly AND the holder forwards its own SIGHUP. Re-entering
  // spawns a SECOND successor on fd 3 — two proxies on one socket, which is the
  // "one extra per deploy" the (handed off) announcement exists to stop — and
  // announces the release twice, and arms a second 5s force-close.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Set BEFORE anything else in this function: every request that arrives from
    // here on is arriving at a process that is leaving, and must be told so.
    active.server._draining = true;
    if (!active) {
      process.exit(0);
      return;
    }
    // Stop listening FIRST, then say so. server.close() unbinds at once and
    // only then drains in-flight requests — up to the 5s below — so a
    // supervisor that waits for our EXIT sees the port unowned for the whole
    // drain (measured: 43 ECONNREFUSED across 3 SIGTERMs with 4 concurrent
    // clients). Announcing lets it take the port back immediately instead.
    //
    // Closing first is ordering hygiene, NOT the cure: announcing while we
    // still hold the socket makes the supervisor race a bind it must lose.
    // Measured, it does not close the window on its own — 5-6 requests are
    // still refused per restart, the same as before the reorder and the same at
    // 1ms and 20ms supervisor retries.
    //
    // UNDER A HOLDER THERE IS NOTHING TO HAND OVER — the holder owns this
    // socket and it is the holder that puts the successor on it. We only say
    // WHICH kind of exit this is, and it says so with an exit code.
    //
    // I built the other shape first: the outgoing proxy spawning its own
    // successor on fd 3. It measured zero refused, and it was still wrong.
    // Once the proxy spawns, the holder is supervising a child it never
    // started, so a supervisor's SIGTERM no longer stops it — measured, the
    // case that asserts exactly that went from 587 ms to 10,985 ms and failed.
    // cswap's pin has the same comment for the same reason, with a worse
    // outcome recorded: 76 minutes of a broken pin reporting healthy, because
    // the successor lost the bind and served on the wrong port.
    //
    // 75 (EX_TEMPFAIL) = "put a successor on this socket". Plain 0 = "I bound
    // my own port, there is nothing to succeed to". Same number and meaning as
    // the pin, so one probe reads both.
    //
    // We do NOT try to tell a redeploy from a shutdown here, because we cannot:
    // both arrive as SIGTERM and only the holder knows which it sent. The
    // holder already tracks that as `stopping` and ignores our code when it is
    // stopping — so 75 is a REQUEST, and the supervisor is what grants it.
    // WE hand the socket to our successor, because the holder cannot. It left
    // libuv's accept path after our generation started — that is what stops it
    // eating steady traffic — and closing its handle made the fd number
    // unusable there (ENOTSOCK, measured). Ours is still valid, so the socket
    // travels DOWN THE CHAIN: each proxy passes its own fd 3 on.
    //
    // SUCCESSOR FIRST, then stop accepting, then drain. Measured at 30
    // concurrent over 3 handovers: 99,710 requests, 0 lost, 0 refused, and the
    // port answered at every step. Removing the successor spawn under the same
    // load puts the losses straight back.
    //
    // Exit 75 (EX_TEMPFAIL) stays even though we spawned: it is what a holder
    // that still owns the socket — the pre-detach case, and cswap's pin —
    // reads as "put a successor on this socket". The two paths must not
    // disagree about what our exit means.
    // UNDER A LIVE HOLDER THERE IS NOTHING TO HAND OVER. The holder still owns
    // the socket, so it survives our exit on its own — measured: parent binds,
    // child listens, child SIGKILLed, the port still ACCEPTED/QUEUED. Spawning
    // our own successor there produces a proxy the holder did not place and does
    // not supervise, which is the process that then cannot self-heal. cswap's
    // pin measured the same shape from the other side: a successor that could
    // not take the port served UNHELD on another one for 76 minutes while every
    // health signal stayed green. Exit instead, and let the holder place the
    // next child on the descriptor it never let go of.
    const heldByLiveHolder = !!process.env.CACHE_FIX_HELD_BY
      && process.env.CACHE_FIX_HELD_BY === String(process.ppid);
    const askForSuccessor = active.inheritedSocket && !releasing && !heldByLiveHolder;
    // WHETHER ONE ACTUALLY STARTED, which is not the same question as whether we
    // wanted one. The announcement below used to be keyed on the WANT, so a
    // spawn that threw still printed "(handed off)" — and the holder reads that
    // exact string as "a successor is already serving, do nothing": it skips
    // reclaim() AND spawnWhenReady(), and its `retired` flag makes our exit a
    // no-op too. A failed spawn therefore ended with nobody on the socket and a
    // supervisor that believed it was covered.
    let handedOff = false;
    if (askForSuccessor) {
      try {
        spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
          stdio: ["ignore", "inherit", "inherit", 3],
          // HELD_BY is CLEARED, and that single fact is what stops a successor
          // self-healing into a rival. Only a live holder names itself; a
          // predecessor handing over on its way out does not. So a successor is
          // not "held", therefore can never be "orphaned from its holder", and
          // the self-heal below needs no blanket exemption for the whole
          // lineage — which is what left two of three machines unable to put a
          // holder back for 30 and 48 days.
          env: { ...process.env, LISTEN_FDS: "1", CACHE_FIX_HELD_BY: undefined },
          detached: true,
        }).unref();
        handedOff = true;
      } catch (err) {
        // Say so and go: a holder that still has its handle will restart us the
        // old way, and one that has detached is better told than left guessing.
        process.stderr.write(`[cache-fix] successor spawn failed (${err?.code || err?.message})\n`);
      }
    }
    // AT THE NET LAYER, so the announcement below is true and nothing is severed
    // to make it true. `close` above carries the discrimination; the sweep this
    // skips is run there, once, behind the flush.
    active.server?._unbind?.();
    // SAY WHO STARTED THE SUCCESSOR. The holder reads this line as "reclaim the
    // port and spawn", so a proxy that already spawned must say so or the two
    // of us put two proxies on one socket — measured, one extra per deploy:
    // PEAK CONCURRENT 4 and 3 still alive after 4 deploys.
    // DO NOT READ THE ARM OFF THIS LINE IN A LOG. The holder both forwards our
    // stdout to the log and parses it, so on a holder-driven handover — where
    // that holder has already settled and is leaving — the line reaches neither,
    // and `(handed off)` then reads as "no handover ever happened". Take the arm
    // from stderr, which names the budget on both outcomes: a cut says
    // `after <budget>s`, a completed drain `of <budget>s budget`.
    say(process.stdout,
        `proxy releasing the listening socket${handedOff ? " (handed off)" : ""}\n`);
    // NOTHING WAITS ON US — one predicate, and the only thing that ever justified
    // a ceiling here. A ceiling is a bet on how long a reply takes; it is payable
    // only when someone's wait is serial.
    //
    //   handedOff         we spawned the successor ourselves
    //   handoverRelease   a holder's SIGUSR2 put a successor on fd 3. Never
    //                     `handedOff`: it sets `releasing`, so askForSuccessor is
    //                     false. Read it from SIGUSR2 and NOT from
    //                     `releasingPort`, which a plain stop also sets.
    //   heldByLiveHolder  a live holder supervises us, and it settles on our
    //                     RELEASE announcement rather than on our exit
    //
    // The third holds ONLY while claude-via-proxy.mjs settles in the `stopping`
    // arm of onLine. Separate them and a stop blocks for this whole budget
    // instead of for 5s, which is the downtime the ceiling was bought with.
    const unwaited = handedOff || handoverRelease || heldByLiveHolder;
    const budgetMs = unwaited
      ? drainBudgetMs(process.env.CACHE_FIX_DRAIN_MS, 1_800_000)
      : 5_000;
    // TIME THE DRAIN THAT FINISHED, not only the one that was cut.
    // 6d6f01d set a 1800s handover budget with no way to see how close anything
    // comes to it — a threshold with no instrument, which is the same defect as
    // the Node 18 assumption above. The forced-close line reports only what was
    // open when patience ran out; it cannot say how much patience was NEEDED.
    // A drain that COMPLETED in N seconds is evidence N was safe to wait, and
    // that is the population a future threshold has to be chosen from. The
    // neighbour layer measured one legitimate drain at 1126.2s, so the range
    // this lives in is not hypothetical.
    const drainStart = Date.now();
    // WHAT WAS AT RISK WHEN THE SIGNAL ARRIVED. `drained clean` means everything
    // owed finished inside the budget -- it does NOT mean nothing was owed, and
    // without this the two are the same line. How often a stop has anything at
    // risk was therefore not derivable from these logs, and this arm's cost has
    // been argued from four terminations.
    //
    // Counted HERE, not at the terminal line: by then the set has drained, which
    // is the question the terminal line already answers.
    const owedAtStart = active.server?._live?.size ?? 0;
    // Hoisted: the clean-drain line is written before the stall loop is
    // installed, so the count has to outlive it.
    let stallEnded = 0;
    // Rate for the past-budget notice. The tick is 1s and a live stream can hold
    // the drain open indefinitely, so that line has to be periodic, not per tick.
    let lastWaitSaid = 0;
    active.close().finally(() => {
      const secs = ((Date.now() - drainStart) / 1000).toFixed(1);
      // PREFIXED like its two siblings above, and NOT the bare phrase
      // "drained clean": a neighbouring component logs its own drain with that
      // exact wording, and its reader matches on it unanchored. It reads one
      // explicit path today so nothing collides — but two components sharing a
      // phrase across two logs is a wrong row that parses cleanly, which is the
      // kind of defect that has no symptom. Renamed before it shipped anywhere.
      // "clean" only when nothing was cut: its reader greps the phrase
      // unanchored, so naming the cut in a suffix would not keep it out.
      say(process.stderr, `[cache-fix] shutdown: drained${stallEnded ? "" : " clean"}`
        + ` in ${secs}s of ${budgetMs / 1000}s budget`
        + `, owed ${owedAtStart} at the start`
        + (stallEnded ? `, ${stallEnded} ended on the stall test` : "") + `\n`);
      process.exit(handedOff ? 75 : 0);
    });
    // THE BUDGET IS 5 s ONLY WHERE SOMETHING IS WAITING ON OUR EXIT.
    //
    // The 5 s is right for a SUPERVISED STOP and the measurement behind it is
    // sound: that path is SERIAL (stop, wait for exit, start), so a longer grace
    // only extends the outage — at 120 s against `DefaultTimeoutStopSec=90s` the
    // stop was SIGKILLed at the cap and restart downtime went 5.0 s -> 53.9 s.
    // Any increase THERE still has to move the unit's TimeoutStopSec with it.
    //
    // It is wrong for a HANDOVER, and it was applied to both. On the handedOff
    // path the successor was already spawned detached with fd 3 and is serving,
    // and the holder reads "(handed off)" as "a successor is already serving, do
    // nothing" — it skips reclaim() AND spawnWhenReady(), and its `retired` flag
    // makes our exit a no-op. Nothing waits on us. We cut anyway, on every
    // deploy: measured on <linux-host> across four of them,
    //     cut 4 -> cut 14 -> cut 17 -> cut 14 -> cut 16
    // every one 100% mid-response, 0 before headers — so every cut was a reply
    // whose headers the client already had and whose body stopped mid-stream.
    //
    // WHY NOT `active.close()`. It cannot express "nothing is owed" here:
    // measured on 18.20.8 / 20.20.2 / 24.11.1, one live CONNECT tunnel leaves
    // close() unresolved with liveResponses 0, and closeIdleConnections()
    // neither frees it nor unblocks close(). So the drain needs its own test.
    //
    // THIS PARAGRAPH USED TO SAY NO HONEST PREDICATE EXISTED, and it was the
    // reason the answer here stayed a number for as long as it did. What it
    // actually refutes is a THRESHOLD ON THROUGHPUT — see the arm below, which
    // never divides anything. Corrected rather than deleted: the wrong version
    // is the kind that stops the next reader from looking.
    //
    // A lingering predecessor costs RAM and nothing else — it holds no listener
    // (we released it above) and the successor is serving. So the handover arm
    // can afford to wait, and CACHE_FIX_DRAIN_MS is now its BACKSTOP rather than
    // its deadline.
    // Also used by the per-connection end below.
    // Shared with the stall loop below, which marks what it has already ended.
    // Empty on the supervised arm, where that loop never runs.
    const seen = new WeakMap();
    const forceClose = (afterMs, why) => {
      // End the laggards rather than destroying them. `closeAllConnections()`
      // destroys the socket, and the kernel answers RST — measured, a client
      // that had already received every byte still surfaced ECONNRESET and
      // threw the delivered data away. `res.end()` sends FIN, which the same
      // client reads as a clean EOF.
      //
      // ONLY THE ONES THAT ALREADY SENT HEADERS. `liveResponses` is filled at
      // request START, so it also holds requests still blocked upstream — and
      // `res.end()` on a response with no writeHead emits an implicit
      // `HTTP/1.1 200 OK` + `Content-Length: 0`. Measured on the wire: a stop
      // during a slow upstream call turned a retryable reset into a well-formed
      // EMPTY SUCCESS, which a client cannot tell from a real one and will not
      // retry. The FIN-not-RST argument only ever applied to a response that had
      // bytes to finish; for one that has sent nothing, a reset is the honest
      // answer and the only retryable one.
      // COUNT OFF THE SNAPSHOT, NEVER OFF THE LIVE SET: `res.on("close")`
      // deletes from liveResponses. Latent today — the delete lands a tick
      // later, measured before=1 afterSync=1 afterTick=0 on 18/20/24 — and
      // lying the moment anything drains the set synchronously. Do not
      // "simplify" the spread away.
      // NAME THE ROUTES, because the count alone cannot say what was lost. This
      // port carries CLI turns alongside bridge traffic, quota polls, statusline
      // and title generation, and only the first kind is a reply a person is
      // reading. A cut of 15 is a different event depending on the mix, and
      // every reader of this line so far has had to guess.
      //
      // COARSE, AND NO QUERY STRING. Two path segments, nothing after `?`: the
      // proxy sees whole request URLs and this line goes to a log, so the
      // grouping is what stops an identifier in a path from being written out.
      // It is also what bounds the cardinality — a per-URL tally on a passthrough
      // route would print one entry per request.
      let ended = 0, destroyed = 0;
      const routes = new Map();
      // HOW LONG EACH ONE HAD BEEN QUIET. `N still owed` cannot tell a stalled
      // reply from a live one, so every forced close has needed re-derivation:
      // measured once under real traffic, `0 ended on the stall test, 4 still
      // owed` was only readable as "they were streaming" by reasoning from the
      // zero. The predicate's own record already dates each connection from its
      // last byte, so this reports what is there rather than counting anything
      // new. RANGE, not one per connection: the minimum answers "was ANY of
      // them live" and the maximum "was ANY of them stalled", and two numbers
      // cannot blow up the line the way a cut of 17 would.
      const quietMs = [];
      const nowAt = Date.now();
      for (const res of [...(active.server?._live ?? [])]) {
        // Already ended by the stall test. It is still here only because its FIN
        // cannot flush, and counting it again reports one connection twice in a
        // line an external monitor parses.
        const rec = seen.get(res);
        if (rec?.done) continue;
        const r = drainRoute(res.req?.url);
        routes.set(r, (routes.get(r) ?? 0) + 1);
        // NO RECORD MEANS THE STALL LOOP NEVER RAN -- the supervised arm -- not
        // that nothing ever moved. Dating from arrival there reports a reply's
        // AGE as its silence: measured, `quiet 17.5s` for one delivering a chunk
        // every 200ms, which reads as a cut that took something already dead.
        // Resolution on that arm is the budget: a reply that stalled mid-drain
        // reads 0, erring toward calling the cut costly rather than free.
        const moved = (res.socket?.bytesWritten ?? 0) !== (res._bornBytes ?? 0);
        quietMs.push(nowAt - (rec?.at ?? (moved ? nowAt : res._bornAt ?? nowAt)));
        try { if (res.headersSent) { res.end(); ended++; } else { res.destroy(); destroyed++; } } catch {}
      }
      const routeTally = [...routes].sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}=${n}`).join(" ");
      const secs = (ms) => (ms / 1000).toFixed(1);
      const lo = Math.min(...quietMs), hi = Math.max(...quietMs);
      const quietTally = !quietMs.length ? ""
        : lo === hi ? `${secs(lo)}s` : `${secs(lo)}-${secs(hi)}s`;
      // THE SAME EXIT CODE THE GRACEFUL PATH USES. It exits
      // `askForSuccessor ? 75 : 0`, and the comment above it says the two paths
      // must not disagree about what our exit means — but this one exited 0
      // unconditionally, and the file calls the watchdog "the normal exit under
      // systemd". So the ordinary stop of a proxy that DID hand its socket on
      // reported EX_OK, and a supervisor keyed on 75 read "nothing to succeed
      // to" for a lineage that had a successor waiting.
      const code = handedOff ? 75 : 0;
      // getConnections is async, so the announce and the exit both live in its
      // callback. Its error arm passes null rather than 0 — an unknown count
      // must not print as "0 connections still held", which is the one reading
      // that would wrongly clear the stop.
      const finish = (held) => {
        process.stderr.write(forcedCloseLine(
          ended, destroyed, held, afterMs, why, routeTally, quietTally, owedAtStart));
        // Then force whatever did not take the FIN. Node >=18.2; package.json
        // engines allows 18.0/18.1, where exiting without forcing is the only
        // option.
        if (typeof active.server.closeAllConnections === "function") {
          setImmediate(() => { active.server.closeAllConnections(); process.exit(code); });
        } else {
          setImmediate(() => process.exit(code));
        }
      };
      try { active.server.getConnections((err, n) => finish(err ? null : n)); }
      catch { finish(null); }
    };
    if (!unwaited) {
      // THE STANDALONE ARM KEEPS ITS CEILING, and it is the only arm left that
      // has one. Nothing supervises us, so the process we are is the process
      // somebody is waiting on, and that wait is serial.
      setTimeout(() => forceClose(budgetMs, ""), budgetMs).unref();
    } else {
      // THE HANDOVER ARM HAS NO CEILING, because a ceiling is a bet on how long
      // a reply takes and every value of it loses: 5s and 1800s cut on this
      // path, and a neighbouring component retuned the same number three times.
      //
      // SCORE BYTES, NOT CONTENT EVENTS, AND NOT A RATE. A rate cannot separate
      // a slow reply from a heartbeat — 490 B/s against 35 B/s on one stream —
      // and that measurement is why this file used to conclude no honest
      // predicate existed. It is an argument against a THRESHOLD ON THROUGHPUT
      // and it does not touch this test, which never divides anything: a reply
      // and a heartbeat both answer "moving", which is the correct answer for
      // both. What it excludes is a connection delivering nothing at all, and
      // that is a different shape rather than a smaller number of the same one.
      // The neighbour's distribution: content-free waits reach 186s while
      // BYTE-free waits reach 23s. The two modes do not overlap, so no value in
      // between is wrong — which is why their stall threshold has never been
      // retuned while every budget has.
      //
      // 90s is a judgement call bounded by two observations (past any gap a live
      // stream produces, short of the ten minutes that was cutting real work),
      // not a percentile. A number presented as derived when it was not is worse
      // than an honest guess.
      //
      // DO NOT TIGHTEN THIS TOWARD THE OBSERVED MAXIMUM. That maximum is not
      // stable: it stood at 2s over 6 samples, then a real reply on a busy host
      // went 23s without a byte and finished clean. Bimodality is what lets you
      // choose a threshold without knowing n; it is NOT what tells you how much
      // MARGIN you have, and only n does that. Every sample under 2s came from
      // quiet hosts. Below ~60s is inside the observed range of a healthy
      // stream, so anything there cuts live work.
      const stallMs = drainBudgetMs(process.env.CACHE_FIX_DRAIN_STALL_MS, 90_000);
      // Polled off the socket rather than stamped on every write: the hot path
      // pays nothing, and `bytesWritten` is the byte actually leaving rather than
      // a chunk we parsed. It is also the only thing that separates a reply that
      // is streaming from one blocked upstream — `headersSent` goes true at
      // writeHead, measured with bytesWritten still 0, so the `mid-response`
      // count above is an upper bound and this is not.
      // WeakMap: a response that finishes leaves `_live` but would stay reachable
      // from here, and this drain can run for as long as work keeps arriving.
      // PER CONNECTION, both the clock and the cut.
      //
      // This was one shared `lastMoved` reset by a disjunction over the whole
      // set, and on a port with any traffic that is a clock that never expires:
      // one live stream answers "moving" for every connection, so a stalled one
      // never ages.
      //
      // AND THE CUT MOVED WITH IT, which is the half that is easy to miss.
      // Per-connection STAMPING alone still ends the WHOLE drain the moment one
      // connection goes quiet, taking the live ones with it — the same
      // zero-interruption violation with the sign flipped. So a quiet connection
      // is ended on its own and the drain keeps going; what ends the drain is
      // `server.close()` resolving, or the backstop.
      const tick = setInterval(() => {
        const now = Date.now();
        for (const res of [...(active.server?._live ?? [])]) {
          const n = res.socket?.bytesWritten ?? 0;
          const rec = seen.get(res);
          // A connection first seen during the drain is stamped, not judged: it
          // has no history here, and treating "no record" as "no movement"
          // would end it on the first tick. It is dated from ARRIVAL only when
          // nothing has left it since — see `_bornBytes`.
          if (!rec) {
            const quietSinceArrival = n === (res._bornBytes ?? 0);
            seen.set(res, { bytes: n, at: quietSinceArrival ? (res._bornAt ?? now) : now });
            continue;
          }
          // MARKED, never deleted. `res.end()` only queues the FIN, so a
          // response whose client stopped reading never leaves the live set,
          // and a deleted record is re-stamped as new and ended again.
          if (rec.done) continue;
          if (rec.bytes !== n) { rec.bytes = n; rec.at = now; continue; }
          if (now - rec.at < stallMs) continue;
          // IT ENDED ITSELF, so `res.end()` is a no-op and there is no cut to
          // report. Reachable on the BUFFERED branch only — its single
          // `end(rawResponse)` ignores backpressure; the streaming path pipes.
          //
          // NOT MARKED DONE. `done` means "already accounted for", and this one
          // is still OWED: megabytes are queued on a socket the client is not
          // reading, and the forced close destroys it. Marking it here dropped it
          // from the backstop's owed count AND from the cut tally, so the drain
          // said `0 response(s) still owed` and `cut no responses` about a reply
          // it then truncated -- the severed-and-called-clean shape this drain
          // exists to remove, one branch over. Re-entering this test each tick
          // costs one comparison and keeps both counts honest.
          if (res.writableEnded) continue;
          // BYTES ON THE WIRE, not headers in a buffer. `headersSent` is true
          // from writeHead with nothing delivered, and `res.end()` there emits a
          // well-formed empty 200 the client will not retry.
          const mid = n > (res._bornBytes ?? 0);
          let how;
          try {
            if (mid) { res.end(); how = "ended"; }
            else { res.destroy(); how = "destroyed"; }
          } catch { how = "gone"; }
          rec.done = true;
          stallEnded++;
          say(process.stderr, `[cache-fix] shutdown: drain ${how} one connection ` +
            `${drainRoute(res.req?.url)} with no byte written for ${Math.round((now - rec.at) / 1000)}s ` +
            `(${mid ? "mid-response" : "before headers"})\n`);
        }
        const elapsed = now - drainStart;
        // THE ONLY THING THAT ENDS THE DRAIN FROM IN HERE. A quiet connection is
        // ended above without ending the drain.
        //
        // REACHING IT IS NOT PROOF OF A DEFECT. A connection still moving at
        // expiry, a CONNECT tunnel or upgrade (never in `_live` — only the
        // request handler fills it, and that is the common shape in forward
        // mode), and the Node 18 keep-alive case above all reach it with the
        // predicate working. Report what is owed; do not accuse.
        if (elapsed >= budgetMs) {
          // Not `_live.size`: it still holds the ones ended above, so one
          // connection would be counted in both halves of the line.
          const owedRes = [...(active.server?._live ?? [])].filter((r) => !seen.get(r)?.done);
          // THE BUDGET IS A RE-EVALUATION POINT, NOT A GUILLOTINE. The stall
          // test is the only thing here that knows whether a connection is
          // alive, and a wall clock that overrules it is a second policy
          // rather than a last resort. Measured twice, identical both times:
          // four replies still delivering were cut at the budget while the
          // stall test had ended none, so it had judged all four alive and
          // was right about all four.
          //
          // Waiting is affordable and cutting is not -- the comment above
          // says a lingering predecessor holds no listener and costs RAM,
          // and the thing on the other side of this branch is a reply
          // someone is reading. A ceiling for the RAM belongs in units of
          // RAM, not seconds.
          const stillLive = owedRes.filter(
            (r) => now - (seen.get(r)?.at ?? r._bornAt ?? now) < stallMs);
          if (stillLive.length) {
            if (now - lastWaitSaid >= 60_000) {
              lastWaitSaid = now;
              say(process.stderr,
                `[cache-fix] shutdown: still waiting ${Math.round(elapsed / 1000)}s in` +
                ` (budget ${Math.round(budgetMs / 1000)}s) — ${stillLive.length} of` +
                ` ${owedRes.length} owed connection(s) still delivering\n`);
            }
            return;
          }
          clearInterval(tick);
          // ROUNDED, because this arm passes the ELAPSED time rather than a
          // configured budget, and `after` renders a non-multiple of 1000 in
          // milliseconds -- so this arm alone said `after 1800660ms` where every
          // other says `after 1800s`, and a reader outside this repo matches the
          // seconds form.
          forceClose(Math.round(elapsed / 1000) * 1000,
            `, on the BACKSTOP budget — ${stallEnded} ended on the stall test,` +
            ` ${owedRes.length} response(s) still owed`);
        }
      }, 1_000).unref();
    }
  };
}
