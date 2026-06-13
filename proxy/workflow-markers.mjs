// Workflow-tool marker catalog for the `workflow-agent-id-synthesis`
// extension (issue #215, directive `proxy-workflow-agent-id-synthesis.md`).
//
// Each entry is a system-prompt or first-user-message fragment that CC
// injects into Workflow-tool subagent requests but NOT into Task subagent
// requests or top-level conversation requests. Detection of any catalog
// entry in the correct position (combined with session-id present + canonical
// agent-id absent) qualifies a request as a Workflow-tool subagent invocation,
// at which point the extension derives an attribution id.
//
// Per the directive's marker-discovery gate (`docs/directives/
// proxy-workflow-agent-id-synthesis.md` §"Markers catalog discovery"):
//
// - `marker_id`  is the STABLE identifier hashed into derived agent ids.
//                Cross-CC-version evolution of the matched `marker` string
//                is allowed; the `marker_id` keeps derived ids stable.
// - `marker`     is the EXACT string from binary inspection. Never hashed.
// - `position`   is "system-prompt" or "first-user-message".
// - `first_message_authorship: "tool"` is required for `position:
//                "first-user-message"` entries. In a top-level CC session
//                the first user message is user-authored, so a
//                user-authored first-user-message marker is user-controlled
//                content and ineligible for matching.
//
// Future marker drift is tracked manually via cc-watch's drift canary
// signal (the extension logs an event when conditions 1+2 hold but no
// catalog entry matches — the early warning that a CC release has shifted
// the marker text).

export const WORKFLOW_MARKERS = [
  {
    marker_id: "workflow-subagent-default-v1",
    cc_version: "2.1.177",
    cc_npm_sha256: "ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7",
    discovered_at: "2026-06-13",
    discovered_by: "proxy-builder",
    marker: "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
    position: "system-prompt",
    notes: "CC workflow factory `mOf` constant — wraps every Workflow agent() call that doesn't pass {schema}.",
  },
  {
    marker_id: "workflow-subagent-structured-v1",
    cc_version: "2.1.177",
    cc_npm_sha256: "ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7",
    discovered_at: "2026-06-13",
    discovered_by: "proxy-builder",
    marker: "CRITICAL: You MUST call the",
    position: "system-prompt",
    notes: "CC workflow factory `UOf`/`BOf` constants — appended to Workflow agents that pass {schema} for StructuredOutput. Partial match (the tool name varies); the load-bearing 'CRITICAL: You MUST call' phrase is stable.",
  },
  {
    marker_id: "workflow-subagent-suffix-v1",
    cc_version: "2.1.177",
    cc_npm_sha256: "ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7",
    discovered_at: "2026-06-13",
    discovered_by: "proxy-builder",
    marker: "NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script",
    position: "system-prompt",
    notes: "CC workflow factory `pOf` constant — appended (not replacing) to system prompts when the agent definition supplies its own. Distinct from `mOf`/`UOf` because it doesn't override; the surrounding `getSystemPrompt()` content varies per agent definition.",
  },
];

// Get the first user-message content as a flat string. Handles both the
// string shape (`content: "text"`) and the block-array shape
// (`content: [{ type: "text", text: "..." }, ...]`) per the Anthropic
// Messages API.
function firstUserMessageText(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return "";
  const first = msgs[0];
  if (!first || first.role !== "user") return "";
  const c = first.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const block of c) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// Get the system prompt as a flat string. Anthropic accepts either a bare
// string or an array of `{type:"text", text:"..."}` blocks.
function systemPromptText(body) {
  const s = body?.system;
  if (typeof s === "string") return s;
  if (!Array.isArray(s)) return "";
  const parts = [];
  for (const block of s) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// Match the first catalog entry whose marker text appears in the
// position-appropriate slot of the request body. Returns the catalog entry
// or null. Position-anchored: a system-prompt marker NEVER fires on
// user-message content and vice versa.
//
// First-user-message entries are matched ONLY if their
// `first_message_authorship` field equals "tool" (the directive's
// false-positive guard for user-controlled content). If the field is
// missing or set to "user", the entry is skipped.
export function matchWorkflowMarker(body) {
  if (!body || typeof body !== "object") return null;
  const sys = systemPromptText(body);
  const firstUser = firstUserMessageText(body);
  for (const entry of WORKFLOW_MARKERS) {
    if (entry.position === "system-prompt") {
      if (sys && sys.includes(entry.marker)) return entry;
    } else if (entry.position === "first-user-message") {
      if (entry.first_message_authorship !== "tool") continue;
      if (firstUser && firstUser.includes(entry.marker)) return entry;
    }
  }
  return null;
}

// Test-only export — re-expose the body-text extractors so the unit tests
// can pin coverage on the block-array shape handling without re-implementing
// the structural walk.
export const __testOnly = { firstUserMessageText, systemPromptText };
