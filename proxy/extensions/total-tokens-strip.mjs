// total-tokens-strip — drop CC's standalone remaining-budget marker before it
// reaches the wire.
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
// Order 335: after smoosh-split (320) and content-strip (330) — the other
// message-level removals — and before tool-input-normalize (340) and
// cache-control-normalize (400), so marker placement is computed over the final
// message list.
//
// Gate: CACHE_FIX_STRIP_TOTAL_TOKENS, default ON. It removes bytes the model
// never reads, and leaving it off by default would mean shipping a measured
// six-figure cache cost as an opt-in.

const MARKER = /^<total_tokens>\d+ tokens left<\/total_tokens>\s*$/;

function envDisabled() {
  return process.env.CACHE_FIX_STRIP_TOTAL_TOKENS === "0";
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
export function isBudgetMarkerMessage(message) {
  const text = standaloneMarkerText(message);
  return typeof text === "string" && MARKER.test(text);
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
    if (isBudgetMarkerMessage(m)) {
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
  name: "total-tokens-strip",
  description:
    "Remove CC's standalone <total_tokens>N tokens left</total_tokens> role:system messages from the " +
    "outbound body. CC prunes them out of mid-history as the conversation grows and each prune rewrites " +
    "the prefix. Disable with CACHE_FIX_STRIP_TOTAL_TOKENS=0.",
  order: 335,

  async onRequest(ctx) {
    if (envDisabled()) return;
    const body = ctx.body;
    if (!body || !Array.isArray(body.messages)) return;

    const plan = planStrip(body.messages);
    if (plan.removed === 0 && plan.skippedMarked === 0) return;

    if (plan.removed > 0) body.messages = plan.messages;

    ctx.meta._totalTokensStrip = {
      total_tokens_removed: plan.removed,
      ...(plan.skippedMarked ? { total_tokens_kept_marked: plan.skippedMarked } : {}),
    };
  },
};
