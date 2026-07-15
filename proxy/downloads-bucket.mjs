// Runtime discovery of the GCS bucket that fronts downloads.claude.ai.
//
// downloads.claude.ai is a custom domain over a Google Cloud Storage bucket
// named `claude-code-dist-<uuid>`. A corp SSL-inspection proxy (e.g. Netskope)
// may bandwidth-throttle the CDN hostname while leaving storage.googleapis.com
// alone, so the download-rewrite acceleration re-issues update/plugin fetches
// to storage.googleapis.com/<bucket>. That requires knowing the bucket.
//
// The bucket is NOT hard-coded. It is embedded in the Claude Code binary itself
// (a plugin-stats URL: storage.googleapis.com/claude-code-dist-<uuid>/...), so
// we read it from the client's own binary at runtime. A bucket rotation ships
// in a new binary and is picked up automatically — no code or config change.
//
// Discovery is best-effort: if the binary can't be found or scanned, the caller
// leaves the download path untouched (blind-tunnel downloads.claude.ai as
// before). Never throws.

import { realpathSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import config from "./config.mjs";

// storage.googleapis.com/<bucket> where <bucket> is claude-code-dist-<hex/uuid>.
const BUCKET_RE = /storage\.googleapis\.com\/(claude-code-dist-[a-z0-9-]+)/i;

// Resolve the claude binary to scan: explicit override, else the standard
// native-install launcher symlink resolved to its real versioned target.
function resolveBinaryPath() {
  if (config.downloadBinaryPath) return config.downloadBinaryPath;
  const launcher = join(homedir(), ".local", "bin", "claude");
  try { return realpathSync(launcher); } catch { return existsSync(launcher) ? launcher : ""; }
}

// Scan the binary for the bucket. Reads the whole file (the native binary is a
// few hundred MB); latin1 keeps every byte as a code unit so the ASCII URL
// matches regardless of surrounding binary data. Cached after first success.
let _cached;           // discovered bucket string, or "" for a cached miss
let _cachedForPath;    // the binary path the cache was computed against

export function discoverBucket() {
  // Explicit override wins and needs no scan.
  if (config.downloadBucketOverride) return config.downloadBucketOverride;

  const binPath = resolveBinaryPath();
  if (!binPath) return "";
  // Re-scan if the resolved binary path changed (e.g. an auto-update repointed
  // the launcher symlink to a new version that may carry a rotated bucket).
  if (_cached !== undefined && _cachedForPath === binPath) return _cached;

  const bucket = scanForBucket(binPath);

  // Cache HITS only. A miss is commonly transient — this runs during an update,
  // exactly when the binary is being replaced (EINTR, partial file, dangling
  // symlink). Caching "" would key the failure to a path that is ALSO the cache
  // key, wedging discovery off on the very version just installed. Retrying a
  // miss costs one streamed scan on the next request; the hit path stays cached.
  if (bucket) {
    _cached = bucket;
    _cachedForPath = binPath;
  }
  return bucket;
}

// Stream the binary in chunks and regex over a sliding window instead of
// readFileSync + toString("latin1"): that pair costs ~2x the file in RSS (a
// ~230MB binary measured at ~484MB delta) and blocks the loop for ~100ms, and
// readFileSync hard-fails past buffer MAX_STRING_LENGTH. Chunks overlap by
// OVERLAP bytes so a match straddling a boundary is still found.
function scanForBucket(binPath) {
  const CHUNK = 4 * 1024 * 1024;
  const OVERLAP = 256;            // >> longest possible match
  let fd;
  try {
    fd = openSync(binPath, "r");
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = carry + buf.toString("latin1", 0, n);
      const m = text.match(BUCKET_RE);
      if (m) return m[1];
      carry = text.slice(-OVERLAP);
    }
  } catch { /* unreadable binary: caller falls back to the un-rewritten host */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  return "";
}

// Test seam: drop the memoized result so a test can re-run discovery.
export function __resetBucketCacheForTests() {
  _cached = undefined;
  _cachedForPath = undefined;
}
