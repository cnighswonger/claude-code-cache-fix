# Consumer setup — the protection set, nothing else

For running this fork purely as protection: no captures, no telemetry, no
development machinery. Install and launch mechanics are upstream's — follow
the main [README](../README.md) ("Quick Start", "Running as a service");
this page only tells you **which switches to turn on and why**.

## What it protects against

Claude Code re-sends the whole conversation every request; Anthropic bills
the unchanged part cheaply only while the bytes match exactly. Three CC
behaviors break that match and silently re-bill six-figure token counts:

1. **Old reminder blocks get re-shaped mid-history**
   ([anthropics/claude-code#76606](https://github.com/anthropics/claude-code/issues/76606),
   [#78660](https://github.com/anthropics/claude-code/issues/78660)) — an
   edit deep in the history re-bills everything after it.
2. **The tools list changes when a tool loads mid-session**
   ([#81967](https://github.com/anthropics/claude-code/issues/81967)) — the
   tools list heads the cached prefix, so one late tool load re-bills the
   entire context.
3. **Byte drift in already-sent messages** (stray whitespace, block
   re-serialization —
   [#48734](https://github.com/anthropics/claude-code/issues/48734)) — any
   2-byte wobble invalidates the whole prefix.

The extensions below hold the forwarded bytes stable across all three, and
a last-line guard makes sure no mitigation can ever corrupt a conversation:
on any structural mismatch it forwards the original untouched.

## The switches

Bake these into the service at install time (see the README's
`install-service` section — flags set at install time land in the unit):

```sh
CACHE_FIX_FORWARD_PROXY=on \
CACHE_FIX_INSERTION_NORMALIZE=1 \
CACHE_FIX_VOLATILE_PIN=1 \
CACHE_FIX_TOOL_REWRITE=1 \
CACHE_FIX_OUTPUT_GUARD=1 \
cache-fix-proxy install-service
```

| switch | what it does |
|---|---|
| `FORWARD_PROXY=on` | transport mode — Claude Code connects through the proxy with no `ANTHROPIC_BASE_URL` change |
| `INSERTION_NORMALIZE=1` | recognizes messages by content, so relocated/re-shaped history is forwarded in its first-seen form |
| `VOLATILE_PIN=1` | pins reminder blocks to their first serialization — CC's re-stamps stop reaching the wire |
| `TOOL_REWRITE=1` | freezes the tools list; late-loaded tools are announced at the tail instead of re-writing the prefix (auto-limited to models measured to support it — everywhere else it degrades to stock behavior, never an error) |
| `OUTPUT_GUARD=1` | the safety net: validates structure after all mitigations and restores the original on any violation |

Everything upstream ships enabled by default stays enabled — those handle
further stabilization (fingerprint stripping, sort stabilization, etc.).

**Deliberately NOT enabled** (development/telemetry, not protection):
`REQUEST_CAPTURE`, `SESSION_MIRROR`, `PREFIXDIFF`, `UPSTREAM_DETECTION` —
these record traffic for the verification machinery. A consumer needs none
of them; leaving them off means nothing about your conversations is written
to disk beyond what Claude Code itself stores.

## How you'd notice it working

The mitigation is invisible by design — the observable is your usage:
long sessions stop hitting sudden six-figure `cache_creation` spikes on
turns where nothing big changed. If you suspect a problem, the guard's
restore events land in
`~/.claude/cache-fix-snapshots/guard-events.jsonl`; an empty or absent
file is the normal state.
