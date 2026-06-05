import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let registry = [];
let failedExtensions = []; // [{ file, error, lastAttempt }]

export async function loadExtensions(dir, configPath) {
  let config = {};
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch {}

  const files = await readdir(dir);
  const mjsFiles = files.filter((f) => f.endsWith(".mjs")).sort();

  const extensions = [];
  const newlyFailed = [];
  for (const file of mjsFiles) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href + "?t=" + Date.now());
      const ext = mod.default;
      if (!ext || !ext.name) continue;

      const cfg = config[ext.name];
      const enabled = cfg?.enabled ?? ext.enabled ?? true;
      const order = cfg?.order ?? ext.order ?? 1000;

      if (enabled) {
        extensions.push({ ...ext, order, _file: file });
      }
    } catch (err) {
      // Load-bearing observability: this branch is the only signal that the
      // proxy is running with a degraded extension graph. See #196: a Node
      // ESM cache stale-import race silently broke thinking-block-sanitize
      // v2 for 17 hours post-merge before AITL grepped the journal. The
      // [CRITICAL] prefix is harder to miss than the prior [pipeline] one,
      // and the explicit "restart proxy to recover" hint tells the operator
      // what to do — the underlying Node ESM cache problem can't be fixed
      // in-process (you can't evict cached transitive imports), so a full
      // process restart is the only path to recover the extension graph.
      const msg = `[CRITICAL] extension load failed: ${file}: ${err.message} — restart cache-fix-proxy.service to recover (in-process reload cannot fix stale ESM cache)\n`;
      process.stderr.write(msg);
      newlyFailed.push({ file, error: String(err.message || err), lastAttempt: new Date().toISOString() });
    }
  }

  extensions.sort((a, b) => a.order - b.order);
  registry = extensions;
  failedExtensions = newlyFailed;
  return extensions;
}

export function getRegistry() {
  return registry;
}

export function snapshotRegistry() {
  return [...registry];
}

// Exposed for /health and any operator-facing tool that wants to surface
// extension-load failures. Returns a fresh array per call so callers can't
// mutate internal state.
export function getFailedExtensions() {
  return failedExtensions.map((f) => ({ ...f }));
}

// Route scoping: extensions default to messages-only so that adding a new
// route (e.g. /api/claude_cli/bootstrap) doesn't drag every existing
// message-mutating extension onto it — most throw on a null body because
// they were never designed for non-messages traffic. Cross-cutting
// extensions (cache-telemetry, usage-log, …) opt into additional routes
// by declaring an explicit `routes` array on their default export.
//
// If ctx.meta.route is undefined we skip filtering entirely — preserves
// back-compat for callers that don't tag routes (legacy tests, embedders).
function appliesToRoute(ext, route) {
  if (!route) return true;
  const routes = ext.routes || ["messages"];
  return routes.includes(route);
}

export async function runOnRequest(ctx, snapshot) {
  const exts = snapshot || registry;
  const route = ctx.meta?.route;
  for (const ext of exts) {
    if (!ext.onRequest) continue;
    if (!appliesToRoute(ext, route)) continue;
    try {
      const result = await ext.onRequest(ctx);
      if (result && result.skip) return result;
    } catch (err) {
      process.stderr.write(`[pipeline] ${ext.name}.onRequest error: ${err.message}\n`);
    }
  }
  return undefined;
}

export async function runOnResponseStart(ctx, snapshot) {
  const exts = snapshot || registry;
  const route = ctx.meta?.route;
  for (const ext of exts) {
    if (!ext.onResponseStart) continue;
    if (!appliesToRoute(ext, route)) continue;
    try {
      await ext.onResponseStart(ctx);
    } catch (err) {
      process.stderr.write(`[pipeline] ${ext.name}.onResponseStart error: ${err.message}\n`);
    }
  }
}

export async function runOnStreamEvent(ctx, snapshot) {
  const exts = snapshot || registry;
  const route = ctx.meta?.route;
  for (const ext of exts) {
    if (!ext.onStreamEvent) continue;
    if (!appliesToRoute(ext, route)) continue;
    try {
      await ext.onStreamEvent(ctx);
    } catch (err) {
      process.stderr.write(`[pipeline] ${ext.name}.onStreamEvent error: ${err.message}\n`);
    }
  }
}

export async function runOnResponse(ctx, snapshot) {
  const exts = snapshot || registry;
  const route = ctx.meta?.route;
  for (const ext of exts) {
    if (!ext.onResponse) continue;
    if (!appliesToRoute(ext, route)) continue;
    try {
      await ext.onResponse(ctx);
    } catch (err) {
      process.stderr.write(`[pipeline] ${ext.name}.onResponse error: ${err.message}\n`);
    }
  }
}
