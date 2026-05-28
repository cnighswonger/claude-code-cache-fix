# Review: proxy-thinking-block-sanitize directive

Date: 2026-05-28
Reviewed: PR #162 directive (`docs/directives/proxy-thinking-block-sanitize.md`)
Label applied: changes-requested

## What Is Correct

- The directive passes the new NFR gate: `## Non-Functional Requirements` is present, non-empty, and `Load-bearing? yes` is the correct classification for a shared request-path body mutator. The explicit Chris-review requirement is also correct.
- The overall cut is appropriately narrow for directive stage: one request-path transform, deterministic/stable output, counts-only telemetry, and explicit out-of-scope boundaries around disk repair and the in-flight/latest assistant message.
- The latest-assistant safety boundary is directionally right. Anthropic's current extended-thinking docs require preserving thinking blocks for the last assistant message during tool-use continuation, so "never touch the latest assistant message" is the correct hard stop for this mitigation.
- The testing checklist aims at the right execution paths: prior-turn strip, latest-turn no-touch, deterministic replay, and live validation against a real wedged request.
- Multiple confirmations on `anthropics/claude-code#63147` report that manually stripping historical thinking blocks from prior assistant messages can un-wedge replay paths, so a request-path mitigation in cache-fix is a reasonable direction to explore.

## Blockers

- `docs/directives/proxy-thinking-block-sanitize.md:8-12`, `:17`, `:24-28`, `:42-43` treat `{ "type":"thinking", "thinking":"", "signature":"..." }` as a uniquely corrupted shape. Anthropic's current extended-thinking docs say the opposite: on Opus 4.7/4.8, omitted thinking is the default response mode and returns regular `thinking` blocks with an empty `thinking` field plus a `signature`; they also state that any text placed in the `thinking` field of a round-tripped omitted block is ignored (see `https://platform.claude.com/docs/en/build-with-claude/extended-thinking`). As written, this directive would therefore strip the normal documented omitted-thinking shape from every prior assistant turn, not a narrowly identified corruption. That breaks the directive's own NFR claim that it removes only the "precisely-matched corrupted shape," and it makes the default-on posture in `:28` unsafe.
- `docs/directives/proxy-thinking-block-sanitize.md:24`, `:42` include `redacted_thinking` in the same "empty/whitespace text + non-empty signature" matcher, but Anthropic's current docs describe `redacted_thinking` as an opaque `{ "type":"redacted_thinking", "data":"..." }` block, not a text-plus-signature shape (same source). Without captured failing requests that show a distinct corrupted `redacted_thinking` wire format, this part of the rule is not safely implementable and risks removing blocks that the protocol expects to be preserved unchanged.

## What Needs Attention

- Resolve open question #1 in the directive itself instead of leaving it to implementation. If a prior assistant message becomes empty after strip, dropping the message is the better contract than synthesizing a placeholder text block: a placeholder mutates semantics and cache prefix bytes, while the Messages API already tolerates consecutive same-role turns by combining them.
- Make the "latest assistant message" definition explicit in the behavior section: "the highest index `i` where `body.messages[i].role === \"assistant\"`." That stays well-defined even when the request ends with a user `tool_result` message.
- Keep the rationale grounded in observed replay behavior rather than the current signature-desync explanation. The upstream issue thread now contains competing hypotheses, including reports that empty `thinking` + intact `signature` is also present in healthy transcripts.

## Bloat / Non-Functional

None. The directive is small, scoped, and has the right non-functional checklist; the problem is the precision of the core wire-shape matcher, not over-engineering.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize.md` — 49 LOC — compact directive with a narrow intended scope, but the current matcher is too broad for a default-on shared-path mutator.
- `preload.mjs` — 2881 LOC — existing source-of-truth surface; implementation should stay near the directive's stated ~100-200 LOC and reuse existing message/content walk patterns rather than adding a subsystem.

## Recommendations

- Revise the strip predicate so it distinguishes an actually broken replay shape from the normal documented omitted-thinking format. The current "empty thinking + signature" test is not sufficient on Opus 4.7/4.8.
- Either remove `redacted_thinking` from this directive or replace it with a documented, captured failing shape. Do not ask implementation to infer a corruption pattern the spec cannot currently define.
- Answer the open questions as follows once the predicate is fixed:
  - Drop the assistant message if stripping leaves `content[]` empty; do not inject placeholder text.
  - Ship opt-in first, not default-on. A body-mutating thinking-block transform on the shared proxy path needs live validation before it becomes the all-users default.
  - The non-empty-signature guard does avoid directly fighting 2.1.152-style signature stripping, but that is not enough by itself because the remaining matched shape is currently also the normal documented omitted-thinking format.

## Bottom Line

Request changes for directive stage. The NFR section and load-bearing gate are correct, and the basic mitigation direction is plausible, but the core strip rule currently targets a shape that Anthropic documents as normal omitted thinking on the very model family this PR targets. On top of that, the `redacted_thinking` half of the matcher does not match the documented schema. Tighten the predicate to a genuinely broken replay shape, resolve the empty-message behavior in the spec, and keep first release opt-in; then this is ready for rereview.
