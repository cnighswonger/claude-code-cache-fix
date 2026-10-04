// request-capture — record MESSAGES-API request bodies for offline replay.
//
// The proxy sees every request byte-for-byte; until this extension, it threw
// the bodies away, so every pipeline change could only be validated against
// synthetic fixtures or live traffic.
//
// SCOPE — the outer half is the pipeline's, not this file's: the extension
// declares no `routes`, so runOnRequest's default of ["messages"] skips the hook
// for every other tagged route, /api/claude_cli/bootstrap included. The body
// gate below is what scopes an UNTAGGED caller, which appliesToRoute admits.
//
// Order 60 — after bootstrap-defense (45) and ttl-tier-detect (75 is
// AFTER, fine: it only reads), before cc-version-normalize (90), the
// first extension that MUTATES the body. Capture must record what CC
// sent, not what the pipeline made of it.
//
// Activation: `enabled: true` in extensions.json (always loaded), runtime
// gate CACHE_FIX_REQUEST_CAPTURE=1 (read per-call so tests can flip it).
// Fail-open: capture failure never fails the request. CACHE_FIX_DEBUG=1
// logs swallowed errors, same idiom as prefix-diff.
//
// Sensitivity: captures contain the FULL conversation content — the same
// sensitivity as the transcripts in ~/.claude/projects/, on the same
// machine. No new exposure class; documented in the directive.
//
// Retention: CACHE_FIX_CAPTURE_MAX_MB (default 2048). Checked every
// SWEEP_EVERY appends per process; oldest capture files deleted first
// until under the cap. The sweep is best-effort and fail-open.

import { appendFile, chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { createHash } from "node:crypto";
import { appendFileOwnerOnly } from "./write-owner-only.mjs";
import { publishableGates } from "../gate-allowlist.mjs";

// The capture directory holds whole request and response bodies — the most
// sensitive thing this proxy writes anywhere. 0700 so the directory listing
// itself, which leaks session keys through filenames, is owner-only too;
// the files inside are 0600 via appendFileOwnerOnly. Both are applied at
// CREATE rather than chmod'ed afterwards, so there is no window in which a
// capture file exists at the ambient umask.
const CAPTURE_DIR_MODE = 0o700;

const DEFAULT_FS = { appendFile, chmod, mkdir, readdir, stat, unlink };
const SWEEP_EVERY = 50;

let _appendsSinceSweep = 0;
// The source tree the traffic was served by, read from the environment the
// server publishes it into. NOT module state: loadExtensions cache-busts its
// imports, so a setter would land on a different module instance than the one
// the pipeline runs and the field would stay null forever.
function proxyTree() {
  return process.env.CACHE_FIX_PROXY_TREE || null;
}

function isEnabled(env = process.env) {
  return env.CACHE_FIX_REQUEST_CAPTURE === "1";
}

function isDebug(env = process.env) {
  return env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[request-capture] DEBUG: ${msg}\n`);
}

function getCaptureDir() {
  return join(claudeHome(), "cache-fix-captures");
}

function getMaxBytes(env = process.env) {
  const raw = parseInt(env.CACHE_FIX_CAPTURE_MAX_MB ?? "2048", 10);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 2048;
  return mb * 1024 * 1024;
}

// Same key derivation family as prefix-diff/insertion-normalization:
// session-id header preferred, content-hash fallback — captures must join
// against the existing events ledgers by key + ts.
export function resolveCaptureKey(headers, body) {
  const sid = headers ? resolveSessionId(headers) : null;
  if (sid) return `s-${sid.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const first = Array.isArray(body?.messages) ? body.messages[0] : null;
  const h = first
    ? createHash("sha256").update(JSON.stringify(first)).digest("hex").slice(0, 12)
    : "empty";
  return `c-${h}`;
}

// One NDJSON record per request. Headers are reduced to the two that
// matter for replay fidelity (beta set: cache semantics; session-id:
// key derivation) — full header capture would add auth material to a
// file that must never contain it.
export function buildCaptureRecord(ctx, now = new Date(), id = null) {
  const headers = ctx.headers || {};
  return {
    ts: now.toISOString(),
    // Join key. Until 2026-07-28 a capture line carried no identifier, so the
    // only way to tie a recorded request to what it COST was to compare wall
    // clocks against a separate ledger — which mis-attributed a 484k event to
    // the wrong session twice in one evening before the error was caught.
    id,
    sid: resolveSessionId(headers) ?? null,
    key: resolveCaptureKey(headers, ctx.body),
    headers: {
      "anthropic-beta": headers["anthropic-beta"] ?? null,
      "session-id": headers["session-id"] ?? headers["x-session-id"] ?? null,
    },
    body: ctx.body,
  };
}

// The OUTCOME of a captured request: what the API actually charged.
//
// A capture recorded what was SENT and never what it cost, so every
// cache question had to be answered by inference — prefix-diff's `cause` is a
// hypothesis about what the API keyed on, never a measurement. With
// `cache_read_input_tokens` on the record, the matched prefix LENGTH becomes
// observable: the cache keys on the longest identical prefix, so a read of N
// tokens says where the match ended, and that can be compared against message
// boundaries instead of guessed at.
//
// Written as a SEPARATE line rather than by amending the request line: the
// request must reach disk immediately (a response that never arrives must not
// lose the request from the corpus), and an append-only file cannot be
// rewritten in place. Consumers join on `id`.
export function buildOutcomeRecord(ctx, id, key, now = new Date()) {
  // Usage is read from the EVENT, not from another extension's meta.
  //
  // The first version read `meta.cacheStats`, which cache-telemetry populates
  // on this same frame — but cache-telemetry is order 100 and this extension
  // is order 60, so it ran first and always saw undefined. It wrote nothing,
  // logged nothing, and looked exactly like a feature that worked. Reading the
  // frame directly removes the ordering dependency instead of reversing it,
  // and a hidden coupling to another extension's side effect is worth removing
  // on its own.
  const u = ctx?.event?.message?.usage;
  const cs = u
    ? {
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreation: u.cache_creation_input_tokens || 0,
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        // cache_creation may carry the per-tier split alongside the scalar.
        ephemeral1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
        ephemeral5m: (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0,
      }
    : ctx?.meta?.cacheStats;
  if (!cs || !id) return null;
  return {
    ts: now.toISOString(),
    type: "outcome",
    id,
    key,
    // The upstream request-id also appears in CC's own session transcript
    // (jsonl-session-mirror records it), so this is the field that finally
    // joins three records that described the same event and shared no key:
    // the cold-rewrite ledger, the capture, and CC's transcript.
    requestId: ctx?.meta?._captureRequestId ?? null,
    model: ctx?.event?.message?.model ?? ctx?.meta?._servedModel ?? null,
    // Everything the API told us it charged. Recorded in full rather than
    // reduced to one number: the tier split says which TTL the cache actually
    // used (not a heuristic), input/output separate the prompt from the
    // completion, and a zero cacheRead beside a large cacheCreation IS the
    // definition of a cold rewrite — the event the whole corpus exists to
    // explain.
    usage: {
      cacheRead: cs.cacheRead ?? 0,
      cacheCreation: cs.cacheCreation ?? 0,
      inputTokens: cs.inputTokens ?? 0,
      outputTokens: cs.outputTokens ?? 0,
      ephemeral1h: cs.ephemeral1h ?? 0,
      ephemeral5m: cs.ephemeral5m ?? 0,
    },
    // What we actually put on the wire, so a replay can PROVE it reproduced
    // the real request instead of assuming it. Set in server.mjs at the one
    // point the outbound bytes exist.
    outSha: ctx?.meta?._forwardedSha ?? null,
    outBytes: ctx?.meta?._forwardedBytes ?? null,
    // Wall time from request to first usage — separates "the cache was cold"
    // from "the request was slow for another reason".
    ms: ctx?.meta?._captureStart ? Date.now() - ctx.meta._captureStart : null,
  };
}

// Delete oldest capture files until the directory is under maxBytes.
// Returns the number of files deleted (for tests/telemetry).
export async function sweepCaptureDir(dir, maxBytes, fs = DEFAULT_FS) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const entries = [];
  for (const f of files) {
    if (!f.endsWith("-requests.jsonl")) continue;
    try {
      const st = await fs.stat(join(dir, f));
      entries.push({ f, size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  let total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= maxBytes) return 0;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let deleted = 0;
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      await fs.unlink(join(dir, e.f));
      total -= e.size;
      deleted++;
    } catch {}
  }
  return deleted;
}

// One per proxy boot, written into every capture file the boot touches.
//
// Two things were unrecoverable from a corpus without it, and both cost time
// on 2026-07-28:
//
//   RESTARTS — a restart resets module-scope state, so replaying across one
//   without knowing where it happened silently models a different run.
//   `--restart-at N` exists precisely for this and had to be guessed by
//   reading journalctl and matching wall clocks.
//
//   THE GATE SET — a capture never recorded which mitigations were ON while it
//   was written, so replaying yesterday's traffic under today's gates compares
//   two different worlds and calls the difference a finding. That is the same
//   class as the gate runner replaying extension DEFAULTS while production ran
//   eleven gates: a verdict over the wrong configuration.
export function buildBootRecord(now = new Date(), env = process.env, tree = null) {
  // Allowlisted gate VALUES only; every other CACHE_FIX_* key is present by
  // NAME with its value redacted. A capture file is the artifact most likely
  // to be attached to a bug report or replayed elsewhere, and the environment
  // holds credentials and machine paths beside the switches. PROXY_TREE is
  // skipped because it is already a field of this record.
  const gates = publishableGates(env, { skip: ["CACHE_FIX_PROXY_TREE"] });
  return {
    ts: now.toISOString(),
    type: "boot",
    pid: process.pid,
    proxyTree: tree,
    gates,
  };
}

let _bootWrittenFor = new Set();

export default {
  name: "request-capture",
  description:
    "Append full request bodies (pre-mutation) to " +
    "~/.claude/cache-fix-captures/<key>-requests.jsonl for offline " +
    "replay and cache simulation",
  enabled: false, // overridden by extensions.json
  // Declared, not inherited. runOnRequest defaults to exactly this, so the
  // value is a no-op -- but the SCOPE note at the top of this file reasons
  // about it, and an inherited default is invisible to anyone widening the
  // corpus. jsonl-session-mirror and image-retry-circuit-breaker spell it out
  // for the same reason.
  routes: ["messages"],
  order: 60,

  async onRequest(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.body || !Array.isArray(ctx.body.messages)) return;

    try {
      const dir = getCaptureDir();
      // Random, not sequential: capture files rotate and several proxies may
      // write concurrently, so a counter would collide across boots.
      const id = randomUUID().slice(0, 12);
      ctx.meta = ctx.meta || {};
      ctx.meta._captureId = id;
      ctx.meta._captureStart = Date.now();
      const record = buildCaptureRecord(ctx, new Date(), id);
      ctx.meta._captureKey = record.key;
      // First write into this file from this boot: stamp the boundary and the
      // configuration, so the corpus carries its own provenance.
      if (!_bootWrittenFor.has(record.key)) {
        _bootWrittenFor.add(record.key);
        await DEFAULT_FS.mkdir(dir, { recursive: true, mode: CAPTURE_DIR_MODE });
        await appendFileOwnerOnly(
          join(dir, `${record.key}-requests.jsonl`),
          JSON.stringify(buildBootRecord(new Date(), process.env, proxyTree())) + "\n",
          DEFAULT_FS,
        );
      }
      await DEFAULT_FS.mkdir(dir, { recursive: true, mode: CAPTURE_DIR_MODE });
      await appendFileOwnerOnly(
        join(dir, `${record.key}-requests.jsonl`),
        JSON.stringify(record) + "\n",
        DEFAULT_FS,
      );
      if (++_appendsSinceSweep >= SWEEP_EVERY) {
        _appendsSinceSweep = 0;
        await sweepCaptureDir(dir, getMaxBytes(), DEFAULT_FS);
      }
    } catch (err) {
      debug(`capture failed: ${err?.message ?? err}`);
    }
  },

  // Response headers carry the upstream request-id; stash it for the outcome
  // record written once usage arrives.
  async onResponseStart(ctx) {
    if (!isEnabled() || !ctx?.meta) return;
    ctx.meta._captureRequestId = ctx.headers?.["request-id"] ?? null;
  },

  // Usage arrives on the streaming `message_start` frame — the same mechanism
  // cache-telemetry uses, and the only one that fires on the SSE path that
  // /v1/messages actually takes. Written once per request: `message_delta`
  // updates output tokens afterwards, but waiting for it would risk losing the
  // record entirely on a cancelled stream, and the cache numbers (which are
  // the point) are final at message_start.
  async onStreamEvent(ctx) {
    if (!isEnabled() || !ctx?.meta) return;
    if (ctx.event?.type !== "message_start") return;
    if (ctx.meta._captureOutcomeWritten) return;
    try {
      const id = ctx.meta._captureId;
      const key = ctx.meta._captureKey;
      if (!id || !key) return;
        const record = buildOutcomeRecord(ctx, id, key);
      if (!record) return;
      ctx.meta._captureOutcomeWritten = true;
      await appendFileOwnerOnly(
        join(getCaptureDir(), `${key}-requests.jsonl`),
        JSON.stringify(record) + "\n",
        DEFAULT_FS,
      );
    } catch (err) {
      debug(`outcome capture failed: ${err?.message ?? err}`);
    }
  },
};
