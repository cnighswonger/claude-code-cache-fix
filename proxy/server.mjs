import http from "node:http";
import { pathToFileURL } from "node:url";
import config from "./config.mjs";
import { forwardRequest } from "./upstream.mjs";
import { streamResponse, createTelemetryRecord } from "./stream.mjs";
import { loadExtensions, snapshotRegistry, runOnRequest, runOnResponseStart, runOnResponse } from "./pipeline.mjs";
import { startWatcher } from "./watcher.mjs";

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
async function preForward(clientReq, clientRes, _abortController, extSnapshot, routeName) {
  const rawBody = await collectBody(clientReq);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  let forwardBody = rawBody;
  const meta = { route: routeName };

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
  if (pre.handled) return;
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
    if (abortController.signal.aborted) return;
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    return;
  }

  // Stash upstream connection id on meta so downstream extensions
  // (rate-limit-log, future per-connection diagnostics) can record which
  // socket carried the request without each one re-instrumenting upstream.
  meta._upstreamConnectionId = upstreamConnectionId ?? null;

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

  const pre = await preForward(clientReq, clientRes, abortController, extSnapshot, "bootstrap");
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

function handleHealth(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

function handleNotFound(_req, res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
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
    if (req.method === "GET" && req.url === "/health") {
      return handleHealth(req, res);
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      return handleMessages(req, res);
    }
    if (req.url?.startsWith("/api/claude_cli/bootstrap")) {
      return handleBootstrap(req, res);
    }
    handleNotFound(req, res);
  });
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
  const watch = options.watch !== false;

  let watcher = null;
  try {
    await loadExtensions(extensionsDir, extensionsConfig);
    if (watch) watcher = startWatcher(extensionsDir, extensionsConfig);
  } catch {}

  const server = createProxyServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  return {
    server,
    port: addr.port,
    address: addr.address,
    close: () =>
      new Promise((resolve, reject) => {
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
