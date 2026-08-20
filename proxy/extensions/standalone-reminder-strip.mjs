// standalone-reminder-strip — drop CC's bookkeeping messages that arrive as
// WHOLE role:system messages rather than <system-reminder>-wrapped blocks.
//
// content-strip already owns the vocabulary for this content and strips it at
// the BLOCK level, gated on REMINDER_WRAP_REGEX. CC also emits the same
// bookkeeping as a bare standalone message with no wrapper, and emits it
// INCONSISTENTLY between consecutive turns — so whichever body became the
// cached prefix disagrees with the next one and the whole prefix rewrites.
// This extension covers that location, reusing content-strip's exported
// patterns rather than restating them.
//
// Two measured members of the class:
//
// CC injects a standalone `{"role":"system"}` message carrying
//
//     <total_tokens>14945929 tokens left</total_tokens>
//
// on most turns, and then PRUNES older ones out of mid-history as the
// conversation grows. Each prune rewrites the prefix from that index and the
// whole thing is re-charged as cache_creation. The count changes every turn, so
// no two markers are byte-identical and nothing can dedupe them.
//
// Measured on one private deployment (CC 2.1.223, 2026-08-15), a single
// session:
//
//     483-529 markers in one body, ~30% of the message list
//     warm[9] pruned                    ->  224,979-token cold write
//     warm[1362,1441,1508,1537] pruned  ->  771,212-token cold write
//
// Stripping beats repairing: a marker that never leaves the proxy cannot be
// pruned. Once every outbound body omits them, CC's pruning of them is
// invisible to the cache.
//
// THE SECOND MEMBER, and the one content-strip half-covers. CC's task-management
// reminder ("The task tools haven't been used recently...") is already in
// BOOKKEEPING_PATTERNS, but only reachable in the wrapped shape. It also
// arrives as a bare standalone role:system message, and CC emits it
// inconsistently between consecutive requests — present at 02:05:22, absent at
// 02:06:12 on one session. Three independent cold writes were replayed against
// their archived predecessors and all three ended the same way: the warm body
// carried a standalone role:system that the current body did not.
//
//     prefix 794 -> 826, breaks at 826: warm[826] "The task tools haven't..."
//     prefix 862 -> 898, breaks at 898: warm[898] "The task tools haven't..."
//
// Importing the patterns rather than copying them means the rest of that
// vocabulary — the TodoWrite reminder, the token/USD counters, the
// auto-compact countdown — is covered in this location for free.
//
// It is CC's, not a proxy artifact: "tokens left" appears in the CC 2.1.223
// binary and not in an April build, and it arrives as a whole role:system
// message rather than a <system-reminder>-wrapped block, which is why
// content-strip's BOOKKEEPING_PATTERNS cannot reach it — that gate requires the
// wrapper and matches blocks inside a message, not the message itself.
//
// THE DANGEROUS NEIGHBOUR. CC also emits
// `<usage><total_tokens>N</total_tokens><tool_uses>...</usage>` inside subagent
// tool_results and parses it back with /<total_tokens>(\d+)<\/total_tokens>/ —
// operators rely on it for per-session subagent cost. Every guard below exists
// to keep that untouched, and it is safe on three independent grounds: the
// pattern is anchored at ^<total_tokens>, so it cannot match a string starting
// with <usage>; it requires " tokens left", which the digits-only form does not
// have; and the gate only ever looks at role:system messages, while that copy
// lives in a role:user tool_result.
//
// Order 335: immediately after content-strip (330), whose vocabulary this
// borrows and whose block-level pass should run first, and before
// tool-input-normalize (340) and cache-control-normalize (400) so marker
// placement is computed over the final message list.
//
// Gate: CACHE_FIX_STRIP_STANDALONE_REMINDERS, default ON — same default as
// content-strip, which removes this same content one location over. It drops
// bytes the model never reads, and shipping a measured six-figure cache cost
// as an opt-in seemed the wrong default.

import { BOOKKEEPING_PATTERNS } from "./content-strip.mjs";

// CC's remaining-budget marker. Not in BOOKKEEPING_PATTERNS because
// content-strip has never seen it in the wrapped form — it only ever arrives
// standalone.
const BUDGET_MARKER = /^<total_tokens>\d+ tokens left<\/total_tokens>\s*$/;

// The full standalone vocabulary: content-strip's patterns plus the marker.
// Imported, not copied — a pattern added to content-strip is covered here for
// free, and a copy would go stale in exactly the way its own comment warns
// about.
const STANDALONE_PATTERNS = [BUDGET_MARKER, ...BOOKKEEPING_PATTERNS];

function envDisabled() {
  return process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS === "0";
}

// The marker text of a standalone role:system message, or null.
//
// BOTH SERIALIZATIONS. CC ships the same standalone system message as a bare
// string OR as a single [{type:"text",text:...}] block, and flips between them
// as history ages — 122 role:system messages flipped inside one 28-second
// window in the measured capture. Matching only one form reproduces the drift
// this extension removes, one level down.
export function standaloneMarkerText(message) {
  if (!message || typeof message !== "object" || message.role !== "system") return null;
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === "text" && typeof c[0].text === "string") {
    return c[0].text;
  }
  return null;
}

// True when this message is nothing but the budget marker.
//
// A message MIXING the marker with real content is left alone: removing it
// would take the real content with it, and dropping just the block would leave
// an empty message. Not observed in the wild — the single-block guard above is
// what enforces it.
export function isStrippableStandalone(message) {
  const text = standaloneMarkerText(message);
  if (typeof text !== "string") return false;
  return STANDALONE_PATTERNS.some((rx) => rx.test(text));
}

// A cache_control marker anywhere on the message.
//
// Removing a message shifts every later index, and if the removed message
// carried a breakpoint the marker set collapses with it. Two live incidents in
// the private deployment this came from (664k and 251k cold writes) were
// exactly that, from deleting a different class of standalone role:system
// message. This class has never been observed carrying one — so the guard
// should never fire, and it can only ever under-strip.
export function carriesCacheControl(message) {
  if (!message || typeof message !== "object") return false;
  if (message.cache_control) return true;
  const c = message.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && typeof b === "object" && b.cache_control);
}

// Pure planner: returns the kept messages plus what was dropped.
export function planStrip(messages) {
  if (!Array.isArray(messages)) return { messages, removed: 0, skippedMarked: 0 };
  const kept = [];
  let removed = 0;
  let skippedMarked = 0;
  for (const m of messages) {
    if (isStrippableStandalone(m)) {
      if (carriesCacheControl(m)) {
        skippedMarked += 1;
      } else {
        removed += 1;
        continue;
      }
    }
    kept.push(m);
  }
  return { messages: kept, removed, skippedMarked };
}

export default {
  name: "standalone-reminder-strip",
  description:
    "Remove CC bookkeeping that arrives as a whole role:system message rather than a " +
    "<system-reminder>-wrapped block (the remaining-budget marker, the task/TodoWrite reminders, the " +
    "token/USD counters). CC emits them inconsistently between turns, so present-vs-absent rewrites the " +
    "prefix. Reuses content-strip's patterns. Disable with CACHE_FIX_STRIP_STANDALONE_REMINDERS=0.",
  order: 335,

  async onRequest(ctx) {
    if (envDisabled()) return;
    const body = ctx.body;
    if (!body || !Array.isArray(body.messages)) return;

    const plan = planStrip(body.messages);
    if (plan.removed === 0 && plan.skippedMarked === 0) return;

    if (plan.removed > 0) body.messages = plan.messages;

    ctx.meta._standaloneReminderStrip = {
      standalone_removed: plan.removed,
      ...(plan.skippedMarked ? { standalone_kept_marked: plan.skippedMarked } : {}),
    };
  },
};
