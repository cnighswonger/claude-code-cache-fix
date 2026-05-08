#!/usr/bin/env node
/**
 * usage-to-dashboard-ndjson — Translate claude-code-cache-fix's usage.jsonl
 * into the proxy NDJSON format expected by @fgrosswig's claude-usage-dashboard,
 * and write to the directory his dashboard already watches.
 *
 *   https://github.com/fgrosswig/claude-usage-dashboard
 *
 * # Why this exists
 *
 * Our interceptor and fgrosswig's dashboard are strongly complementary:
 * the interceptor captures per-call API data from inside the Node.js process
 * (cache metrics, quota state, request rewrites), while his dashboard
 * provides visualization, historical trending, and multi-host aggregation.
 *
 * Rather than build our own visualization layer, we translate our per-call
 * usage records into the NDJSON schema his dashboard ingests. A user running
 * both tools gets the best of both: the interceptor fixes what it can fix
 * and emits rich per-call data, and the dashboard displays that data
 * alongside whatever Claude Code's own session JSONLs already capture.
 *
 * # What this tool does
 *
 * Reads `~/.claude/usage.jsonl` (our interceptor's per-call log) and
 * translates each entry into a minimal-but-compatible record in the shape
 * his dashboard expects under `~/.claude/anthropic-proxy-logs/*.ndjson`.
 * The output file follows the convention `proxy-YYYY-MM-DD.ndjson`, one
 * file per UTC day, matching the filename pattern his `collectProxyNdjsonFiles()`
 * helper discovers.
 *
 * # Fields emitted
 *
 * Mapped from our usage.jsonl to fgrosswig's proxy-core.js shape:
 *
 *   {
 *     "ts_start":  <our timestamp>,
 *     "ts_end":    <our timestamp>,        // single-point, no duration
 *     "duration_ms": null,                 // we don't measure this
 *     "method":    "POST",
 *     "path":      "/v1/messages",
 *     "upstream_status": 200,              // implicit from usage presence
 *     "usage": {
 *       "input_tokens": <ours>,
 *       "output_tokens": <ours>,
 *       "cache_read_input_tokens": <ours>,
 *       "cache_creation_input_tokens": <ours>
 *     },
 *     "cache_read_ratio": <computed>,
 *     "cache_health":     "healthy" | "affected" | "mixed",
 *     "request_hints":    { "model": <ours> },
 *     "response_anthropic_headers": {      // if quota fields available
 *       "anthropic-ratelimit-unified-5h-utilization": "<ours>",
 *       "anthropic-ratelimit-unified-7d-utilization": "<ours>"
 *     },
 *     "ttl_tier":         <ours, interceptor-specific>,
 *     "ephemeral_1h_input_tokens": <ours, interceptor-specific>,
 *     "ephemeral_5m_input_tokens": <ours, interceptor-specific>,
 *     "source": "claude-code-cache-fix"
 *   }
 *
 * Extra fields beyond fgrosswig's native schema (ttl_tier, ephemeral_*,
 * source) are added for forward-compatibility — his dashboard ignores
 * unknown fields per its tolerant-ingest design, and our own tooling
 * downstream may find them useful when consuming the same NDJSON.
 *
 * # Usage
 *
 *   # One-shot translation (reads all of usage.jsonl, writes today's file)
 *   node tools/usage-to-dashboard-ndjson.mjs
 *
 *   # Follow mode (tail usage.jsonl, append new records as they arrive)
 *   node tools/usage-to-dashboard-ndjson.mjs --follow
 *
 *   # Custom input/output paths
 *   node tools/usage-to-dashboard-ndjson.mjs --input /path/to/usage.jsonl --output-dir /path/to/ndjson-dir
 *
 *   # Dry-run: print to stdout instead of writing files
 *   node tools/usage-to-dashboard-ndjson.mjs --stdout
 *
 * # Environment
 *
 *   ANTHROPIC_PROXY_LOG_DIR  Override output directory (matches fgrosswig's
 *                            dashboard env var so both tools stay in sync).
 *
 * Part of claude-code-cache-fix. MIT licensed.
 *   https://github.com/cnighswonger/claude-code-cache-fix
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: join(homedir(), '.claude', 'usage.jsonl'),
    outputDir: process.env.ANTHROPIC_PROXY_LOG_DIR || join(homedir(), '.claude', 'anthropic-proxy-logs'),
    stdout: false,
    follow: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':      opts.input = args[++i]; break;
      case '--output-dir': opts.outputDir = args[++i]; break;
      case '--stdout':     opts.stdout = true; break;
      case '--follow':     opts.follow = true; break;
      case '-h':
      case '--help':       opts.help = true; break;
      default:
        console.error(`unknown flag: ${args[i]}`);
        opts.help = true;
    }
  }

  return opts;
}

function printUsage() {
  console.log(`usage-to-dashboard-ndjson — Translate cache-fix usage.jsonl to fgrosswig dashboard NDJSON.

Usage:
  node usage-to-dashboard-ndjson.mjs                 One-shot: read all, write today's file
  node usage-to-dashboard-ndjson.mjs --follow        Tail usage.jsonl, append new records live
  node usage-to-dashboard-ndjson.mjs --stdout        Print NDJSON to stdout instead of files
  node usage-to-dashboard-ndjson.mjs --input <path>  Custom input (default: ~/.claude/usage.jsonl)
  node usage-to-dashboard-ndjson.mjs --output-dir <path>  Custom output dir (default: ~/.claude/anthropic-proxy-logs)

Output files follow the convention: proxy-YYYY-MM-DD.ndjson (one per UTC day).

Environment:
  ANTHROPIC_PROXY_LOG_DIR  Override output directory (also used by fgrosswig's dashboard).

Credit: this tool writes the NDJSON schema expected by @fgrosswig's
claude-usage-dashboard (https://github.com/fgrosswig/claude-usage-dashboard).
Running both tools together gives users per-call data from our interceptor
plus the visualization layer from his dashboard, with no coordination needed.
`);
}

// ─── Record translation ─────────────────────────────────────────────────────

/**
 * Translate one claude-code-cache-fix usage.jsonl record into a
 * fgrosswig-dashboard-compatible NDJSON record. Returns null if the
 * record doesn't have enough fields to be usable.
 *
 * Accepts both schemas:
 *   - Preload-era: `entry.timestamp`, `entry.q5h_pct` / `entry.q7d_pct` (int 0-100)
 *   - Proxy v:1 (MeterRowSchema, written by `usage-log` extension v3.2.0+):
 *     `entry.ts`, `entry.q5h` / `entry.q7d` (float 0-1)
 *
 * Both forms are handled via fallback so this translator continues to work
 * across the schema evolution. Tracking issue: #112.
 */
export function translateRecord(entry) {
  // Entry guard — accept both formats. Drop only when neither timestamp form
  // is present, or model is missing.
  if (!entry || !(entry.timestamp || entry.ts) || !entry.model) return null;

  const inTok = entry.input_tokens || 0;
  const outTok = entry.output_tokens || 0;
  const crTok = entry.cache_read_input_tokens || 0;
  const ccTok = entry.cache_creation_input_tokens || 0;

  // Cache health (fgrosswig's semantic labels)
  const totalCacheInput = crTok + ccTok;
  const cacheReadRatio = totalCacheInput > 0 ? crTok / totalCacheInput : null;
  let cacheHealth = 'na';
  if (cacheReadRatio != null) {
    if (cacheReadRatio >= 0.8) cacheHealth = 'healthy';
    else if (cacheReadRatio < 0.4 && ccTok > 0) cacheHealth = 'affected';
    else cacheHealth = 'mixed';
  }

  // Reconstruct a minimal response_anthropic_headers blob from the quota
  // fields we captured. Two schema flavors:
  //   preload: q5h_pct / q7d_pct as int 0-100 (divide by 100 to get utilization)
  //   v:1:     q5h / q7d as float 0-1 (already in utilization form)
  // Not byte-identical to what the proxy would see on the wire, but
  // structurally compatible for the dashboard's consumers.
  const responseHeaders = {};
  if (entry.q5h_pct != null) {
    responseHeaders['anthropic-ratelimit-unified-5h-utilization'] = String(entry.q5h_pct / 100);
  } else if (entry.q5h != null) {
    responseHeaders['anthropic-ratelimit-unified-5h-utilization'] = String(entry.q5h);
  }
  if (entry.q7d_pct != null) {
    responseHeaders['anthropic-ratelimit-unified-7d-utilization'] = String(entry.q7d_pct / 100);
  } else if (entry.q7d != null) {
    responseHeaders['anthropic-ratelimit-unified-7d-utilization'] = String(entry.q7d);
  }

  const entryTs = entry.timestamp || entry.ts;

  const rec = {
    ts_start: entryTs,
    ts_end: entryTs,
    duration_ms: null,
    method: 'POST',
    path: '/v1/messages',
    upstream_status: 200,
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_input_tokens: crTok,
      cache_creation_input_tokens: ccTok,
    },
    cache_read_ratio: cacheReadRatio,
    cache_health: cacheHealth,
    request_hints: {
      model: entry.model,
    },
    response_anthropic_headers: responseHeaders,
    // Interceptor-specific extras — fgrosswig's dashboard ignores unknown
    // fields, so these pass through without breaking ingestion.
    ttl_tier: entry.ttl_tier || null,
    ephemeral_1h_input_tokens: entry.ephemeral_1h_input_tokens || 0,
    ephemeral_5m_input_tokens: entry.ephemeral_5m_input_tokens || 0,
    peak_hour: entry.peak_hour || false,
    source: 'claude-code-cache-fix',
  };

  // Synthesize a stable pseudo-request-id from timestamp + model for dedup
  // at the dashboard layer. Not a real request ID — just a deterministic key.
  rec.req_id = 'ccf_' + entryTs.replace(/[^0-9]/g, '') + '_' + entry.model.slice(-6);

  return rec;
}

// ─── File output ────────────────────────────────────────────────────────────

function dayFileFor(outputDir, isoTimestamp) {
  // proxy-YYYY-MM-DD.ndjson from UTC date
  const date = isoTimestamp.slice(0, 10);
  return join(outputDir, `proxy-${date}.ndjson`);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeRecords(records, outputDir, useStdout) {
  if (useStdout) {
    for (const r of records) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
    return records.length;
  }

  ensureDir(outputDir);

  // Group by day for efficient appending
  const byDay = new Map();
  for (const r of records) {
    const day = dayFileFor(outputDir, r.ts_start);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  for (const [dayFile, dayRecords] of byDay) {
    const payload = dayRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    // Overwrite on one-shot mode — the tool is idempotent within a single
    // input file, so rewriting today's file from a full replay is safe.
    writeFileSync(dayFile, payload);
  }

  return records.length;
}

// ─── One-shot batch mode ────────────────────────────────────────────────────

function runBatch(opts) {
  if (!existsSync(opts.input)) {
    console.error(`ERROR: input file not found: ${opts.input}`);
    process.exit(1);
  }

  const raw = readFileSync(opts.input, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const records = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const rec = translateRecord(entry);
      if (rec) records.push(rec);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  const written = writeRecords(records, opts.outputDir, opts.stdout);
  if (!opts.stdout) {
    console.error(`usage-to-dashboard-ndjson: wrote ${written} records to ${opts.outputDir} (${skipped} skipped)`);
  }
}

// ─── Follow mode ────────────────────────────────────────────────────────────

function runFollow(opts) {
  if (!existsSync(opts.input)) {
    console.error(`ERROR: input file not found: ${opts.input}`);
    process.exit(1);
  }

  // First, catch up on the existing file (idempotent write)
  runBatch(opts);

  // Then watch for new entries
  console.error(`usage-to-dashboard-ndjson: watching ${opts.input} for new records...`);
  let lastSize = statSync(opts.input).size;

  watch(opts.input, { persistent: true }, () => {
    let currentSize;
    try { currentSize = statSync(opts.input).size; } catch { return; }
    if (currentSize <= lastSize) {
      // File truncated or unchanged — rewind lastSize
      if (currentSize < lastSize) lastSize = 0;
      return;
    }
    // Read only the new bytes
    try {
      const fd = readFileSync(opts.input, 'utf8');
      const newContent = fd.slice(lastSize);
      lastSize = currentSize;
      const newLines = newContent.split('\n').filter(l => l.trim());
      const newRecs = [];
      for (const line of newLines) {
        try {
          const entry = JSON.parse(line);
          const rec = translateRecord(entry);
          if (rec) newRecs.push(rec);
        } catch {}
      }
      if (newRecs.length > 0) {
        // Append to today's dayfile per record
        ensureDir(opts.outputDir);
        for (const r of newRecs) {
          const dayFile = dayFileFor(opts.outputDir, r.ts_start);
          appendFileSync(dayFile, JSON.stringify(r) + '\n');
        }
        console.error(`[${new Date().toISOString()}] appended ${newRecs.length} records`);
      }
    } catch (err) {
      console.error(`watch error: ${err.message}`);
    }
  });

  // Keep the process alive
  process.stdin.resume();
}

// ─── Main ───────────────────────────────────────────────────────────────────

// Guard CLI execution so tests can `import { translateRecord }` without
// auto-running the batch/follow flow.
const _isMain = import.meta.url === `file://${process.argv[1]}`;
if (_isMain) {
  const opts = parseArgs();
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  if (opts.follow) {
    runFollow(opts);
  } else {
    runBatch(opts);
  }
}
