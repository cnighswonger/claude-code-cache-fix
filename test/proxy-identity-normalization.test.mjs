import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  pinBlockContent,
  stripSessionKnowledge,
  normalizeSessionStartText,
  isContinueTrailerBlock,
  isBookkeepingReminder,
} from "../proxy/extensions/identity-normalization.mjs";

// --- Unit tests: stripSessionKnowledge ---

test("stripSessionKnowledge: removes session_knowledge tags", () => {
  const input = 'before\n<session_knowledge key="x">data</session_knowledge>\nafter';
  const result = stripSessionKnowledge(input);
  assert.ok(!result.includes("session_knowledge"));
  assert.ok(result.includes("before"));
  assert.ok(result.includes("after"));
});

test("stripSessionKnowledge: removes multiple session_knowledge tags", () => {
  const input = 'a\n<session_knowledge key="1">d1</session_knowledge>\nb\n<session_knowledge key="2">d2</session_knowledge>\nc';
  const result = stripSessionKnowledge(input);
  assert.ok(!result.includes("session_knowledge"));
  assert.ok(result.includes("a") && result.includes("b") && result.includes("c"));
});

test("stripSessionKnowledge: no-op on text without session_knowledge", () => {
  const input = "no knowledge here";
  assert.equal(stripSessionKnowledge(input), input);
});

// --- Unit tests: normalizeSessionStartText ---

test("normalizeSessionStartText: returns tuple [text, count]", () => {
  const [text, count] = normalizeSessionStartText("normal text");
  assert.equal(text, "normal text");
  assert.equal(count, 0);
});

test("normalizeSessionStartText: strips session-id tag", () => {
  const input = 'SessionStart:startup hook success: pre <session-id>abc123</session-id> post';
  const [text, count] = normalizeSessionStartText(input);
  assert.ok(!text.includes("session-id"), "session-id tag should be removed");
  assert.ok(!text.includes("abc123"), "session-id content should be removed");
  assert.ok(count > 0);
});

test("normalizeSessionStartText: strips Last active line", () => {
  const input = 'SessionStart:startup hook success: pre\nLast active: 2026-04-23\npost';
  const [text, count] = normalizeSessionStartText(input);
  assert.ok(!text.includes("Last active"), "Last active line should be removed");
  assert.ok(count > 0);
});

test("normalizeSessionStartText: no-op without SessionStart marker", () => {
  const input = "no session start marker in this text";
  const [text, count] = normalizeSessionStartText(input);
  assert.equal(text, input);
  assert.equal(count, 0);
});

test("normalizeSessionStartText: rewrites SessionStart:resume → :startup", () => {
  const input = "<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n</system-reminder>";
  const [out, count] = normalizeSessionStartText(input);
  assert.ok(out.includes("SessionStart:startup hook success:"));
  assert.ok(!out.includes("SessionStart:resume"));
  assert.ok(count >= 1);
});

test("normalizeSessionStartText: startup marker is unchanged (no mutation)", () => {
  const input = "<system-reminder>\nSessionStart:startup hook success: [hook-reload] ok\n</system-reminder>";
  const [out, count] = normalizeSessionStartText(input);
  assert.equal(out, input);
  assert.equal(count, 0);
});

test("normalizeSessionStartText: resume + session-id + Last-active normalized together", () => {
  const input =
    "<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n<session-id>xyz-999</session-id>\nLast active: 2026-04-17T10:00:00Z\n[hook-reload] done\n</system-reminder>";
  const [out] = normalizeSessionStartText(input);
  assert.ok(out.includes("SessionStart:startup hook success:"));
  assert.ok(!out.includes("SessionStart:resume"));
  assert.ok(!out.includes("<session-id>"));
  assert.ok(!out.includes("xyz-999"));
  assert.ok(!/Last active: \d{4}/.test(out));
});

test("normalizeSessionStartText: idempotent (running twice equals running once)", () => {
  const input =
    "<system-reminder>\nSessionStart:resume hook success:\nLast active: 2026-04-17T10:00:00Z\n[hook-reload] running\n</system-reminder>";
  const [once] = normalizeSessionStartText(input);
  const [twice] = normalizeSessionStartText(once);
  assert.equal(twice, once);
});

// --- Unit tests: pinBlockContent ---

test("pinBlockContent: normalizes trailing whitespace", () => {
  const input = "content  \n</system-reminder>  \n";
  const result = pinBlockContent("test_block", input);
  assert.ok(result.endsWith("</system-reminder>"), "should normalize trailing whitespace");
});

test("pinBlockContent: returns same text for identical content (deterministic)", () => {
  const text = "content\n</system-reminder>";
  const a = pinBlockContent("determ_test", text);
  const b = pinBlockContent("determ_test", text);
  assert.equal(a, b);
});

// --- Unit tests: isContinueTrailerBlock ---

test("isContinueTrailerBlock: detects continue trailer", () => {
  assert.ok(isContinueTrailerBlock({ type: "text", text: "Continue from where you left off." }));
});

test("isContinueTrailerBlock: does not match longer text", () => {
  assert.ok(!isContinueTrailerBlock({ type: "text", text: "Please continue from where you left off and also do this." }));
});

test("isContinueTrailerBlock: does not match non-text blocks", () => {
  assert.ok(!isContinueTrailerBlock({ type: "image" }));
  assert.ok(!isContinueTrailerBlock(null));
  assert.ok(!isContinueTrailerBlock(undefined));
});

// --- Unit tests: isBookkeepingReminder ---

test("isBookkeepingReminder: detects token usage format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nToken usage: 50000/200000; 150000 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: detects output tokens format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nOutput tokens — turn: 500 · session: 3000\n</system-reminder>"));
});

test("isBookkeepingReminder: detects USD budget format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nUSD budget: $5.00/$10.00; $5.00 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: does not match non-bookkeeping reminders", () => {
  assert.ok(!isBookkeepingReminder("<system-reminder>\nImportant project context.\n</system-reminder>"));
});

test("isBookkeepingReminder: does not match non-reminder text", () => {
  assert.ok(!isBookkeepingReminder("Just normal text."));
});

test("isBookkeepingReminder: handles non-string input", () => {
  assert.ok(!isBookkeepingReminder(null));
  assert.ok(!isBookkeepingReminder(42));
});

// --- Integration tests: onRequest ---

test("onRequest: normalizes system blocks with session_knowledge", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: 'hook output\n<session_knowledge key="k">data</session_knowledge>\nrest' },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "prompt" }] }],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(!ctx.body.system[0].text.includes("session_knowledge"));
});

test("onRequest: normalizes SessionStart text in message content", async () => {
  const ctx = {
    body: {
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: 'SessionStart:startup hook success: ok <session-id>xyz</session-id> done' },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(!ctx.body.messages[0].content[0].text.includes("session-id"), "session-id should be stripped from message content");
});

test("onRequest: rewrites SessionStart:resume → :startup in message content", async () => {
  const ctx = {
    body: {
      system: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n<session-id>abc-123</session-id>\n</system-reminder>",
            },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  const out = ctx.body.messages[0].content[0].text;
  assert.ok(out.includes("SessionStart:startup hook success:"), "resume marker should be rewritten to startup");
  assert.ok(!out.includes("SessionStart:resume"), "resume marker should be gone");
  assert.ok(!out.includes("<session-id>"), "session-id tag should be stripped");
});

test("onRequest: handles empty messages array", async () => {
  const ctx = { body: { messages: [], system: [] }, headers: {}, meta: {} };
  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.messages, []);
});

test("onRequest: preserves content when all blocks are continue trailers", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Continue from where you left off." }],
        },
      ],
      system: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(ctx.body.messages[0].content.length > 0);
});
