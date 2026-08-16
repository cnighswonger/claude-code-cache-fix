import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ext, { maskCurrentDate, normalizeMessages } from "../proxy/extensions/currentdate-normalize.mjs";

const LINE = "Today's date is 2026-08-16.";
const MASKED = "Today's date is 0000-00-00.";
const CLAUDEMD = `<system-reminder>\n# currentDate\n${LINE}\n</system-reminder>`;

let origEnv;
beforeEach(() => {
  origEnv = process.env.CACHE_FIX_NORMALIZE_CURRENTDATE;
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.CACHE_FIX_NORMALIZE_CURRENTDATE;
  else process.env.CACHE_FIX_NORMALIZE_CURRENTDATE = origEnv;
});

const block = (text) => ({ role: "user", content: [{ type: "text", text }] });
const mkCtx = (body) => ({ headers: {}, meta: {}, body });

// --- the mask ----------------------------------------------------------------

test("masks the date and leaves everything around it alone", () => {
  const r = maskCurrentDate(CLAUDEMD);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes(MASKED));
  assert.ok(r.text.includes("# currentDate"), "the header must survive — the signal is abstracted, not removed");
  assert.ok(!r.text.includes("2026-08-16"));
});

test("IDEMPOTENT — running twice is byte-identical and counts once", () => {
  // A proxy can see the same body more than once (retries, replays). A
  // non-idempotent mask would keep reporting work and, worse, could differ
  // between two emissions of the same body.
  const once = maskCurrentDate(CLAUDEMD);
  const twice = maskCurrentDate(once.text);
  assert.equal(twice.count, 0, "second pass must find nothing");
  assert.equal(twice.text, once.text);
});

test("masks every occurrence in one string", () => {
  const r = maskCurrentDate(`${LINE}\n...\nToday's date is 2025-01-02.`);
  assert.equal(r.count, 2);
  assert.ok(!/20\d\d-\d\d-\d\d/.test(r.text.replace(/0000-00-00/g, "")));
});

test("does not require the # currentDate header", () => {
  // CC emits the line both with and without the markdown header across
  // claudeMd shapes, so anchoring on the header would miss half the cases.
  assert.equal(maskCurrentDate(LINE).count, 1);
});

test("leaves unrelated dates and prose alone", () => {
  for (const s of [
    "The release was on 2026-08-16.",
    "Today's date is unknown.",
    "Todays date is 2026-08-16.",
    "Today's date is 2026-8-16.",
    "",
  ]) {
    assert.equal(maskCurrentDate(s).count, 0, s);
  }
  assert.equal(maskCurrentDate(null).count, 0);
  assert.equal(maskCurrentDate(42).count, 0);
});

// --- the walk ----------------------------------------------------------------

test("normalizeMessages handles block content and string content", () => {
  const msgs = [block(CLAUDEMD), { role: "user", content: LINE }];
  assert.equal(normalizeMessages(msgs), 2);
  assert.ok(msgs[0].content[0].text.includes(MASKED));
  assert.equal(msgs[1].content, MASKED);
});

test("normalizeMessages tolerates junk", () => {
  assert.equal(normalizeMessages(null), 0);
  assert.equal(normalizeMessages("nope"), 0);
  assert.equal(normalizeMessages([null, 7, {}, { content: 3 }, { content: [null, { text: 1 }] }]), 0);
});

// --- onRequest ---------------------------------------------------------------

test("THE DEFECT — midnight no longer moves the prefix", async () => {
  // The same session serialized either side of a calendar rollover. Before the
  // mask these bodies differ at the claudeMd block, which sits ahead of the
  // first cache_control marker — so everything from byte 0 invalidates.
  const before = mkCtx({ messages: [block(`# currentDate\n${LINE}`), block("real content")] });
  const after = mkCtx({ messages: [block("# currentDate\nToday's date is 2026-08-17."), block("real content")] });

  assert.notEqual(
    JSON.stringify(before.body.messages),
    JSON.stringify(after.body.messages),
    "premise: the rollover really does change the bytes",
  );

  await ext.onRequest(before);
  await ext.onRequest(after);

  assert.equal(
    JSON.stringify(before.body.messages),
    JSON.stringify(after.body.messages),
    "after masking, the two sides of midnight must be byte-identical",
  );
});

test("annotates only when it changed something", async () => {
  const hit = mkCtx({ messages: [block(CLAUDEMD)] });
  await ext.onRequest(hit);
  assert.equal(hit.meta._currentDateNormalize.currentdate_blocks_masked, 1);

  const miss = mkCtx({ messages: [block("nothing to see")] });
  await ext.onRequest(miss);
  assert.equal(miss.meta._currentDateNormalize, undefined);
});

test("also masks a top-level system block", async () => {
  const ctx = mkCtx({ messages: [], system: [{ type: "text", text: CLAUDEMD }] });
  await ext.onRequest(ctx);
  assert.ok(ctx.body.system[0].text.includes(MASKED));

  const asString = mkCtx({ messages: [], system: LINE });
  await ext.onRequest(asString);
  assert.equal(asString.body.system, MASKED);
});

test("CACHE_FIX_NORMALIZE_CURRENTDATE=0 disables it", async () => {
  process.env.CACHE_FIX_NORMALIZE_CURRENTDATE = "0";
  const ctx = mkCtx({ messages: [block(CLAUDEMD)] });
  await ext.onRequest(ctx);
  assert.ok(ctx.body.messages[0].content[0].text.includes("2026-08-16"));
});

test("a malformed body is left alone", async () => {
  for (const body of [undefined, null, {}, { messages: "nope" }]) {
    const ctx = { headers: {}, meta: {}, body };
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._currentDateNormalize, undefined);
  }
});

test("registration: declares its own order", () => {
  assert.equal(ext.name, "currentdate-normalize");
  assert.equal(ext.order, 310, "beside identity-normalization (300), before the cache_control mutators");
  assert.equal(typeof ext.onRequest, "function");
});
