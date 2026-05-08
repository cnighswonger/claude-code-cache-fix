import http from "node:http";
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

async function handleMessages(clientReq, clientRes) {
  const abortController = new AbortController();
  const extSnapshot = snapshotRegistry();

  clientReq.on("close", () => {
    if (!clientRes.writableEnded) {
      abortController.abort();
    }
  });

  const rawBody = await collectBody(clientReq);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  let forwardBody = rawBody;
  const meta = {};

  if (parsed && extSnapshot.length > 0) {
    const reqCtx = { body: parsed, headers: { ...clientReq.headers }, meta };
    const skipResult = await runOnRequest(reqCtx, extSnapshot);

    if (skipResult && skipResult.skip) {
      const status = skipResult.status || 400;
      const body = skipResult.body || { error: "blocked_by_extension" };
      clientRes.writeHead(status, { "content-type": "application/json" });
      clientRes.end(JSON.stringify(body));
      return;
    }

    forwardBody = Buffer.from(JSON.stringify(reqCtx.body));
  }

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

function handleHealth(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

function handleNotFound(_req, res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return handleHealth(req, res);
  }
  if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
    return handleMessages(req, res);
  }
  handleNotFound(req, res);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function initPipeline() {
  try {
    await loadExtensions(config.extensionsDir, config.extensionsConfig);
    startWatcher(config.extensionsDir, config.extensionsConfig);
  } catch {}
}

initPipeline().then(() => {
  server.listen(config.port, config.bind, () => {
    const addr = server.address();
    process.stdout.write(`proxy listening on ${addr.address}:${addr.port}\n`);
  });
});

export { server };
