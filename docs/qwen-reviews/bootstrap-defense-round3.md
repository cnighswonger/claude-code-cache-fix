## Verdict
REQUEST-CHANGES

## Findings
- CRITICAL: proxy/extensions/bootstrap-defense.mjs:51 - The log record includes the entire client request headers (via `headers: ctx.headers`), which may contain sensitive information (e.g., `Authorization`, `Cookie`, `X-Forwarded-For`) and could lead to PII leakage in the audit log. The fix is to remove the `headers` field from the log record and rely only on explicitly logged fields (`upstream_host`, `request_id`).

## Question-answers
1. Security: can the audit log leak request bodies / PII / credentials? Yes, the entire request headers are logged without redaction, potentially leaking sensitive headers.
2. Correctness: does the route discrimination work? Yes, `ctx.meta.route` is correctly set to "bootstrap" in `preForward` and used for extension filtering.
3. Robustness: log rotation race conditions? The rotation uses atomic `renameSync` and single-writer invariant holds, so no race conditions.
4. Test coverage: do tests cover all branches? Yes, all branches (audit/block modes, upstream errors, non-JSON responses, log rotation) are covered by tests.
5. Forward-compat: are reserved v3.7.0 fields correctly emitted as null? Yes, `baseline_hash` and `anomaly_status` are explicitly set to `null`.
6. Hook design: does reusing onRequest/onResponse with ctx.meta.route hold up? Yes, the route-based discrimination is consistent and correctly implemented.

## Things-the-PR-got-right
- Fixed upstream error audit gap by adding `upstream_error_audited` phase and ensuring error metadata is logged before returning 502.
- Implemented log rotation using atomic `renameSync` with single-writer invariant, validated by tests.
- Correctly handled block mode by returning empty 200 without upstream calls (verified in tests).
- Set reserved v3.7.0 fields (`baseline_hash`, `anomaly_status`) to `null` in log record for forward compatibility.
- Correctly handled non-JSON upstream responses by logging raw byte count and forwarding raw payload.

## Forward-compat / followups
- The log record correctly sets `baseline_hash` and `anomaly_status` to `null` for v3.6.3, ensuring log readers won't break when v3.7.0 populates these fields.
- The PR intentionally defers full anomaly detection to v3.7.0, which is the correct approach for this audit-only release.
