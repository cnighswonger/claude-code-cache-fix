import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Most fields are read once at module init (preserving prior behavior).
// Corp-proxy/CA fields and `upstream` are getters so they reflect live env —
// important for test isolation (see test/proxy-upstream-corp-proxy.test.mjs
// and test/proxy-server-bootstrap.test.mjs) and for callers that legitimately
// want to flip env at runtime.
const config = {
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
};

export default config;
