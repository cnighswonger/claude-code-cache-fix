# Test spec: thinking-sanitize efficacy (real-API replay)

**For:** Proxy Test Agent. **Owner of the feature under test:** Proxy Builder (#162). **Resolves:** #162 Open Question 1.
**Status:** spec — **requires Chris's go-ahead before execution** (it makes real Anthropic API calls).
**References:** anthropics/claude-code#63147 (root cause + reproducible triggers), cache-fix #162 (the mitigation: drop prior-turn omitted thinking on the request path), #157, #158.

## Goal

Empirically answer: **does the #162 transform actually clear the `400 ... thinking blocks in the latest assistant message cannot be modified`?** The 400 names the *latest* assistant message, but #162 drops *prior-turn* thinking and conservatively leaves the latest message alone — so its efficacy is unproven. Produce a results table that tells PB the exact "which turns to drop" rule before #162's implementation locks.

## Why a real-API experiment (not the fake-upstream smoke)

The 400 is **real-Anthropic-API validation behavior**. The docker smoke's fake upstream returns only canned shapes — it can't reproduce the 400, and hardcoding it would just encode our assumption circularly. And the failing request requires **genuine server-signed thinking blocks** — signatures are server-issued and cannot be forged or synthesized. So the experiment must hit the real API.

## Method

### Phase 0 — obtain genuine signed thinking blocks
Make a real API call (Opus 4.7 and, separately, 4.8; extended/interleaved thinking on; include at least one tool so the turn interleaves `thinking` + `tool_use`). Capture the full assistant response, preserving the real `signature` on each thinking block. Use a **minimal throwaway conversation**, never a production working session.

### Phase 1 — reproduce the 400 (establish ground truth)
Construct follow-up requests that replay that assistant turn with thinking **text emptied to `""`** (the omitted shape CC persists) + the **real signature retained**. Build the trigger variants:
- **(a) latest turn completed** — thinking + tool_use + tool_result all resolved, then a new user message (resume/`--continue` shape).
- **(b) latest turn mid-continuation** — thinking + tool_use, then a tool_result that continues that same turn (the interleaved-thinking-with-tools continuation).
- **(c) ordering variant** — thinking block positioned *after* a tool_use in the same assistant message, if reproducible (the MicHuang hypothesis).

Send each to the **real `api.anthropic.com`**. Record, per variant: 400 vs 200, and the exact `messages.N.content.M` pointer. This is the ground-truth map of which shapes actually fail.

### Phase 2 — test the transform (the actual question)
For each variant that 400'd, run two transform scopes and re-send:
- **Scope A (#162 as written):** drop prior-turn omitted thinking; never touch the latest assistant message.
- **Scope B (candidate fix):** also drop omitted thinking from the latest *completed* turn — but never from a latest turn that is an active tool-continuation.
Record, per (variant × scope): does the 400 clear (200) or not?

### Phase 3 — regression + safety
- **Healthy passthrough:** a normal request (no omitted-thinking issue) yields the same outcome (200, equivalent response) with the transform on vs off.
- **Determinism:** same input → byte-identical transformed body.
- **Continuation fallback:** confirm `DISABLE_INTERLEAVED_THINKING=1` avoids the failing form for variant (b) — the documented user-side answer for the case the proxy can't cover.

## Harness

Reuse the docker rig, but point `CACHE_FIX_PROXY_UPSTREAM` at the **real `api.anthropic.com`** (the Dockerfile default) instead of the fake. A/B by toggling the transform: `CACHE_FIX_THINKING_SANITIZE=on` vs `off` (note: #162 ships opt-in/default-off, so the on-arm must set it explicitly). A standalone replay script that posts the captured bodies is an acceptable alternative if simpler.

## Non-functional / safety constraints

- **Cost:** small N, minimal token bodies. Throwaway context only — never a live working session.
- **Sensitive data:** the captured bodies contain real thinking content + signatures. Treat as sensitive: do **not** commit raw thinking text or signatures; record only variant description, 400/200, the `content.M` pointer, and transform on/off outcome. Honor the repo's public-info-hygiene rules (no secrets/IPs/tokens in any committed artifact).
- **Auth:** use a test key or a throwaway subscription context; never embed the key in committed files or logs.

## Deliverable

A results table mapping **{trigger variant (a/b/c)} × {transform scope (A/B/off)} → {400 cleared?}**, posted to #162. It resolves Open Question 1 and tells PB the exact "which turns to drop" rule. Expected high-value outcomes:
- If Scope A clears (a) but not (b): #162-as-written covers resume/replay; (b) stays the documented `DISABLE_INTERLEAVED_THINKING=1` case.
- If only Scope B clears (a): #162 must also drop the latest *completed* turn's omitted thinking (update the directive's "which turns" rule).
- If neither scope clears the continuation case (b): confirms the proxy cannot fix it — elevate `DISABLE_INTERLEAVED_THINKING=1` as the sole answer there.
