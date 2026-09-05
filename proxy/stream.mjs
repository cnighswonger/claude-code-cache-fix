import { runOnStreamEvent } from "./pipeline.mjs";
import { StringDecoder } from "node:string_decoder";

export function createTelemetryRecord() {
  return {
    model: null,
    requestedModel: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    stopReason: null,
  };
}

function extractTelemetry(event, telemetry) {
  if (event.type === "message_start" && event.message) {
    const msg = event.message;
    telemetry.model = msg.model || null;
    if (msg.usage) {
      telemetry.inputTokens = msg.usage.input_tokens || 0;
      telemetry.cacheRead = msg.usage.cache_read_input_tokens || 0;
      telemetry.cacheCreation = msg.usage.cache_creation_input_tokens || 0;
    }
  } else if (event.type === "message_delta") {
    if (event.usage) {
      telemetry.outputTokens = event.usage.output_tokens || 0;
    }
    telemetry.stopReason = event.delta?.stop_reason || null;
  }
}

async function processLine(line, clientRes, telemetry, extSnapshot, meta, responseHeaders) {
  if (!line.startsWith("data: ")) {
    const ok = clientRes.write(line + "\n");
    if (!ok) await new Promise((r) => clientRes.once("drain", r));
    return;
  }

  const jsonStr = line.slice(6);
  if (jsonStr === "[DONE]") {
    const ok = clientRes.write(line + "\n");
    if (!ok) await new Promise((r) => clientRes.once("drain", r));
    return;
  }

  let event;
  try {
    event = JSON.parse(jsonStr);
  } catch {
    const ok = clientRes.write(line + "\n");
    if (!ok) await new Promise((r) => clientRes.once("drain", r));
    return;
  }

  extractTelemetry(event, telemetry);

  if (!extSnapshot || extSnapshot.length === 0) {
    const ok = clientRes.write(line + "\n");
    if (!ok) await new Promise((r) => clientRes.once("drain", r));
    return;
  }

  const ctx = { event, meta, telemetry, responseHeaders: responseHeaders || null, drop: false };
  const originalRef = event;
  await runOnStreamEvent(ctx, extSnapshot);

  if (ctx.drop) return;

  let output;
  if (ctx.event === originalRef) {
    output = line + "\n";
  } else {
    try {
      output = "data: " + JSON.stringify(ctx.event) + "\n";
    } catch {
      output = line + "\n";
    }
  }

  const ok = clientRes.write(output);
  if (!ok) await new Promise((r) => clientRes.once("drain", r));
}

export async function streamResponse(upstreamRes, clientRes, telemetry, extSnapshot, meta, responseHeaders) {
  let buffer = "";
  // UTF-8 chars can straddle chunk boundaries; decode statefully so a split
  // multi-byte char is not turned into U+FFFD replacement chars.
  const decoder = new StringDecoder("utf8");

  for await (const chunk of upstreamRes) {
    const text = decoder.write(chunk);
    buffer += text;

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line === "") {
        const ok = clientRes.write("\n");
        if (!ok) await new Promise((r) => clientRes.once("drain", r));
      } else {
        await processLine(line, clientRes, telemetry, extSnapshot, meta, responseHeaders);
      }
    }
  }

  buffer += decoder.end();
  if (buffer.length > 0) {
    await processLine(buffer, clientRes, telemetry, extSnapshot, meta, responseHeaders);
  }

  clientRes.end();
  return telemetry;
}
