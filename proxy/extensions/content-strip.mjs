const CONTINUE_TRAILER_TEXT = "Continue from where you left off.";

const REMINDER_WRAP_REGEX = /^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>\s*$/;
const BOOKKEEPING_PATTERNS = [
  /^Token usage: \d+\/\d+; \d+ remaining\s*$/,
  /^Output tokens — turn: [^\n]+ · session: [^\n]+\s*$/,
  /^USD budget: \$[\d.]+\/\$[\d.]+; \$[\d.]+ remaining\s*$/,
  /^The task tools haven't been used recently\./,
  /^The TodoWrite tool hasn't been used recently\./,
  /^Remaining conversation turns: /,
  /^Messages? until auto-compact: /,
];

function isContinueTrailerBlock(block) {
  return (
    !!block &&
    typeof block === "object" &&
    block.type === "text" &&
    block.text === CONTINUE_TRAILER_TEXT
  );
}

function isBookkeepingReminder(text) {
  if (typeof text !== "string") return false;
  const m = text.match(REMINDER_WRAP_REGEX);
  if (!m) return false;
  const inner = m[1];
  for (const rx of BOOKKEEPING_PATTERNS) {
    if (rx.test(inner)) return true;
  }
  return false;
}

function stripContentBlocks(messages) {
  if (!Array.isArray(messages)) return { messages, stats: null };

  let trailerCount = 0;
  let reminderCount = 0;

  const result = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    let msgTrailers = 0;
    let msgReminders = 0;

    const kept = msg.content.filter((block) => {
      if (isContinueTrailerBlock(block)) {
        msgTrailers++;
        return false;
      }
      if (block.type === "text" && isBookkeepingReminder(block.text)) {
        msgReminders++;
        return false;
      }
      return true;
    });

    if (kept.length === 0 || kept.length === msg.content.length) return msg;

    trailerCount += msgTrailers;
    reminderCount += msgReminders;
    return { ...msg, content: kept };
  });

  const total = trailerCount + reminderCount;
  return {
    messages: total > 0 ? result : messages,
    stats: total > 0 ? { trailerCount, reminderCount } : null,
  };
}

// BOOKKEEPING_PATTERNS is exported so a sibling extension can strip the SAME
// content in a location this one does not reach — CC emits these as whole
// role:system messages as well as wrapped blocks. Reuse, not a second copy that
// goes stale when a pattern is added here.
export { isContinueTrailerBlock, isBookkeepingReminder, stripContentBlocks, BOOKKEEPING_PATTERNS };

export default {
  name: "content-strip",
  description: "Strip continue trailers and bookkeeping system-reminders from user messages",
  enabled: false,
  order: 350,

  async onRequest(ctx) {
    if (!ctx.body.messages) return;

    const { messages, stats } = stripContentBlocks(ctx.body.messages);
    if (stats) {
      ctx.body.messages = messages;
      ctx.meta.contentStripStats = stats;
    }
  },
};
