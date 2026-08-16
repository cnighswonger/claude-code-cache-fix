// beta-stabilize — hold the outbound anthropic-beta header steady per session.
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

// Bounded so a long-lived proxy cannot accumulate one entry per session seen.
// Map preserves insertion order, so the oldest key is the first one out.
const MAX_SESSIONS = 500;

function remember(key, tokens) {
  snapshots.set(key, tokens);
  while (snapshots.size > MAX_SESSIONS) {
    snapshots.delete(snapshots.keys().next().value);
  }
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
    return { tokens: incoming, action: "snapshot", added: [], removed: [] };
  }
  const have = new Set(snapshot);
  const want = new Set(incoming);
  const added = incoming.filter((t) => !have.has(t));
  const removed = snapshot.filter((t) => !want.has(t));
  if (added.length === 0 && removed.length === 0) {
    return { tokens: snapshot, action: "stable", added, removed };
  }
  return { tokens: snapshot, action: "stabilized", added, removed };
}

export default {
  name: "beta-stabilize",
  description:
    "Hold the outbound anthropic-beta header at its first-seen value per session, so CC toggling " +
    "betas between turns cannot invalidate the cache prefix (#326). Deltas are reported, not " +
    "forwarded. Opt-in via CACHE_FIX_BETA_STABILIZE=1.",
  order: 530,

  async onRequest(ctx) {
    if (!enabled()) return;

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
    };

    if (plan.action === "stabilized") {
      process.stderr.write(
        `[beta-stabilize] held session betas` +
          (plan.added.length ? ` +${plan.added.join(",")}` : "") +
          (plan.removed.length ? ` -${plan.removed.join(",")}` : "") +
          ` — emitting first-seen set (CACHE_FIX_BETA_STABILIZE=1)\n`,
      );
    }
  },
};
