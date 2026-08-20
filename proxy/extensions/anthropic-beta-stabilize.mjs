// anthropic-beta-stabilize — hold the outbound anthropic-beta header steady
// per session.
//
// Issue #326. CC toggles the beta set between consecutive turns of the SAME
// session — same conversation, same model, same tools — and each toggle is a
// cache-key change on Anthropic's side, so the whole prefix is recreated even
// though nothing else moved. Measured on visits-01 (2026-08-08):
// cache-diagnosis-2026-04-07 flipped four times in 33 seconds across turns
// 821→822→823→825, each appearing in prefix-diff as
// `header:anthropic-beta[±...]`.
//
// Same class as the Workflow-tool oscillation deferred-tool-rewrite (#273)
// absorbs: client-side volatility in a cache-key input, where the client is
// not in a position to see what it just cost.
//
// Behaviour, per the issue: snapshot the set at FIRST SEEN per session and
// emit that on every subsequent turn regardless of what CC sends. Deltas are
// observed and reported, never forwarded. First-seen wins — this is not a
// policy layer and makes no decision about which betas are desirable.
//
// Gate: CACHE_FIX_BETA_STABILIZE=1, default OFF. Same discipline as
// deferred-tool-rewrite — it changes what we send upstream, so it stays
// opt-in.
//
// Order 530: AFTER auto-1m-guard (520). That ordering is load-bearing rather
// than cosmetic — auto-1m-guard in strip mode removes context-1m from this
// same header, so snapshotting before it would freeze a token the next stage
// then removes, and the emitted value would differ from the snapshot on every
// turn. Snapshotting after it means the stable set is the set we actually
// send. Before session-health (590) / cache-telemetry (600), whose flat
// ctx.meta annotation this mirrors.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeHome } from "../claude-home.mjs";
import { findBetaHeader, parseBetaTokens, joinBetaTokens } from "./auto-1m-guard.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { conversationSubKey } from "./message-hash.mjs";
import { systemPromptSubKey } from "./insertion-normalization.mjs";

// Per-session first-seen token arrays. In-memory by design: the snapshot is
// only useful while Anthropic still holds the prefix it was cached against,
// and a proxy restart has already lost that race — a session resuming after
// one is a fresh snapshot either way, which is the same state a new session
// starts in. Persisting it would add an on-disk format to a change that does
// not otherwise have one.
const snapshots = new Map();

// Betas that are ALWAYS forwarded, even when they are not in the snapshot.
//
// A strict pin is wrong for a token that carries a per-turn contract rather
// than a session-wide capability. deferred-tool-rewrite (#273, order 425) adds
// `mid-conversation-tool-changes-2026-07-01` on ANY turn where it injects a
// tool_addition block — including turn N > 1, which by definition is after
// this extension has snapshotted. Stripping it there does not fail loudly: the
// tool_addition block still reaches Anthropic, Anthropic ignores it for want
// of the beta, and DTR's entire purpose is silently defeated with no error on
// either side. A pin that eats a contract token is worse than no pin.
//
// DTR runs FIRST (425 < 530) so the token is present in `incoming` by the time
// this pass sees it — that ordering is what makes passthrough possible at all.
//
// Passthrough is accounted separately from `added`. Folding it into the delta
// would report DTR's deliberate, contracted addition as client drift, which is
// the one thing this extension's telemetry exists to distinguish.
export const ALWAYS_PASSTHROUGH = Object.freeze([
  "mid-conversation-tool-changes-2026-07-01",
]);

const PASSTHROUGH = new Set(ALWAYS_PASSTHROUGH);

// The only endpoint whose header this pass may touch.
//
// server.mjs routes any POST /v1/messages* to handleMessages, and the
// pipeline's `routes: ["messages"]` default filters by route, not subpath — so
// without this, /v1/messages/count_tokens and /v1/messages/batches reach the
// extension looking exactly like a real turn. A token-count probe carrying a
// different beta set would snapshot under the same tenant key the eventual
// turn uses, and the turn would then be "stabilized" against a probe.
//
// Requires `path` in ctx.meta (server.mjs supplies it as baseMeta). Absent —
// an older server, or a call site that does not pass it — this returns false
// and the pass no-ops. Fail-safe on purpose: a pass that cannot tell which
// endpoint it is on must not mutate a header.
export function isStabilizablePath(path) {
  if (typeof path !== "string" || path === "") return false;
  return path.split("?")[0].split("#")[0] === "/v1/messages";
}

// Bounded so a long-lived proxy cannot accumulate one entry per session seen.
// Map preserves insertion order, so the oldest key is the first one out.
const MAX_SESSIONS = 500;

function remember(key, tokens) {
  snapshots.set(key, tokens);
  while (snapshots.size > MAX_SESSIONS) {
    snapshots.delete(snapshots.keys().next().value);
  }
}

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

function enabled() {
  return process.env.CACHE_FIX_BETA_STABILIZE === "1";
}

// Test seam: the module-level Map would otherwise leak between cases.
export function resetBetaSnapshots() {
  snapshots.clear();
}

// The tenant a snapshot belongs to.
//
// Session id ALONE is not a tenant, and this is the lesson
// test/session-key-invariants.mjs exists to carry: every subagent of a session
// runs the same agent prompt under the same session id, so a (session-id,
// system-prompt) key put 39 distinct conversations in one bucket for
// insertion-normalization, and deferred-tool-rewrite inherited the identical
// collision because nothing connected the two. Same key shape as
// resolveToolRewriteSessionKey, and for the same reason.
//
// It matters here even though the header is CC-process-global: a coarse key
// would impose conversation A's first-seen set on conversation B, sending B a
// header nobody asked for. The reverse risk — more keys than processes — costs
// nothing in this design, because a new key snapshots on its first turn rather
// than waiting to promote a baseline.
//
// Null when the request carries no session id, which leaves the header alone.
// The sibling falls back to `c-<model>-<conv>` there; this one does not,
// because anthropic-beta is process-global and two CC processes opening with
// the same model and first message would then share a beta set.
export function betaSessionKey(headers, body) {
  const sid = resolveSessionId(headers);
  if (!sid) return null;
  const safe = sid.replace(/[^A-Za-z0-9_-]/g, "_");
  return `s-${safe}-${systemPromptSubKey(body?.system)}-${conversationSubKey(body?.messages)}`;
}

// Pure planner. `snapshot` is the first-seen token array (or null on the
// first request for this session); `incoming` is what CC sent this turn.
//
// Returns { tokens, action, added, removed }:
//   action "snapshot"   first sight — adopt and emit what CC sent
//   action "stable"     incoming matches the snapshot; nothing to do
//   action "stabilized" incoming drifted; emit the snapshot, report the delta
//
// Set comparison, not string comparison: a pure reorder is a cache-key change
// too, and reporting it as a delta would misdescribe it as CC adding or
// removing a beta.
export function planStableBetas(snapshot, incoming) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return { tokens: incoming, action: "snapshot", added: [], removed: [], passthrough: [] };
  }
  const have = new Set(snapshot);
  const want = new Set(incoming);
  // Whitelisted arrivals are forwarded, never counted as drift. Split before
  // the delta so a DTR turn reads as `passthrough`, not `added`.
  const arrived = incoming.filter((t) => !have.has(t));
  const passthrough = arrived.filter((t) => PASSTHROUGH.has(t));
  const added = arrived.filter((t) => !PASSTHROUGH.has(t));
  const removed = snapshot.filter((t) => !want.has(t));

  // pinned union passthrough: snapshot order preserved, forwarded tokens
  // appended. Order IS wire-visible — joinBetaTokens normalizes SPACING, not
  // order — so appending rather than merging is what makes the bytes return
  // to exactly the snapshot's on the next turn DTR does not inject. A turn
  // that adds the token and a later turn that drops it both leave the pinned
  // prefix byte-identical, which is the property the extension exists for.
  const tokens = passthrough.length ? [...snapshot, ...passthrough] : snapshot;

  if (added.length === 0 && removed.length === 0 && passthrough.length === 0) {
    return { tokens: snapshot, action: "stable", added, removed, passthrough };
  }
  if (added.length === 0 && removed.length === 0) {
    // Only a contract token arrived. Nothing was withheld, so this is not a
    // stabilization — reporting it as one would make DTR turns look like
    // drift in every dashboard that counts `stabilized`.
    return { tokens, action: "passthrough", added, removed, passthrough };
  }
  return { tokens, action: "stabilized", added, removed, passthrough };
}

// --- Durable telemetry (DTR's idiom: per-session JSONL beside its state) ---
//
// ctx.meta is per-request and dies with it; stderr is not addressable. An
// operator asking "did the stabilizer fire on session X at 03:12, and what did
// it withhold?" six months from now needs a file. Same directory and row
// shape as deferred-tool-rewrite so one reader serves both.

const DEFAULT_FS = { appendFile, mkdir };

export function betaEventsPath(dir, sessionKey) {
  return join(dir, `${sessionKey}-anthropic-beta-events.jsonl`);
}

export async function appendBetaEvent(dir, sessionKey, record, fs = DEFAULT_FS) {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(betaEventsPath(dir, sessionKey), JSON.stringify(record) + "\n");
  } catch {
    // Telemetry must never fail a request. The header is already decided by
    // the time this runs.
  }
}

export default {
  name: "anthropic-beta-stabilize",
  description:
    "Hold the outbound anthropic-beta header at its first-seen value per session, so CC toggling " +
    "betas between turns cannot invalidate the cache prefix (#326). Deltas are reported, not " +
    "forwarded. Opt-in via CACHE_FIX_BETA_STABILIZE=1.",
  order: 530,

  async onRequest(ctx) {
    if (!enabled()) return;

    // Step 0 - endpoint. Before ANY state is read or written: a count_tokens
    // probe must not be able to create the snapshot a real turn is then held
    // against.
    if (!isStabilizablePath(ctx.meta?.path)) return;

    const found = findBetaHeader(ctx.headers);
    if (!found) return;

    const incoming = parseBetaTokens(found.raw);
    if (incoming.length === 0) return;

    const key = betaSessionKey(ctx.headers, ctx.body);
    if (!key) return;

    const plan = planStableBetas(snapshots.get(key), incoming);
    if (plan.action === "snapshot") remember(key, plan.tokens);

    // Written on every turn, including "stable". The joined form is the
    // canonical one, so a turn where CC sent the same set with different
    // spacing still leaves the wire bytes identical to the previous turn —
    // which is the property the whole extension exists to hold.
    ctx.headers[found.key] = joinBetaTokens(plan.tokens);

    ctx.meta._betaStabilize = {
      beta_stabilize_action: plan.action,
      ...(plan.added.length ? { beta_stabilize_added: plan.added } : {}),
      ...(plan.removed.length ? { beta_stabilize_removed: plan.removed } : {}),
      ...(plan.passthrough.length ? { beta_stabilize_passthrough: plan.passthrough } : {}),
    };

    // Durable row. Awaited so a test can observe the file, and because the
    // append is the only record of this decision that survives the request.
    await appendBetaEvent(getSnapshotDir(), key, {
      ts: new Date().toISOString(),
      key,
      sid: resolveSessionId(ctx.headers) ?? null,
      action: plan.action,
      adds: plan.added,
      removes: plan.removed,
      passthrough: plan.passthrough,
      pinned: plan.tokens,
    }, ctx.__fs ?? DEFAULT_FS);

    if (plan.action === "stabilized") {
      process.stderr.write(
        `[anthropic-beta-stabilize] held session betas` +
          (plan.added.length ? ` +${plan.added.join(",")}` : "") +
          (plan.removed.length ? ` -${plan.removed.join(",")}` : "") +
          (plan.passthrough.length ? ` ->${plan.passthrough.join(",")}` : "") +
          ` — emitting first-seen set (CACHE_FIX_BETA_STABILIZE=1)\n`,
      );
    }
  },
};
