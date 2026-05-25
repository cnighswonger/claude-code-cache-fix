## Verdict
APPROVE

## Findings
- MINOR: proxy/extensions/bootstrap-defense.mjs:103, The fallback for body_bytes calculation uses JSON.stringify(ctx.body) which may not match the actual wire bytes for non-JSON responses. This is acceptable since the upstream sets _bootstrapBodyBytes directly, but the fallback should be documented as "only used when upstream doesn't set the field" to avoid confusion.
- MINOR: proxy/extensions/bootstrap-defense.mjs:106, The log rotation implementation renames to ${path}.1 but doesn't handle multiple rotations (e.g., .2, .3). This is acceptable for a single-writer log but could be improved for long-running processes.

## Question-answers
1. Security: The audit log does NOT leak request bodies/PII/credentials - the PII discipline is enforced by extracting only host/request-id and the test suite confirms sensitive headers are excluded. Block mode cannot be bypassed as it's handled in onRequest before forwarding. JSONL writer has no injection risk as it uses JSON.stringify on controlled fields.
2. Correctness: Route discrimination works via ctx.meta.route === "bootstrap" (verified in tests). Env-var modes are resolved correctly with fallback. Upstream 5xx is handled by setting meta._bootstrapUpstreamError and logging the error.
3. Robustness: Log rotation has a race condition if multiple processes write to the log (but single-writer invariant is documented). Single-writer assumption is valid for this proxy architecture. Disk errors are logged to stderr but not handled further (acceptable for log file).
4. Test coverage: All branches are covered in tests (non-bootstrap, audit, block, mode resolution, PII, upstream errors, log rotation).
5. Forward-compat: v3.7.0 fields (baseline_hash, anomaly_status) are correctly emitted as null in recordShape.
6. Hook design: Reusing onRequest/onResponse with ctx.meta.route is clean and consistent with the new preForward pipeline. No cleaner alternative was missed - this is the standard pattern for route-aware extensions.

## Things-the-PR-got-right
- Explicit PII discipline contract: Audit log only includes extracted scalar fields (upstream_host, request_id) with no sensitive headers or bodies.
- Comprehensive test suite: Includes PII leakage test that verifies no sensitive headers appear in audit records.
- Forward-compatibility: Correctly emits v3.7.0 fields as null in recordShape.
- Single-writer invariant documentation: Clearly states the assumption and when it would need to change.
- Error handling: Logs errors to stderr rather than crashing the process.
- Mode resolution: Handles invalid modes by falling back to "audit" with clear documentation.

## Forward-compat / followups
- The v3.7.0 anomaly detection framework will populate baseline_hash and anomaly_status fields in the audit log.
- The log rotation implementation should be enhanced to handle multiple rotations (e.g., .1, .2, .3) in future versions.
- The fallback body_bytes calculation could be improved with a clearer comment about when it's used.
