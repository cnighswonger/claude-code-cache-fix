## v3.6.3 — Bootstrap-channel handling and audit logging

Adds explicit handling for `/api/claude_cli/bootstrap` to the proxy router, with audit logging at `~/.claude/cache-fix-bootstrap-log.jsonl` (5 MB cap, `.1` rotation). Log records include forward-compatible fields (`baseline_hash`, `anomaly_status`, `mode`, `extension_version`) that v3.7.0 will populate as the bootstrap-defense extension matures on the pipeline framework.

**Behavior change for existing cache-fix users.** Prior versions routed only `/v1/messages` and `/health`, returning 404 for any other Anthropic API path including bootstrap. As a result, bootstrap-section content was not previously reaching CC for cache-fix users. v3.6.3 default mode is `audit`: bootstrap responses now proxy through to CC and are logged locally for inspection. Users who want to preserve v3.6.2's de-facto block behavior should set `CACHE_FIX_BOOTSTRAP_MODE=block` in the proxy environment, which short-circuits the upstream call and returns a 200 with an empty JSON body.

**Background.** Claude Code v2.1.150 added a prompt-section consumer (`nAA()` / `heron_brook`) that reads server-supplied strings from `/api/claude_cli/bootstrap` and merges them into the agent's behavioral-instructions prompt. We filed the behavior with Anthropic via HackerOne VDP on 2026-05-25; the report was closed as *Informative* on 2026-05-27, with Anthropic treating TLS as the transport-integrity boundary and declining to add application-layer authenticity checks. This release gives cache-fix users local visibility into bootstrap-channel content (audit mode) and an opt-in path to drop it (block mode). See [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) for the full disposition record.

**Operational notes.**

- Audit mode writes metadata about bootstrap fetches to a local log file. The log never leaves the host. Records are scalar-only by design (no headers, no bodies) — PII discipline is enforced at the writer's call signature.
- Block mode also writes to the audit log (the block event itself is logged); auditability of blocks matters more than log volume.
- Upstream errors on the bootstrap path are also routed through the audit pipeline (`phase: upstream_error_audited`). Anomaly-friendly: a DNS-shenanigan or upstream-outage probe leaves a record before the client receives a 502.
- Log path is `~/.claude/cache-fix-bootstrap-log.jsonl` by default; override with `CACHE_FIX_BOOTSTRAP_LOG_PATH` if you need to redirect it (used for test isolation; useful for sandboxed deployments).
- No statusline signal in v3.6.3 — check the log file directly. The env-flag-detector statusline pattern (#144) will absorb bootstrap-log surfacing in v3.7.0.
- Single-process invariant: the cache-fix proxy is one Node process per host, so the audit writer relies on intra-process serialization. Future changes must preserve this.
- Pipeline framework: this release adds a new pipeline hook for the bootstrap path; v3.7.0's anomaly + baseline + dismissal extension binds to it. Design note for the hook lifecycle lands in the v3.6.3 PR description.
