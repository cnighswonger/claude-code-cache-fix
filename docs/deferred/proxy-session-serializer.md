# Deferred design: Per-session request serializer (Phase 3b)

**Original date:** 2026-04-21
**Status:** Deferred — preserved as a design reference, not scheduled
**Tracking issue:** [#67](https://github.com/cnighswonger/claude-code-cache-fix/issues/67)

This document was written before the proxy v3.0 multi-extension
architecture landed. Some assumptions (e.g., the `onResponseComplete`
hook described below does not exist yet, and the original branch path
referenced a pre-v3 layout) need to be re-evaluated before this is
picked up. See #67 for the gating questions.

---

## Problem

Claude Code sends parallel HTTP requests to the Anthropic API during
concurrent tool calls (subagents, simultaneous tool use). When multiple
requests for the same conversation hit the API simultaneously, failure
modes include request rejection, cache invalidation, and degraded
model selection. Community research has identified this pattern and
confirmed that serializing requests per session eliminates it.

---

## Goal

Implement a per-session request serializer as a proxy extension. Only
one request per conversation is in-flight to Anthropic at a time.
Additional requests queue until the previous response completes.

---

## 1. Design

### 1.1 Scope

Single-user localhost proxy. The serializer needs:

- Per-conversation FIFO queue
- Configurable depth limit
- Timeout for queued requests
- Clean release on response completion or error

### 1.2 Session Identity

The serializer keys on whatever session/conversation identifier CC
includes in requests. Investigate the request to determine the key:
- Request headers (session-related)
- Request body fields
- Anthropic-specific headers

If no session identifier is present, requests pass through without
serialization (backwards compatible).

### 1.3 Queue Behavior

```
Request arrives → extract session key
  → Is there an in-flight request for this session?
    → No: mark as in-flight, forward immediately
    → Yes: add to FIFO queue
      → Queue depth exceeded? → reject with 429 + retry-after
      → Queue accepted → wait for current in-flight to complete
        → Timeout exceeded? → reject with 504
        → Released → forward this request
```

### 1.4 Release Trigger

The in-flight lock is released when:
- The upstream response is fully streamed (SSE stream ends)
- The upstream returns a non-streaming response (body complete)
- The upstream returns an error
- The request is aborted by the client
- The configured timeout expires

### 1.5 Extension Interface

The serializer is a proxy extension following the Phase 3a pipeline.
It should run early (low order number) so requests are serialized
before other extensions process them.

**Design question:** The current extension interface does not have an
`onResponseComplete` hook. The serializer needs to know when the full
response has been sent to release the lock. Options:

1. Add `onResponseComplete(ctx)` hook to the pipeline
2. Use the server's response `finish` event to trigger release
3. Have the serializer wrap the response stream and detect end

Recommend option 1 — it benefits other extensions too.

---

## 2. Configuration

Add to `proxy/extensions.json`:

```json
{
  "session-serializer": {
    "enabled": true,
    "order": 50,
    "maxQueueDepth": 10,
    "timeoutMs": 120000,
    "idleCleanupMs": 300000
  }
}
```

---

## 3. Observability

- Debug logging (`CACHE_FIX_DEBUG`): queue, release, reject, timeout, cleanup events
- Health endpoint: expose active session count, queue depth, total processed

---

## 4. Testing

- Queue/release mechanics
- Timeout and depth limit enforcement
- Client abort while queued releases correctly
- Upstream error releases lock
- No session key = passthrough
- Mixed sessions don't block each other
- Integration: two concurrent requests to same session, second waits

---

## 5. Acknowledgment

The concurrent-request failure pattern and its impact on cache stability
were identified by [@fgrosswig](https://github.com/fgrosswig) through
his proxy-based API observability work. Our implementation is independent,
designed for the single-user localhost proxy use case.

---

## 6. Deliverables

1. `proxy/extensions/session-serializer.mjs`
2. `onResponseComplete` hook in `proxy/pipeline.mjs` (if option 1)
3. Updated `proxy/extensions.json`
4. Updated health endpoint in `proxy/server.mjs`
5. Tests

---

## 7. Non-Goals

- Multi-client session registry
- Dashboard visualization
- Remote deployment support
