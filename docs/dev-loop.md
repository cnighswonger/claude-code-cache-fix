# Dev loop: working on this proxy without shipping cache busts

Read this before changing anything under `proxy/`. It is the procedure that
found six self-inflicted defects in one day (2026-07-28) after months in which
every one of them was live and invisible.

## The four commands

```sh
node tools/replay.mjs <capture.jsonl> --census   # what shapes are in this traffic
node tools/replay.mjs <capture.jsonl> [--env …]  # the GATE — must exit 0
node tools/gate-live.mjs                         # the gate over EVERY live capture
node tools/harvest.mjs                           # promote novel pairs to fixtures
npm test                                         # committed fixtures, deterministic
```

`npm test` is necessary and not sufficient — see "the corpus is blind along
its own curation axis" below. `gate-live` is the one that runs against
production-shaped input.

Captures live in `~/.claude/cache-fix-captures/` (written by the
`request-capture` extension, `CACHE_FIX_REQUEST_CAPTURE=1`).

## The gate

`tools/replay.mjs` runs the real pipeline over recorded traffic and enforces
four invariants. It exits non-zero on any of them, so it is a gate, not a
report.

| check | question | failure means |
|---|---|---|
| **stability** | did our output diverge EARLIER than CC's input? | we made a bust bigger than CC's bug required |
| **safety** | same message count, roles, order, tool adjacency? | we corrupted the conversation |
| **sequence** | does a normalize get followed by a reset? | a mitigation that works once and bleeds after |
| **canonical order** | do canonical entries map to increasing wire indices? | our state model has drifted from the wire |

Safety outranks the rest: cache costs money, a mangled history costs
correctness.

`--census` classifies structural deltas; `--trace` shows per-conversation
extension state. `--trace` is a **diagnostic, not a gate** — it has never gone
red on a defect it was built for, so it carries no authority.

## Standing rules

**Captures are PRE-pipeline** (`request-capture` runs at order 60, ahead of
every mutating extension). So: a divergence present in the raw capture is
Claude Code's; one absent there is OURS. That single fact is what makes
attribution possible instead of speculative — use it before blaming either
side.

**Group by conversation before comparing anything.** One session-id header
carries the main thread, every subagent, and CC's own sidecar calls. Comparing
across them makes tenant switches look like churn. This artifact produced
false results six separate times in one day, including in the gate itself —
adjacent-line pairing reported 0 violations on a 602-request capture while a
40-request single-conversation slice of the same session reported 2.

**A green gate is required; token numbers are advisory.** The goal is zero
preventable busts. `tools/cache-sim.mjs` prices what the gates let through,
and its absolute totals are not trustworthy (see its header) — use it for A/B
deltas on one corpus, never as a verdict.

**Run `npm test` alone.** The suite shells out to `git`, so a concurrent
commit in the same repo makes it block on `index.lock` — once observed as a
600-second hang that looked like a hung test.

## Replay the configuration that is SERVING, not the defaults

`replay.mjs` inherits nothing from the systemd unit. Extension gates are read
from `process.env`, and several default OFF while production sets them ON —
`CACHE_FIX_TOOL_REWRITE` is the one that bit. On 2026-07-28 every gate run
that day exercised a pipeline nobody runs:

    default gates:     0 stability violations
    production gates:  2 stability violations, both deferred-tool-rewrite

Same corpus, same code, same day. A green verdict over the wrong
configuration is worth nothing, and it is worse than no verdict because it
reads like one.

`tools/gate-live.mjs` now resolves the gate set from the running unit and
prints it, so every sweep is self-describing. Three answers to "which gates"
must agree, and `doctor` compares all three:

    DECLARED   Environment= in cache-fix-proxy.service
    RUNNING    /health `gates` — what the process actually started with
    VERIFIED   `gates` in cache-fix-gate-status.json — what the sweep replayed

DECLARED ≠ RUNNING means the unit was edited without a restart. VERIFIED ≠
RUNNING means the sweep's verdict does not apply to production. Either way
the other two answers become meaningless, so both are FAIL.

Running a one-off replay by hand? Pass the gates, or you are testing fiction:

```sh
node tools/gate-live.mjs        # resolves them for you — prefer this
```

## Rule out the instrument before reporting a defect

When a check goes red, there are always two hypotheses: the SYSTEM is broken,
or the CHECK is. Report the first without excluding the second and you file a
phantom — and on 2026-07-28 five of six things that looked like Claude Code's
bug were ours, while the safety gate's first 243 "corruptions" were its own
missing exemption. The instrument is not a neutral observer; it is the newest
and least-tested thing in the room.

Order that works, cheapest first:

1. **Is the pair what you think it is?** Violations are reported per
   CONVERSATION, so the predecessor is usually not the previous capture line.
   Diff `prevN` against `n` — never `n-1` against `n`. (This cost a wrong
   diagnosis: the pair was 44→47, the probe compared 46→47, and the two
   unrelated subagent requests it diffed looked like total corruption. The
   violation line now prints `prevN->n` for that reason.)
2. **Is the checker's own exemption list current?** A DECLARED behaviour —
   `deferred-tool-rewrite`'s `tool_addition` announcement is the standing
   example — is not a defect, and a check that forbids it trains its reader
   to ignore red.
3. **Read the attribution the gate already prints.** Every stability
   violation now carries `[CC bytes at outDiv IDENTICAL -> ours]` or
   `[CC also changed outDiv]`. The first means the divergence is ours by
   construction — nothing upstream changed at that index — and needs no
   probe. This line exists because the same comparison was hand-derived by
   throwaway script three times in one day; the throwaway probe is the tell
   that a check is missing.
4. **Only then look at the bytes.** Print the diverging index from both
   sides and read what is actually there.

Whenever a step of this list gets answered by hand twice, that is the signal
to move it into the tool. Steps 1 and 3 both started as manual probes.

A finding survives this and it is real: at index 4, request 44 carried an
injected `tool_addition` block that request 47 did not. That is a genuine
self-inflicted bust, and it was worth being sure before saying so.

## "Streams" is a claim about a mechanism, not an API choice

The capture read was fixed for scale twice and was still O(file) the third
time. `readFile` → RangeError (found 2026-07-28); per-entry retention →
compactEntry (same day, "the wall had only moved"); and then readline's async
iterator, which reads push-based and buffers every line the consumer has not
taken yet. The replay awaits per request, so during each await the queue grew
— measured 2026-07-29: 1.2 GB held after 25 consumed lines, the entire
remaining file (~2.3 GB as strings) by line 75, a 3.27 GB peak wearing a
comment that said "streamed, never slurped".

Three things worth keeping from the episode:

- **Verify the mechanism, not the API shape.** "We use a stream now" was true
  and irrelevant — reading happened at disk speed regardless of consumption.
  The content question is `bytesRead` against bytes consumed, and it is
  cheap: the read-lines bite test asks exactly that and went red on line 3
  against the readline shape.
- **A probe must reproduce the consumer's YIELD behaviour, not just its
  cost.** The first probe simulated per-line work with a synchronous
  busy-wait: the event loop never turned, the stream could not run ahead, and
  the probe reported the defect absent. Swapping the busy-wait for
  `await sleep(40)` — same delay, one yield — showed 2.3 GB. A slow consumer
  and an *awaiting* consumer are different programs to a push-based source.
- **A recurring failure class earns a resource cap as its standing check.**
  After the third wall, the fix stopped being only code: gate-live now runs
  every replay child under `--max-old-space-size=2048`. A replay that truly
  streams needs ~15% of capture bytes; one that regressed into retaining its
  input dies against the cap and fails the sweep the same day, whatever the
  fourth wall turns out to be made of.

## The census names the class; only content names the cause

Row 4 sat "re-opened" for a day with the mechanism unexplained — while an
outside reporter with far lighter tooling (#78660) had already named it. The
gap was not effort; it was a structural blindness we designed in: the census
reduces messages to hashes and ordinals, which is what makes it scalable and
publishable, and exactly what makes it causally mute. Hashes can say
same/different/moved; they cannot say "this is the task-tools nudge, and it
anchors to the last human message." Two rules from the miss:

- **When a class is localized, return to the bytes and to the STRUCTURE.**
  Read the actual content at the offending position (once, locally — the
  privacy discipline applies to what gets committed, not to what gets read),
  and relate the position to conversation structure: roles, anchors,
  injection zones. The verdict that closed row 4 was one 30-line matcher
  relating edit positions to the last human-typed message (20 of 22 within
  ±2). That relation now lives in the census itself (`anchorDelta` on every
  edit row, with a "far from any anchor = new mechanism" callout) — the
  matcher was the prototype, per the standing rule about throwaway probes.
- **Sweep the public tracker when an investigation OPENS, not after it
  ships.** The row-4 mechanism sat in a public issue for over two weeks
  while we derived the same facts independently. One `gh search issues` per
  new unexplained class converts an investigation into a verification —
  strictly cheaper, and the verification is worth posting back.

## Never hand-roll identity in a probe

Twice on 2026-07-28 a throwaway probe reached a wrong conclusion because it
computed its own notion of "the same message" instead of importing the one the
code uses:

- a probe hand-built a session key, found a collision that did not exist, and
  reported a bug against production code;
- a probe compared message SETS to decide whether a pair was a tail append. It
  was a mid-history edit at index 768. The probe had printed the positional
  divergence in the same output and it was read past — set membership says
  "these entries all still exist", which is not the question a cache asks.

A third on 2026-07-31, in a NEW tool rather than a throwaway probe: a census
of the row-4 container migration paired requests by `sid`, then by its own
first-message hash, instead of importing `conversationOf`. It reported 475
rule failures — 99.3% — and every row read `actual=0ch`, the tell that no
counterpart was found AT ALL rather than a rule that failed. Two distinct
errors rode in on the hand-rolled identity: comparing `before[i]` to
`after[i]` by INDEX (one inserted message shifts every later index), and
pairing ADJACENT capture lines (live traffic interleaves main, subagent and
sidecar, so two requests of one conversation sit several lines apart — the
trap `replay.mjs` already documents at its grouping comment). Corrected
grouping turned 475 failures into 0. Both wrong answers looked like findings
and would have blocked a correct mitigation.

Both are the same mistake as the collisions in the extensions themselves: an
identity computed more cheaply than the thing it identifies. Import
`semanticIds`, `identityKey`, `firstDivergence`, `censusPair`,
`conversationOf` — never re-derive them inline. Two corollaries the third
instance forced:

- **Extend an existing tool before writing a new one.** If a tool in the
  domain already exists, the default is to add the mode there; a new file
  needs a stated reason the existing one did not fit. This is not tidiness —
  reuse INHERITS hard-won correctness (the interleaving lesson, the pairing
  rule, the three-answer discipline), while a fresh file re-earns every one
  of them from zero, silently and usually wrongly.
- **Any comparison of two requests is grouped by CONVERSATION, never by
  capture adjacency and never by index.** `conversationOf` is exported from
  `replay.mjs` for exactly this; if a tool needs an identity that is not
  exported yet, export it rather than restate it. And when a question is about CACHE, the answer is always
POSITIONAL: the API keys on the longest identical PREFIX, so "what changed and
at which index" is the only form that means anything. "Which entries exist"
never is.

The tools now answer it directly — `--census` prints `edit@N of M` per
replace/edit and `[CC bytes at outDiv IDENTICAL -> ours]` per violation — so
reaching for a probe at all is the signal that something is missing from them.

## A checker has THREE answers, not two

    verified clean    -> pass
    verified broken   -> fail
    COULD NOT VERIFY  -> its own answer, folded into neither

The third is where checkers lie, and it happened three times on 2026-07-28
alone:

- `claude-worktime --cold` printed **"No cold rewrites recorded"** while 26 real
  records sat in the file — its parser had died on one malformed line and the
  error went to `/dev/null`;
- the gate sweep would have reported a run over **zero captures** as success —
  it checked nothing and nothing said so;
- the replay-fidelity check printed **"0/0"**, which reads exactly like
  "checked and clean" when it means "there was nothing to check".

Every one of those is an absence of evidence wearing a verdict's clothes, and
each was written by someone who had just fixed the previous one.

Which of the two an absence maps to is a JUDGEMENT, and it has to be made
deliberately rather than by default:

- absence that is ITSELF the defect → **fail**. A gate running with no entry in
  the acceptance roster means somebody flipped a flag without recording what
  proved it safe.
- absence that is nobody's fault → **warn, and say what is missing**. No
  comparable requests, no outcome records yet, no captures on this machine.

What is never allowed is silence, or a number shaped like a pass. If a run
proves nothing, the output says it proves nothing.

Mechanised on the dotfiles side: `bootstrap/doctor.py` enumerates its own
`*_verdict` functions by introspection and fails its self-check if any lacks a
test, so a new verdict cannot be added without its could-not-verify case being
exercised.

## The closing gate: four questions before any proxy work is done

MANDATE (operator, 2026-07-29). Every piece of work here — a fix, an
investigation, a probe, a doc — answers these four before it closes. Each
question has a same-day precedent where skipping it cost real time; "no"
is an acceptable answer, silence is not — and a "no" or "not yet" must
NAME the missing evidence or design element, which converts it into a
spec. An unnamed deferral is drift, and a deferral justified by a cited
rule that collapses under one question was a rationalization, not a
reason (same day: a trend alarm was declined citing red-before-build,
which synthetic bites already satisfied; naming the real concern —
false-fires on deliberate changes — produced the design that dissolved
it, acknowledge-by-commit, within the hour).

1. **Can this be mechanized?** Interpretation stays human; everything
   around it is machinery — the check, the annotation, the alarm, the
   EVIDENCE DELIVERY. The tell remains the throwaway probe: row 4's verdict
   came from a 30-line matcher that became `anchorDelta` the same day, and
   the byte-extraction friction that stalled the row for a day became the
   far-from-anchor excerpt pass. If the answer is "it needs judgment", ask
   again about the part BELOW the judgment: delivering the inputs to the
   judgment is always mechanizable.
2. **Is the evidence harvestable?** Captures rotate on a quadratic clock;
   a finding that rests on volatile bytes is a finding with an expiry date.
   If the claim would be unverifiable after rotation, snapshot what proves
   it — sanitized, via the harvest path — before closing (precedent: the
   growth-step spec exists because a baseline step's explaining diff dies
   with the capture).
3. **Does the census need a new class or annotation?** A class you named
   by hand while investigating is a classification the census should emit
   — otherwise the next instance gets re-derived instead of recognized
   (precedent: `anchorDelta`, occurrence ordinals, the tools-delta kinds
   all started as hand-derivations). A NAMED deferral can still answer
   the wrong question here: whether the class deserves an ALARM is
   question 4's concern — question 3 asks only whether a classification
   now exists by hand, and a probe that assigns kinds or counts to
   traffic answers it YES by existing. The one valid deferral argues the
   derivation is genuinely one-off. (Observed: the resume-boundary
   classifier was parked with an alarm-shaped basis minutes after its
   probe had hand-classified every capture; one operator question undid
   the parking.)
4. **Did the instruments ride along?** A mitigation change without its
   replay/gate change ships blind: the gate replays the SERVING config, so
   an instrument that lags the extension verifies a pipeline nobody runs
   (precedent: the day every gate run exercised defaults while production
   ran eleven gates). New state, new record fields, new gates — each lands
   with its replay handling, its ledger declaration, and its three-answer
   doctor verdict in the same change.

### Cadence: the gate guards the flow, the sweep re-checks the stock

The closing gate runs at work-time, per change. A dispatched stock-sweep
(read-only, the four questions over the WHOLE system) is for after building
bursts — the 2026-07-29 sweep found twelve gaps because twelve pieces of
machinery had just landed, and its top finding was live within the hour.
Not a standing schedule: standing machinery must be maintained forever, and
a sweep of an unchanged system yields nothing. Retirement signal, borrowed
from skill-craft's consolidation rule: two consecutive sweeps returning
only minor findings — then the ritual stops until the next burst.

## Adding a check

Two rules, both learned the expensive way:

1. **It must go RED on the real defect before it counts.** Not "would have
   caught it" — demonstrated. Two checks built this way did not work, and only
   the bite test revealed it: a canonical-size drift signal flagged nothing on
   the bug it was designed for, because a split adds one entry AND one message
   so the counts stay equal while the ORDER diverges.
2. **Automate the mechanism, not the symptom you remember.** That drift check
   was built from a remembered number ("canon 92, live 84") that came from a
   *different* bug, already fixed. Re-derive which change produced an
   observation before building on it.

   **A bite's expected value comes from the invariant's DEFINITION, never
   from the implementation or the reasoning that produced it** — an
   expectation with the same parentage as the code pins the bug it should
   catch. Write the definitional comment first; the assertion follows from
   it. (Observed: the succession bite's first draft asserted a
   one-shot-sidecar handback as a correct succession — same mental model
   as the code's missing first-appearance condition; writing the
   definition sentence is what contradicted the assertion, and the
   phantom-minting bug fell out of the correction.)

3. **The corpus is blind along its own curation axis.** `harvest.mjs` selects
   pairs by *structural novelty* and sanitises them, so the committed fixtures
   are small by construction — and therefore a fixture corpus curated for
   structure can never contain a scale-shaped input. Both gate defects found
   on 2026-07-28 lived exactly there: a `RangeError` on a 955 MB capture, and
   a 3.2 GB retention peak. `npm test` could not have caught either, and no
   amount of care would have changed that. Generalise it before assuming this
   is about file size: **whatever property a corpus is curated for, every
   other property is where it is blind.**

   That is what `tools/gate-live.mjs` is for — it runs the real gate over the
   live captures (daily, via `cache-fix-gate.timer`), because they are the
   only production-shaped input that exists. `doctor` reads its verdict from
   `~/.claude/cache-fix-gate-status.json`. Run it by hand after any change
   that touches how the tools READ or RETAIN a capture; the fixtures will not
   tell you.

Every new gate gets a mutation test in `test/replay-gate-selfcheck.test.mjs`.
A gate that is confidently wrong is worse than no gate: it converts
"unverified" into "verified" and nobody notices.

Corollary: **a check that fires on a non-defect is also broken.** `gate 1` in
`output-guard.test.mjs` asserted a hardcoded corpus count and therefore
validated nothing from the moment a 9th corpus was added; the safety gate
counted `deferred-tool-rewrite`'s own declared `tool_addition` announcement as
243 corruptions. Both trained their reader to ignore a red suite.

## Identity is where the bugs live

Four keying collisions surfaced in one day, all the same shape:

| where | key that was too cheap |
|---|---|
| `deferred-tool-rewrite` | bare session-id — main thread and sidecars shared one tools baseline |
| `insertion-normalization` | (session-id, system-prompt) — every subagent shares one agent prompt |
| the replay gate | adjacency instead of conversation |
| `cache-sim` | a truncated 200-char prefix of `msgs[0]` |

**An identity computed more cheaply than the thing it identifies will collide,
and the collision presents as churn rather than as a bug.** Hash the whole
thing. `proxy/extensions/message-hash.mjs` is the shared primitive.

## Volatile content vs. real change

CC injects session-scoped content into structures that are otherwise stable,
and does so inconsistently:

- `<system-reminder>` hook blocks inside user messages (absorbed by
  `insertion-normalization`'s volatile-block pinning)
- the per-session console URL inside the **Bash tool's description**
  (absorbed by `toolFingerprint`'s volatile stripping)

Both are decoration, not contract. The rule when adding another: exclude it
from IDENTITY and forward the FIRST-SEEN bytes, keep the pattern narrow, and
make sure a genuine change still resets. Never serve a stale schema or a stale
message.

## Corpus hygiene

Captures grow **quadratically** (each request re-sends the whole history —
one session reached 555 MB) and the retention cap deletes oldest-first. So the
window between "capture written" and "capture deleted" is the deadline for
harvesting. `cache-fix-harvest.timer` runs twice daily for that reason;
`tools/harvest.mjs` is also safe to run by hand at any time — it is idempotent
via per-capture watermarks.

Harvested fixtures are sanitized (text replaced by deterministic hash tokens,
structure preserved exactly) and therefore committable. Ledgers are
per-machine (`LEDGER-<host>.json`); novelty is judged against every sibling
ledger, so N machines share one deduplicated corpus with no coordination.

The gate reads captures **line by line**, so pointing it at a live
multi-hundred-megabyte capture is the intended use, not an abuse. It slurped
them until 2026-07-28, when a 955 MB capture produced `RangeError: Invalid
string length` — the gate was unrunnable on the largest corpus while staying
green on every small one. Run it on the live capture, not only on fixtures:
that is what surfaced this.

## Compaction is a new conversation, not a drop

Settled 2026-07-28 by replaying a capture containing a real compaction
(session `58c979ce`), keys computed with the shipped
`resolveInsertionSessionKey`:

    n=778  1548 msgs   conversation 0dc13516c44f88c7
    n=780  1548 msgs   conversation 0dc13516c44f88c7   <- summarization call
    n=786     4 msgs   conversation 554180f85a9a1528   <- continuation
    n=787     6 msgs   conversation 554180f85a9a1528

Same session-id, same system-prompt sub-key, **different conversation
sub-key**: conversation identity is derived from the history itself, and
compaction replaces `messages[0]` with the summary. So to every stateful
extension the continuation is a NEW conversation — fresh canonical, no reset.

That is correct, and there is nothing to mitigate. The prefix changed at
index 0, so no cached bytes survive by construction; a compaction bust is
honest. All four gates stayed at 0 across the boundary.

Two readings this makes easy to get wrong:

- `insertion-normalization`'s `dropped-majority` branch is **not** the
  compaction path and will never see one — it serves in-conversation
  shrinkage, where `messages[0]` survives. An earlier version of this file
  called that branch an untested gap awaiting a compaction in the corpus; the
  corpus now has one and it does not go there.
- `--census` cannot classify a compaction as `drop-only`, because the pair
  straddles two conversation groups and is never compared. Absence of
  `drop-only` after a compaction is the expected reading, not a miss.

Both were predicted the other way before the capture was replayed. The
prediction cost nothing because it was checked; stating it as a result would
have put two wrong facts in this file.
