import { createHash } from "node:crypto";

const _pinnedBlocks = new Map();

const SESSION_START_RESUME_MARKER = /SessionStart:resume hook success:/g;
const SESSION_START_ID_TAG = /\n?<session-id>[^<]*<\/session-id>/g;
const SESSION_START_LAST_ACTIVE_LINE = /\nLast active:[^\n]*/g;
const CONTINUE_TRAILER_TEXT = "Continue from where you left off.";

const REMINDER_WRAP_REGEX = /^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>\s*$/;
const BOOKKEEPING_REMINDER_PATTERNS = [
  /^Token usage: \d+\/\d+; \d+ remaining\s*$/,
  /^Output tokens \u2014 turn: [^\n]+ \u00b7 session: [^\n]+\s*$/,
  /^USD budget: \$[\d.]+\/\$[\d.]+; \$[\d.]+ remaining\s*$/,
];

function pinBlockContent(blockType, text) {
  const normalized = text.replace(/\s+(<\/system-reminder>)\s*$/, "\n$1");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const pinned = _pinnedBlocks.get(blockType);

  if (pinned && pinned.hash === hash) {
    return pinned.text;
  }

  _pinnedBlocks.set(blockType, { hash, text: normalized });
  return normalized;
}

function stripSessionKnowledge(text) {
  return text.replace(
    /\n<session_knowledge[^>]*>[\s\S]*?<\/session_knowledge>/g,
    ""
  );
}

function normalizeSessionStartText(text) {
  if (typeof text !== "string" || !text.includes("SessionStart:")) return [text, 0];
  let count = 0;
  let out = text;
  if (SESSION_START_RESUME_MARKER.test(out)) {
    SESSION_START_RESUME_MARKER.lastIndex = 0;
    out = out.replace(SESSION_START_RESUME_MARKER, "SessionStart:startup hook success:");
    count++;
  }
  if (SESSION_START_ID_TAG.test(out)) {
    SESSION_START_ID_TAG.lastIndex = 0;
    out = out.replace(SESSION_START_ID_TAG, "");
    count++;
  }
  if (SESSION_START_LAST_ACTIVE_LINE.test(out)) {
    SESSION_START_LAST_ACTIVE_LINE.lastIndex = 0;
    out = out.replace(SESSION_START_LAST_ACTIVE_LINE, "");
    count++;
  }
  return [out, count];
}

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
  for (const rx of BOOKKEEPING_REMINDER_PATTERNS) {
    if (rx.test(inner)) return true;
  }
  return false;
}

export { pinBlockContent, stripSessionKnowledge, normalizeSessionStartText, isContinueTrailerBlock, isBookkeepingReminder };

export default {
  name: "identity-normalization",
  description: "Normalize volatile identity fields (SessionStart, Continue trailers, bookkeeping) for cache stability",
  order: 300,

  async onRequest(ctx) {
    const { body } = ctx;

    if (Array.isArray(body.system)) {
      for (let i = 0; i < body.system.length; i++) {
        const block = body.system[i];
        if (block.type !== "text" || typeof block.text !== "string") continue;

        let text = block.text;
        if (text.includes("session_knowledge")) {
          text = stripSessionKnowledge(text);
        }
        if (text.includes("<system-reminder>")) {
          text = pinBlockContent(`system_${i}`, text);
        }
        if (text !== block.text) {
          body.system[i] = { ...block, text };
        }
      }
    }

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;

        for (let i = msg.content.length - 1; i >= 0; i--) {
          const block = msg.content[i];
          if (block.type !== "text" || typeof block.text !== "string") continue;

          if (isContinueTrailerBlock(block) && i === msg.content.length - 1 && msg.role === "user") {
            continue;
          }

          if (isBookkeepingReminder(block.text)) {
            continue;
          }

          const [normalized] = normalizeSessionStartText(block.text);
          if (normalized !== block.text) {
            msg.content[i] = { ...block, text: normalized };
          }
        }
      }
    }
  },
};
