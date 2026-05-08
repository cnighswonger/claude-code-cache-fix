# Review: rate-limit upstream connection id threading

Date: 2026-05-08
Reviewed: PR #113 (`feat: thread upstream connection id into rate-limit-log JSONL (H3-vs-H4 verification)`)
Label applied: reviewed-by-codex-agent

## What Is Correct

- `proxy/upstream.mjs` assigns stable `cn-<int>` ids with a module-private `WeakMap` plus monotonic counter, which is the minimal design that preserves keep-alive reuse semantics without leaking per-socket state.
- `forwardRequest()` captures the assigned socket id and returns it alongside the upstream response; `server.mjs` then threads the same `meta` object through `runOnRequest()`, `runOnResponseStart()`, and `runOnResponse()`, so `meta._upstreamConnectionId` reaches `rate-limit-log` without cloning loss.
- `rate-limit-log.buildRecord()` adds `upstream_connection_id` as a schema-additive field while keeping `schema_version: 1`, which matches the documented compatibility rule that additive fields do not force a version bump.
- Test coverage is appropriate for the change. `test/proxy-upstream-connection-id.test.mjs` proves same-socket stability, distinct-socket uniqueness, null handling, and resettable deterministic numbering. `test/proxy-rate-limit-log.test.mjs` proves the JSONL field round-trip, including the `cn-1, cn-1, cn-2` H3 clustering shape.
- Directive updates are internally consistent: schema example, field semantics, post-analysis playbook, and shipped follow-up note all describe `upstream_connection_id` the same way.
- Verification on Node behavior is consistent with the implementation. Node's `http.ClientRequest` docs define `'socket'` as firing after a socket is assigned to the request, while `'response'` fires when response headers are received. A local runtime probe on Node `v24.11.1` showed `'socket'` arriving before the response callback for both fresh and keep-alive-reused sockets; attaching the listener immediately after `http.request()` returned was sufficient.

## Blockers

None

## What Needs Attention

- None

## Recommendations

- Keep the `'socket'` listener attached immediately after `transport.request()` creation. A local probe showed that delaying listener attachment by `process.nextTick()` is already too late to observe the event reliably.

## Bottom Line

Ship it. The change is narrowly scoped, threads the new signal through the existing proxy pipeline without disturbing existing behavior, preserves log-schema compatibility, and is backed by focused tests that cover both the connection-id helper and the end-to-end JSONL recording path.
