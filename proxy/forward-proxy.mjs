// Forward-proxy (HTTP CONNECT + selective MITM) transport.
//
// Why: cache-fix's normal transport points Claude Code at the proxy via
// ANTHROPIC_BASE_URL. On Claude Code >= 2.1.196 a non-Anthropic base URL
// disables Remote Control (RC). This transport instead sits in front of the
// REAL api.anthropic.com as an HTTPS_PROXY: CC's base URL stays
// api.anthropic.com, so RC keeps working, while we still see and transform
// /v1/messages.
//
// It only MITMs the upstream host (api.anthropic.com), where the cacheable
// /v1/messages traffic lives, and blind-tunnels every other CONNECT
// (mcp-proxy.anthropic.com, telemetry, npm, ...) untouched, so RC/MCP and
// unrelated traffic are unaffected. The decrypted upstream request is fed into
// the SAME http request handler used by reverse-proxy mode (server.emit
// ('connection', tlsSocket)), so the entire extension pipeline is reused as-is.
//
// Client wiring (ANTHROPIC_BASE_URL stays UNSET):
//   HTTPS_PROXY=http://127.0.0.1:<port>  NODE_EXTRA_CA_CERTS=<caPath>  claude
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import config from "./config.mjs";
import { getAgent } from "./upstream.mjs";
import { discoverBucket } from "./downloads-bucket.mjs";

// The CA is global (one cert CC trusts), not per-config-dir, so it lives outside
// CLAUDE_CONFIG_DIR. Overridable for tests / non-default homes.
const CA_DIR = process.env.CACHE_FIX_CA_DIR || join(homedir(), ".claude", "cache-fix-ca");

function upstreamHost() {
  try { return new URL(config.upstream).hostname; } catch { return "api.anthropic.com"; }
}

// The extra host we MITM (besides the upstream) to accelerate large downloads.
const DOWNLOADS_HOST = "downloads.claude.ai";

// Whether download-rewrite is BOTH enabled (opt-in) AND has a usable bucket
// discovered from the client binary. Only then do we MITM downloads.claude.ai;
// with no bucket we leave it blind-tunneled, so a discovery miss degrades to
// the pre-existing (slower but working) path instead of a broken rewrite.
function downloadRewriteActive() {
  return config.downloadRewrite && discoverBucket() !== "";
}

// All DNS names the leaf cert must cover so the client accepts our TLS
// termination. Always the upstream host; plus downloads.claude.ai when the
// download-rewrite acceleration is active.
function mitmHosts() {
  const hosts = [upstreamHost()];
  if (downloadRewriteActive()) hosts.push(DOWNLOADS_HOST);
  return hosts;
}

/**
 * Ensure a CA + leaf cert for the upstream host exist (generated once via
 * openssl). Idempotent. Returns { caPath, key, cert } for TLS termination and
 * the CA path the client must trust via NODE_EXTRA_CA_CERTS.
 */
export function ensureCA() {
  const caPem = join(CA_DIR, "ca.pem");
  const caKey = join(CA_DIR, "ca.key");
  const leafPem = join(CA_DIR, "leaf.pem");
  const leafKey = join(CA_DIR, "leaf.key");
  const host = upstreamHost();
  const hosts = mitmHosts();
  // The leaf must cover every host in `hosts`. A leaf minted by an older build
  // (or with download-rewrite previously off) may carry only a subset of SANs;
  // treat that as not-ready so it gets regenerated instead of serving a cert
  // the client rejects for downloads.claude.ai (UNKNOWN/ALTNAME mismatch).
  // Parsed in-process with node:crypto, NOT `openssl x509 -ext`: `-ext` is an
  // OpenSSL 1.1.1+ flag that LibreSSL (which is what /usr/bin/openssl is on
  // macOS) rejects with "unknown option". Shelling out would make this return
  // false forever on any host whose PATH resolves to LibreSSL, so `ready()`
  // could never be true: every call would re-mint the leaf, and a concurrent
  // caller would spin the .gen.lock wait to its full deadline and then generate
  // anyway — the exact race the lock exists to prevent. A throw here means the
  // leaf is genuinely unparseable, for which re-minting IS the right answer.
  const leafCoversAllHosts = () => {
    try {
      const san = new X509Certificate(readFileSync(leafPem)).subjectAltName || "";
      const names = san.split(",").map((s) => s.trim());
      return hosts.every((h) => names.includes(`DNS:${h}`));
    } catch { return false; }
  };
  const ready = () => existsSync(caPem) && existsSync(leafPem) && existsSync(leafKey) && leafCoversAllHosts();
  if (ready()) {
    return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
  }
  mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });

  // Serialize generation across concurrent proxies (two proxies started against
  // separate config dirs share this global CA dir). An atomic mkdir lock elects one generator;
  // the others wait for it to finish rather than racing openssl and clobbering
  // each other's ca.pem/leaf.pem (which produced a leaf that didn't chain to
  // the on-disk CA -> client UNKNOWN_ISSUER). All artifacts are written to
  // temp paths and atomically renamed into place so a reader never sees a
  // half-written file.
  const lock = join(CA_DIR, ".gen.lock");
  let haveLock = false;
  try { mkdirSync(lock); haveLock = true; } catch {}
  if (!haveLock) {
    // Someone else is generating. Wait (bounded) for the artifacts to appear.
    // Synchronous sleep via Atomics.wait (no busy-spin, no external `sleep`).
    const sleep100 = () => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch {} };
    const deadline = Date.now() + 30000;
    while (!ready() && Date.now() < deadline) sleep100();
    if (ready()) return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
    // Timed out (stale lock / dead generator): fall through and generate anyway.
    try { mkdirSync(lock); } catch {}
  }
  try {
    if (ready()) return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
    const run = (args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
    const tmp = (n) => join(CA_DIR, `.tmp.${n}`);

    // Reuse an existing root CA; only mint a new one on first run. Regenerating
    // the root here is a bug: the client trusts the CA via a NODE_EXTRA_CA_CERTS
    // bundle captured at its OWN startup, so rotating ca.pem/ca.key (e.g. when a
    // new SAN forces a leaf re-issue) orphans every running session's trust and
    // breaks TLS with "certificate verify failed". The leaf is always re-minted
    // (SANs may have changed); the root is reused so the trust bundle stays
    // valid across restarts. `CACHE_FIX_CA_FORCE_ROTATE=1` opts into a full
    // rotation (e.g. suspected key compromise) at the cost of that break.
    const haveCA = existsSync(caPem) && existsSync(caKey) &&
                   process.env.CACHE_FIX_CA_FORCE_ROTATE !== "1";
    const caPemSrc = haveCA ? caPem : tmp("ca.pem");
    const caKeySrc = haveCA ? caKey : tmp("ca.key");
    if (!haveCA) {
      run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tmp("ca.key"), "-out", tmp("ca.pem"),
           "-days", "3650", "-subj", "/CN=cache-fix forward-proxy CA"]);
    }
    run(["genrsa", "-out", tmp("leaf.key"), "2048"]);
    const csr = tmp("leaf.csr");
    run(["req", "-new", "-key", tmp("leaf.key"), "-out", csr, "-subj", `/CN=${host}`]);
    const ext = tmp("leaf.ext");
    const sanLine = hosts.map((h) => `DNS:${h}`).join(",");
    writeFileSync(ext, `subjectAltName=${sanLine}\nextendedKeyUsage=serverAuth\n`);
    // -set_serial (random positive 128-bit) instead of -CAcreateserial: the
    // latter derives the serial filename from the -CA path, and macOS LibreSSL
    // truncates an absolute path at the first '.' (…/j.lee8/…/ca.pem → /Users/j
    // .srl) then EACCES on write, so leaf signing throws and forward-proxy silently
    // falls back to reverse mode. A random serial needs no file and is unique per
    // mint. High bit cleared to keep the ASN.1 INTEGER positive.
    const serial = "0x00" + randomBytes(16).toString("hex");
    run(["x509", "-req", "-in", csr, "-CA", caPemSrc, "-CAkey", caKeySrc, "-set_serial", serial,
         "-out", tmp("leaf.pem"), "-days", "3650", "-extfile", ext]);
    // Atomic publish. The existence guard keys on ca.pem+leaf.pem+leaf.key, so
    // publish those last. When reusing the CA, ca.pem/ca.key already exist and
    // MUST NOT be touched (that is the whole point of the reuse) — only the leaf
    // is renamed into place.
    if (!haveCA) {
      renameSync(tmp("ca.key"), caKey);
      renameSync(tmp("ca.pem"), caPem);
    }
    renameSync(tmp("leaf.key"), leafKey);
    renameSync(tmp("leaf.pem"), leafPem);
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
  return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
}

// Parse an http(s)://host:port proxy URL into { host, port }.
function parseProxy(url) {
  if (!url) return null;
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || 80 }; }
  catch { return null; }
}

// Blind-tunnel a CONNECT to `target` (host:port) untouched. Routes through the
// outbound proxy (config.httpsProxy, e.g. a corporate proxy) when set, else
// dials the target directly. No TLS termination; bytes pass through opaque.
function blindTunnel(target, clientSocket, head) {
  const [host, portStr] = target.split(":");
  const port = Number(portStr) || 443;
  const via = parseProxy(config.httpsProxy);
  const onUpstream = (upstream) => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    const bail = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on("error", bail);
    clientSocket.on("error", bail);
  };
  if (via) {
    // CONNECT target through the outbound proxy.
    const r = http.request({ host: via.host, port: via.port, method: "CONNECT", path: target,
                             headers: { host: target } });
    r.on("connect", (res, socket) => {
      // Node fires 'connect' even when the outbound proxy DENIES the tunnel
      // (403/407/502). Relaying our own "200 Connection Established" then would
      // hand the client a dead pipe. Propagate the real failure status and tear
      // down instead, so a corp-proxy denial surfaces as a clean error.
      if (res.statusCode !== 200) {
        try {
          clientSocket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage || "Proxy Error"}\r\n\r\n`);
        } catch {}
        socket.destroy();
        clientSocket.destroy();
        return;
      }
      onUpstream(socket);
    });
    r.on("error", () => clientSocket.destroy());
    r.end();
  } else {
    const socket = net.connect(port, host, () => onUpstream(socket));
    socket.on("error", () => clientSocket.destroy());
  }
}

// Open a TLS connection to the upstream host, directly or through the corp
// CONNECT proxy (config.httpsProxy), and invoke cb(tlsSocket). Used to relay a
// MITM'd WebSocket upgrade to the real upstream.
function connectUpstreamTLS(cb, onErr) {
  let upHost = "api.anthropic.com", upPort = 443;
  try { const u = new URL(config.upstream); upHost = u.hostname; upPort = Number(u.port) || 443; } catch {}
  const finish = (rawSocket) => {
    const tlsUp = tls.connect({ socket: rawSocket, servername: upHost }, () => cb(tlsUp));
    tlsUp.on("error", onErr);
  };
  const via = parseProxy(config.httpsProxy);
  if (via) {
    const r = http.request({ host: via.host, port: via.port, method: "CONNECT",
                             path: `${upHost}:${upPort}`, headers: { host: `${upHost}:${upPort}` } });
    r.on("connect", (res, rawSocket) => {
      if (res.statusCode !== 200) { rawSocket.destroy(); onErr(new Error(`upstream CONNECT ${res.statusCode}`)); return; }
      finish(rawSocket);
    });
    r.on("error", onErr);
    r.end();
  } else {
    const rawSocket = net.connect(upPort, upHost, () => finish(rawSocket));
    rawSocket.on("error", onErr);
  }
}

// Relay a decrypted client WebSocket/Upgrade to the upstream host verbatim.
function relayUpstreamUpgrade(req, clientSocket, head) {
  const bail = (up) => { try { up && up.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
  connectUpstreamTLS((up) => {
    // Re-serialize the original request line + headers onto the upstream TLS
    // socket, then splice the two streams. Headers are relayed as-received
    // (Upgrade/Connection/Sec-WebSocket-* preserved) so the handshake completes
    // end-to-end and only the bytes flow through us.
    let head_ = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) head_ += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    head_ += "\r\n";
    up.write(head_);
    if (head && head.length) up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
    up.on("error", () => bail(up));
    clientSocket.on("error", () => bail(up));
  }, () => bail(null));
}

// Egress agent for the storage re-issue: reuse the corp CONNECT proxy
// (config.httpsProxy, e.g. privoxy at :8118) exactly like upstream.mjs, so the
// storage.googleapis.com request follows the same routing that measured fast.
// Cached (keepAlive) so range-request resumes reuse the connection.
// Reuse upstream.mjs's agent builder rather than rolling our own: it is the one
// place that honors NO_PROXY (shouldBypassProxy), CACHE_FIX_PROXY_CA_FILE, and
// rejectUnauthorized together. A local reimplementation silently ignored all
// three — forcing a NO_PROXY'd host through the corp proxy, and failing TLS for
// anyone who needs a custom CA, which is precisely the SSL-inspecting setup this
// feature targets. Agents are cached inside getAgent(), so this stays keep-alive.
function storageAgent() {
  return getAgent(true, "storage.googleapis.com");
}

// Handle one decrypted request that arrived on the MITM'd downloads.claude.ai
// connection: re-issue it to storage.googleapis.com/<bucket><path> and stream
// the response back verbatim. Preserves method and Range (updater resumes with
// byte ranges), rewrites Host, drops hop-by-hop + auth headers (public bucket).
// Serve the request from the ORIGIN (downloads.claude.ai) instead of the storage
// rewrite. Used when the rewrite can't deliver: the origin is reachable, merely
// throttled, so this is slow-but-correct rather than a hard failure. Headers pass
// through as the client sent them (same-origin request — no third-party leak
// concern that the storage path's allowlist guards against); only hop-by-hop and
// the proxy's own framing are dropped.
function fallbackToOrigin(clientReq, clientRes, why) {
  if (clientRes.headersSent || clientRes.writableEnded) return;
  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    const lk = k.toLowerCase();
    if (lk === "connection" || lk === "keep-alive" || lk === "proxy-connection" ||
        lk === "transfer-encoding" || lk === "te" || lk === "upgrade") continue;
    headers[k] = v;
  }
  headers["host"] = DOWNLOADS_HOST;
  const req = https.request({
    hostname: DOWNLOADS_HOST, port: 443,
    path: clientReq.url, method: clientReq.method, headers,
    agent: getAgent(true, DOWNLOADS_HOST), timeout: config.timeout,
  }, (res) => {
    const out = {};
    for (const [k, v] of Object.entries(res.headers)) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding") continue;
      out[k] = v;
    }
    try { clientRes.writeHead(res.statusCode || 502, out); } catch { return; }
    res.pipe(clientRes);
    res.on("error", () => { try { clientRes.destroy(); } catch {} });
  });
  req.on("error", (err) => {
    try {
      if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "text/plain" });
      clientRes.end(`cache-fix downloads fallback failed (${why}): ${err.message}`);
    } catch {}
  });
  req.on("timeout", () => req.destroy(new Error("origin timeout")));
  clientRes.on("close", () => { if (!clientRes.writableFinished) req.destroy(); });
  req.end();
}

function handleDownloadsRequest(clientReq, clientRes) {
  const bucket = discoverBucket();
  if (!bucket) {
    // No bucket (discovery regressed after the MITM was set up). Fail soft with
    // a 502 rather than serving a wrong path; the updater retries and the SAN
    // will drop on the next restart. Should not happen: the CONNECT branch only
    // MITMs downloads when downloadRewriteActive() already saw a bucket.
    try { clientRes.writeHead(502, { "content-type": "text/plain" }); clientRes.end("cache-fix: no download bucket"); } catch {}
    return;
  }
  const path = "/" + bucket + (clientReq.url.startsWith("/") ? clientReq.url : "/" + clientReq.url);

  // ALLOWLIST, not a denylist: this re-issues the request to a THIRD PARTY
  // (storage.googleapis.com), so anything not explicitly needed must not travel.
  // A denylist leaks whatever it forgets — `proxy-authorization` (corp-proxy
  // credentials!), `x-api-key`, `anthropic-*` are all headers the client may set
  // for its own hosts. A public-bucket GET needs almost nothing, so enumerate it:
  // range/if-range carry the updater's resume, the rest are content negotiation.
  const ALLOWED = new Set(["range", "if-range", "if-none-match", "if-modified-since",
                           "accept", "user-agent"]);
  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    if (ALLOWED.has(k.toLowerCase())) headers[k] = v;
  }
  headers["host"] = "storage.googleapis.com";
  // identity: nothing here parses the body, but the bucket serves the binary
  // pre-compressed; asking for identity keeps Content-Length/Range semantics
  // exact for the updater's resume math.
  headers["accept-encoding"] = "identity";

  const opts = {
    hostname: "storage.googleapis.com",
    port: 443,
    path,
    method: clientReq.method,
    headers,
    agent: storageAgent(),
    timeout: config.timeout,
  };

  const upReq = https.request(opts, (upRes) => {
    // The rewrite is an OPTIMIZATION; the origin is the source of truth. If the
    // bucket answers with an error — rotated/renamed bucket (404), blocked by the
    // corp proxy (403), outage (5xx) — serving that through would turn a working
    // (if slow) download into a broken one. Fall back to the origin instead: this
    // is the "degrade to the pre-existing path" this feature keeps promising.
    // 2xx/3xx pass through; a Range request's 206 is a success, not an error.
    const code = upRes.statusCode || 0;
    if (code >= 400) {
      upRes.resume();                       // drain, don't leak the socket
      fallbackToOrigin(clientReq, clientRes, `storage ${code}`);
      return;
    }
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding") continue;
      outHeaders[k] = v;
    }
    clientRes.writeHead(code || 502, outHeaders);
    upRes.pipe(clientRes);
    upRes.on("error", () => { try { clientRes.destroy(); } catch {} });
  });
  upReq.on("error", (err) => {
    // Network-level failure reaching storage: same reasoning as an HTTP error.
    fallbackToOrigin(clientReq, clientRes, "storage error: " + err.message);
  });
  upReq.on("timeout", () => upReq.destroy(new Error("storage timeout")));
  clientReq.on("error", () => upReq.destroy());
  // A client that hangs up mid-body surfaces on the RESPONSE, not the request.
  // Without this the upstream body keeps streaming to a dead socket: an aborted
  // updater that retries would stack concurrent ~240MB fetches from storage.
  clientRes.on("close", () => { if (!clientRes.writableFinished) upReq.destroy(); });
  // Downloads are GET/HEAD (no body); end immediately.
  clientReq.resume();
  upReq.end();
}

// A dedicated http.Server whose sole job is to serve the decrypted
// downloads.claude.ai stream via the storage rewrite. Built lazily so the
// upstream MITM path is untouched when download-rewrite is off.
let _downloadsServer;
function downloadsServer() {
  if (!_downloadsServer) {
    _downloadsServer = http.createServer(handleDownloadsRequest);
    _downloadsServer.on("clientError", (_e, sock) => { try { sock.destroy(); } catch {} });
  }
  return _downloadsServer;
}

/**
 * Attach the forward-proxy CONNECT handler to an existing http.Server (the one
 * returned by createProxyServer()). MITMs the upstream host and feeds the
 * decrypted stream back into `server`'s own request handler; blind-tunnels the
 * rest. Returns the CA path (for NODE_EXTRA_CA_CERTS).
 */
export function attachForwardProxy(server) {
  const { caPath, key, cert } = ensureCA();
  const secureContext = tls.createSecureContext({ key, cert });
  const host = upstreamHost();
  // Freeze the download-rewrite decision here, next to the leaf we just minted:
  // ensureCA() baked mitmHosts() into the SAN set, so this is the same answer
  // the cert was built from. The CONNECT handler reads only this, never
  // downloadRewriteActive() again — see the comment at the downloads branch.
  const downloadsMitm = downloadRewriteActive();

  // WebSocket / HTTP Upgrade on the MITM'd host. Our http.Server has no default
  // upgrade handling, so without this Node would DESTROY the socket, breaking
  // any WS to the upstream host (e.g. /voice's wss://api.anthropic.com/api/ws/
  // speech_to_text/voice_stream). Relay the upgrade to upstream over a fresh TLS
  // connection (through the corp proxy if configured) and pipe raw bytes both
  // ways. `req` is the decrypted request on the MITM'd tlsSocket; `socket` is
  // that tlsSocket; `head` is any buffered bytes after the headers.
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    try {
      relayUpstreamUpgrade(req, socket, head);
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  server.on("connect", (req, clientSocket, head) => {
    // Wrap the whole handler: a throw in a 'connect' listener escapes to
    // uncaughtException and takes the process down. Self-heal means a single
    // bad CONNECT tears down that one socket, never the proxy. Always attach
    // the client-socket error handler first so a mid-handshake reset can't
    // crash us either.
    clientSocket.on("error", () => {});
    try {
      const target = req.url; // "host:port"
      const reqHost = target.split(":")[0];

      // downloads.claude.ai: MITM and serve via the storage-rewrite server so
      // the big update/plugin binaries take the un-throttled GCS hostname. The
      // decrypted stream goes to downloadsServer(), NOT the messages pipeline.
      //
      // Keyed on `downloadsMitm`, frozen at attach time alongside the leaf's SAN
      // set — NOT re-evaluated per request. The two must agree: if discovery
      // missed at startup the leaf carries no downloads SAN, and MITMing anyway
      // (because discovery later succeeded, e.g. an auto-update repointed the
      // launcher symlink) would serve a cert the client rejects with
      // ERR_TLS_CERT_ALTNAME_INVALID — a hard failure instead of the intended
      // degrade-to-blind-tunnel. Frozen together, cert and routing cannot drift.
      if (reqHost === DOWNLOADS_HOST && downloadsMitm) {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext });
        tlsSocket.on("error", () => tlsSocket.destroy());
        downloadsServer().emit("connection", tlsSocket);
        return;
      }

      if (reqHost !== host) return blindTunnel(target, clientSocket, head);

      // MITM the upstream host: terminate TLS with our leaf, then hand the
      // decrypted socket to the server's HTTP handler as if it were a plaintext
      // connection. The pipeline + upstream forwarding run exactly as in
      // reverse-proxy mode; upstream egress uses config.upstream (+ config
      // .httpsProxy) via forwardRequest().
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext });
      tlsSocket.on("error", () => tlsSocket.destroy());
      server.emit("connection", tlsSocket);
    } catch {
      try { clientSocket.destroy(); } catch {}
    }
  });

  return caPath;
}
