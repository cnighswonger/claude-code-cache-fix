# heron_brook bootstrap channel — disclosure record (2026-05)

This page documents a security disclosure we filed against Claude Code v2.1.150, Anthropic's disposition, and what this proxy ships in response. It exists so that users of cache-fix can see — in primary-source form — the reasoning behind the bootstrap-audit feature added in v3.6.3.

## What was filed

On 2026-05-25 we filed a report (HackerOne **#3760645**) through Anthropic's VDP (`hackerone.com/anthropic-vdp`) describing a remote behavior-injection channel in Claude Code v2.1.150. The CC binary added a new prompt-section consumer (`nAA()` / `heron_brook`) that reads server-supplied strings from `/api/claude_cli/bootstrap` and merges them into the agent's behavioral-instructions prompt path. The report included static binary analysis, wire-level reproduction against `claude-opus-4-7`, a CVSS 4.0 vector of `CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:N/VC:N/VI:H/VA:N/SC:H/SI:H/SA:N` (rated **Critical 9.0** by HackerOne's calculator), and CWE-345 (Insufficient Verification of Data Authenticity). A courtesy notification was sent to `disclosure@anthropic.com` the same day.

## How it was closed

On 2026-05-27, the report was closed as **Informative** by `claudesec-h1`. The full close text:

> Thank you for your report. After review, we've determined this falls outside Claude Code's threat model.
>
> Claude Code is intentionally designed to operate through corporate TLS-intercepting proxies, and our public documentation describes configuring HTTPS_PROXY and NODE_EXTRA_CA_CERTS for such environments. Claude Code therefore relies on TLS as the transport-integrity boundary and does not implement certificate pinning or response signing, consistent with comparable developer CLI tools.
>
> The scenario described requires that a rogue certificate authority is already trusted by the system trust store (or explicitly added via NODE_EXTRA_CA_CERTS). An adversary in that position likely already has equivalent or greater capability through the same TLS interception, including modifying inference responses directly. The configuration endpoint does not grant capability beyond what the TLS-MITM precondition already provides.
>
> We appreciate you researching our systems and welcome future submissions.

The position is internally consistent: TLS is the integrity boundary, no application-layer signing is planned, and an attacker holding a TLS-MITM position is treated as out-of-scope because they can also modify inference responses directly. No remediation is planned upstream.

## What this proxy ships in response

Users who want visibility into bootstrap-channel content — independent of whether they accept the TLS-boundary framing — now have a defense layer they can run locally:

- **cache-fix v3.6.3** adds bootstrap-response audit logging at `~/.claude/cache-fix-bootstrap-log.jsonl` (5 MB cap, `.1` rotation). Default mode is `audit`; users who want to drop bootstrap responses entirely can opt into block mode by setting `CACHE_FIX_BOOTSTRAP_MODE=block` in the proxy environment. See the [CHANGELOG entry](../../CHANGELOG.md) for v3.6.3 for the feature surface, and the README's *"What this proxy defends against"* section for the operational story.

- **Proof-of-concept repository:** [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) contains the wire-level reproducer and evidence log referenced in the HackerOne submission.

This is the full disposition. Future cache-fix releases that touch this defense category will reference back to this page.
