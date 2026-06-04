# Review: proxy v3a extension pipeline directive

Date: 2026-04-20
Reviewed: docs/proxy-v3a-extensions-directive.md
Label applied: changes-requested

## What Is Correct
- The phase split is sensible. Treating the extension pipeline as a separate directive on top of the already-approved proxy foundation keeps the work bounded.
- Porting preload fixes as individually toggleable modules is the right abstraction for long-term maintainability and observability.
- Error isolation and the requirement that zero enabled extensions still yield transparent forwarding are both good baseline constraints.

## Blockers
- `docs/proxy-v3a-extensions-directive.md:40-44`, `:55-57`, and `:131-139` do not define a wire-safe stream rewrite contract. The directive says each SSE `data:` line is parsed, passed through `onStreamEvent`, then the "modified response/stream" is forwarded, but it never specifies how mutated events are serialized back to bytes. That is transport-critical. The current proxy forwards raw chunks in [proxy/stream.mjs](proxy/stream.mjs#L1), not reconstructed events. Before implementation, the spec needs to say whether the stream layer will fully own SSE reserialization, what happens to non-`data:` lines (`event:`, `id:`, `retry:`, comments), and whether multi-line `data:` payloads are preserved or normalized.
- The proposed hook surface cannot support the listed streaming observability extensions because it never exposes response headers/status on the streaming path. `cache-telemetry` is explicitly defined in `docs/proxy-v3a-extensions-directive.md:108-109` as extracting `cache_read/cache_creation` from response headers, but `onStreamEvent(ctx)` only gets `{ event, meta, telemetry }` and `onResponse(ctx)` is non-streaming only. The spec needs a response-start/header hook, or equivalent streaming context, before this design can be implemented coherently.

## What Needs Attention
- `docs/proxy-v3a-extensions-directive.md:7` still names the branch as `feature/proxy-v3/extensions`, which conflicts with the branch naming rule added in the same PR (`feature/proxy-v3-extensions`). That is a doc consistency issue, not a blocker by itself.
- `docs/proxy-v3a-extensions-directive.md:63-76` describes hot reload for modules, but not whether changes to `proxy/extensions.json` are also watched and applied without restart. Since enabled/order overrides live there, the hot-reload behavior should cover it explicitly.
- `docs/proxy-v3a-extensions-directive.md:33-34` mentions `skip: true` to abort forwarding, but the directive does not define what response shape/status the client receives when an extension does that.

## Recommendations
- Add a concrete stream-processing contract that defines:
  - the canonical parsed SSE unit,
  - which line types are surfaced to extensions,
  - how mutated events are serialized back to bytes,
  - and which framing/header invariants must be preserved.
- Add a streaming response-start hook, or broaden stream hook context, so extensions can read and possibly annotate response status/headers before body streaming begins.
- Update the branch reference and clarify whether `extensions.json` participates in hot reload.

## Bottom Line
The overall direction is good, but I would revise once more before adding `plan-approved`. As written, the directive does not yet specify how safe streamed response mutation works on the wire, and it does not expose the data that the proposed streaming telemetry extension needs.
