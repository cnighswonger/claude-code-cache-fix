import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let registry = [];

export async function loadExtensions(dir, configPath) {
  let config = {};
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch {}

  const files = await readdir(dir);
  const mjsFiles = files.filter((f) => f.endsWith(".mjs")).sort();

  const extensions = [];
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
      process.stderr.write(`[pipeline] failed to load ${file}: ${err.message}\n`);
    }
  }

  extensions.sort((a, b) => a.order - b.order);
  registry = extensions;
  return extensions;
}

export function getRegistry() {
  return registry;
}

export function snapshotRegistry() {
  return [...registry];
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
