Verdict: REQUEST_CHANGES

## What Is Correct

- `proxy/extensions/jsonl-session-mirror.mjs:333-385` binds only `onRequest`, `onStreamEvent`, and `onResponse` on `routes: ["messages"]`, matching the actual pipeline surface in `proxy/pipeline.mjs:85-141` and the non-streaming split in `proxy/server.mjs:160-188`.
- The core dedup walk is otherwise correct: `stageUserRecords()` filters to user-role entries before comparing against `mirroredUserMessageCount`, and `flushAccumulator()` advances state only after `writeRecordsSync()` succeeds (`proxy/extensions/jsonl-session-mirror.mjs:94-160`, `255-317`). The 3-turn, retry, repeated-text, and tool-result tests cover the critical acceptance paths (`test/proxy-jsonl-session-mirror.test.mjs:123-264`).
- Envelope shaping preserves `record.message.content`, dereferences image bytes to references, and wires the synthetic parent chain as designed (`proxy/session-mirror-envelope.mjs:30-209`, `test/proxy-session-mirror-envelope.test.mjs:44-209`, `test/proxy-jsonl-session-mirror.test.mjs:377-394`).
- Writer isolation, path safety, and retention basics are solid: reuse of `sessionFilename()` is correct, stale files are pruned, and write failures are swallowed without breaking the stream (`proxy/session-mirror-writer.mjs:41-167`, `test/proxy-session-mirror-writer.test.mjs:110-208`, `test/proxy-jsonl-session-mirror.test.mjs:318-338`).

## Blockers

1. Interrupted-stream partial flush is advertised in the directive and implemented as a gate + helper, but the runtime never calls it. `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED` is read in `proxy/extensions/jsonl-session-mirror.mjs:34-36`, and `_flushInterruptedForTest()` exists at `proxy/extensions/jsonl-session-mirror.mjs:387-394`, but `proxy/server.mjs:113-115` only aborts the upstream on client close and `proxy/stream.mjs:84-108` simply ends the response when the stream loop exits. There is no path that invokes the helper, no README entry for the env var (`README.md:778-785`), and no end-to-end test. As shipped, the default-true interrupted-flush recovery path is dead code.
2. The “memory-bounded” session map is only capped after successful flushes, so aborted/erroring sessions can accumulate past `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS`. `getSession()` inserts every seen session immediately (`proxy/extensions/jsonl-session-mirror.mjs:59-73`), but `evictIfOverCap()` is only called inside the post-`writeRecordsSync()` success path (`proxy/extensions/jsonl-session-mirror.mjs:287-299`). A stream of requests that stage in `onRequest()` and then fail before `message_stop` never hits the eviction path, which violates the stated bounded-memory contract and couples memory growth to the exact failure modes this extension is meant to tolerate.

## What Needs Attention

- The event-log contract in docs says “open / rotate / sweep / error” operational events, but normal writes do not emit `open` at all; a clean write leaves no event log (`README.md:795`, `proxy/session-mirror-writer.mjs:96-109`, `164-166`).
- The event log is also carrying more than the documented scalar surface. `logEvent()` spreads whatever fields it is given (`proxy/session-mirror-writer.mjs:82-91`), rotate logs a full file path (`proxy/session-mirror-writer.mjs:65-67`), and error records include raw error messages (`proxy/extensions/jsonl-session-mirror.mjs:305-309`, `340-345`, `359`). That is still far better than logging prompt content, but it is contract drift from the documented “session id / timestamps / action / byte counts” shape.
- Coverage is good on the core dedup walk, but some directive-listed cases remain untested in-tree: no 200-turn replay, no LRU eviction test, no async-rejected writer path, and no end-to-end interrupted-flush path (`test/proxy-jsonl-session-mirror.test.mjs`, `test/proxy-session-mirror-writer.test.mjs`). Given the two blockers above, those omissions matter.

## Precision / Tightenings

- The envelope docs say the `version` field should reflect the proxy version, but the shaper currently hardcodes bare `cache-fix-proxy` instead of a release-qualified value (`docs/directives/proxy-jsonl-session-mirror.md:72`, `proxy/session-mirror-envelope.mjs:25-26`, `96`). That does not break reader compatibility, but it weakens the provenance story the docs describe.
- User envelope parity tests do not currently iterate the fixture’s user key sets the way the assistant parity tests do (`test/fixtures/cc-transcript-shape-snapshot.json:31-50`, `test/proxy-session-mirror-envelope.test.mjs:109-130`). The implementation looks structurally close, but the test claim is stronger than what is actually asserted.

## Bloat / Non-Functional

- The LOC overrun is not the main problem here. The accumulator/dedup/writer split is defensible, and most of the extra test volume is buying readability around failure modes. I would not block on raw size alone.
- The bigger non-functional issue is that some of that extra surface is carrying undocumented or unreachable behavior (`CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED`, `open` events) instead of reducing risk.

## Recommendations

- Either wire interrupted-stream flushing through `server.mjs`/`stream.mjs` and add the missing end-to-end tests, or cut the env var/helper/doc claims from this PR and defer the behavior explicitly.
- Enforce `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` at session creation/access time rather than only after successful writes, and add a regression test that stages multiple failing sessions over the cap.
- Bring the docs and tests back in line with the actual event-log and envelope contracts: either emit `open`/bounded scalar events as documented, or narrow the documentation to match what is really written.

## Bottom Line

The core mirror path is thoughtfully built and most of the load-bearing dedup/envelope behavior is in good shape, but two directive-level promises are not actually realized at runtime: interrupted-stream flushing is unreachable, and the session-state cap is not enforced for failed/aborted sessions. Those are both directly in the recovery/failure-isolation surface of the feature, so I’m requesting changes before approval.

— Codex review
