// deferred-tool-rewrite — Phase B (robustness-threat-matrix class 6).
//
// Design: docs/directives/proxy-deferred-tool-rewrite.md, including the
// 2026-07-28 Phase B addendum (documented wire shapes + persistent
// re-injection). Spec contradiction on record: CC docs say deferred-tool
// loads append without disturbing cache; measured 2026-07-27 12:47:56
// (175k, ledger row tools[SendMessage:added], toolsMatch:false) says
// otherwise on this surface. Until upstream fixes it, the proxy holds
// tools[] byte-stable across a pure tool addition and delivers the newly
// available schema per the DOCUMENTED mid-conversation-tool-changes
// contract (beta mid-conversation-tool-changes-2026-07-01):
//
//   - the new tool goes into tools[] with defer_loading: true;
//   - the announcement is a {"type": "tool_addition", "tool":
//     {"type": "tool_reference", "name": ...}} content block on a
//     {"role": "system"} message appended to messages[] — NOT a text
//     block on top-level system (Phase A's placeholder; wrong shape AND
//     wrong location — top-level system heads the cache prefix, so every
//     injection there would bust the whole cache).
//
// STATELESSNESS: the API loads a deferred tool only when its
// tool_addition block is present in THAT request, and CC never echoes
// our injected message back. So both halves re-apply every request:
// tools[] stays held with added tools permanently defer_loading:true,
// and each injected system message is re-spliced byte-identically at a
// content-anchored position (identity hash of the message it was
// injected after). Anchor pruned by context management → re-anchor after
// the latest user message, telemetry `reanchored`, one honest partial
// re-cache. Pipeline order isolates this from insertion-normalization
// (395 < 425): the canonical never sees the injected message.
//
// Detect: compare incoming tools[] against the persisted known set (keyed
// by name). Three things can happen to a known name, and only one is an
// honest content change:
//   - present, byte-unchanged (fingerprint match) → carried forward using
//     the FROZEN persisted object (not the incoming one), so its wire
//     bytes stay stable turn over turn even if the incoming array's key
//     order or position drifted;
//   - ABSENT from incoming (harness GC'd a loaded deferred tool, e.g. a
//     skills/tool-list update) → HELD: re-inserted at its first-seen
//     position using the frozen object, exactly as if it were still
//     present. Inert once held; costs ~0 (threat-matrix row 13). This
//     also fixes pure reorder diffs (e.g. DeferredToolPlaceholder moving
//     relative to its neighbors with no add/remove) as a side effect,
//     since output order is ALWAYS the first-seen order, never the
//     incoming array's order;
//   - present but fingerprint-changed → the one honest case: passthrough
//     + full reset (the directive's "never paper over a real edit" — and
//     specifically never serve a stale schema for a name that changed).
// A new name (not in the known set) is additively marked
// defer_loading:true and announced via one appended tool_addition system
// block, exactly as before. Any combination of held + new in the same
// request composes (both are additive from the wire's perspective; only
// a fingerprint change is destructive).
//
// Phase B stops at: documented shapes + persistent re-injection,
// validated by unit tests and replay A/B (directive addendum's gates 1-2).
// The final live acceptance probe (gate 3: one real request through the
// proxy at a session boundary, watch for 400 vs the model using the
// added tool) happens before the service-unit flag flips — the header
// plumbing this depended on was fixed in server.mjs 10d33e4.
//
// Activation: `enabled: true` in extensions.json (always loaded), runtime
// gate CACHE_FIX_TOOL_REWRITE=1, default OFF per directive ("Phase A (build
// now, env-gated CACHE_FIX_TOOL_REWRITE=1, default off)"). Order 425 — after
// sort-stabilization (200, so tools[] arrives name-sorted — comparisons and
// output order are keyed on name, not incoming array order);
// before ttl-management (500), consistent with the rest
// of the body-shaping extensions running ahead of the TTL pass.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { hashMessageContent, conversationSubKey } from "./message-hash.mjs";
import { systemPromptSubKey } from "./insertion-normalization.mjs";
import { createHash } from "node:crypto";

// Models known to ACCEPT the mid-conversation-tool-changes contract.
//
// Opt-IN, not opt-out, and that direction is the whole point. On 2026-07-28
// a sonnet-5 subagent dispatch died with:
//
//     API Error: 400 tool_addition/tool_removal is not supported on this model
//
// The tool_addition block is a documented beta, but support is per-MODEL and
// this extension applied it to whatever came through. A cache mitigation that
// can HARD-FAIL a request is strictly worse than no mitigation, so an unknown
// model gets no announcement: it degrades to forwarding the new tool
// normally (a tools[] change, i.e. the bust we would have prevented) instead
// of a 400 that loses the request outright.
//
// This file's own header prescribed exactly this check — "the final live
// acceptance probe (gate 3: one real request through the proxy at a session
// boundary, watch for 400 vs the model using the added tool) happens before
// the service-unit flag flips". The flag was flipped without running it.
//
// Evidence, not guesswork — tools/probe-tool-addition.mjs measures a model
// in one real request (same OAuth path as production, wire shapes imported
// from this file). Add a prefix here only with a real request behind it.
//
//   claude-opus-5    ACCEPTED  sessions 58c979ce and 538c0aef, injections on
//                              the wire, no 400.
//   claude-sonnet-5  REJECTED  the 2026-07-28 live 400 above.
//   claude-haiku-4-5 REJECTED  probe 2026-07-29: "tool_addition/tool_removal
//                              requires a model that supports mid-conversation
//                              system content; this model does not" — the
//                              probe surfaced the CAPABILITY the beta gates
//                              on, which the sonnet error never named.
//   claude-fable-5   ACCEPTED  live probe 2026-07-29, session c05a754c: a
//                              disposable `claude -p` run through a throwaway
//                              proxy (CACHE_FIX_TOOL_ADDITION_EXTRA) injected
//                              the announcement for a mid-run ToolSearch load;
//                              production's capture holds the block at
//                              messages[4], the forwarded body hash matches
//                              the recorded outSha byte-for-byte, and the
//                              outcome record shows the API streamed a 200.
//                              (Direct-API probes 429 on this subscription for
//                              ALL big models — hand-built OAuth requests are
//                              refused regardless of quota, so the through-CC
//                              path is the only working probe for them;
//                              haiku's direct probe worked because CC itself
//                              sends it free-form utility traffic.)
const TOOL_ADDITION_MODELS = ["claude-opus-5", "claude-fable-5"];

// CACHE_FIX_TOOL_ADDITION_EXTRA: comma-separated additional prefixes,
// read per call like every gate. It exists for ONE purpose — the directive's
// live acceptance probe: a throwaway proxy instance sets it so a disposable
// real session can carry the announcement to a candidate model without
// touching the production allowlist. It is never set in the service unit;
// an ACCEPTED result graduates to TOOL_ADDITION_MODELS with its evidence,
// the override does not substitute for the entry.
export function supportsToolAddition(model) {
  if (typeof model !== "string") return false;
  const extra = (process.env.CACHE_FIX_TOOL_ADDITION_EXTRA ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return TOOL_ADDITION_MODELS.concat(extra).some((prefix) => model.startsWith(prefix));
}

const BETA_TOKEN = "mid-conversation-tool-changes-2026-07-01";
const BETA_HEADER_NAME = "anthropic-beta";

const DEFAULT_FS = { readFile, writeFile, rename, appendFile, mkdir };

// Models already warned about in this process — the suppressed-announcement
// warning fires once per model, not per request. Module state is acceptable
// here precisely because losing it (restart, reload) only repeats a warning.
const warnedSuppressedModels = new Set();

// --- Env gates (read per-call, mirrors the insertion-normalization idiom) ---

function isEnabled(env = process.env) {
  return env.CACHE_FIX_TOOL_REWRITE === "1";
}

function isDebug(env = process.env) {
  return env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[deferred-tool-rewrite] DEBUG: ${msg}\n`);
}

// --- Storage (snapshots-dir idiom, mirrors insertion-normalization) ---

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

function statePath(dir, sessionKey) {
  return join(dir, `${sessionKey}-deferred-tool-canon.json`);
}

function eventsPath(dir, sessionKey) {
  return join(dir, `${sessionKey}-deferred-tool-events.jsonl`);
}

// State: { tools: [...], additions: [{ name, anchorHash, message }] }.
// `additions` (Phase B) carries each injected system message byte-frozen,
// plus the identity hash of the message it was anchored after. Old files
// without the field read as additions=[] — no migration, sessions started
// under Phase A simply have no pending injections.
async function loadState(dir, sessionKey, fs) {
  try {
    const txt = await fs.readFile(statePath(dir, sessionKey), "utf-8");
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed?.tools)) return null;
    return { tools: parsed.tools, additions: Array.isArray(parsed.additions) ? parsed.additions : [] };
  } catch (err) {
    if (err && err.code !== "ENOENT") debug(`state read failed: ${err?.message ?? err}`);
    return null;
  }
}

async function saveState(dir, sessionKey, state, fs) {
  await fs.mkdir(dir, { recursive: true });
  const finalPath = statePath(dir, sessionKey);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, finalPath);
}

async function appendTelemetry(dir, sessionKey, record, fs) {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(eventsPath(dir, sessionKey), JSON.stringify(record) + "\n");
  } catch (err) {
    debug(`telemetry append failed: ${err?.message ?? err}`);
  }
}

// --- Session key (same idiom as insertion-normalization) ---

// Sub-keyed by system-prompt hash for the same reason insertion-normalization
// is (threat-matrix row 14): the session-id header is shared by the main
// thread, every subagent it dispatches, and CC's own sidecar calls
// (title-generation etc.) — but those carry DIFFERENT tools arrays. Keyed on
// the bare session id they all collide on one baseline, so each alternation
// reads as "a known tool's schema changed" and takes the honest-reset path,
// re-baselining against whichever tenant spoke last.
//
// Measured before this fix (2026-07-28, a 602-request capture):
// SIX distinct (tools, system-prompt) combinations shared a single baseline,
// and enabling the rewrite RAISED main-conversation tools[] churn from 1 to 2
// — the extension built to hold tools[] byte-stable was destabilising it.
// The directive never considered sidecars; only replay over real multi-tenant
// traffic surfaced it.
// The key carries a CONVERSATION sub-key as well as the system prompt.
//
// Without it (until 2026-07-28) every subagent of a session shared one tools
// baseline AND one set of persisted additions, because they all run the same
// agent system prompt. That is not merely noisy: the tool_addition
// announcement is anchored to a MESSAGE IDENTITY, so under a shared key the
// stored anchor belongs to a different conversation's history, fails to
// match, and injectAdditions falls back to "after the last user message" — a
// different index on every request. Measured on one corpus: our output
// diverged at index 4 while CC's own history was byte-identical through index
// 23, twice, re-billing 19 messages that never changed.
//
// insertion-normalization hit the identical collision and was fixed hours
// earlier; this extension had the same key and did not get the fix. Hence
// conversationSubKey living in message-hash.mjs rather than in either
// extension — a second copy is a second truth, and the second consumer
// learning the lesson late is exactly what happened here.
export function resolveToolRewriteSessionKey(headers, body) {
  const sid = headers ? resolveSessionId(headers) : null;
  const conv = conversationSubKey(body?.messages);
  if (sid) return `s-${sid.replace(/[^A-Za-z0-9_-]/g, "_")}-${systemPromptSubKey(body?.system)}-${conv}`;
  const model = typeof body?.model === "string" ? body.model : "unknown";
  return `c-${model}-${conv}`;
}

// --- Canonical tool comparison ---
//
// Only name/description/input_schema participate in the equality check —
// any OTHER field (e.g. a defer_loading marker WE ourselves might have
// added on a prior rewrite) is deliberately excluded, so re-classifying a
// tool object that happens to carry that marker can never misfire as "the
// existing tool's schema changed."
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// VOLATILE SUBSTRINGS inside a tool DESCRIPTION (2026-07-28). CC embeds the
// per-session console URL in the Bash tool's description — it is the commit
// trailer the model is instructed to write — and it does not embed it
// consistently: measured over 640 live requests, 628 carried it and 12 did
// not, with two transitions. Each transition is a tools[] byte change, and
// tools[] renders BEFORE system and messages, so no cache_control breakpoint
// can survive it; one of them cost 705k creation tokens on this session.
//
// Nothing about what Bash DOES changes across that flip — the session URL is
// not part of the tool's contract. So it is excluded from the identity and
// the first-seen description is forwarded: exactly the treatment
// insertion-normalization already applies to <system-reminder> blocks in
// messages, one region over.
//
// Deliberately NARROW: only the session-URL shape. Any other description
// difference is still a real edit and still resets, because serving a stale
// schema for a tool whose contract changed is the one failure this extension
// must never produce.
const VOLATILE_DESC_PATTERNS = [
  // https://claude.ai/code/session_<id> — appears bare and as a
  // "Claude-Session:" trailer line; the whole line goes either way.
  /^.*https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+.*$/gm,
];

export function stripVolatileDescription(desc) {
  if (typeof desc !== "string") return desc;
  let out = desc;
  for (const re of VOLATILE_DESC_PATTERNS) out = out.replace(re, "");
  // Collapse the blank lines the removal leaves behind, so a description that
  // differs ONLY by the volatile line canonicalizes identically either way.
  return out.replace(/\n{2,}/g, "\n").trim();
}

export function toolFingerprint(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string") return null;
  return JSON.stringify(
    canonicalize({
      name: tool.name,
      description: stripVolatileDescription(tool.description ?? null),
      input_schema: tool.input_schema ?? null,
    }),
  );
}

// --- Core classifier (pure) ---
//
// Returns:
//   { action: "no-baseline", knownTools }                                             — first-seen session; persist baseline, forward unchanged
//   { action: "unchanged", knownTools }                                               — incoming === known set, same order; forward unchanged
//   { action: "reset", knownTools, reason }                                           — a known tool's schema changed; forward unchanged, re-baseline
//   { action: "rewrite", tools, newNames, heldNames, knownTools }                      — held removal and/or reorder and/or pure addition; onRequest forwards forwardedTools(knownTools, additions) and injects the addition message
export function classifyToolChange(incomingTools, priorKnownTools) {
  if (!Array.isArray(priorKnownTools)) {
    return { action: "no-baseline", knownTools: incomingTools };
  }

  const priorByName = new Map(priorKnownTools.map((t) => [t.name, t]));
  const incomingByName = new Map(incomingTools.map((t) => [t.name, t]));

  // Schema-change scan runs over every name present in BOTH sets — absence
  // is handled separately below (held, not reset) — so a removal elsewhere
  // in the array never short-circuits this check.
  for (const [name, priorTool] of priorByName) {
    const incomingTool = incomingByName.get(name);
    if (incomingTool && toolFingerprint(incomingTool) !== toolFingerprint(priorTool)) {
      return { action: "reset", knownTools: incomingTools, reason: "tool-schema-changed" };
    }
  }

  const priorOrderNames = [...priorByName.keys()];
  const heldNames = priorOrderNames.filter((name) => !incomingByName.has(name));
  const newNames = [...incomingByName.keys()].filter((name) => !priorByName.has(name));

  const incomingOrderNames = incomingTools.map((t) => t.name);
  const orderMatches =
    heldNames.length === 0 &&
    newNames.length === 0 &&
    incomingOrderNames.length === priorOrderNames.length &&
    incomingOrderNames.every((name, i) => name === priorOrderNames[i]);

  if (orderMatches) {
    return { action: "unchanged", knownTools: priorKnownTools };
  }

  const newTools = newNames.map((name) => incomingByName.get(name));
  const deferredNewTools = newTools.map((t) => ({ ...t, defer_loading: true }));
  // First-seen order, for every name ever known — held (removed) names
  // included, using their frozen object so wire bytes never drift for a
  // tool whose content didn't actually change.
  const heldOrPresentTools = priorOrderNames.map((name) => priorByName.get(name));

  return {
    action: "rewrite",
    tools: heldOrPresentTools.concat(deferredNewTools),
    newNames,
    heldNames,
    knownTools: priorOrderNames.concat(newNames).map((name) => priorByName.get(name) ?? incomingByName.get(name)),
  };
}

// --- Wire shapes (documented mid-conversation-tool-changes contract) ---

// The tool_addition announcement: one system-ROLE message in messages[]
// carrying a tool_addition block per newly-added tool. The tool must
// already be in tools[] with defer_loading: true; the block references it
// by name. See the directive addendum for the placement constraints this
// satisfies.
export function buildToolAdditionMessage(toolNames) {
  return {
    role: "system",
    content: toolNames.map((name) => ({
      type: "tool_addition",
      tool: { type: "tool_reference", name },
    })),
  };
}

// Identity hash for an anchor message. hashMessageContent covers
// block-array content; string-content messages hash their raw string
// (same fallback family as insertion-normalization's content-derived
// identity — never positional).
export function anchorHash(msg) {
  const h = hashMessageContent(msg);
  if (h) return h;
  const c = msg?.content;
  if (typeof c === "string") return "s:" + createHash("sha256").update(c).digest("hex").slice(0, 16);
  return null;
}

// Splice persisted addition messages back into messages[] at their
// anchors. Pure: returns { messages, reanchored } without mutating input.
// Each addition lands immediately after the message whose identity hash
// matches its anchorHash; a vanished anchor (context-management prune)
// re-anchors after the LAST user message — the closest stable position
// that satisfies the "must follow a user message" placement constraint —
// and reports it so state can be updated and telemetry emitted.
//
// Resolution happens in a first pass against the ORIGINAL `messages` array
// (never mutated while resolving), so a SHARED anchor's landing position is
// computed once regardless of how many additions target it. This is what
// keeps the run FIFO — discovery order, oldest first — instead of the
// previous idx+1-per-addition splice, which re-found the same anchor fresh
// on every iteration (the search excludes role==="system", so
// already-injected additions were invisible to it) and always landed the
// newest addition closest to the anchor: a LIFO stack that reordered the
// already-forwarded prefix on every new addition (a probe capture,
// n=372-397, 25 stability violations during an MCP discovery cascade).
export function injectAdditions(messages, additions) {
  if (!Array.isArray(additions) || additions.length === 0) {
    return { messages, reanchored: [] };
  }

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const reanchored = [];
  // Original-array index -> messages to inject right after it, in discovery
  // (oldest-first) order — the run for a shared anchor.
  const byAnchorIdx = new Map();

  for (const add of additions) {
    const idx = messages.findIndex((m) => m.role !== "system" && anchorHash(m) === add.anchorHash);
    let landingIdx = idx;
    if (idx < 0) {
      if (lastUserIdx >= 0) {
        landingIdx = lastUserIdx;
        reanchored.push({ names: add.names, anchorHash: anchorHash(messages[lastUserIdx]) });
      } else {
        // No user message at all — cannot satisfy the placement
        // constraint; skip this injection (the tool stays deferred and
        // unloaded this request; honest degradation, not a malformed
        // request).
        reanchored.push({ names: add.names, anchorHash: null });
        continue;
      }
    }
    if (!byAnchorIdx.has(landingIdx)) byAnchorIdx.set(landingIdx, []);
    byAnchorIdx.get(landingIdx).push(add.message);
  }

  const out = [];
  messages.forEach((m, i) => {
    out.push(m);
    const injected = byAnchorIdx.get(i);
    if (injected) out.push(...injected);
  });

  return { messages: out, reanchored };
}

// The frozen tools[] to forward when additions exist: knownTools order,
// with every name covered by an addition marked defer_loading — the
// classifier's knownTools stores UNMARKED objects (fingerprints must
// match CC's raw array), so the marker is applied at forward time.
export function forwardedTools(knownTools, additions) {
  const deferredNames = new Set(additions.flatMap((a) => a.names));
  return knownTools.map((t) => (deferredNames.has(t.name) ? { ...t, defer_loading: true } : t));
}

// (Phase A's placeholder — a pseudo-XML text block appended to top-level
// body.system — was removed in Phase B: wrong shape, and decisively wrong
// location, since top-level system heads the cache prefix and every
// injection there would have busted the whole cache.)

// --- Beta header (additive token; reuses no state from auto-1m-guard, but
// mirrors its header-token parse/join idiom rather than reimplementing ad
// hoc string splitting) ---

function findBetaHeader(headers) {
  if (!headers) return null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === BETA_HEADER_NAME) return { key: k, raw: headers[k] };
  }
  return null;
}

function parseBetaTokens(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export function addBetaToken(headers) {
  const found = findBetaHeader(headers);
  const tokens = found ? parseBetaTokens(found.raw) : [];
  if (tokens.includes(BETA_TOKEN)) return; // already present — idempotent
  tokens.push(BETA_TOKEN);
  const key = found ? found.key : BETA_HEADER_NAME;
  headers[key] = tokens.join(", ");
}

// --- Extension contract ---

export default {
  name: "deferred-tool-rewrite",
  description:
    "Phase A: hold tools[] byte-stable across a pure tool addition, announcing the new tool via an appended " +
    "tool_addition system block instead; also holds a harness-GC'd tool in place and pins output order to " +
    "first-seen (works around CC's mid-conversation deferred-tool-load and tool-GC cache busts)",
  enabled: false, // overridden by extensions.json
  order: 425,

  async onRequest(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.body) return;

    const body = ctx.body;
    if (!Array.isArray(body.tools) || body.tools.length === 0) return;

    const dir = getSnapshotDir();
    const fs = DEFAULT_FS;
    const headers = ctx.headers || null;
    const sessionId = headers ? resolveSessionId(headers) : null;
    const sessionKey = resolveToolRewriteSessionKey(headers, body);

    try {
      const prior = await loadState(dir, sessionKey, fs);
      const result = classifyToolChange(body.tools, prior?.tools ?? null);

      // Carry prior additions forward except on reset (a schema change
      // re-baselines everything — the harness's own tools[] becomes truth
      // and pending injections are abandoned with it).
      let additions = result.action === "reset" ? [] : (prior?.additions ?? []);

      // Model gate, applied at the single point everything downstream reads.
      // Emptying `additions` here disables the announcement, the
      // defer_loading markers forwardedTools() derives from it, AND the beta
      // header — one place rather than three, and it also neutralises state
      // persisted before this gate existed (a session that accumulated
      // additions under the old build must not keep replaying them into a
      // model that 400s on them).
      const announceOk = supportsToolAddition(body?.model);
      if (!announceOk) additions = [];

      // A suppressed announcement is a real cost and must not be silent: the
      // session pays a full-prefix bust per tool load exactly as if this
      // extension were absent. The documented availability rule is "Opus
      // onward", so a NEW model family landing here is most likely
      // support-capable and unprobed — the warning names the probe so the
      // gap closes in minutes instead of surviving until someone reads
      // telemetry. Once per model per process; the telemetry entry carries
      // `suppressed` on every occurrence.
      const suppressed =
        !announceOk && result.action === "rewrite" && (result.newNames?.length ?? 0) > 0;
      if (suppressed && !warnedSuppressedModels.has(body?.model)) {
        warnedSuppressedModels.add(body?.model);
        process.stderr.write(
          `[deferred-tool-rewrite] model ${body?.model} is not allowlisted for tool_addition — ` +
            `tools[] busts are being paid (${result.newNames.join(",")}). ` +
            `Probe it: see tools/probe-tool-addition.mjs (big models need the through-proxy method).\n`,
        );
      }

      // The announcement path is gated on model support; the HOLD and
      // ORDER-PIN paths are not, because neither needs the beta contract —
      // they only ever re-send tools the model already understands.
      if (
        announceOk &&
        result.action === "rewrite" &&
        result.newNames.length > 0 &&
        Array.isArray(body.messages) &&
        body.messages.length > 0
      ) {
        // New tool(s): ONE addition message covering them all, anchored
        // after the current last message. Injected below with any prior
        // additions, and persisted for re-injection on every subsequent
        // request (the API is stateless — see file header).
        const anchorMsg = body.messages[body.messages.length - 1];
        additions = additions.concat([
          {
            names: result.newNames,
            anchorHash: anchorHash(anchorMsg),
            message: buildToolAdditionMessage(result.newNames),
          },
        ]);
      }

      // Forward the frozen array whenever we hold state: rewrite uses the
      // classifier's held order; "unchanged" ALSO re-forwards it when
      // additions exist, because CC's incoming array never carries our
      // defer_loading markers — forwarding it raw would silently un-defer
      // every added tool. no-baseline and reset pass through untouched.
      if (result.action === "rewrite") {
        body.tools = forwardedTools(result.knownTools, additions);
      } else if (result.action === "unchanged") {
        // ALWAYS re-forward the frozen array here, not only when additions
        // exist. Two reasons, and the second was measured the hard way:
        //   - CC's incoming array never carries our defer_loading markers, so
        //     forwarding it raw would silently un-defer every added tool;
        //   - "unchanged" now means "identical after volatile stripping",
        //     which includes descriptions that differ ONLY by the per-session
        //     console URL. Forwarding CC's raw array in that case would put
        //     the flip straight back on the wire and invalidate tools[] —
        //     making the identity fix pointless. The frozen array is the
        //     first-seen form, so the wire stays byte-stable.
        body.tools = forwardedTools(prior.tools, additions);
      }

      let reanchored = [];
      if (additions.length > 0 && Array.isArray(body.messages)) {
        const injected = injectAdditions(body.messages, additions);
        body.messages = injected.messages;
        reanchored = injected.reanchored;
        if (reanchored.length > 0) {
          additions = additions.map((a) => {
            const r = reanchored.find((x) => x.names.join() === a.names.join());
            return r && r.anchorHash ? { ...a, anchorHash: r.anchorHash } : a;
          });
        }
        // Beta token whenever a deferred tool / injected message is on
        // the wire — every request after the first addition.
        if (headers) addBetaToken(headers);
      }

      await saveState(dir, sessionKey, { tools: result.knownTools, additions }, fs);

      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolRewriteStats = {
        action: result.action,
        newNames: result.newNames ?? [],
        heldNames: result.heldNames ?? [],
        reason: result.reason ?? null,
        injected: additions.length,
        reanchored: reanchored.filter((r) => r.anchorHash).length,
      };

      await appendTelemetry(
        dir,
        sessionKey,
        {
          ts: new Date().toISOString(),
          key: sessionKey,
          sid: sessionId,
          action: result.action,
          newNames: result.newNames ?? [],
          heldNames: result.heldNames ?? [],
          injected: additions.length,
          ...(suppressed ? { suppressed: true, model: body?.model } : {}),
          ...(reanchored.length > 0 ? { reanchored } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        },
        fs,
      );

      if (isDebug()) {
        process.stderr.write(
          `[deferred-tool-rewrite] action=${result.action}` +
            (result.newNames ? ` new=${result.newNames.join(",")}` : "") +
            (result.heldNames && result.heldNames.length ? ` held=${result.heldNames.join(",")}` : "") +
            (result.reason ? ` reason=${result.reason}` : "") +
            "\n",
        );
      }
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
