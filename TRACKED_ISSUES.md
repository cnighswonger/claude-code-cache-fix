# Tracked GitHub Issues — Claude Code Cache & Context Bugs

Issues we are actively monitoring, have commented on, or are directly relevant to our interceptor work.

Last updated: 2026-06-11 (added CC#66728 safety cascade-lock canonical thread + 4 cache-fix-directive-driving issues #66815/#66734/#66486/#66761/#67055; noted github-actions[bot] mass-closure event 2026-06-11T11:00-12:00 UTC affecting #43657 and others — stale-bot inactivity closures, NOT resolved bugs)

## Legend

- **Engaged** — We have posted comments with data/fixes
- **Monitoring** — Relevant to our work, watching for developments
- **New** — Recently discovered, not yet engaged

---

## Engaged Issues (we've posted on these)

| # | Title | State | Our involvement |
|---|-------|-------|-----------------|
| [#63147](https://github.com/anthropics/claude-code/issues/63147) | Extended-thinking session permanently wedges (`thinking:""`+signature re-sent on disk reload) | Open | Our **#63172 consolidated into it** (canonical "Cluster 13A"). Posted **binary-confirmed mechanism** 2026-05-29 as cnighswonger ([comment](https://github.com/anthropics/claude-code/issues/63147#issuecomment-4574730571)): env-var gates (`CLAUDE_CODE_DISABLE_THINKING=1`/`MAX_THINKING_TOKENS=0` disable thinking; `DISABLE_INTERLEAVED`/`ADAPTIVE` don't) + in-memory-vs-disk trigger taxonomy. Drove cache-fix #162 (opt-in proxy mitigation) + #160 (session-health). CVP-sanctioned binary analysis. |
| [#34629](https://github.com/anthropics/claude-code/issues/34629) | Prompt cache regression in --resume (~20x cost) | Closed | Root cause analysis, interceptor fix. Original bug that started this work. |
| [#40524](https://github.com/anthropics/claude-code/issues/40524) | Conversation history invalidated on subsequent turns | Closed | Image persistence discovery, fingerprint analysis, Renvect collaboration. Multiple posts. |
| [#42052](https://github.com/anthropics/claude-code/issues/42052) | Max 20x plan: 100% usage after 2 hours | Open | Bidirectional TTL data, overage mechanism analysis. TigerKay1926 has contradicting data (stuck 5m TTL). Vergil824 confirmed npm vs standalone cache difference, shared 1h cache patch — pointed to our interceptor (2026-04-09). |
| [#42260](https://github.com/anthropics/claude-code/issues/42260) | Resume loads disproportionate tokens from thinking signatures | Open | Posted analysis of opaque thinking token overhead. |
| [#27048](https://github.com/anthropics/claude-code/issues/27048) | Prompt cache invalidation on resume: plugin state changes | Open | Posted interceptor as solution, replied to thoeltig re: plugin registration logic (2026-04-08). |
| [#44045](https://github.com/anthropics/claude-code/issues/44045) | Prompt cache partial miss on every --resume turn | Open | Posted interceptor data, confirmed skill_listing block scatter (2026-04-08). bilby91 tested interceptor — 1h TTL works, found 1-char tool diff in Agent SDK. Asked for details (2026-04-09). |
| [#44724](https://github.com/anthropics/claude-code/issues/44724) | Subagent cache miss on first SendMessage resume | Open | Posted analysis — cache_read=0 suggests system prompt differs between Agent and SendMessage, not just block scatter. Asked for mitmproxy diff. (2026-04-08) |
| [#42542](https://github.com/anthropics/claude-code/issues/42542) | Silent context degradation — microcompact, cached microcompact, session memory compact | Open | Posted interceptor monitoring data — 0 microcompact events in 4,700+ calls, 84 budget warnings, confirmed no DISABLE_MICROCOMPACT. (2026-04-08) |
| [#45188](https://github.com/anthropics/claude-code/issues/45188) | System prompt grew ~70K tokens between v2.1.89 and v2.1.96 | Open | Posted comparison data — no growth on minimal setup between v2.1.92 and v2.1.96; growth is plugin-amplified. Added prompt size measurement feature. (2026-04-08). Replied to AlfredGuquan re: skill listing duplication on resume — 8+ injections per session, ~3-4K each (2026-04-19). |
| [#41930](https://github.com/anthropics/claude-code/issues/41930) | Critical: Widespread abnormal usage drain — multiple root causes | Open | Posted interceptor data corroborating root causes (2026-04-08). Source code analysis of "API Usage Billing" header, auth fallback vs token behavior (2026-04-09). Replied to marcuspuchalla (tool search) and Adanielyan92 (interceptor) (2026-04-09). **New Apr 20:** lemagus posted Pro plan drain — 64.8M cache_read tokens in one session, 77,000x ratio, wiped monthly Pro quota in one morning. Bug now hitting beyond Max tier. TidyWeb, vryugal, przadka, dw2021 also reporting. |
| [#34556](https://github.com/anthropics/claude-code/issues/34556) | Persistent memory across context compactions | Open | Shared our memory system approach — MEMORY.md index + typed topic files with YAML frontmatter. (2026-04-08) |
| [#45572](https://github.com/anthropics/claude-code/issues/45572) | CLI usage classified as API billing on Max | Open | Posted isClaudeAISubscriber() source analysis — none of the false conditions apply to their setup. Suggested subprocess auth context and Apr 4 backend regression. Offered interceptor for instrumentation. (2026-04-09) |
| [#44869](https://github.com/anthropics/claude-code/issues/44869) | Prompt cache completely broken — 16-26K on "hello" | Open | Posted root cause explanation (readdir jitter, resume scatter, TTL gating) and interceptor fix. (2026-04-09) |
| [#43657](https://github.com/anthropics/claude-code/issues/43657) | Resume/continue cache invalidation | **Closed (stale-bot 2026-06-11)** | Was closed, simpolism claimed "fixed in 2.1.97" — we posted test data showing scatter still present. Reopened after our comment (2026-04-09). **Re-closed 2026-06-11T11:42 by github-actions[bot] as `not_planned` for inactivity, NOT resolved.** Underlying bug still present per our v2.1.148 testing. |
| [#45756](https://github.com/anthropics/claude-code/issues/45756) | Pro Max 5x quota exhausted in 1.5h — cache_read counting at full rate? | Open | Defended against bot auto-closure. Shared v1.6.1 quota tracking, validated molu0219's analysis, collecting off-peak data. (2026-04-09). **New Apr 21:** nikhilsitaram called out Anthropic's 1h→5m TTL switch contradiction — Boris references 1h windows but server enforces 5m. |
| [#66728](https://github.com/anthropics/claude-code/issues/66728) | Safety classifier cascade-lock: Fable 5 false-positive → Opus 4.8 fallback ALSO fails → session stuck. Only Sonnet escapes. | Open | Posted "turn-scoped vs session-locked" framing 2026-06-10. Posted second-instance corroboration 2026-06-11 ([comment](https://github.com/anthropics/claude-code/issues/66728#issuecomment-4680609201)) — added Opus 4.8-also-fails + Sonnet-escapes data points. Hypothesis: shared model-class gate with v2.1.170 autonomy-append hardcoding. Cluster: #66973, #66662, #66672, #66671, #66595, #66657, #67205, #67204. Canonical thread for the cascade-lock pattern. |
| [#66815](https://github.com/anthropics/claude-code/issues/66815) | Image-processing-error retry storm — 19 retries × 34 MB context, 60% Q5h consumed | Open | Drives cache-fix directive PR #213 (image-retry circuit breaker, cleared at lead-gate 2026-06-11). Reporter filed under Anthropic Fin support direction. **Note:** [#47391](https://github.com/anthropics/claude-code/issues/47391) is the same bug pattern from May — closed `not_planned` by stale-bot 2026-06-11T11:41 for inactivity, NOT resolved. Two issues for the same bug; bug remains. |
| [#66734](https://github.com/anthropics/claude-code/issues/66734) | Session JSONL rewritten in-place to metadata-only stub — user/assistant records lost (2.1.168–2.1.170, since native installer migration) | Open | Tagged `data-loss` by Anthropic. Drives cache-fix directive PR #214 (JSONL session-content mirror). |
| [#66486](https://github.com/anthropics/claude-code/issues/66486) | 2.1.169: interactive sessions write no JSONL transcript (only ai-title stub) | **Closed (fixed in 2.1.170)** | Companion to #66734. Also informs cache-fix directive PR #214. |
| [#66761](https://github.com/anthropics/claude-code/issues/66761) | Workflow-tool agent() subagents omit x-claude-code-agent-id / parent-agent-id (Task subagents are tagged) | **Closed** | Closed without fix-commitment; gap remains, fix would not be retroactive. Drives cache-fix directive PR #215 (Workflow agent-id attribution, proxy-derived). |
| [#67055](https://github.com/anthropics/claude-code/issues/67055) | Desktop: false "GitHub CLI authentication expired" toast — any `gh auth status` failure (incl. 5s timeout) classified as expired credentials | Open | Multi-platform repro confirmed. Drives cache-fix directive PR #216 (tools/gh-auth-status-shim PATH-shim workaround). Sunset on issue close. |

## Monitoring — Directly relevant

| # | Title | State | Why it matters | Fresh activity |
|---|-------|-------|---------------|----------------|
| [#43044](https://github.com/anthropics/claude-code/issues/43044) | --resume loads 0% context on v2.1.91 | **Closed** | Three regressions in session loading pipeline, source-code verified. Listed in our README. **Silently closed by Anthropic with no comment (2026-04-09).** ArkNill flagged it. | 2026-04-09 |

## Monitoring — Related (quota/cost/context)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#38335](https://github.com/anthropics/claude-code/issues/38335) | Max plan limits exhausted abnormally fast since March 23 | Open | 466 comments. Mega-thread on quota drain. Cache bugs are a contributing factor. |
| [#38239](https://github.com/anthropics/claude-code/issues/38239) | Extremely rapid token consumption | Open | 62 comments. Parallel thread to #38335. |
| [#41930](https://github.com/anthropics/claude-code/issues/41930) | Critical: Widespread abnormal usage drain — multiple root causes | Open | 39 comments. Best-organized analysis of the multi-cause problem. |
| [#16157](https://github.com/anthropics/claude-code/issues/16157) | Instantly hitting usage limits with Max subscription | Open | 1,440 comments. The original mega-thread. |
| [#6457](https://github.com/anthropics/claude-code/issues/6457) | 5-hour limit reached in less than 1h30 | Open | 119 comments. Long-running thread. |
| [#40851](https://github.com/anthropics/claude-code/issues/40851) | Opus 4.6 (Max $100) — Quota reaches 93% after minimal prompting | Open | 16 comments. Single-session quota drain. |
| [#41617](https://github.com/anthropics/claude-code/issues/41617) | Excessive token consumption after recent updates | Open | 16 comments. Post-update cost spike. |
| [#41583](https://github.com/anthropics/claude-code/issues/41583) | Rate limit errors on Pro Plan at 26% usage | Open | Rate limit stuck per-session, contradicts docs. |
| [#33949](https://github.com/anthropics/claude-code/issues/33949) | SSE streaming hangs indefinitely | Open | Root cause analysis with fix proposals. Affects session stability. |
| [#34556](https://github.com/anthropics/claude-code/issues/34556) | Persistent memory across context compactions | Open | 59 compactions documented. Related to our memory/CLAUDE.md approach. |

## CRITICAL: v2.1.112 / v2.1.113 — context window cut + preload death (Apr 17)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#50083](https://github.com/anthropics/claude-code/issues/50083) | 1M context window silently removed for Max 5x in v2.1.112 | Open | Server-side `context-1m-2025-08-07` experiment flag revoked. Recurring pattern (Mar 26, Apr 13, Apr 17). Workaround: `DISABLE_COMPACT=1` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` (v2.1.112 only). Cross-linked from #41082, #44403, #47549. |
| [#49585](https://github.com/anthropics/claude-code/issues/49585) | Per-turn smoosh pipeline folds dynamic system-reminders | Open | Our primary thread. deafsquad posted comprehensive v2.1.112/v2.1.113 impact analysis (Apr 17). v2.0.3 shipped to fix sticky marker overflow. |

### Our repo issues

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#35](https://github.com/cnighswonger/claude-code-cache-fix/issues/35) | v2.1.113 removes cli.js | Open | Bun binary replaces Node.js. `--import` preload dead. deafsquad proposed proxy via `ANTHROPIC_BASE_URL`. wadabum raised concern about subscription auth compatibility. |
| [#36](https://github.com/cnighswonger/claude-code-cache-fix/issues/36) | Microcompact rewrites bust cache prefix on idle sessions | Open | `time_based_microcompact` clears old tool results, changing prefix bytes. Reported by Jonathan via contact form. |
| [#39](https://github.com/cnighswonger/claude-code-cache-fix/issues/39) | Upstream change detection — alert on CC-originated changes | Open | Fingerprint request structure, alert on drift. Remote telemetry option for enterprise. cc @deafsquad. |

## Engaged — new since Apr 10

| # | Title | State | Our involvement |
|---|-------|-------|-----------------|
| [#50513](https://github.com/anthropics/claude-code/issues/50513) | Complex engineering behavior regression across sessions | Open | Posted Priority E follow-up with three-dataset convergence (Apr 22). ArkNill posted 38,996-request dataset with GrowthBook feature flag causal evidence — toggling flags dropped truncation/clearing events to zero across 9,996 requests. YuriyKrasilnikov maintaining evidence map. |
| [#52002](https://github.com/anthropics/claude-code/issues/52002) | Agent-initiated compaction (feature request) | Open | Filed by us (Apr 22). No comments yet. |
| [#47098](https://github.com/anthropics/claude-code/issues/47098) | New sessions will NEVER hit a full cache | Open | Posted interceptor layer coverage breakdown (Apr 17). wadabum cross-linked #50085 (attribution header). |
| [#38335](https://github.com/anthropics/claude-code/issues/38335) | Max plan limits exhausted abnormally fast | Open | Posted v2.1.113 proxy path forward (Apr 18). 466+ comments mega-thread. |
| [#42796](https://github.com/anthropics/claude-code/issues/42796) | Claude Code unusable for complex engineering (Feb updates) | Closed | OP is Stella Laurenzo (AMD AI team). Adaptive thinking regression. fgrosswig referenced re: 4.7 changes. |

## NEW: v2.1.101 regression cluster (Apr 10 evening)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#46437](https://github.com/anthropics/claude-code/issues/46437) | Context window not set to 1M on Max despite Opus 4.6 | Open — Chris shut down git-bot autoclose + 👀 reaction (2026-04-10 evening) | Directly in our lane — 1M context allocation / plan-tier identification. Possibly the same capacity-rationing mechanism v2.1.78 introduced ("model dropdown no longer offers 1M context variant to subscribers whose plan tier is unknown"). Worth a close read in the morning. |
| [#46444](https://github.com/anthropics/claude-code/issues/46444) | Worktree auto-cleanup permanently deleted 10 days of work | Open | Data-loss escalation. Windows-specific. Not in our lane but serious for filer. Monitor only. |
| [#46445](https://github.com/anthropics/claude-code/issues/46445) | /continue and /resume showing cross-project sessions in 2.1.101 | Open | Session visibility regression — adjacent to our resume-path work but not a cache bug. Monitor. |

## NEW: Quota accounting / billing routing cluster (Apr 7-9)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#45249](https://github.com/anthropics/claude-code/issues/45249) | Max 20x subscription ignored — 100% routing to Extra Usage | Open | Billing routing regression. Subscription untouched, all calls to Extra Usage. Disabling Extra Usage = hard failure. |

| [#45660](https://github.com/anthropics/claude-code/issues/45660) | aside_question subagent duplicates entire session | Open | New token drain vector — subagent copies full context, massive waste. |
| [#45333](https://github.com/anthropics/claude-code/issues/45333) | Excessive token consumption on Opus 4.6 — thinking disproportionate | Open | Thinking overhead separate from cache issues. |


## Community Research

| Resource | Author | Relevance |
|----------|--------|-----------|
| [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) | @ArkNill | 7 bugs: microcompact, budget caps, false rate limiter, JSONL duplication, extended thinking quota. **New:** 38,996-request dataset (Apr 1-16), GrowthBook feature flag causal test (truncation/clearing → zero when flags toggled), Opus 4.7 2.4x burn advisory. Pivoting to llm-relay (multi-provider). |
| [X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor) | @Renvect | HTTPS proxy with dashboard, system prompt diffing, per-tool stripping thresholds |
| [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) | @fgrosswig | Self-hosted dashboard with SSE live monitoring, multi-host aggregation, forced-restart detection, compaction analysis, quadratic cost modeling. v1.4.0 shipped 2026-04-11. Reads from `~/.claude/projects/**/*.jsonl` + optional HTTP proxy. Complementary vantage point to our in-process interceptor. Includes `scripts/scrub-for-public.sh` for log sanitization before sharing. |
| [NEXO Brain](https://github.com/wazionapps/nexo) | @wazionapps | MCP-based "shared brain" for AI agents. Persistent memory, semantic RAG, natural forgetting, metacognitive guard, trust scoring, 150+ MCP tools. Works with Claude Code, Codex, Claude Desktop & any MCP client. 100% local, open source, npm `nexo-brain`. **License: AGPL-3.0** — safe to reference the architecture but deep integration contaminates downstream code. Benchmarked on LoCoMo (F1 0.588, +55% vs GPT-4). Adjacent to the "curated brain" concept in `project_curated_brain.md` memory but from a different angle (passive accumulation vs. deliberate curation). Monday-queue item: ship a `claude-meter → NEXO` data exporter since we produce structured per-call telemetry that NEXO can ingest for free without touching their AGPL code. |

## Key People

| User | Contribution |
|------|-------------|
| @TigerKay1926 | Detailed TTL tracking data showing stuck 5m TTL even at 0% quota. Contradicts our bidirectional findings — may indicate second mechanism. |
| @thoeltig | Plugin registration logic analysis (#27048). Raised architectural concern about CC rewriting conversation start without intermediate messages. |
| @Renvect | Image duplication discovery, cross-project contamination, X-Ray proxy. Active collaborator on #40524. |
| @jmarianski | MITM proxy + Ghidra reverse engineering of standalone binary. Multi-mode cache test script. |
| @VictorSun92 | Original monkey-patch fix for v2.1.88, partial scatter detection on v2.1.90. |
| @ArkNill | Systematic proxy-based analysis of 7 hidden bugs. Microcompact/budget/false-rate-limiter documentation. |
| @bilby91 ([Crunchloop DAP](https://dap.crunchloop.ai)) | SDK-level reproduction of skill_listing block missing from messages[0] (#44045). Clean minimal repro. Agent SDK / DAP production user. Tested v1.5.1 (deferred tools fix) and v1.6.2 (fresh-session sort + identity normalization). First production team to merge the interceptor to trunk for team-wide deployment (2026-04-10). |
| @Alpha2Zulu1872 | Persistent phantom billing on disabled keys, "API Usage Billing" header investigation (#41930). Active support ticket 215473797766657. |
| @Sn3th | Comprehensive microcompact/context degradation documentation (#42542). Three clearing mechanisms identified. |
| @kolkov | Source-code verified analysis of 3 regressions in session loading pipeline (#43044). |
| @labzink | Subagent/SendMessage cache miss discovery (#44724). |
| @Vergil824 | Independent npm vs standalone cache confirmation, 1h cache enforcement patch (#42052). |
| @marcuspuchalla | Reported enable_tool_search improvement on v2.1.74 (#41930). |
| @Adanielyan92 | v2.1.96 user, $200 weekly quota in 3 days, 5x session drain (#41930). |
| @molu0219 | Rigorous cache_read quota accounting analysis (#45756). Measured 103.9M raw tokens, hypothesized cache_read counts at full rate for quota. |
| @triphase-physics | Max 20x billing routing bypass — 100% Extra Usage, subscription untouched (#45249). |
| @odgriff79 | OAuth-only billing misclassification — CC treating Max as API billing (#45572). |
| @fgrosswig ([claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)) | Self-hosted forensic dashboard + private `claude-gateway` proxy. Model spoofing discovery (76 silent Haiku transitions), 12.5x A/B burn rate test (4.6 vs 4.7), session lifecycle charting. Private repo collaborator. |
| @Hisham-Hussein | Surfaced the v2.1.81 pin workaround on 2026-04-11 morning in #38335 — "pin to v2.1.81 for pre-March-23 behavior." Kicked off the cross-version investigation that produced the ScheduleWakeup 5m TTL finding and the March 23 server-side regression hypothesis. |
| @deafsquad | 7 PRs (#26-33) shipped in v2.0.0/v2.0.1: smoosh_split, session_start_normalize, continue_trailer_strip, deferred_tools_restore, reminder_strip, cache_control_normalize, tool_use_input_normalize, cache_control_sticky. Proposed and built proxy architecture for v3.0.0 (post-Bun migration). 1400+ message production session validating v2.0.3. |
| @wadabum | Cache layer analysis (#47098), attribution header discovery (#50085), `ANTHROPIC_BASE_URL` subscription auth concern (#35). Key architectural thinker. |
| @cowwoc | First to report v2.1.113 Bun binary switch (#35). Suggested proxy refactor. |
| @stellaraccident | AMD AI team lead. Filed #42796 (Claude Code unusable for complex engineering). High-visibility signal on adaptive thinking regression. |
| @lemagus | First documented **Pro plan** quota drain with hard ccusage data (#41930, Apr 20). 64.8M cache_read tokens in one session, 77,000x ratio, wiped monthly Pro quota in a morning. Proves drain extends beyond Max tier. |
| @nikhilsitaram | Called out Anthropic's 1h→5m TTL contradiction (#45756, Apr 21) — Boris references 1h cache windows while server enforces 5m. |
| @AlfredGuquan | Documented skill listing duplication on resume (#45188, Apr 19) — 8+ injections per session, ~3-4K tokens each. |
| @YuriyKrasilnikov | Maintaining evidence map and appendix on #50513. Engaged ArkNill for cross-validation. |
| @ThatDragonOverThere | 5 detailed posts on #41930 (Apr 23): 54% Q7d in 34.5h on v2.1.118, confirmed default effort silently upgraded to high for all models, identified three compounding factors on 4.7 launch. Best independent analysis of the effort+pricing+context triple hit. |
| @ANogin | Bedrock/LiteLLM cache_read double-counting (#45756, Apr 22-23). 19.3M input / 19.2M cache_read suggests input includes cache_read on Bedrock path. We disambiguated: direct Anthropic auth shows 0.1x weight, not double-counted. |
| @TheAuditorTool | Max20 depleted in 32 minutes, one Q5h = 18% weekly (#38335, Apr 23). Previously assessed our tool as "LEGITIMATE." Now documenting the cost crisis himself. |

## Media Coverage

| Source | Title | Date |
|--------|-------|------|
| [The Register](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/) | Claude quota drain not caused by cache tweaks | Apr 13 |
| [DevOps.com](https://devops.com/claude-code-quota-limits-usage-problems/) | Developers Using Claude Code Hit by Token Drain Crisis | Apr 2026 |
| [paddo.dev](https://paddo.dev/blog/anthropic-trust-erosion/) | The Trust Tax: Anthropic's Worst Month | Apr 2026 |
| [Medium/@marianski.jacek](https://medium.com/@marianski.jacek/claude-code-cache-crisis-a-complete-reverse-engineering-analysis-9a6f4e03fae4) | Claude Code Cache Crisis: A Complete Reverse-Engineering Analysis | Apr 2026 |
| [SmartScope](https://smartscope.blog/en/blog/claude-code-token-consumption-cache-bug/) | Why Claude Code Burns Through Tokens So Fast | Apr 2026 |
| [devclass](https://www.devclass.com/ai-ml/2026/04/14/claude-code-cache-confusion-as-anthropic-tweaks-defaults-but-quotas-still-drain/5216975) | Claude Code cache confusion as Anthropic tweaks defaults | Apr 14 |

---

## Confirmed Fixes

Users who have confirmed the interceptor resolved their issue:

| User | Issue | What was fixed |
|------|-------|---------------|
| @bilby91 | [#44045](https://github.com/anthropics/claude-code/issues/44045) | 1h cache TTL preserved with interceptor on Agent SDK. Tool reorder fix shipped in v1.5.1. Fresh-session sort fix shipped in v1.6.2 — root cause: `normalizeResumeMessages` early-return on `length < 2` left first call unsorted, busting cache prefix on every resume turn. |

---

## Issues needing our attention

## NEW: Upstream cache-busting mechanisms (wadabum, Apr 12)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#47098](https://github.com/anthropics/claude-code/issues/47098) | New sessions will NEVER hit a full cache | Open | Skills + CLAUDE.md blocks in `messages[0]` are not prefix-cacheable. Regenerated non-deterministically on fresh session / `/clear`. 6,505+ tokens of cache_creation even seconds after prior session. Separate from TTL issue — prefix placement problem. **Our issue #12.** |
| [#47107](https://github.com/anthropics/claude-code/issues/47107) | Uncachable system prompt caused by git status | Open | `includeGitInstructions` (default: true) injects live `git status` into `system[]`. Every file edit busts the entire system-prompt cache prefix. **Our issue #11.** |

### Completed (2026-04-23 — v3.0.3/v3.0.4/v3.0.5 shipped, three CC issues filed)
- **v3.0.3** — corp proxy support (PR #54, @X-15), Korean README (PR #56, @ArkNill), Chinese README restructured
- **v3.0.4** — cache-telemetry extension now persists quota state to disk (was broken since v3.0.0 for all proxy users)
- **v3.0.5** — status bar reads from quota-status.json instead of dead claude-meter.jsonl
- **Filed CC #52376** — thinking.display for subscription sessions (thinking content server-gated, signature = encoded billing token)
- **Filed CC #52470** — MCP hot-reload without session restart
- **Filed CC #52534** — Opus 4.7 ignores CLAUDE_CODE_EFFORT_LEVEL env var and settings.json (pins to xhigh)
- **Binary analysis findings:** CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING only matches 4.6 model strings, silently ignored on 4.7. Opus 4.7 defaults to xhigh effort (not high as ThatDragonOverThere reported — it's worse). Thinking block "signature" field = encoded content used for billing via tl8() function (length * 0.75 = tokens).
- **#45756** — Posted cache_read double-counting disambiguation. Direct Anthropic auth = 0.1x weight (not double-counted). ANogin's finding is Bedrock/LiteLLM-specific.
- **#41930** — ThatDragonOverThere posted 5 detailed comments: 54% Q7d in 34.5h, default effort silently upgraded, three compounding factors on 4.7 launch.
- **#38335** — TheAuditorTool: Max20 depleted in 32 minutes, one Q5h window = 18% weekly (was 8.5% before Mar 23). mhbosch: Codex gained 1M users in two weeks (German press).
- **All three filed issues got bot "duplicate" responses** — no actual dups linked (known bot behavior).
- **No Anthropic engineer responses** on any tracked issue today.

### Completed (2026-04-22 — v3.0.1 shipped, issue sweep)
- **v3.0.1 proxy shipped to npm**, v3.0.0 proxy architecture issue #40 closed.
- **v3.1.0 milestone created** — #47 (overage warning), #48 (systemd service), #39 (upstream detection) tagged.
- #50513: Priority E follow-up posted with three-dataset convergence data. ArkNill responded with 38,996-request GrowthBook causal evidence.
- #45188: Replied to AlfredGuquan (skill listing duplication, 8+ injections per session).
- #52002: Filed agent-initiated compaction feature request.
- **Sweep findings (no action taken):**
  - #41930: Pro plan drain now documented (lemagus, 64.8M cache_read). Bug spreading beyond Max tier.
  - #45756: nikhilsitaram flagged 1h→5m TTL contradiction in Anthropic's own messaging.
  - No Anthropic engineer responses on any tracked issue since Apr 18.

### Completed (2026-04-12 morning — Sunday check-in)
- #38335: Replied to @ssougnez with v2.1.81 pin instructions + interceptor recommendation + soft ask for fallback-percentage data contribution.
- #38335: @dewtoricor1997-ship-it posted **first independent replication of v2.1.81 pin on Max 20x** — "reached ONLY 10% of my weekly quota vs 30% on v2.1.83+, approximately 3-4× improvement." Strongest community validation datum to date. Held acknowledgment for Monday Part 2 bundle.
- #38335: @Codename-404 reported +51% Q5h in 20 min of idle + 8% Q7d spike on Max $100, not peak hours. Textbook TTL-downgrade-at-cap behavior per our Layer 2 model.
- #41930: @elvisskensberg reported "weekly reset should have been 0% but woke up at 75%." Max $200. Possible Layer 3 sticky variant or carry-over mechanism. Monitoring.
- npm downloads: Apr 11 = 202 (down from 489 on Apr 10). Likely Saturday effect; waiting for Monday data before interpreting.

### Completed (2026-04-11 afternoon — March 23 regression investigation)
- **Blog post published**: "The 5-Minute Baseline: What We Found in Claude Code's Tools Array" — https://vsits.co/5-minute-baseline-tools-array/ — standalone from the cache investigation series. Anchored on the ScheduleWakeup tool description confirming 5m TTL baseline from Anthropic's own product code.
- **Cross-version investigation**: Installed v2.1.81, v2.1.83, v2.1.90, v2.1.101 side-by-side via `~/bin/cc-version` launcher. Dumped full tools array per version via `CACHE_FIX_DUMP_TOOLS=<path>` hook. Found: (a) v2.1.81→v2.1.83 client diff is ~500 chars of schema (not enough to explain quota drain), (b) v2.1.101 adds Monitor+ScheduleWakeup tools totaling 6,615 chars = ~1,700 extra prefix tokens per turn, (c) `ScheduleWakeup` description quotes 5m TTL as baseline and advises avoiding 300-1200s sleeps. Full investigation doc at `docs/march-23-regression-investigation.md`.
- #38335: Posted cross-version measurement table, ScheduleWakeup quote, server-side hypothesis (regression not aligned with client release), and practical decision tree (pin v2.1.81 / interceptor / both). Directly tagged @dewtoricor1997-ship-it with request for per-turn token delta from their v2.1.81 downgrade test.
- #42052: Posted ScheduleWakeup quote confirming TigerKay1926's "stuck 5m TTL" observation from Anthropic's own tooling side. Linked to blog for fuller context.

### Completed (2026-04-11 morning)
- #38335: Replied to @TheAuditorTool's cache_read discount removal theory with 500-call telemetry sample — 228M cache_read tokens tracking at discounted rate (8.8× ratio discounted vs full-rate). Flagged @dewtoricor1997's fresh-reset `/compact` costing 7% Q5h as worth independent confirmation. Distinguished API-level discount (still live) from Max quota divisor (unknown).

### Completed (2026-04-10 afternoon — v1.6.2 release)
- **v1.6.2 shipped to npm.** Three changes:
  - fix: fresh-session sort/pin (#5, bilby91 #44045) — removed `messages.length < 2` early return. Validated on CC v2.1.97 + v2.1.100, call 2 cache_read = call 1 cache_creation to the exact token.
  - feat: opt-in identity normalization (#6, labzink #44724) — `CACHE_FIX_NORMALIZE_IDENTITY=1` rewrites Agent SDK identity in `system[1]` to canonical Claude Code identity, fixing Agent()→SendMessage() cache parity.
  - feat: opt-in output efficiency rewrite hook (#1/#4, @VictorSun92 PR) — `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` rewrites the `# Output efficiency` system prompt section.
- #44724: labzink confirmed system[1] identity diff via mitmproxy. Posted v1.6.2 update with opt-in fix instructions.
- #41930: Replied to 2008sliu re: npm vs binary install + v2.1.100 status.
- v2.1.100 shipped 05:00 UTC. Tested with v1.6.2 — interceptor works, CC scatter still present.

### Completed (2026-04-10 morning)
- #45572: Posted isClaudeAISubscriber() source analysis for odgriff79. First comment on the issue.
- #44869: Posted cache bug root cause explanation and interceptor fix for talesmetal. First comment on the issue.
- #43657: Countered simpolism's "fixed in 2.1.97" claim with v2.1.97 test data showing resume scatter still present. Reopened by simpolism after our comment.
- #45756: Posted to defend against bot auto-closure. Shared v1.6.1 quota tracking capability, validated molu0219's analysis.

### Completed (2026-04-09)
- #41930: Source code analysis of "API Usage Billing" header + auth fallback behavior for Alpha2Zulu1872 (thumbs-up received). Replied to marcuspuchalla (tool search + interceptor) and Adanielyan92 (interceptor recommendation).
- #44045: bilby91 tested interceptor, 1h TTL confirmed. Debug trace received via email — root cause: readdir ordering jitter + whitespace diff. v1.5.1 shipped with sortDeferredToolsBlock + content pinning fix. Posted sanitized findings publicly.
- #42052: Replied to Vergil824 — acknowledged npm vs standalone finding, pointed to our interceptor.
- #43044: Silently closed by Anthropic. Logged in internal tracker.

### Completed (2026-04-08)
All previously flagged issues engaged. 8 comments posted across 8 issues.
