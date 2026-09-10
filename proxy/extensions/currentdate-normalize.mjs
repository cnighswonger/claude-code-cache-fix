// currentdate-normalize — mask CC's daily current-date injection so the
// calendar rolling over mid-session does not invalidate the prefix.
//
// CC stamps the date into the claudeMd system-reminder block:
//
//     # currentDate
//     Today's date is 2026-08-16.
//
// It sits deep inside the first user message's injected claudeMd block —
// measured ~30k characters into `messages[0].content[3]` on one capture. When
// the calendar day rolls over mid-session that value advances by one, and
// everything from byte 0 through the first cache_control marker invalidates:
// a full cold write, once per midnight, for every session still running.
// Measured at ~386k tokens on the session that motivated it (2026-04-23
// 00:34:50).
//
// It is a *scheduled* cache bust — the one class you can predict to the minute
// — and it scales with how long sessions live rather than with what they do.
//
// The fix is to write a canonical placeholder in place of the value. The model
// still sees the `# currentDate` header, so the signal is visibly abstracted
// rather than missing, and CC still delivers the real rollover separately via
// its own "The date has changed" system-reminder when it actually happens.
//
// The placeholder keeps the YYYY-MM-DD shape so anything downstream that
// parses that format keeps parsing.
//
// Order 310: beside identity-normalization (300), which stabilizes the same
// class of volatile per-turn field inside otherwise-stable reminder blocks, and
// before the cache_control mutators.
//
// Gate: CACHE_FIX_NORMALIZE_CURRENTDATE=0 to disable. Default on — the
// alternative is a scheduled full cold write per session per day.

const PLACEHOLDER = "0000-00-00";

// Deliberately NOT anchored on the `# currentDate` header above it: CC has
// been observed emitting the line both with and without that header across
// claudeMd shapes. The sentence is specific enough that matching it anywhere is
// safe — content that coincidentally contains it benefits from the same
// stabilization.
//
// The negative lookahead keeps the transform IDEMPOTENT: running twice
// produces the same bytes and the same count as running once, which matters
// because a proxy may see the same body more than once (retries, replays).
const DATE_LINE = /(Today's date is )(?!0000-00-00\.)\d{4}-\d{2}-\d{2}(\.)/g;

function envDisabled() {
  return process.env.CACHE_FIX_NORMALIZE_CURRENTDATE === "0";
}

// Pure: returns { text, count }. count is the number of dates masked.
export function maskCurrentDate(text) {
  if (typeof text !== "string" || !text.includes("Today's date is ")) {
    return { text, count: 0 };
  }
  let count = 0;
  const out = text.replace(DATE_LINE, (_m, head, tail) => {
    count += 1;
    return `${head}${PLACEHOLDER}${tail}`;
  });
  return { text: out, count };
}

// Walk every text-bearing block of a message list and mask in place.
// Returns the number of blocks changed.
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let applied = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.content === "string") {
      const r = maskCurrentDate(m.content);
      if (r.count) {
        m.content = r.text;
        applied += 1;
      }
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object" || typeof b.text !== "string") continue;
      const r = maskCurrentDate(b.text);
      if (r.count) {
        b.text = r.text;
        applied += 1;
      }
    }
  }
  return applied;
}

export default {
  name: "currentdate-normalize",
  description:
    "Mask CC's 'Today's date is YYYY-MM-DD.' injection to a canonical placeholder so the calendar rolling " +
    "over mid-session does not invalidate the whole prefix. Disable with CACHE_FIX_NORMALIZE_CURRENTDATE=0.",
  order: 310,

  async onRequest(ctx) {
    if (envDisabled()) return;
    const body = ctx.body;
    if (!body) return;

    let applied = normalizeMessages(body.messages);

    // The same line has been observed in top-level system blocks; masking it
    // there too costs one walk and keeps the two locations consistent.
    if (Array.isArray(body.system)) {
      for (const b of body.system) {
        if (!b || typeof b !== "object" || typeof b.text !== "string") continue;
        const r = maskCurrentDate(b.text);
        if (r.count) {
          b.text = r.text;
          applied += 1;
        }
      }
    } else if (typeof body.system === "string") {
      const r = maskCurrentDate(body.system);
      if (r.count) {
        body.system = r.text;
        applied += 1;
      }
    }

    if (applied > 0) {
      ctx.meta._currentDateNormalize = { currentdate_blocks_masked: applied };
    }
  },
};
