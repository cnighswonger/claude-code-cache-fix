import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { claudeHome } from "./claude-home.mjs";

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
  // CACHE_FIX_UPSTREAM_PROXY wins over HTTPS_PROXY/HTTP_PROXY, which is the
  // point: those two are the SESSION's wiring and they reach us by inheritance,
  // so our upstream ends up being whatever shell happened to launch us.
  // Measured twice on one box in a day — `run-service` started from a wired
  // shell adopted the hop IN FRONT of us and every request looped. The right
  // answer was in the same environment (CACHE_FIX_FALLBACK_PROXIES=…:8118) and
  // lost to an inherited HTTPS_PROXY.
  //
  // A dedicated name cannot be inherited by accident: nothing but this proxy's
  // own supervisor sets it. The old variables stay as the fallback so a direct
  // `cache-fix-proxy server` in a shell still works the way it always has.
  get httpsProxy() {
    return process.env.CACHE_FIX_UPSTREAM_PROXY
        || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  },
  get httpProxy()  {
    return process.env.CACHE_FIX_UPSTREAM_PROXY
        || process.env.HTTP_PROXY  || process.env.http_proxy  || "";
  },
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
  // Directory holding the forward-proxy's generated CA + leaf certs. Defaults
  // under the Claude config root (claudeHome() honors CLAUDE_CONFIG_DIR), like
  // the rest of the proxy's on-disk state, so relocating the config dir moves
  // the CA with it. Override with CACHE_FIX_CA_DIR to pin a fixed location.
  get caDir() { return process.env.CACHE_FIX_CA_DIR || join(claudeHome(), "cache-fix-ca"); },
  // How long a starter waits on a peer's CA-generation lock (.gen.lock) before
  // deciding it is wedged/stale. Generation itself takes well under a second;
  // the generous default absorbs a slow first run on a loaded machine. Mostly
  // a test seam (tests shrink it so lock-contention paths run fast).
  get caLockWaitMs() { return Number(process.env.CACHE_FIX_CA_LOCK_WAIT_MS) || 30000; },
  // Forward-proxy download acceleration (opt-in, default OFF). When "on" AND
  // forward-proxy is active, MITM downloads.claude.ai (the Claude Code update /
  // plugin CDN) and re-issue each request to storage.googleapis.com/<bucket> —
  // the SAME GCS object served by a hostname a corp SSL-inspection proxy (e.g.
  // Netskope) does not bandwidth-throttle. Measured through such a proxy:
  // downloads.claude.ai ~0.2-1.7MB/s vs storage.googleapis.com ~16MB/s, so the
  // ~240MB updater binary otherwise times out ("Auto-update failed").
  //
  // OFF by default because on an un-inspected network both hostnames hit the
  // same GCS backend at the same speed, so the rewrite buys nothing. It is a
  // corp-proxy workaround, not a general speedup — enable it only where a proxy
  // throttles the CDN hostname. The bucket is NEVER hard-coded: it is discovered
  // at runtime from the client's own claude binary (see downloads-bucket.mjs),
  // so a bucket rotation is followed automatically with no code or config edit.
  get downloadRewrite() { return process.env.CACHE_FIX_DOWNLOAD_REWRITE === "on"; },
  // Optional explicit override for the discovered bucket (escape hatch only —
  // normal operation needs no bucket config at all). Empty = auto-discover.
  get downloadBucketOverride() { return process.env.CACHE_FIX_DOWNLOAD_BUCKET || ""; },
  // Optional path to the claude binary to scan for the bucket. Empty = resolve
  // the standard native-install launcher (~/.local/bin/claude) at runtime.
  get downloadBinaryPath() { return process.env.CACHE_FIX_DOWNLOAD_BINARY || ""; },
  get oauthRefreshMarginMs() { return envInt("CACHE_FIX_OAUTH_REFRESH_MARGIN_MS", 2 * 60 * 60 * 1000); }, // 2h
  get oauthTickMs() { return envInt("CACHE_FIX_OAUTH_TICK_MS", 5 * 60 * 1000); }, // 5min
  // §2a hard deadline — strictly below the client's 10s stale-break.
  get oauthPostTimeoutMs() { return envInt("CACHE_FIX_OAUTH_POST_TIMEOUT_MS", 8000); },
};

export default config;
