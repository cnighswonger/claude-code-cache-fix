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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate, createPublicKey } from "node:crypto";
import config from "./config.mjs";
import { getAgent, resolveHop, requireHop } from "./upstream.mjs";
import { discoverBucket } from "./downloads-bucket.mjs";

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
  // Read once per call from config (live, not frozen at import). The CA dir
  // defaults under the Claude config root and follows CLAUDE_CONFIG_DIR, with
  // CACHE_FIX_CA_DIR as an explicit override; see config.caDir. Note that two
  // proxies started against separate config dirs CAN still share one CA dir
  // (via the override), which is why generation below is lock-serialized.
  const caDir = config.caDir;
  const caPem = join(caDir, "ca.pem");
  const caKey = join(caDir, "ca.key");
  const leafPem = join(caDir, "leaf.pem");
  const leafKey = join(caDir, "leaf.key");
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
  // Existence + SAN is not enough: leaf.key and leaf.pem are published as two
  // separate renames, so a reader can catch a window where a new key sits next
  // to an old (still SAN-valid) cert, or vice versa — a mismatched pair that
  // fails tls.createSecureContext() at handshake time. Prove the on-disk key
  // matches the on-disk cert (public keys equal) before treating them as ready,
  // so a mixed-generation pair is regenerated instead of served.
  const leafKeyMatchesCert = () => {
    try {
      const certPub = new X509Certificate(readFileSync(leafPem)).publicKey.export({ type: "spki", format: "der" });
      const keyPub = createPublicKey(readFileSync(leafKey)).export({ type: "spki", format: "der" });
      return Buffer.compare(keyPub, certPub) === 0;
    } catch { return false; }
  };
  const ready = () =>
    existsSync(caPem) && existsSync(leafPem) && existsSync(leafKey) &&
    leafCoversAllHosts() && leafKeyMatchesCert();
  // Every successful return goes through here: normalize private-key modes to
  // 0600 even on reuse — openssl defaults are not guaranteed, and a preexisting
  // operator-supplied ca.key must not stay world-readable just because this
  // process didn't mint it.
  const publish = () => {
    for (const f of [caKey, leafKey]) { try { chmodSync(f, 0o600); } catch {} }
    return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
  };
  if (ready()) {
    return publish();
  }
  mkdirSync(caDir, { recursive: true, mode: 0o700 });

  // Serialize generation across concurrent proxies (two proxies started against
  // separate config dirs share this global CA dir). An atomic mkdir lock elects one generator;
  // the others wait for it to finish rather than racing openssl and clobbering
  // each other's ca.pem/leaf.pem (which produced a leaf that didn't chain to
  // the on-disk CA -> client UNKNOWN_ISSUER). All artifacts are written to
  // temp paths and atomically renamed into place so a reader never sees a
  // half-written file.
  const lock = join(caDir, ".gen.lock");
  // Acquiring = atomically creating the lock dir, then stamping our pid inside
  // so peers can tell a live generator from a stale lock left by a dead one.
  // Generation happens ONLY while holding the lock; the old code fell through
  // on wait-timeout and generated anyway — without ownership, with the same
  // fixed temp filenames as the (possibly still-running) real generator, and
  // its `finally` then deleted the owner's lock. Two concurrent starts could
  // clobber each other and publish a leaf that doesn't chain to the CA the
  // client was told to trust (UNKNOWN_ISSUER).
  const acquire = () => {
    try { mkdirSync(lock); } catch { return false; }
    try { writeFileSync(join(lock, "pid"), String(process.pid)); } catch {}
    return true;
  };
  const lockOwnerAlive = () => {
    try {
      const pid = Number(readFileSync(join(lock, "pid"), "utf8").trim());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = exists but not ours -> alive. ESRCH / unreadable pid -> dead.
      // A lock with no pid file after the full wait is stale too: a live owner
      // stamps its pid within milliseconds of the mkdir.
      return !!err && err.code === "EPERM";
    }
  };
  let haveLock = acquire();
  if (!haveLock) {
    // Someone else is generating. Wait (bounded) for the artifacts to appear.
    // Synchronous sleep via Atomics.wait (no busy-spin, no external `sleep`).
    const sleep100 = () => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch {} };
    const deadline = Date.now() + config.caLockWaitMs;
    while (!ready() && Date.now() < deadline) sleep100();
    if (ready()) return publish();
    // Timed out. Reclaim ONLY a stale lock (owner dead); a live owner means a
    // generator is still working (or wedged) — throwing is the safe answer, and
    // the caller (attachForwardProxy) already degrades to reverse-proxy mode.
    if (!lockOwnerAlive()) {
      try { rmSync(lock, { recursive: true, force: true }); } catch {}
      haveLock = acquire(); // may lose to another reclaimer; that's fine
    }
    if (!haveLock) {
      throw new Error(
        `cache-fix forward-proxy: CA generation lock ${lock} still held after ` +
        `${config.caLockWaitMs}ms; refusing to generate without owning the lock`,
      );
    }
  }
  // Temp names carry our pid: even if lock discipline were ever violated, two
  // generators cannot clobber each other's in-flight files. All of ours are
  // removed in the finally (rename already moved the durable ones into place;
  // the csr/ext scratch files would otherwise accumulate as litter).
  const tmp = (n) => join(caDir, `.tmp.${process.pid}.${n}`);
  try {
    if (ready()) return publish();
    const run = (args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });

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
    for (const n of ["ca.key", "ca.pem", "leaf.key", "leaf.pem", "leaf.csr", "leaf.ext"]) {
      try { rmSync(tmp(n), { force: true }); } catch {}
    }
    // Only remove a lock this process created. Deleting a peer's lock lets a
    // third starter acquire it mid-generation and republish artifacts out from
    // under the real owner.
    if (haveLock) {
      try { rmSync(lock, { recursive: true, force: true }); } catch {}
    }
  }
  return publish();
}

// Parse an http(s)://host:port proxy URL into { host, port }.
function parseProxy(url) {
  if (!url) return null;
  // Scheme-defaulted, like hopAlive(): `|| 80` sent the CONNECT for an
  // `https://hop` carrying no explicit port to :80, so the tunnel died against
  // a hop hopAlive() had just confirmed on :443.
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) }; }
  catch { return null; }
}

// The outbound hop for a CONNECT: the configured upstream when it answers, else
// the first reachable fallback, else "" for a direct dial.
//
// resolveHop() and NOT config.httpsProxy. That getter reads
// CACHE_FIX_UPSTREAM_PROXY / HTTPS_PROXY and is never fed by
// CACHE_FIX_FALLBACK_PROXIES, so with only a fallback configured — the shipped
// wiring — it is "" and every CONNECT dialled direct. On the work Mac that
// meant straight into the corporate MITM: `/login` failed with
// UNABLE_TO_GET_ISSUER_CERT while plain HTTP failed over correctly, because
// forwardRequest() was resolveHop()'s only caller. Found by cswap's pin.
//
// Async where the old read was synchronous, so both callers moved their dial
// into a continuation. That is the whole cost: hopAlive() is a refused-or-
// accepted connect, one syscall, and a hop that is down refuses rather than
// hanging.
const hopFor = async () => parseProxy(await resolveHop(true));

// Blind-tunnel a CONNECT to `target` (host:port) untouched. Routes through the
// resolved hop when there is one, else dials the target directly. No TLS
// termination; bytes pass through opaque.
async function blindTunnel(target, clientSocket, head) {
  const [host, portStr] = target.split(":");
  const port = Number(portStr) || 443;
  const via = await hopFor();
  // The client may have given up while we probed the chain; dialling for a
  // dead socket leaks the upstream connection.
  if (clientSocket.destroyed) return;
  if (!via && requireHop()) {
    process.stderr.write(`[forward-proxy] no chain hop reachable and CACHE_FIX_REQUIRE_HOP=1 — refusing ${target}\n`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
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
async function connectUpstreamTLS(cb, onErr) {
  let upHost = "api.anthropic.com", upPort = 443;
  try { const u = new URL(config.upstream); upHost = u.hostname; upPort = Number(u.port) || 443; } catch {}
  const finish = (rawSocket) => {
    const tlsUp = tls.connect({ socket: rawSocket, servername: upHost }, () => cb(tlsUp));
    tlsUp.on("error", onErr);
  };
  // Same chain as the blind tunnel above — see hopFor().
  let via;
  try { via = await hopFor(); } catch (err) { return onErr(err); }
  if (!via && requireHop()) return onErr(new Error("no chain hop reachable (CACHE_FIX_REQUIRE_HOP=1)"));
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
  }, () => bail(null)).catch(() => bail(null));   // async since it resolves the hop
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

// Absolute-form entry into the download rewrite. The CONNECT-MITM path feeds
// decrypted downloads.claude.ai requests into handleDownloadsRequest; a client
// that skips CONNECT (axios's plain-proxy mode, RFC 7230 §5.3.2) delivers the
// same request as an absolute-form GET on the proxy port. Route it through the
// same rewrite so both arrival styles get the acceleration; when the rewrite
// is inactive the caller falls through to the generic relay (origin — slower
// but correct). Returns true when the request was taken over.
export function handleDownloadsAbsolute(clientReq, clientRes, url) {
  if (url.hostname !== DOWNLOADS_HOST || !downloadRewriteActive()) return false;
  clientReq.url = url.pathname + url.search;
  handleDownloadsRequest(clientReq, clientRes);
  return true;
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
  // Warm bucket discovery BEFORE minting the leaf. downloadRewriteActive() is
  // consulted twice below and both answers are frozen for this proxy's life: once
  // by ensureCA() -> mitmHosts() for the leaf SAN, once for `downloadsMitm`. A
  // miss right now is commonly transient — the proxy (re)starts in the sub-second
  // window of an auto-update's symlink swap and reads a dangling/partial binary —
  // and would otherwise wedge the download-rewrite OFF for the whole instance
  // (downloads.claude.ai blind-tunneled, updates hit the throttled origin).
  // discoverBucket() re-scans on a miss (it caches hits only), so a short bounded
  // retry rides out the swap so the SAN covers downloads.claude.ai and the rewrite
  // arms consistently. Bounded (~1.5s worst case) and only when rewrite is on.
  if (config.downloadRewrite && discoverBucket() === "") {
    const sleep100 = () => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch {} };
    for (let i = 0; i < 8 && discoverBucket() === ""; i++) sleep100();
  }
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

      // blindTunnel resolves the hop, so it is async now. An unhandled
      // rejection here would be swallowed by forward mode's own self-heal and
      // leave the client socket open forever; destroy it instead.
      if (reqHost !== host) {
        blindTunnel(target, clientSocket, head).catch(() => clientSocket.destroy());
        return;
      }

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
