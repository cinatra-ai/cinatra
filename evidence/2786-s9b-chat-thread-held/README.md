# chat-hitl S9b — the §V recommendation hold, decided inside the conversation

Head under proof: `feat/2786-s9b-chat-origin-holds`, at the head this round
pushed.

These FIVE cells are a complete RE-SHOOT on the MERGED §V redraw
(cinatra#2841), taken 2026-08-21 on a lane-private stack. They REPLACE every
earlier capture in this directory, and the driver that took them was rewritten
for the same reason.

Nothing here is a component harness. Every pixel is the shipped chat surface in
a running instance, and every decision was pressed on a CHIP'S OWN button inside
the conversation.

## Why the previous five cells were refused, stated first

Round 5 refused the set on one ground, and it is the reason this round exists:

> The redraw is merged and the code now draws the new face, but the five capture
> cells are byte-identical blobs to the pre-redraw review point […] all five show
> the deleted face: the "Confirm the skills for this run" heading plate, the
> "Skills (n/m)" disclosure, a slug chip, one row-level Confirm/Skip pair — no
> display-name chip, no per-chip Confirm/Adjust/Skip. Deviates, five of five. The
> committed driver still clicks the deleted controls, so it cannot reproduce this
> head.

Both halves are answered here: the driver was rewritten to operate the ratified
controls, and all five cells were re-shot through it. Every file in the list
below changed its bytes.

## The drawing these cells must show

design `specs/app-lifecycle-cards.html` §V, at the ratified redraw:

> the turn carries a chip-row: **one chip per skill**, each carrying its own
> Confirm, Adjust and Skip, so the reader shapes the run one skill at a time
> before it runs. **The row is the whole card.** There is no heading plate above
> it and no row-level submit beneath it.

Concretely, at the DOM: the card root is the chip row itself and carries
`data-lifecycle-card="recommendation_hold"`, `-host`, and `-state` of `held` or
`decided`; each chip is `[data-recommendation-chip]` printing the owning
extension's manifest `cinatra.displayName` with its id on `data-skill-id`; each
chip carries `[data-skill-action="confirm"|"adjust"|"skip"]`; Adjust opens that
skill's panel with `adjust-keep` / `adjust-drop`. The `display: contents` wrapper
that used to carry the identity is gone, and so is every card-level control.

## What the driver had to change

`drivers/02-capture-chat-thread.mjs`, rewritten:

| Pre-redraw driver | This driver |
|---|---|
| Clicked `[data-action="confirm-run-recommendation"]` / `…skip…` | Presses `[data-skill-action="confirm"|"adjust"|"skip"][data-skill-id=…]` on ONE chip at a time, and `adjust-keep` in the panel that Adjust portals open |
| Ticked a `data-selected` pill to "select" a skill | There is no selection pill: a skill is shaped by pressing its own Adjust and choosing inside its panel |
| Waited for `state === "confirmed"` / `"skipped"` | Waits for `state === "decided"` plus `data-run-recommendation-decision`, read off the card ROOT (the redraw publishes it there) |
| Framed the chip row because the root had no box | Frames the ROOT itself — since the redraw the root has real geometry |
| Recorded no label claim | Records every chip's printed label beside its id AND beside the manifest declaration it must equal, so the display-name rule is a comparison and not an impression |
| Recorded no absence claim | Records the DELETED face per shot: heading plate, `Skills (n/m)` disclosure, row-level Confirm, row-level Skip — all must read `false` |
| Wrote a prose log and no records, so every cell stayed unindexed | Counts the capture contract's own selectors on the screen it photographs, writes a record per cell into `capture-records.json`, and those records are registered in `scripts/ci/chat-hitl-capture-index.json` |

The fixture changed with it: the agent is assigned THREE skills rather than one,
because the redraw made the decision per chip and the row does not release until
every chip is decided. A one-candidate row can never photograph one skill shaped
while its neighbours stay live, and three lets ONE settled row carry all three of
§V's marks.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`node scripts/dev-server.mjs`), the standing rule for a dispatch-dependent capture |
| App | worktree dev server on port **3794**, queue `cinatra-x2794cap-jobs` |
| Stack | throwaway Compose project `x2794cap`: own Postgres (`127.0.0.1:55794`), own Redis (`127.0.0.1:56794`), own volumes, own network |
| Database | the lane's own database, at `core__0094_run-recommendation-skip-record`; the boot precondition check reports the core schema current for this head |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` — the wizard only |
| LLM | none. `CINATRA_TEST_LLM_PROVIDER=scripted`, so the turn takes the real hard pre-router with no model call. |
| Viewport | 1440 × 1200 at `deviceScaleFactor: 2`; full-page cells uncropped |
| Operator's stack | not read and not written. Its ports were briefly bound and released before the capture, disclosed below. |

Neither production fence (`assertScriptedProviderNotProduction`,
`lifecycleSeedEnvVerdict` FENCE 1a) was weakened; this branch does not touch them.

**A port trap, disclosed rather than smoothed over.** The registration round ran
on a machine that had just rebooted, so the operator's own containers were down
and its ports were free. Twice the repo's tooling took them. `docker compose -f
docker-compose.yml -f docker-compose.dev.yml` publishes the OPERATOR's 5434 and
6379, because that override hardcodes them; and `scripts/dev-server.mjs`, finding
the connector service down, ran its own `docker compose up -d nango-server`,
which brought up a lane `nango-db` on the operator's 5435 and re-created the lane
Redis back onto 6379. Both were caught within seconds and released, and nothing
of the operator's was read, written or deleted. The fix is the two the prior
round already knew: publish through a lane-private override (the file this lane
used is the same one recorded in `x2794cap-artifacts/lane-compose.yml`) and run
the dev server with `CINATRA_SKIP_DEV_PREFLIGHT=1`, which turns off both the
DB-port preflight and the nango auto-start. The capture itself ran with the lane
on 55794 / 56794 only.

## The driving message

> `run cinatra_blog-draft-writer-agent to draft a blog post about onboarding`

ZERO mention tokens, asserted in the log before every turn. Two mentions flip the
thread into Slack layout, which suppresses `parts` and therefore suppresses every
part-level mount. The pre-router accepts this legacy `cinatra_<slug>` form
(`EXPLICIT_DISPATCH_VERB_RE` + `LEGACY_CINATRA_SLUG_RE`), so the turn streams in
the default layout and the card mounts at its part position.

**One turn per conversation.** The acceptance criterion is stated per TURN, so
each decision got its own fresh thread and the counts in the log are that turn's
counts, with nothing from an earlier turn in the same transcript. Both threads
are recorded entering at `recommendation_hold roots on entry = 0`.

## What is real, and what is fixture

**REAL, and all of it is on the path under proof:** the application, the chat
surface, the hard pre-router, the `agent_run` primitive,
`maybeHoldRunForRecommendation`, the park store, the redrawn §V card, its
per-chip Confirm / Adjust / Skip, the canonical release, the skip persistence,
BullMQ and Postgres. The identity is a Better Auth sign-up through the running
app's own first-owner surface. The message was typed into the real composer and
every button was pressed in the transcript.

**FIXTURES, none of them inside the decision under test:**

- three `agent_assigned_skills` rows on `@cinatra-ai/blog-draft-writer-agent`
  (`@cinatra-ai/chat:blog-content`, `@cinatra-ai/chat:company-research`,
  `@cinatra-ai/chat:chat-automation-authoring`), written by the SHIPPED writer
  `insertAssignedSkill`. The scorer only offers an agent's assigned set, and a
  fresh instance has none. All three declare a manifest `cinatra.displayName`,
  which is what makes the display-name claim checkable;
- an OpenAI **presence placeholder**, written through the shipped
  `writeOpenAIConnection`. Without a bound provider adapter the runtime falls
  into `conversationOnly` and nulls the dispatch package, so the pre-router never
  fires. Generation is served by the scripted provider; no real key was read or
  used;
- the MCP public base URL, set through the shipped `setMcpPublicBaseUrl`;
- `WAYFLOW_BASE_URL` pointed at an UNUSED lane port, so the preflight answers
  `PREFLIGHT_UNAVAILABLE` and the dispatch handler proceeds. Never the operator's
  WayFlow.

**An assignment must be INSTALLED, not merely catalogued.**
`resolveAssignedSkillTier` revalidates every assignment against the installed
extension set and withholds an id whose owning extension is absent. Measured on
this stack: two matcher skills present in `cinatra.skills` were withheld
`:not-installed`, and the row drew ONE chip. The three above are in the
instance's bundled extension set.

## The five cells, graded

| cell | what §V requires | what the picture shows | verdict |
|---|---|---|---|
| `S9b-1__recommendation-hold__chat_thread__held.png` | The held card in the transcript: a chip per skill, display-name labels, per-chip Confirm/Adjust/Skip, no heading plate, no disclosure, no row-level pair | Three chips — **Blog Content Skill**, **Automation Authoring Skill**, **Company Research Skill** — each with its own Confirm, Adjust and Skip. No heading, no subtitle, no disclosure, no row-level control. Thread and composer in frame; the card sits ABOVE the inline run panel, which reads `pending input` / "No messages yet." and carries no copy of it | **Conforms** |
| `S9b-2__recommendation-hold__chat_thread__held__root.png` | The card root, close up | The ROOT ITSELF, framed on `[data-lifecycle-card="recommendation_hold"]` — which the redraw made photographable. Three display-name chips, nine per-chip buttons, nothing above and nothing below | **Conforms** |
| `S9b-2b__recommendation-hold__chat_thread__held__shaped.png` | One skill shaped in place, the row still live | **Blog Content Skill** carries the adjusted tint after its own Adjust → *Keep it in this run*; the other two stay undecided; the card root still reads `state=held` and the panel still reads `pending input`. Nothing released, and no row-level control was pressed — there is none | **Conforms**, with one honest reading below |
| `S9b-3__recommendation-hold__chat_thread__decided__confirmed.png` | The settled row: each chip states its own outcome, nothing summarised above it, nothing left to press | **Blog Content Skill ⇄ ADJUSTED** and **Automation Authoring Skill ✓ CONFIRMED**, in the same transcript position, no navigation and no reload; the panel below has advanced to its actionable input step | **Conforms for the kept set; deviates on the skipped chip** — see the residual below |
| `S9b-4__recommendation-hold__chat_thread__decided__skipped.png` | The settled row after a whole-row skip | All three chips present, each **× SKIPPED** on §V's dashed treatment, display names intact, controls gone, still inside the conversation list; the panel below carries NO second copy | **Conforms** |

`capture-log.txt` is the unedited machine output: the anchors, the label
comparison, the run/park reads, the queue probes and the decision-evidence reads.

## The capture index — every cell named by its RECORDED ANCHORS

A file name claims nothing. Before each shot the driver reads the card's own
attributes off the live DOM and writes them into `capture-log.txt` beside the
picture. Read the log, not the file name; where the two ever disagree, the log is
the record and the file name is the error.

| File | Recorded kind | Recorded host | Recorded state | Recorded decision | Where the record is |
|---|---|---|---|---|---|
| `S9b-1__recommendation-hold__chat_thread__held.png` | `recommendation_hold` | `chat_thread` | `held` | — | `HELD anchors` |
| `S9b-2__recommendation-hold__chat_thread__held__root.png` | `recommendation_hold` | `chat_thread` | `held` | — | `HELD anchors` |
| `S9b-2b__recommendation-hold__chat_thread__held__shaped.png` | `recommendation_hold` | `chat_thread` | `held` | — | `SHAPED-IN-CHAT anchors` |
| `S9b-3__recommendation-hold__chat_thread__decided__confirmed.png` | `recommendation_hold` | `chat_thread` | `decided` | `confirmed` | `CONFIRMED anchors` |
| `S9b-4__recommendation-hold__chat_thread__decided__skipped.png` | `recommendation_hold` | `chat_thread` | `decided` | `skipped` | `SKIPPED anchors` |

Every row additionally records `chatThreadMarker: true` (the
`data-chat-thread-recommendation-hold` marker rides the card's own root) and
`insideConversationList: true`.

### These five cells are REGISTERED, and that is new in this round

A prose log is not an index. Until this round no record in
`scripts/ci/chat-hitl-capture-index.json` answered any of these five cells, and
`scripts/ci/lib/capture-record-contract.mjs` is explicit about what that means:
an unindexed screenshot counts as zero, however honest the picture is. The log
also could not be turned into records after the fact, because it never looked
for the anchors the contract requires. It read
`data-chat-thread-recommendation-hold`, which is a different attribute from
`[data-lifecycle-card-host="chat_thread"]`, and it wrote booleans where the
contract wants counts.

So the driver now OBSERVES the contract's selectors on each screen and
photographs it in the same breath, and it writes a record per cell into
`capture-records.json` beside the pictures. The same five records are registered
in the canonical index. Each carries the cell, the declared host, kind and
state, the final URL, the screenshot with its SHA-256, and the counts observed:

| Cell | Declared state | `[data-conversation-list]` | `[data-lifecycle-card-host="chat_thread"]` | card root | per-chip Confirm / Adjust / Skip, inside the root |
|---|---|---|---|---|---|
| `S9b-1…held` | `pending` | 1 | 1 | 1 | 3 / 3 / 3 |
| `S9b-2…held__root` | `pending` | 1 | 1 | 1 | 3 / 3 / 3 |
| `S9b-2b…held__shaped` | `pending` | 1 | 1 | 1 | 3 / 3 / 3 |
| `S9b-3…decided__confirmed` | `decided` | 1 | 1 | 1 | 0 / 0 / 0 |
| `S9b-4…decided__skipped` | `decided` | 1 | 1 | 1 | 0 / 0 / 0 |

The two decided cells owe the ABSENCE of the decision controls, and the record
states that zero as an observation rather than the README stating it as a
sentence. Both also record `[data-lifecycle-card-state]` inside the root, which
is the marker a settled capture owes.

**The cells were RENAMED for the same reason.** The old names put the descriptor
after the host (`S9b-1__chat_thread__recommendation-hold-held`), and
`parseCellName` reads the kind from the token BEFORE the host and the state from
the tokens after it. Under the old names every record would have parsed as kind
`null` and state `null`, so the contract would have asked for nothing and the
registration would have proved nothing. The names now carry the contract's own
vocabulary, which is what makes the held cells owe their controls and the
decided cells owe the absence of them.

**The pictures were re-shot, and nothing about the drawing moved.** A record
binds to one image by digest, so records for the earlier files could not be
written without re-taking them. The re-shoot reproduced the previous round's
readings exactly: three chips, per-chip Confirm/Adjust/Skip while held, no chip
printing its raw id, no heading plate, no disclosure, no row-level pair, and the
same four acceptance lines. The five earlier files are deleted; nothing in the
tree cites them.

## The ratified face, measured per shot

The driver's own conformance block, unedited from `capture-log.txt`:

```
held:      chips=3 perChipConfirmAdjustSkip=true chipsPrintingTheRawId=0
           headingPlate=false skillsDisclosure=false rowLevelConfirm=false rowLevelSkip=false
shaped:    chips=3 perChipConfirmAdjustSkip=true chipsPrintingTheRawId=0
           headingPlate=false skillsDisclosure=false rowLevelConfirm=false rowLevelSkip=false
confirmed: chips=2 chipsPrintingTheRawId=0
           headingPlate=false skillsDisclosure=false rowLevelConfirm=false rowLevelSkip=false
skipped:   chips=3 chipsPrintingTheRawId=0
           headingPlate=false skillsDisclosure=false rowLevelConfirm=false rowLevelSkip=false
```

`perChipConfirmAdjustSkip` is `false` on the two settled rows because a settled
chip has nothing left to press, which is what §V draws.

And the label claim, stated as a comparison rather than an impression:

```
id=@cinatra-ai/chat:blog-content              printed="Blog Content Skill"        manifest="Blog Content Skill"        matches=true
id=@cinatra-ai/chat:chat-automation-authoring printed="Automation Authoring Skill" manifest="Automation Authoring Skill" matches=true
id=@cinatra-ai/chat:company-research          printed="Company Research Skill"     manifest="Company Research Skill"     matches=true
```

The third is the sharpest: its slug is `chat-automation-authoring` and it prints
"Automation Authoring Skill", so a card printing the slug and a card printing the
name cannot be confused.

## The one-card acceptance criteria, unchanged

> *held, confirmed and skipped turns each contain exactly one `recommendation_hold`
> root on `chat_thread` outside the inline panel; no second summary under
> "Agentic Run Progress"; Confirm/Skip settle without navigation or reload;
> queue proof 0 → 1.*

Measured, from `capture-log.txt`:

```
held:      roots=1 host=chat_thread state=held                     outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
shaped:    roots=1 host=chat_thread state=held                     outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
confirmed: roots=1 host=chat_thread state=decided decision=confirmed outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
skipped:   roots=1 host=chat_thread state=decided decision=skipped   outsideInlinePanel=1 insideInlinePanel=0 summariesUnderAgenticRunProgress=0
```

```
CONFIRMED settled without navigation: true      SKIPPED settled without navigation: true
CONFIRMED settled without reload:     true      SKIPPED settled without reload:     true
```

The URL is read IMMEDIATELY BEFORE the press that releases the row and compared
with the URL after the card settles, so the comparison brackets the release
itself and nothing earlier in the session. The driver issues no reload at any
point.

## The state proofs, by command

| moment | run row | park | jobs naming THIS run |
|---|---|---|---|
| held (run `b2a5bd99`) | `pending_input` / `human_present=true` | `parked` | `0` (`job_keys=<none>`) |
| after the row released as CONFIRMED | `pending_approval` | `released` | `1`, and that job key IS the run id |
| held before Skip (run `fce41a7d`) | `pending_input` / `human_present=true` | `parked` | `0` (`job_keys=<none>`) |
| after the row released as SKIPPED | `pending_approval` | `released` | `1`, and that job key IS the run id |

**Read `jobs_naming_this_run`, not a queue total.** The load-bearing quantity is
how many jobs name the run under test: `0` while that run is held, exactly `1`
after the decision releases it. While held there is NO queue job naming the run
at all — that is the assertion separating a real hold from a card drawn over a
run that was dispatched anyway.

## The durable decision evidence, on the real store

Read back out of the database in the log, not asserted from the UI:

```
CONFIRMED durable selection rows: @cinatra-ai/chat:blog-content:user_adjusted
                                  @cinatra-ai/chat:chat-automation-authoring:recommended_confirmed
CONFIRMED durable rejection rows: <none>

SKIPPED durable selection rows:   <none>
SKIPPED per-skill evidence rows:  @cinatra-ai/chat:blog-content:user_skipped:NULL
                                  @cinatra-ai/chat:chat-automation-authoring:user_skipped:NULL
                                  @cinatra-ai/chat:company-research:user_skipped:NULL
SKIPPED run-level marker in run_recommendation_skips: 1 row(s); candidate_count=3
```

- the Adjust → *Keep it in this run* press is durably `user_adjusted`, which is
  why its settled chip reads **Adjusted** and not **Confirmed**;
- `run_recommendation_skips` holds ONE row keyed by `run_id` — the durable marker
  the settled card reads, verified before the park is released — and its
  `candidate_count` is `3`, matching the row that was actually offered;
- `run_rejected_recommendations` holds one row per offered candidate with a NULL
  rank, because none was scorer-ranked (see the residual below).

## Residuals, named rather than smoothed over

**The confirm row drops the chip the reader skipped.** `S9b-3` shows two chips,
not three: the Company Research chip was skipped by its own button, the row then
released on the CONFIRM path, and that path records only the kept set —
`durable rejection rows: <none>`. The settled row is derived from the run's
durable evidence, so a skill with no row has no chip. §V says each chip states
its own outcome, so this is a real deviation from the drawing, and it is a
STORE-shaped one: on the confirm path there is nowhere to record "the reader
skipped this one". Whole-row Skip is unaffected — `S9b-4` shows all three,
because that path writes a rejection row for every candidate.

**A live chip signals its mark by tint alone.** In `S9b-2b` the adjusted chip
carries §V's adjusted tint but no "ADJUSTED" wordmark; the wordmark exists only
on the settled row. The three affordances also stay on screen and re-pressable
until the row releases, which is the shipped model.

**Every chip is a force-add, and it is not a capture defect.** All three chips
carry `data-forced` and the tooltip "Not recommended — adding forces this skill".
The scorer's only input is the run's `inputParams`, and the CHAT pre-router
dispatches with `input_params = {}` — read back into the log at every moment. So
on a chat-origin run the scorer has no intent to score against, every candidate
lands at 0.00, none clears the `>= 0.30` threshold, and the row offers all of
them under §V's NAMED candidate-set deviation. Two prompts were tried, one
deliberately loaded with the skills' own vocabulary, with the same result,
because those words never reach the scorer. The RECOMMENDED reading of the same
row is proven on the run surface in `evidence/2841-v-redraw`.

**The panel's "Skills (3)" block is not the deleted disclosure.** On `S9b-4` the
inline run panel below the card shows `Skills (3)` over three slug chips. That is
the RUN PANEL's own assigned-skills readout, outside the card and outside this
PR's surface: it is not a `recommendation_hold` root, not a
`[data-run-recommendation-decision]` summary, and not the deleted `Skills (n/m)`
selector — which was a selection counter INSIDE the card and is absent from every
cell (`skillsDisclosure=false`, measured on the card's own text). That it prints
slugs rather than display names is a different surface's label, untouched here.

**The confirmed chip's source.** The kept, non-recommended
`chat-automation-authoring` was written `recommended_confirmed` rather than
`user_forced`. The chip reads **Confirmed**, which is what the reader pressed, so
the drawing is truthful; the source naming is a store detail for the owning
slice, not a presentation defect.

## The drivers

`drivers/` is the capture path itself, so this round is reproducible rather than
narrated. They are evidence tooling: nothing there ships, and nothing there
writes a lifecycle row by hand.

- `00-fixtures.mts` — the three skill assignments, the provider presence
  placeholder and the MCP public base URL, all through the SHIPPED writers.
  Needs `S9B_OWNER_USER_ID`.
- `01-signup.mjs` — the instance owner, through the real first-owner sign-up
  surface. Its own run log is not committed: the repo gitignores `*.log`, and
  `capture-log.txt` is the record this evidence rests on.
- `02-capture-chat-thread.mjs` — the five cells: one turn per fresh thread,
  anchors and label comparisons read off the card's own root before every shot,
  run/park/queue and decision-evidence probes at each moment.
- `03-diagnose-turn.mjs` — the read-only diagnostic that found the missing
  provider-adapter fixture by recording the wire and the rendered transcript.

Run them in that order against a booted lane stack:

```
S9B_OWNER_USER_ID=<owner> node --conditions=react-server --env-file=.env.local --import tsx \
  evidence/2786-s9b-chat-thread-held/drivers/00-fixtures.mts
node evidence/2786-s9b-chat-thread-held/drivers/01-signup.mjs http://localhost:3794 <sessionDir>
node evidence/2786-s9b-chat-thread-held/drivers/02-capture-chat-thread.mjs \
  http://localhost:3794 <sessionDir> <outDir>
```

Boot traps this directory has now paid for three times:

1. A fresh worktree needs the pinned extension closure staged
   (`scripts/ci/sync-dev-extensions.mjs --pinned`) BEFORE boot and then a SECOND
   `pnpm install`, because the staged connectors are workspace members whose own
   dependencies resolve only on that second pass. `pnpm-lock.yaml` is restored
   afterwards; an evidence round must not change it.
2. On a COLD dev route the first `POST /api/chat` compiles for minutes before the
   pre-router dispatches at all. The driver allows 900s for the first held card.
3. **`/api/mcp` must be warm before the first turn.** The assistant runtime
   probes the public MCP URL with a 2500ms budget and REFUSES the turn without
   Cinatra tools if it does not answer. A cold route blows that budget, the turn
   is refused, and NO row appears in `agent_runs` — measured here, once, with the
   refusal in the dev log and nothing else to show for fifteen minutes. Hit
   `/api/mcp` once (a 401 is a fine answer) before running the capture.
