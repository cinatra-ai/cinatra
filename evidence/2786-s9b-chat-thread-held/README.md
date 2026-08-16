# chat-hitl S9b — the §V recommendation hold, decided inside the conversation

Captured 2026-08-16 on the DEVELOPMENT RUNTIME, against this branch, on the real
application. These four cells REPLACE the earlier round's captures.

## Correction to the previous round, stated first

The earlier round photographed the §V card on the run page and bridged the
conversation with a sentence. That was wrong, and the reason is not that the
capture was driven badly.

**The slice set as filed contradicted itself.** This slice's acceptance demanded
the card in the conversation while the epic's host-ownership table assigned the
§V `chat_thread` mount to a later slice. The branch followed the table: it built
the hold, left the card on the run surface, and pointed at it in prose. The owner
has since ruled the chat mount into THIS slice, and this round implements it.

Two earlier claims are withdrawn:

- **"The recommendation card has no chat_thread mount in this build"** — withdrawn.
  There was no mount because none had been ruled or built. There is one now, and
  it is in this branch.
- **The diagnosis-round conclusion that the held state should be "the inline run
  card carrying the §V card"** — withdrawn. The ruled shape is the opposite: the
  §V card is its OWN mount in the assistant dispatch turn, under the
  `chat_thread` provider, OUTSIDE the inline run panel's subtree. The panel stays
  the separate `run_card` host. One §V component, two authorized mounts.

The Slack-layout finding from that round still stands as a fact about the
transcript: Slack layout suppresses `parts`, and `parts` is the only mount point
at a tool-call position. It is why this round asserts the layout BEFORE
photographing anything. It was never the fix; the fix was to build the mount.

## The runtime and the stack

DEV RUNTIME, labelled on every cell, which is the standing rule for a
dispatch-dependent capture: `pnpm dev`, `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`. Neither
production fence (`assertScriptedProviderNotProduction`, `lifecycleSeedEnvVerdict`
FENCE 1a) was weakened; this branch does not touch them.

Throwaway Compose project `s9b2786cap` — own ports (Postgres 55432, Redis 56379),
own volumes, own network, dev server on 3100, own BullMQ queue name. The
operator's `cinatra_cinatra` project was never started, stopped, read or written.
The stack was destroyed after the capture.

## The driving message, and why it matters

> `run cinatra_blog-draft-writer-agent to draft a blog post about onboarding`

ZERO mention tokens. Two mentions flip the thread into Slack layout, which
suppresses `parts` and therefore suppresses every part-level mount. The
pre-router accepts this legacy `cinatra_<slug>` form, so the turn streams in the
default layout. Both facts are ASSERTED in the log before any screenshot.

## What is real, and the four fixtures

**Real:** the application, the chat surface, the pre-router, the `agent_run`
primitive, the hold, the park store, the §V card, its Confirm and Skip, the
canonical release, BullMQ and Postgres. The message was typed into the real
composer. The skill chip was ticked and the buttons pressed in the transcript.

**Fixtures**, none inside the decision under test: one `agent_assigned_skills`
row (the scorer only offers an agent's assigned set; a fresh instance has none);
the agent template's org anchor (boot registration leaves it NULL and the scope
guard correctly refuses); an OpenAI **presence placeholder** so a provider
adapter binds before the pre-router runs (the scripted provider serves
generation; no real key was read, used or stored); and a local MCP public URL
plus an unused WayFlow port so the preflight answers `PREFLIGHT_UNAVAILABLE` and
proceeds.

## The cells

| cell | runtime | what it shows |
|---|---|---|
| `S9b-1__chat_thread__recommendation-hold-held.png` | **development** | The held §V card in the conversation: heading, the skill chip, **Confirm** and **Skip** — with the thread and the composer in frame, ABOVE the inline run panel rather than inside it. The dispatch line reads `status: pending_input` and points nowhere. |
| `S9b-2__chat_thread__hold-wrapper-anchors.png` | **development** | The `data-chat-thread-recommendation-hold` wrapper itself, close up. |
| `S9b-2b__chat_thread__skill-selected-in-chat.png` | **development** | The skill ticked inside the conversation, before Confirm. |
| `S9b-3__chat_thread__confirmed-settled-in-place.png` | **development** | After Confirm IN CHAT: the same card settled in place to "Skills confirmed (1)", same position, same conversation, no navigation — and the run panel below has advanced to its actionable form. |
| `S9b-4__chat_thread__skipped-settled-in-place.png` | **development** | After Skip IN CHAT on a second run: the release and dispatch succeed. See the finding below on what the row settles into. |

`capture-log.txt` is the unedited machine output, including the DOM anchor
readouts and the queue probes.

## The structural anchors, read off the live DOM

HELD (`S9b-1` / `S9b-2`):

```
conversationList:                 true
wrapperInsideConversationList:    true
wrapperRunId:                     eebd31cb-0b9c-480b-8661-8de00bda97ec
chipRowInsideWrapper:             true
confirmAnchorInsideWrapper:       true
skipAnchorInsideWrapper:          true
outsideInlineRunCardSubtree:      true
composerVisible:                  true
```

CONFIRMED (`S9b-3`) — the same wrapper, settled:

```
wrapperInsideConversationList:    true
decisionSummary:                  "confirmed"
chipRowInsideWrapper:             false     (controls replaced, in place)
outsideInlineRunCardSubtree:      true
url unchanged (no navigation):    true
```

## The state proofs, by command

| moment | run row | park | queue |
|---|---|---|---|
| held | `pending_input` / `human_present=true` | `parked` | `jobs_ever_created=<unset>`, `job_keys=<none>`, `jobs_naming_this_run=0` |
| after Confirm in chat | advanced off `pending_input` | `released` | `jobs_ever_created=1`, exactly one job key, and it IS the run id |
| after Skip in chat (second run) | advanced off `pending_input` | `released` | `jobs_ever_created=2` (one per run), exactly one job naming the second run |

While held there is NO queue job at all. That is the assertion separating a real
hold from a card drawn over a run that was dispatched anyway.

## Note on the three §V root attributes

The card root carries `data-lifecycle-card="recommendation_hold"`,
`data-lifecycle-card-host` and `data-lifecycle-card-state`. They were ruled in
AFTER these screenshots were taken, so they are not visible in the pixels here;
they are DOM attributes and are pinned by test instead — the chat mount asserts
all three with `host="chat_thread"` and a state that moves with the decision, and
the card suite asserts the host label is correct on each authorized mount.

They live on the CARD's own root rather than on either mount's wrapper, so both
authorized mounts (this `chat_thread` mount and the run panel's `run_card`
mount) are labelled host-correct by construction, from the provider each mount
declared. The root is `display: contents`, so the identity costs no layout.

## FINDING — Skip releases and dispatches, but renders no settled summary here

Confirm settles exactly as ruled. **Skip does not, on this fixture, and the cause
is in the core action rather than in the mount.**

`skipRunRecommendationAction` writes its durable skip evidence only for
candidates the scorer marked `recommended`. This capture's single candidate is
offered but NOT recommended — the row shows `Skills (0/1)` and the chip carries
`data-forced="true"` — because the run's extracted `inputParams` are empty on a
scripted-provider stack, so the intent text the scorer matches against is `{}`.
With no recommended candidate, Skip writes no `run_rejected_recommendations` row;
`getRunRecommendationHoldStateAction` then finds neither selected revisions nor a
skip marker and answers `none`, so the card clears instead of settling into a
"skipped" summary.

Confirm is unaffected because it persists the SELECTED skill, recommended or
forced, which is why `S9b-3` settles.

This is recorded, not resolved. It is stated as a contradiction for the owner in
the PR: the ruling says a successful Skip settles the card into its skipped
summary, and the shipped action makes that outcome conditional on a recommended
candidate existing.
