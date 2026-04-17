import { test } from "node:test";
import assert from "node:assert/strict";
import { isBookkeepingReminder } from "../preload.mjs";

function wrap(inner) {
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

test("isBookkeepingReminder: Token usage reminder matches", () => {
  assert.equal(isBookkeepingReminder(wrap("Token usage: 150/200; 50 remaining")), true);
});

test("isBookkeepingReminder: USD budget reminder matches", () => {
  assert.equal(
    isBookkeepingReminder(wrap("USD budget: $1.50/$10.00; $8.50 remaining")),
    true
  );
});

test("isBookkeepingReminder: Output tokens reminder matches (em-dash + middot format)", () => {
  assert.equal(
    isBookkeepingReminder(wrap("Output tokens \u2014 turn: 500 \u00b7 session: 3200")),
    true
  );
});

test("isBookkeepingReminder: TodoWrite nudge matches", () => {
  const body = "The TodoWrite tool hasn't been used recently. Consider using it...";
  assert.equal(isBookkeepingReminder(wrap(body)), true);
});

test("isBookkeepingReminder: task-tools nudge matches", () => {
  const body = "The task tools haven't been used recently. Consider creating tasks...";
  assert.equal(isBookkeepingReminder(wrap(body)), true);
});

test("isBookkeepingReminder: Remaining conversation turns counter matches", () => {
  assert.equal(isBookkeepingReminder(wrap("Remaining conversation turns: 12")), true);
});

test("isBookkeepingReminder: Messages until auto-compact counter matches", () => {
  assert.equal(isBookkeepingReminder(wrap("Messages until auto-compact: 24")), true);
  assert.equal(isBookkeepingReminder(wrap("Message until auto-compact: 1")), true);
});

test("isBookkeepingReminder: hook-injected reminders are NOT matched", () => {
  const hookReminders = [
    "PreToolUse:Edit hook blocking error from command: blocked",
    "PostToolUse:Bash hook additional context: [thinking-enrichment] hint",
    "UserPromptSubmit hook additional context: [classify-user-intent.py] intent",
    "SessionStart:startup hook success: reload done",
    "The user sent a new message while you were working: hello",
  ];
  for (const inner of hookReminders) {
    assert.equal(isBookkeepingReminder(wrap(inner)), false, `should not match: ${inner}`);
  }
});

test("isBookkeepingReminder: claudeMd preamble is NOT matched", () => {
  const inner = "As you answer the user's questions, you can use the following context:\n# claudeMd\nSome user memory...";
  assert.equal(isBookkeepingReminder(wrap(inner)), false);
});

test("isBookkeepingReminder: deferred-tools attachment is NOT matched", () => {
  const inner = "The following deferred tools are now available via ToolSearch:\nBash\nEdit";
  assert.equal(isBookkeepingReminder(wrap(inner)), false);
});

test("isBookkeepingReminder: plain user text is NOT matched", () => {
  assert.equal(isBookkeepingReminder("Hi, what's up?"), false);
  assert.equal(isBookkeepingReminder("Token usage: 1/1"), false); // missing wrapper
});

test("isBookkeepingReminder: non-string inputs return false without throwing", () => {
  assert.equal(isBookkeepingReminder(null), false);
  assert.equal(isBookkeepingReminder(undefined), false);
  assert.equal(isBookkeepingReminder(42), false);
  assert.equal(isBookkeepingReminder({}), false);
  assert.equal(isBookkeepingReminder([]), false);
});

test("isBookkeepingReminder: partial pattern match inside longer inner body is rejected (anchored)", () => {
  // Patterns are anchored with ^ — a bookkeeping phrase embedded inside a
  // larger reminder body must NOT be stripped, because the surrounding
  // content is semantic.
  const inner = "Here is some report. Token usage: 1/1; 0 remaining. More content after.";
  assert.equal(isBookkeepingReminder(wrap(inner)), false);
});

test("isBookkeepingReminder: Token usage with slightly off format is rejected", () => {
  assert.equal(
    isBookkeepingReminder(wrap("Token usage: 150/200 remaining")), // missing semicolon count
    false
  );
  assert.equal(
    isBookkeepingReminder(wrap("Token usage: abc/xyz; foo remaining")),
    false
  );
});
