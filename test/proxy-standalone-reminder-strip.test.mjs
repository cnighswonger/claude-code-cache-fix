import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ext, {
  carriesCacheControl,
  isStrippableStandalone,
  planStrip,
  standaloneMarkerText,
} from "../proxy/extensions/standalone-reminder-strip.mjs";

const MARKER = "<total_tokens>14945929 tokens left</total_tokens>";
// The subagent cost block CC parses back with /<total_tokens>(\d+)<\/total_tokens>/.
// Every assertion mentioning it is guarding that it is NEVER touched.
const USAGE =
  "<usage><total_tokens>12345</total_tokens><tool_uses>3</tool_uses><duration_ms>10</duration_ms></usage>";

let origEnv;
beforeEach(() => {
  origEnv = process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS;
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS;
  else process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS = origEnv;
});

const sysString = (text) => ({ role: "system", content: text });
const sysBlock = (text) => ({ role: "system", content: [{ type: "text", text }] });
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const mkCtx = (messages) => ({ headers: {}, meta: {}, body: { messages } });

// --- both serializations -----------------------------------------------------

test("the marker is recognised as a bare string AND as a single text block", () => {
  // CC flips the same message between the two forms as history ages — 122
  // role:system messages flipped inside one 28-second window in the capture
  // this came from. Matching one form reproduces the drift, one level down.
  assert.equal(standaloneMarkerText(sysString(MARKER)), MARKER);
  assert.equal(standaloneMarkerText(sysBlock(MARKER)), MARKER);
  assert.ok(isStrippableStandalone(sysString(MARKER)));
  assert.ok(isStrippableStandalone(sysBlock(MARKER)));
});

test("non-system roles are never candidates", () => {
  assert.equal(standaloneMarkerText(user(MARKER)), null);
  assert.equal(isStrippableStandalone({ role: "assistant", content: MARKER }), false);
});

test("a message mixing the marker with real content is left alone", () => {
  // Removing it would take the real content with it; dropping just the block
  // would leave an empty message.
  const mixed = {
    role: "system",
    content: [
      { type: "text", text: MARKER },
      { type: "text", text: "something real" },
    ],
  };
  assert.equal(isStrippableStandalone(mixed), false);
});

// --- the subagent usage block is never touched -------------------------------

test("the subagent usage block is not the marker", () => {
  // Safe on three independent grounds: ^<total_tokens> cannot match a string
  // starting with <usage>; " tokens left" excludes the digits-only form; and
  // the gate is role:system-only while that copy lives in a tool_result.
  assert.equal(isStrippableStandalone(sysString(USAGE)), false);
  assert.equal(isStrippableStandalone(sysBlock(USAGE)), false);
  assert.equal(isStrippableStandalone(sysString("<total_tokens>12345</total_tokens>")), false);
});

test("a usage block inside a tool_result survives a full strip", async () => {
  const ctx = mkCtx([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: USAGE }] },
    sysBlock(MARKER),
  ]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 1, "the marker should have gone");
  assert.ok(JSON.stringify(ctx.body.messages[0]).includes(USAGE), "usage block was destroyed");
});

// --- the strip ---------------------------------------------------------------

test("markers are removed and real conversation is untouched", async () => {
  const ctx = mkCtx([
    user("hi"),
    sysBlock(MARKER),
    { role: "assistant", content: [{ type: "text", text: "yo" }] },
    sysString("<total_tokens>999 tokens left</total_tokens>"),
  ]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 2);
  assert.ok(ctx.body.messages.every((m) => m.role !== "system"));
  assert.equal(ctx.meta._standaloneReminderStrip.standalone_removed, 2);
});

test("THE DEFECT — a pruned marker no longer shifts the prefix", () => {
  // CC prunes older markers out of mid-history as the conversation grows, and
  // each prune rewrites the prefix from that index. Modelled here as the warm
  // body and the next turn's body, which differ only by a pruned marker.
  const warm = [user("a"), sysBlock(MARKER), user("b"), user("c")];
  const cold = [user("a"), user("b"), user("c")]; // CC dropped the marker

  const prefix = (x, y) => {
    let i = 0;
    while (i < Math.min(x.length, y.length) && JSON.stringify(x[i]) === JSON.stringify(y[i])) i++;
    return i;
  };
  assert.equal(prefix(warm, cold), 1, "premise: the prune caps the shared prefix at the marker");

  const after = prefix(planStrip(warm).messages, planStrip(cold).messages);
  assert.equal(after, 3, "with both bodies stripped the prune is a no-op");
});

test("a body with no markers is returned untouched and annotates nothing", async () => {
  const messages = [user("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }];
  const ctx = mkCtx(messages);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages, messages, "the array should not have been rebuilt");
  assert.equal(ctx.meta._standaloneReminderStrip, undefined);
});

// --- the marker-collapse guard ----------------------------------------------

test("a marker carrying cache_control is KEPT", async () => {
  // Removing a message shifts every later index, and if the removed message
  // carried a breakpoint the marker set collapses with it — two live incidents
  // (664k and 251k cold) came from exactly that on a different class of
  // standalone role:system message. Never observed on this class, so the guard
  // should never fire and can only under-strip.
  const marked = { role: "system", content: [{ type: "text", text: MARKER, cache_control: { type: "ephemeral" } }] };
  assert.ok(carriesCacheControl(marked));
  const ctx = mkCtx([user("a"), marked, user("b")]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 3, "a breakpoint-carrying message must survive");
  assert.equal(ctx.meta._standaloneReminderStrip.standalone_kept_marked, 1);
  assert.equal(ctx.meta._standaloneReminderStrip.standalone_removed, 0);
});

test("message-level cache_control counts too", () => {
  assert.ok(carriesCacheControl({ role: "system", content: MARKER, cache_control: { type: "ephemeral" } }));
  assert.equal(carriesCacheControl(sysBlock(MARKER)), false);
});

// --- the rest of content-strip's vocabulary, in the standalone location ------

test("the task reminder is stripped as a standalone message", async () => {
  // Already in content-strip's BOOKKEEPING_PATTERNS, but only reachable in the
  // wrapped shape. CC emits it standalone too, and inconsistently between
  // consecutive requests — present at 02:05:22, absent at 02:06:12 on one
  // session. Two replayed cold writes broke at exactly this message:
  // prefix 794->826 and 862->898.
  const reminder =
    "The task tools haven't been used recently. If you're working on tasks that would benefit from " +
    "tracking progress, consider using TaskCreate.";
  assert.ok(isStrippableStandalone(sysString(reminder)));
  assert.ok(isStrippableStandalone(sysBlock(reminder)));
  const ctx = mkCtx([user("a"), sysString(reminder), user("b")]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 2);
  assert.equal(ctx.meta._standaloneReminderStrip.standalone_removed, 1);
});

test("the imported vocabulary covers the rest for free", () => {
  // Imported from content-strip rather than copied, so a pattern added there is
  // covered here without a second edit — and cannot go stale the way a copy
  // would.
  for (const text of [
    "The TodoWrite tool hasn't been used recently. Consider using it.",
    "Token usage: 1234/200000; 198766 remaining",
    "USD budget: $1.23/$5.00; $3.77 remaining",
    "Remaining conversation turns: 12",
    "Messages until auto-compact: 40",
  ]) {
    assert.ok(isStrippableStandalone(sysString(text)), text);
  }
});

test("real content is never a candidate", () => {
  for (const text of [
    "The user sent a new message while you were working",
    "Please use the task tools to track this.",
    "Token usage is looking fine.",
    "",
  ]) {
    assert.equal(isStrippableStandalone(sysString(text)), false, text);
  }
});

// --- gate and robustness -----------------------------------------------------

test("CACHE_FIX_STRIP_STANDALONE_REMINDERS=0 disables it", async () => {
  process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS = "0";
  const ctx = mkCtx([user("a"), sysBlock(MARKER)]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 2);
  assert.equal(ctx.meta._standaloneReminderStrip, undefined);
});

test("on by default", async () => {
  delete process.env.CACHE_FIX_STRIP_STANDALONE_REMINDERS;
  const ctx = mkCtx([user("a"), sysBlock(MARKER)]);
  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 1);
});

test("a malformed body is left alone", async () => {
  for (const body of [undefined, null, {}, { messages: "nope" }, { messages: null }]) {
    const ctx = { headers: {}, meta: {}, body };
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._standaloneReminderStrip, undefined);
  }
  assert.deepEqual(planStrip("nope"), { messages: "nope", removed: 0, skippedMarked: 0 });
  assert.equal(standaloneMarkerText(null), null);
});

test("registration: declares its own order", () => {
  assert.equal(ext.name, "standalone-reminder-strip");
  assert.equal(ext.order, 335, "immediately after content-strip (330), whose patterns it borrows");
  assert.equal(typeof ext.onRequest, "function");
});
