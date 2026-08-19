# chat-hitl S9b — the §V recommendation hold, decided inside the conversation

Head under proof: `feat/2786-s9b-chat-origin-holds`.

These FIVE cells are a complete RE-SHOOT, taken 2026-08-19 on a lane-private
stack against the branch head that carries the run-level skip record and the
one-card mount rule. They REPLACE every earlier capture in this directory.

Nothing here is a component harness. Every pixel is the shipped chat surface in
a running instance, and every decision was pressed on the card's own controls
inside the conversation.

## Why the earlier captures were disqualified, stated first

The round-8 review refused the previous set on two grounds, and both are the
reason this round exists:

1. **They predated the DOM they claimed.** The card's three identity attributes
   (`data-lifecycle-card`, `data-lifecycle-card-host`, `data-lifecycle-card-state`)
   were ruled in AFTER those pictures were taken. The old README said so itself
   and fell back to "pinned by test instead". A picture that cannot show its own
   host claims nothing: the anchors are the record, and the old set had none.
2. **`S9b-4` was stale and showed the defect.** It was byte-identical to the
   previous head and still rendered the skipped summary TWICE in one turn — once
   as the `chat_thread` card and once as the inline run panel's `run_card` copy.
   That duplication is what the ambient-host suppression rule fixed; the picture
   predated the fix.

Two further contradictions in the old text are gone with it: the
`jobs_ever_created` table that disagreed with its own recapture log, and the
stale line claiming an empty candidate row still releases.

**Every cell below carries the anchors the review asked for, read off the card's
own root, in one session, on one head.**

## Every record carries the host it actually rendered

A file name claims nothing. Before each shot the driver reads the card's own
attributes off the live DOM and writes them into `capture-log.txt` beside the
picture: `data-lifecycle-card`, `data-lifecycle-card-host`,
`data-lifecycle-card-state`, whether the root sits inside `[data-conversation-list]`,
and how many `recommendation_hold` roots are inside versus outside the inline
run panel's subtree. Read the log, not the file name; where the two ever
disagree, the log is the record and the file name is the error.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`pnpm dev`), the standing rule for a dispatch-dependent capture |
| App | worktree dev server on port **3794**, queue `cinatra-x2794cap-jobs` |
| Stack | throwaway Compose project `x2794cap`: own Postgres (`127.0.0.1:55794`), own Redis (`127.0.0.1:56794`), own volumes, own network |
| Database | fresh: `scripts/apply-public-schema.mjs` + `pnpm auth:migrate`, then the app's own boot bootstrap built the `cinatra` schema and applied 80 core migrations through `core__0094_run-recommendation-skip-record` |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` — the wizard only |
| LLM | none. `CINATRA_TEST_LLM_PROVIDER=scripted`, so the turn takes the real hard pre-router with no model call. |
| Operator's stack | untouched. Its containers stayed up across the whole round and none was started, stopped, read or written. |

Neither production fence (`assertScriptedProviderNotProduction`,
`lifecycleSeedEnvVerdict` FENCE 1a) was weakened; this branch does not touch them.

## The driving message, and why it matters

> `run cinatra_blog-draft-writer-agent to draft a blog post about onboarding`

ZERO mention tokens, asserted in the log before every turn. Two mentions flip
the thread into Slack layout, which suppresses `parts` and therefore suppresses
every part-level mount. The pre-router accepts this legacy `cinatra_<slug>` form
(`EXPLICIT_DISPATCH_VERB_RE` + `LEGACY_CINATRA_SLUG_RE`), so the turn streams in
the default layout and the card mounts at its part position.

**One turn per conversation.** The acceptance criterion is stated per TURN, so
each decision got its own fresh thread and the counts in the log are that turn's
counts, with nothing from an earlier turn in the same transcript. Both threads
are recorded entering at `recommendation_hold roots on entry = 0`.

## What is real, and what is fixture

**REAL, and all of it is on the path under proof:** the application, the chat
surface, the hard pre-router, the `agent_run` primitive, `maybeHoldRunForRecommendation`,
the park store, the §V card, its Confirm and Skip, the canonical release, the
skip persistence, BullMQ and Postgres. The identity is a Better Auth sign-up
through the running app's own first-owner surface. The message was typed into
the real composer and the buttons were pressed in the transcript.

**FIXTURES, none of them inside the decision under test:**

- one `agent_assigned_skills` row (`@cinatra-ai/blog-draft-writer-agent` →
  `@cinatra-ai/chat:blog-content`). The scorer only offers an agent's assigned
  set, and a fresh instance has none, so without this row the candidate gate
  answers "no recommendation candidates" and the run dispatches unheld;
- an OpenAI **presence placeholder**, written through the shipped
  `writeOpenAIConnection`. Without a bound provider adapter the runtime falls
  into `conversationOnly` and nulls the dispatch package, so the pre-router never
  fires — measured on this stack: two capture attempts, zero rows in `agent_runs`.
  Generation is served by the scripted provider; no real key was read or used;
- the MCP public base URL, set through the shipped `setMcpPublicBaseUrl`;
- `WAYFLOW_BASE_URL` pointed at an UNUSED lane port, so the preflight answers
  `PREFLIGHT_UNAVAILABLE` and the dispatch handler proceeds. Never the
  operator's WayFlow.

## The five cells

| cell | what it shows |
|---|---|
| `S9b-1__chat_thread__recommendation-hold-held.png` | The held §V card in the conversation: heading, the `blog-content` chip, **Confirm** and **Skip** — thread and composer in frame, ABOVE the inline run panel rather than inside it. The panel below reads `pending input` / "No messages yet." and carries no copy of the card. |
| `S9b-2__chat_thread__hold-wrapper-anchors.png` | The hold's own chip row, close up. |
| `S9b-2b__chat_thread__skill-selected-in-chat.png` | The skill ticked inside the conversation, before Confirm (`data-selected` false → true on the forced candidate). |
| `S9b-3__chat_thread__confirmed-settled-in-place.png` | After Confirm IN CHAT: the same card settled in place to "Skills confirmed (1) @cinatra-ai/chat:blog-content", same position, same conversation, no navigation and no reload — and the run panel below has advanced to its actionable input step. |
| `S9b-4__chat_thread__skipped-settled-in-place.png` | After Skip IN CHAT: the same card settled to "Skill recommendation skipped — running with the default set.", controls gone, still inside the conversation list — and the panel below carries NO second copy of that summary. |

`capture-log.txt` is the unedited machine output: the anchors, the run and park
reads, the queue probes and the skip-evidence reads.

## The capture index — every cell named by its RECORDED ANCHORS

| File | Recorded kind | Recorded host | Recorded state | Where the record is |
|---|---|---|---|---|
| `S9b-1__chat_thread__recommendation-hold-held.png` | `recommendation_hold` | `chat_thread` | `held` | `capture-log.txt` → `HELD anchors` |
| `S9b-2__chat_thread__hold-wrapper-anchors.png` | `recommendation_hold` | `chat_thread` | `held` | `capture-log.txt` → `HELD anchors` |
| `S9b-2b__chat_thread__skill-selected-in-chat.png` | `recommendation_hold` | `chat_thread` | `held` | `capture-log.txt` → `SELECTED anchors` |
| `S9b-3__chat_thread__confirmed-settled-in-place.png` | `recommendation_hold` | `chat_thread` | `confirmed` | `capture-log.txt` → `CONFIRMED anchors` |
| `S9b-4__chat_thread__skipped-settled-in-place.png` | `recommendation_hold` | `chat_thread` | `skipped` | `capture-log.txt` → `SKIPPED anchors` |

Every row additionally records `chatThreadMarker: true` (the
`data-chat-thread-recommendation-hold` marker rides the card's own root) and
`insideConversationList: true`.

## The acceptance criteria, as the round-8 review set them

> *held, confirmed and skipped turns each contain exactly one `recommendation_hold`
> root on `chat_thread` outside the inline panel; no second summary under
> "Agentic Run Progress"; Confirm/Skip settle without navigation or reload;
> queue proof 0 → 1.*

Measured, from `capture-log.txt`:

```
held:      recommendation_hold roots=1 host=chat_thread state=held
           outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
confirmed: recommendation_hold roots=1 host=chat_thread state=confirmed
           outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
skipped:   recommendation_hold roots=1 host=chat_thread state=skipped
           outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
```

```
CONFIRMED settled without navigation: true      SKIPPED settled without navigation: true
CONFIRMED settled without reload:     true      SKIPPED settled without reload:     true
```

The URL is read IMMEDIATELY BEFORE each press and compared with the URL after
the card settles, so the comparison brackets the decision itself and nothing
earlier in the session. The driver issues no reload at any point: unlike the
previous round's Skip cell, this one settles in place and is photographed as it
stands.

## The state proofs, by command

| moment | run row | park | jobs naming THIS run |
|---|---|---|---|
| held (run `569480d9`) | `pending_input` / `human_present=true` | `parked` | `0` (`job_keys=<none>`) |
| after Confirm in chat | `pending_approval` | `released` | `1`, and that job key IS the run id |
| held before Skip (run `48b11720`) | `pending_input` / `human_present=true` | `parked` | `0` (`job_keys=<none>`) |
| after Skip in chat | `pending_approval` | `released` | `1`, and that job key IS the run id |

**Read `jobs_naming_this_run`, not a queue total.** The load-bearing quantity is
how many jobs name the run under test: `0` while that run is held, exactly `1`
after the decision releases it. While held there is NO queue job naming the run
at all — that is the assertion separating a real hold from a card drawn over a
run that was dispatched anyway.

## The skip persistence, on the real store

The Skip cell was taken against the run-level skip record, and the rows are read
back out of the database in the log:

```
SKIPPED per-skill evidence rows: @cinatra-ai/chat:blog-content:user_skipped:NULL
SKIPPED run-level marker in run_recommendation_skips: 1 row(s); candidate_count=1
```

- `run_recommendation_skips` holds ONE row keyed by `run_id` — the durable
  marker the settled card reads, verified before the park is released;
- `run_rejected_recommendations` holds one row for the candidate the row
  actually offered, with a NULL rank because that candidate was forced rather
  than scorer-ranked;
- the Confirm run wrote no skip rows at all, and one
  `run_selected_skill_revisions` row with `selection_source = recommended_confirmed`.

## Two things in the pixels worth naming

**The close-up is the chip row, not the card root.** The card's identity root is
`display: contents`, so it has no box and cannot be photographed as an element.
`S9b-2` therefore targets the chip row INSIDE that root, and the log says so on
the line beside it. The root's three attributes are recorded in the anchors,
which is where that cell's claim actually rests.

**The panel's "Skills (1) blog-content" chip is not a second summary.** It is the
run's own skill display, and it appears on both settled cells. On the confirmed
run it reflects the one confirmed selection; on the SKIPPED run there is no
selection row at all, and the chip shows the agent's assigned default set —
which is precisely what "running with the default set" means. Neither is a
`recommendation_hold` root and neither is a `[data-run-recommendation-decision]`
summary, which is why both counts read `0` inside the panel.

## The drivers

`drivers/` is the capture path itself, so this round is reproducible rather than
narrated. They are evidence tooling: nothing there ships, and nothing there
writes a lifecycle row by hand.

- `00-fixtures.mts` — the provider presence placeholder and the MCP public base
  URL, both through the SHIPPED writers.
- `01-signup.mjs` — the instance owner, through the real first-owner sign-up
  surface. Its own run log is not committed: the repo gitignores `*.log`, and
  `capture-log.txt` is the record this evidence rests on.
- `02-capture-chat-thread.mjs` — the five cells: one turn per fresh thread,
  anchors read off the card's own root before every shot, run/park/queue and
  skip-evidence probes at each moment.
- `03-diagnose-turn.mjs` — the read-only diagnostic that found the missing
  provider-adapter fixture by recording the wire and the rendered transcript.

Run them in that order against a booted lane stack:

```
node --conditions=react-server --env-file=.env.local --import tsx \
  evidence/2786-s9b-chat-thread-held/drivers/00-fixtures.mts
node evidence/2786-s9b-chat-thread-held/drivers/01-signup.mjs http://localhost:3794 <sessionDir>
node evidence/2786-s9b-chat-thread-held/drivers/02-capture-chat-thread.mjs \
  http://localhost:3794 <sessionDir> <outDir>
```

Two boot traps this round re-confirmed, both from the S9c round's drivers README:
a fresh worktree needs the pinned extension closure staged
(`scripts/ci/sync-dev-extensions.mjs --pinned`) BEFORE boot and then a SECOND
`pnpm install`, because the staged connectors are workspace members whose own
dependencies resolve only on that second pass. `pnpm-lock.yaml` is restored
afterwards; an evidence round must not change it.

A third, learned here: on a COLD dev route the first `POST /api/chat` compiles
for minutes before the pre-router dispatches at all. A 300s budget failed this
way twice, with zero rows in `agent_runs` to show for it. The driver now allows
900s for the first held card.
