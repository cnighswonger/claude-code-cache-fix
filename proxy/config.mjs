import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Package version, read once at init. Surfaced on /health so clients (e.g. a
// status line) can show which cache-fix build is actually serving them.
let _version = "unknown";
try { _version = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version || "unknown"; } catch {}

// Most fields are read once at module init (preserving prior behavior).
// Corp-proxy/CA fields and `upstream` are getters so they reflect live env —
// important for test isolation (see test/proxy-upstream-corp-proxy.test.mjs
// and test/proxy-server-bootstrap.test.mjs) and for callers that legitimately
// want to flip env at runtime.
const config = {
  version: _version,
  port: envInt("CACHE_FIX_PROXY_PORT", 9801),
  bind: process.env.CACHE_FIX_PROXY_BIND || "127.0.0.1",
  get upstream() { return process.env.CACHE_FIX_PROXY_UPSTREAM || "https://api.anthropic.com"; },
  timeout: envInt("CACHE_FIX_PROXY_TIMEOUT", 600_000),
  extensionsDir: process.env.CACHE_FIX_EXTENSIONS_DIR || join(__dirname, "extensions"),
  extensionsConfig: process.env.CACHE_FIX_EXTENSIONS_CONFIG || join(__dirname, "extensions.json"),
  debug: process.env.CACHE_FIX_DEBUG === "1",
  get httpsProxy() { return process.env.HTTPS_PROXY || process.env.https_proxy || ""; },
  get httpProxy()  { return process.env.HTTP_PROXY  || process.env.http_proxy  || ""; },
  get noProxy()    { return process.env.NO_PROXY    || process.env.no_proxy    || ""; },
  get caFile()     { return process.env.CACHE_FIX_PROXY_CA_FILE || ""; },
  get rejectUnauthorized() {
    const raw = process.env.CACHE_FIX_PROXY_REJECT_UNAUTHORIZED;
    if (raw === undefined || raw === "") return true;
    if (raw === "1" || raw.toLowerCase() === "true")  return true;
    if (raw === "0" || raw.toLowerCase() === "false") return false;
    return true;
  },

  // Proxy-owned OAuth refresher. Gated default-OFF; the whole subsystem is
  // inert until CACHE_FIX_OAUTH_REFRESH=on is set and the proxy is restarted.
  // Contract: docs/directives/proxy-owned-oauth-refresh.md.
  get oauthRefreshEnabled() { return process.env.CACHE_FIX_OAUTH_REFRESH === "on"; },
  // Forward-proxy (HTTP CONNECT + selective MITM) transport. Default OFF.
  // When "on", the proxy also handles CONNECT and MITMs only the upstream host,
  // so clients point HTTPS_PROXY (not ANTHROPIC_BASE_URL) at it and keep Remote
  // Control. See proxy/forward-proxy.mjs.
  get forwardProxy() { return process.env.CACHE_FIX_FORWARD_PROXY === "on"; },
  get oauthRefreshMarginMs() { return envInt("CACHE_FIX_OAUTH_REFRESH_MARGIN_MS", 2 * 60 * 60 * 1000); }, // 2h
  get oauthTickMs() { return envInt("CACHE_FIX_OAUTH_TICK_MS", 5 * 60 * 1000); }, // 5min
  // §2a hard deadline — strictly below the client's 10s stale-break.
  get oauthPostTimeoutMs() { return envInt("CACHE_FIX_OAUTH_POST_TIMEOUT_MS", 8000); },
};

export default config;
