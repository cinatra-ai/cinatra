# S9d rework — evidence (cinatra#2788, PR #2939)

## Round 8 (2026-08-26) — all seven cells re-shot after the settled row and the merge of main

> **Why the whole set was taken again.** Round 7's seven cells were shot before
> two changes this branch then took, and a picture taken before a change is the
> record of what came before it:
>
> 1. **The settled row on the setup rail** — a decided gate row now reads as the
>    ratified drawing's resolved-gate history row: the completed circle where the
>    numeral was, the title left unhighlighted. Round 7's C10c still showed
>    `2 Recommendation` on a run that had come back from its own Confirm.
> 2. **The merge of `main` 803fe94045fe (cinatra#3006)** — the schedule form now
>    stays in the rail's schedule step after Continue, armed; there is no Trigger
>    tab and no "Trigger configuration" card anywhere; the breadcrumb and the tab
>    say **Schedule**, never *Trigger*. Round 7's C9 was shot on a head where
>    arming a one-off took the page to a second screen.
>
> So **C7, C9, C10, C10b, C10c, C11 and C11b are all re-shot here, light and
> dark**, on this head, from real runs. **The set's other sixteen pictures are
> byte-identical** — to the file at the previous head AND, for the twelve the
> SHA-256 table below lists, to that table — and `page-controls.json`'s two **C8**
> records are byte-identical in the same place in the file. The canonical capture
> index is untouched.

### What the two changes look like in the pixels

| cell | round 7 | round 8 |
|---|---|---|
| **C10c** | the decided row still read `2 Recommendation` — the numeral where the drawing wants the completed circle | the row draws the **completed circle with the check glyph** in place of the numeral (`railStepIndicatorText` **""**, `railStepIndicatorHasCheckGlyph` **true**, `data-run-surface-rail-settled="true"`), and the detail column holds the settled chip `Blog Content Skill ✓ CONFIRMED` |
| **C9** | Continue on a one-off armed ahead handed the screen to a second drawing of the same facts | the SAME run page comes back with the **armed form still inside the schedule step** — *Schedule for later* selected, `27.08.2026, 09:30`, `Europe/Berlin`, the press now reading *Save changes* — the rail still beside it, and a **Schedule** tab added to the strip |

Both are measured as well as shown. Every record in `page-controls.json` now
carries two readings the round 7 sidecar had no field for, counted off the live
page by the same reader that measures every other anchor:

- **per rail row** — `railStepIndicatorText` and `railStepIndicatorHasCheckGlyph`,
  read at the row's own indicator (`[data-conformance-id="run-surface-rail-indicator"]`),
  so "the completed circle in place of the numeral" is a reading and not a claim;
- **per page** — `pageTabs`, `breadcrumbTrail`, `triggerWordOccurrences` and
  `triggerConfigurationCards`. On **all fourteen** cells the word *Trigger* occurs
  **0** times in what a person can read and there are **0** "Trigger
  configuration" cards; the breadcrumb ends in **Schedule** on every one.

One clause is worth stating exactly, because the picture alone could be
misread: on C10c the settled row is also the **selected** one — it had to be
pressed to open the settled chip — so its title carries the SELECTION's emphasis.
The settling itself adds none, which is the drawing's clause; the row's own
`before` reading in the same record (`selectedStep: "schedule"`) is the settled
row while it is not the open one.

### The cells, and what each one is

| cell | reading | run |
|---|---|---|
| **C7** | the first-time run page: two columns, the rail NAMING `1 Schedule` / `2 Recommendation` / `3 Review`, the unchanged scheduling form open in the right column, no run progress | a run that was never pressed |
| **C9** | the SAME run page after **Continue** with a one-off armed ahead — the armed form still in the schedule step | a second run, one press later |
| **C10** | the skills-recommendation row pressed on a run with a **LIVE hold** — the hold card, in the right column | a run held at its skills question |
| **C10b** | the same row on a run with **no park at all** — closed, muted, `aria-disabled="true"`, and a forced press changes nothing | the C7 run |
| **C10c** | the same row after the hold was **DECIDED** on the card — the settled chip, and the rail's resolved-gate history row | a second held run, after Confirm |
| **C11** | the review row pressed once a **gate is on file** — the review card in place | a completed run that produced a reviewable artifact |
| **C11b** | the review row pressed **while the run works** — the placeholder with the spinning icon | two runs caught inside the outbox→gate window |

### Six runs, and why one could not carry them all

Each reason is a property of the screen under proof, and **one of them changed
with cinatra#3006**:

1. **Arming a one-off no longer leaves the setup surface** — the form stays in the
   schedule step — but it does move the run out of the first-shown state C7 is
   drawn for. So C7 and C10b stand on one run that was never pressed, and C9 on a
   second that was.
2. **The hold only fires for an agent that HAS a candidate skill**, and a hold is
   either live or decided, never both. A skill was assigned through the app's own
   **Matches** tab (`drivers/2975-r7-assign-skill.mjs`; the row is in the readback
   as `@cinatra-ai/author-agent` ↔ `@cinatra-ai/chat:blog-content`, `source: manual`),
   and C10 and C10c stand on two runs of that agent.
3. **The review step needs a run that produced a reviewable artifact**, and its
   *working* reading lives only between the artifact's PENDING outbox row and the
   gate the sweeper opens from it. That window was **measured, not assumed**:
   `20:53:45.163 → 20:54:14.008` (**28.8 s**) on one run and
   `21:04:23.8 → 21:04:51.0` (**27.2 s**) on the other — long enough for one
   shutter, not two contexts — so C11b's two themes come from two runs, and C11 is
   shot on the first of them once its gate is on file.
   `drivers/2975-r8-drive-review-run.mjs` answers the run's approval steps and
   fires the capture inside the window; it re-presses after a cool-down rather
   than once and for all, which is what the round 7 catcher could not do.

### What this lane could NOT do, said plainly

- **The marketplace still could not install anything.** Its own screen says
  installing needs the package registry connected, and this lane holds no registry
  credential — even with the instance's own local registry up and its 112 bundled
  packages published to it. The agent under proof and its dependency were
  installed through the product's OTHER install path, the **Upload Extension**
  screen (`drivers/2975-r7-install-extension.mjs`), from a zip built out of this
  branch's own pinned extension source. Both rows are in the readback
  (`installedAgents`, `owner_level: organization`).
- **The first runs of this lane could not materialise an artifact** until the
  instance namespace was provisioned, which the app says itself: *"Instance
  namespace is not configured. Run /setup/name to provision a registry identity."*
  It was provisioned through that step, the app's own screen, with a neutral name.
- **Five turns were refused before the ingress was warmed.** The runtime HEADs the
  public MCP URL with a 2.5 s budget and refuses the turn outright if it does not
  answer; the route's first compile on this dev server exceeds that, and warmed it
  answers in about 0.3 s. All five refusals are quoted in the runtime evidence
  rather than trimmed out.
- **What the review card DRAWS INSIDE ITSELF is still a lane reading, not this
  issue's.** On these pixels the card's content rung says *"review target
  unavailable — slot 'detail', reason 'no-semantic-renderer'"* and falls back to
  the generic read-only view of the artifact. That is the artifact type's
  renderer, not the review step, and nothing here changes it.
- **"Estimated run duration — Unavailable."** is still on the scheduler step. The
  resolver sends no duration copy; recorded in this set since its round 2 and
  unchanged.

### The runtime

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify
Postgres and Redis, loopback-only, with the agent runtime and the instance's own
package registry brought up beside it. It is **not** a production-equivalent build
— every record is labelled `dev-runtime`. Cells are shot at `deviceScaleFactor: 2`,
uncropped, at the full 1440x900 window (2880x1800 device pixels).

The provider is REAL and was configured **through the app's own `/setup/model`
form**, so the app sealed the credential itself; it is in no file, no argument, no
log and no record here. `cinatra.usage_events` records what the instance actually
called: provider `openai`, models `gpt-5.5` (17 calls) and `gpt-5.5-2026-04-23`
(23 calls) — **40** calls, 514,819 input and 10,051 output tokens.
`CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts, and the server log
carries **zero** scripted-runtime lines. What this round can NOT say is stated
rather than implied: this host prints **no environment at all** for the listening
process, so the process-table read establishes nothing —
`serverEnvAvailable: false` in `readback/2975-r8-readback.json`, which is why the
positive evidence is the usage rows, the **62** `POST /api/mcp 200` callbacks from
the provider's own servers over the public ingress, the **3**
`[llm-bridge-run-select] served-by=run_token` lines the agent runtime produced, and
the absent scripted lines.

### The direct-SQL writes this lane made, disclosed

Two, both provisioning and neither a record: the lane account was given the
`admin` role in Better Auth's own table, and a membership row was written so the
account belongs to the organization the instance's boot import stamped every agent
template with (`evidence/2970-setup-rail/drivers/01-lane-setup.mjs`,
`02-join-template-org.mjs`, which carry the same disclosure). Everything else —
every run, trigger, park, outbox row, gate, install row and skill match — was
written by the app itself through its own screens.

### Where this round's own artefacts are

`2975-r8-walk.json` (the executable plan) ·
`drivers/2975-reshoot-page-controls.mjs` (the capture driver, extended this round
with the settled-indicator and page-wording readings above and nothing else) ·
`drivers/2975-r8-drive-review-run.mjs` and `drivers/2975-r8-press-approval.mjs`
(the review run's own drivers) · `readback/2975-r8-readback.json` (the rows and the
runtime screens) · `readback/2975-r8-runtime-evidence.txt` (the server's own lines,
with the grep that produced each block and the public origin, host address and
funnel name all redacted) · `readback/2975-r8-read-back.mjs` (the readback driver).
The chain drivers reused from the earlier rounds live in
`evidence/2970-setup-rail/drivers/` and beside this file.


## Round 7 (2026-08-26) — every cell of round 6 re-shot on the fixed head, and the three readings the fix defines

> **Why the whole round was re-shot.** Round 6's four cells were taken BEFORE the
> change this pull request's *"Acceptance item 3 — the recommendation and review
> rows open to the right"* section describes. Pictures taken before a fix are the
> record of the defect, not of the fix, so all four — **C7, C9, C10, C11** — are
> taken again here, and three readings the fix defines are ADDED: **C10b** (a run
> with no recommendation park — the row closed and muted), **C10c** (a run whose
> hold was decided — the settled row), and **C11b** (the review step while the run
> works — the placeholder with the spinning icon).
>
> **The other twelve pictures are byte-identical** to the SHA-256s round 5
> committed, and `page-controls.json`'s two **C8** records are byte-identical to
> round 5's, in the same place in the file. The canonical capture index is
> untouched.

### The two FAILs round 6 reported are gone, and the pixels say so

Round 6 had to file **C10 FAIL** ("the skills-recommendation step opens onto an
EMPTY run detail", `detailColumnTextLength` **0**) and **C11 FAIL** ("the review
step can NEVER be opened here"). On this head:

| round 6 | round 7 |
|---|---|
| C10: row 2 pressed, run detail **blank**, `detailColumnTextLength` **0** | C10: row 2 opens the shipped `recommendation_hold` card — `[data-lifecycle-card="recommendation_hold"]` **1**, host `run_card`, the chip **Blog Content Skill** with **Confirm / Adjust / Skip**, `detailColumnTextLength` **35** |
| C11: row 3 carried `aria-disabled`, a forced press changed **nothing** — the step could not be opened for any run | C11: row 3 reads `data-run-surface-rail-reached="true"` / `data-action="open-review-step"`, and opens the run's review slot — `[data-run-review-slot]` **1** with `[data-conformance-id="review-gate-card"]` **1** inside it |

### The cells, and what each one is

| cell | reading | run |
|---|---|---|
| **C7** | the first-time run page: two columns, the rail NAMING `1 Schedule` / `2 Recommendation` / `3 Review`, the unchanged scheduling form open in the right column, no run progress | the setup run, before any press |
| **C9** | the SAME run after **Continue** with a one-off armed ahead | the same run, one press later |
| **C10** | the skills-recommendation row pressed on a run with a **LIVE hold** — the hold card, in the right column | a run held at its skills question |
| **C10b** | the same row on a run with **no park at all** — closed, muted, `aria-disabled="true"`, and a forced press changes nothing | the C7 run |
| **C10c** | the same row after the hold was **DECIDED** on the card — the settled reading of the same one renderer (`Blog Content Skill ✓ CONFIRMED`) | the C10 run, after Confirm |
| **C11** | the review row pressed once a **gate is on file** — the review card in place | a completed run that produced a reviewable artifact |
| **C11b** | the review row pressed **while the run works** — the placeholder with the spinning icon | two runs caught inside the outbox→gate window |

### Six runs, and why one could not carry them all

Each is a property of the screen under proof, not a convenience:

1. **A one-off armed AHEAD leaves the setup surface.** `shouldShowPersistentTab`
   is true for a `scheduled`/`recurring` trigger row, so the page becomes the
   Trigger tab. C7 and C9 are therefore a genuine BEFORE and AFTER of one press on
   ONE run — and C10b is shot on that same run, before the press — but that run
   can never also show a hold or a review.
2. **The hold only fires for an agent that HAS a candidate skill.**
   `maybeHoldRunForRecommendation` parks only when the request-aware scorer returns
   a candidate, and a candidate is an assigned skill of that agent. A skill was
   assigned through the app's own **Matches** tab
   (`drivers/2975-r7-assign-skill.mjs`); C10 and C10c stand on a run of that agent.
3. **The review step needs a run that produced a reviewable artifact.** C11 stands
   on a run that ran to completion on the real provider and whose artifact opened a
   gate. **C11b's two themes come from two runs**, and the reason is measured, not
   assumed: `runReviewStepReading` answers `working` only between the artifact's
   PENDING outbox row and the gate the sweeper opens from it, and on this lane that
   window ran **25 s** on one run and about **5 s** on another — shorter than two
   shutters. The catcher (`drivers/2975-r7-catch-review-readings.mjs`) polls the
   run's own rows four times a second and fires inside the window; the light and
   dark cells each caught their own run's window, and each record carries its run
   id and its shutter time.

### What this lane could NOT do, said plainly

- **The marketplace could not install anything.** Its own screen says installing
  needs the package registry connected, and this lane holds no registry
  credential. The agent under proof was installed through the product's OTHER
  install path — the **Upload Extension** screen
  (`drivers/2975-r7-install-extension.mjs`) — which needs none. Its dependency was
  installed the same way. Both rows are in the readback
  (`installedAgents`, `owner_level: organization`).
- **Two runs of this lane were dispatched by the explicit-dispatch pre-router**,
  not by the model's own tool call, because the sentence naming the package
  triggers that path. **Neither carries a cell.** Both are named in
  `readback/2975-r7-runtime-evidence.txt` with the grep that found them.
- **Two turns were refused before the ingress was warmed**, and five more across
  the session: the runtime HEADs the public MCP URL with a 2.5 s budget and
  refuses the turn outright if it does not answer. The first TLS handshake through
  this lane's ingress takes about five seconds; warmed, about 0.3 s. All seven
  refusals are quoted in the runtime evidence rather than trimmed out.
- **What the review card DRAWS INSIDE ITSELF is a lane reading, not this issue's.**
  On these pixels the card's content rung says *"review target unavailable — slot
  'detail', reason 'no-semantic-renderer'"* and falls back to the generic read-only
  view of the artifact. That is the artifact type's renderer, not the review step,
  and nothing here changes it. (cinatra#3008, the separate defect where the
  markdown representation held the producer's JSON envelope, is CLOSED; this is a
  different reading and is recorded, not fixed.)

### The runtime

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify
Postgres and Redis, loopback-only, with the agent runtime and the instance's own
package registry brought up beside it. It is **not** a production-equivalent build
— every record is labelled `dev-runtime`. Cells are shot at `deviceScaleFactor: 2`,
uncropped, at the full 1440x900 window (2880x1800 device pixels).

The provider is REAL and was configured **through the app's own `/setup/model`
form**, so the app sealed the credential itself; it is in no file, no argument, no
log and no record here. `cinatra.usage_events` records what the instance actually
called: provider `openai`, models `gpt-5.5` and `gpt-5.5-2026-04-23`, **84** calls.
`CINATRA_TEST_LLM_PROVIDER` was removed from the server's environment at launch and
is set in nothing this lane starts, and the server log carries **zero**
scripted-runtime lines. What this round can NOT say is stated rather than implied:
this host prints **no environment at all** for the listening process, so the
process-table read establishes nothing — `serverEnvAvailable: false` in
`readback/2975-r7-readback.json`, which is why the positive evidence is the usage
rows, the **94** `POST /api/mcp 200` callbacks from the provider's own servers over
the public ingress, the **9** `[llm-bridge-run-select] served-by=run_token` lines
the agent runtime produced, and the absent scripted lines.

### Where this round's own artefacts are

`2975-reshoot-walk.json` (the executable plan) ·
`drivers/2975-reshoot-page-controls.mjs` (the capture driver, BYTE-UNCHANGED from
round 6) · `drivers/2975-r7-confirm-hold.mjs`, `2975-r7-continue-immediate.mjs`,
`2975-r7-catch-review-readings.mjs`, `2975-r7-press-continue.mjs`,
`2975-r7-assign-skill.mjs`, `2975-r7-install-extension.mjs` ·
`readback/2975-r7-readback.json` (the rows and the runtime screens) ·
`readback/2975-r7-runtime-evidence.txt` (the server's own lines, with the grep that
produced each block and the public origin redacted) ·
`readback/2975-r7-read-back.mjs` (the readback driver). The chain drivers reused
from the earlier round live in `evidence/2970-setup-rail/drivers/`.


## Round 6 (2026-08-26) — C7 re-shot on the two-column setup surface, and the three cells cinatra#2970 adds

> **What changed and what did not.** ONE cell of this set was re-shot — **C7**,
> the run's setup scheduling step — because cinatra#2970 (PR #2975) rebuilt the
> screen it photographs. **The other twelve pictures are byte-identical**: their
> SHA-256s in the table below are the ones round 5 committed, and
> `page-controls.json`'s two C8 records are byte-identical to round 5's, in the
> same place in the file. Three cells were ADDED — C9, C10, C11 — for the
> acceptance items C7 alone cannot answer.

**The FAIL round 5 had to report is gone.** Round 5 wrote: *"ONE cell still
carries a FAIL and says so: C7, against the named drawing's two-column frame … a
standing gap between the drawing and the shipped setup wizard, which this slice
does not touch."* cinatra#2970 closed that gap, and the re-shot C7 measures it:
the same anchors that read **`run-step-rail-column` 0 / `run-detail-column` 0** in
round 5's record read **1 and 1** in the new one, on the same screen, through the
same reader. The rail carries the run's three setup steps **named** — `1 Schedule`,
`2 Recommendation`, `3 Review` — and the unchanged scheduling form ("When should
this run?", the three option rows, Estimated run duration, **Continue**) is drawn
in the RIGHT column, with no agentic run progress card anywhere in the window
(`agentic-run-progress` 0, `lifecycle-card-host` 0).

**The empty rail titles are gone too.** Round 5's C7 could not have shown them —
the screen had no rail. The lane that first shot this screen inside the new frame
(`evidence/2970-setup-rail/`, on this branch) found every rail row drawing its
numeral above an EMPTY title, because a server component was reading a label
constant out of a `"use client"` module. That was fixed on this branch before this
round, and these pixels are the first that show the rail naming its steps.

### The three cells this round ADDS, and why C7 could not carry them

| cell | shows | answers |
|---|---|---|
| **C9** | the SAME run's page after **Continue** was pressed on the scheduler step: `Trigger configuration` — type `scheduled`, `Aug 26, 2026, 9:30:00 PM`, `Europe/Berlin` — and `Cancel trigger` | cinatra#2970 acceptance 2, second half: *"Continue arms it exactly as today"*. C7 is its BEFORE: one run, one press between the two pictures |
| **C10** | the **skills-recommendation** row pressed on that same run: the row takes the selection, the run detail column carries the step — and draws **nothing** | cinatra#2970 acceptance 3, first half. It does not pass; see below |
| **C11** | the **review** row pressed: nothing happens at all, the scheduler stays open | cinatra#2970 acceptance 3, second half. It does not pass either; see below |

### TWO ACCEPTANCE ITEMS DO NOT PASS ON THESE PIXELS, AND THE CELLS ARE FILED SAYING SO

cinatra#2970 acceptance 3 reads: *"The skills-recommendation step and the review
step open the same way, to the right of the steps, never under a row."* Neither
half is met on this head, and each failure has a different cause, read out of the
code the pictures were taken against:

1. **The recommendation step opens onto an EMPTY run detail (C10).** The step's
   surface is the one shipped `RecommendationHoldCard`; with no live hold it
   resolves to nothing and renders no DOM at all, so the right column is blank —
   `detailColumnTextLength` **0**, counted off the live page, and the picture shows
   an empty right half of the screen. The rail's own guard cannot prevent it: it
   asks whether the step's surface EXISTS, and a component element exists however
   the component later resolves. PR #2975's own text names this exact residual
   ("a started run with no live hold can therefore still open a step whose card
   resolves to nothing"); C10 is that residual photographed. **What it means for
   the issue:** on this head the ruling's last clause — *"the right column never
   shows an empty step surface"* — is reachable by a person, on the run this round
   walked, in two presses.
2. **The review step can NEVER be opened here (C11).** On the setup run page the
   review step is composed with `surface: null` unconditionally
   (`instance-screens.tsx`), so `isRunSurfaceStepSelectable` closes the row for
   every run, whatever `reached` says. The row is drawn, numbered and muted, it
   carries `aria-disabled="true"` and `data-action="review-step-unavailable"`, and
   pressing it does nothing: the scheduler stays open and the detail column keeps
   the form. That is the RULING honoured, and acceptance item 3 unmet, at the same
   time — the two sentences are in tension and only the maintainer can settle
   which one the screen should obey.

Neither is a regression this round introduces and neither is fixed here: this lane
shoots the owed cells, it does not change the change under review.

### One more reading worth writing down: the rail's guard does not cover this run's status

The run these cells stand on reads `pending_approval`, which is **not** one of the
three pre-execution statuses `setupStepReachedForRunStatus` closes rows for
(`pending_input`, `pending_trigger`, `armed`). So its recommendation row is left
UNSTATED — drawn plainly, no `aria-disabled`, `data-action="open-recommendation-step"`
— and is therefore pressable, which is how C10 exists at all. A run that has
answered its scheduler and is waiting on its trigger choice (`pending_trigger`, the
state `evidence/2970-setup-rail/` photographed) has the row CLOSED instead. Both
readings are in the committed records, and neither is inferred.

### The runtime, and the two limits this round hit

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify
Postgres and Redis, loopback-only, with a clone of this branch's own extension
tree. It is **not** a production-equivalent build — every record is labelled
`dev-runtime`. Cells are shot at `deviceScaleFactor: 2`, uncropped, at the full
1440x900 window (2880x1800 device pixels).

The provider is REAL and was configured **through the app's own `/setup/model`
form** by a driver that read the credential from its process environment and typed
it into the form, so the app sealed the connection itself; the credential is in no
file, no argument, no log and no record here. `cinatra.usage_events` records what
the instance actually called: provider `openai`, model `gpt-5.5`, 2 streamed calls.
`CINATRA_TEST_LLM_PROVIDER` was removed from the server's environment at launch and
is set in nothing this lane starts, and the server log carries **zero**
scripted-runtime lines. What this round can NOT say is stated rather than implied:
this host prints **no environment at all** for the listening process (macOS SIP), so
the process-table read establishes nothing — `serverEnvAvailable: false` in
`readback/2975-reshoot-readback.json`, which is why the positive evidence is the
usage rows, the eight `POST /api/mcp 200` callbacks from the provider's own servers,
and the absent scripted lines.

**Two lane limits, named rather than hidden.**

1. **A stale build cache 404'd the chat handshake.** The lane's first boot failed
   to resolve the extension tree; the build cache it left behind then served a 404
   for `POST /api/assistants/chat/capabilities`, and the chat surface fails closed
   on that handshake, so no turn ran. Clearing the cache and rebooting fixed it.
   A lane-environment fault, not a product finding — but it is why the first two
   chat attempts of this session produced nothing.
2. **The public MCP probe timed out on a cold TLS handshake.** Before every turn
   the runtime HEADs the public MCP URL with a 2.5 s budget and refuses the turn
   outright if it does not answer (`#1699`). The first handshake through this
   lane's ingress takes about five seconds; warmed, it takes about 0.3 s. Two
   turns were refused before the ingress was warmed with one HEAD request. Both
   refusals are in `readback/2975-runtime-evidence.txt`, left in rather than
   trimmed out, and nothing was stood in for.

### Where this round's own artefacts are

`2975-reshoot-walk.json` (the executable plan, both passes) ·
`drivers/2975-reshoot-page-controls.mjs` (the capture driver; `page-control.mjs` is
BYTE-UNCHANGED) · `readback/2975-reshoot-readback.json` (the rows and the runtime
screens) · `readback/2975-runtime-evidence.txt` (the server's own lines, with the
grep that produced each block and the public origin redacted) ·
`readback/2975-chain.json` (the chat chain and what was measured either side of
each press) · `readback/2975-reshoot-read-back.mjs` (the readback driver). The chain
drivers this round reused and added live in `evidence/2970-setup-rail/drivers/`
(`08-chat-run-parked.mjs`, and the new `11-lane-identity.mjs` and
`12-scheduler-continue.mjs`).

**The canonical index is untouched.** `scripts/ci/chat-hitl-capture-index.json`
carries no C7 cell (it never did) and no record in it was rewritten: this screen
draws no lifecycle card at all, which is half of what these cells prove, so a
record of that index could only be made by inventing an anchor.


## Round 5 — every pictured cell re-shot on a chain with nothing stood in

Rounds 3 and 4 had to report one thing about themselves, and the maintainer
rejected the round for it: **the assistant's own turn came from the deterministic
model bridge**, and it was visible in the pictures in the assistant's own words —
"CINATRA_UAT_OK: deterministic chat reply." That is gone. All **fourteen**
pictures were taken again, and every leg of every pictured chain is the shipped
one.

**The chat turn now runs on the REAL provider, over the platform's own public
ingress.** The limit rounds 3 and 4 named was real: a real-model chat turn hands
the tool catalogue to the provider as ONE provider-hosted MCP reference, so it
needs a PUBLICLY reachable MCP URL, and the runtime refuses the turn outright
without one (`checkPublicMcpReachability`). This round has one. The instance's
public base URL was stated **through the product's own tunnel tab**
(`/configuration/development?tab=tunnel`), which is what records
`publicBaseUrlSource: "manual"` — no database row was hand-edited — and the
public `/api/mcp` endpoint answers. What follows from that is the whole point of
the round:

- the model chose the tool itself, and the thread's own dispatch part records it
  as a provider-hosted MCP call — `{"type":"tool_call","name":
  "schedule_proposal_render","serverLabel":"cinatra","id":"mcp_0e1afcff…"}`;
- the provider's servers called back into the shipped MCP endpoint over that
  public origin (`POST /api/mcp 200`, repeatedly);
- `usage_events` records `provider openai`, `model gpt-5.5` for the turn;
- and the assistant's words in the pictures are its own ("Schedule proposal is
  ready. Please confirm it on the scheduling card in this conversation to arm the
  one-time run."), not a bridge's marker.

`CINATRA_TEST_LLM_PROVIDER` was **UNSET** for the whole round. The scripted
runtime served nothing, and the server log carries **zero** scripted-runtime
lines.

**AND THAT IS NO LONGER ONLY THIS FILE'S WORD FOR IT.** Rounds 3 and 4 asserted
their database and runtime facts in prose and committed nothing a reader could
check. This round commits both:

- `readback/db-readback.json` — the rows themselves, produced by
  `readback/read-back.mjs` (committed beside it, and re-runnable against any
  lane) and left unedited. Every value `RUN-READBACK.md` and `TIMELINE.md` quote
  is in it, including the ledger rows naming which provider and model served each
  call, and every armed run this lane produced, discarded passes included.
- `readback/runtime-evidence.txt` — the server's own log lines, with the grep that
  produced each block so the extraction is repeatable, and ONE redaction applied
  everywhere it occurs: the instance's public origin, because a committed hostname
  is a leak and a lane the next operator cannot reproduce. Each block states what
  its lines can and cannot say — a log line does not name a caller's address, and
  a zero-result grep is not a capture of the process environment — and points at
  the row in `db-readback.json` that carries the load-bearing half.

Neither artifact makes the round self-proving — a lane can write its own log —
and this file does not claim it does. What they buy is that the numbers in the
prose can be checked against the rows and lines they were read from, instead of
being taken on faith.

**The agent's own execution is real too, and this time the run COMPLETED.** The
agent runtime called back into the shipped `/api/llm-bridge`, which resolved the
instance's own sealed `openai_connection` row by this run's own run token
(`[llm-bridge-run-select] served-by=run_token run=9384a346-…`); `usage_events`
records `provider openai`, `model gpt-5.5-2026-04-23` at `17:42:11.792+00`, and
the run reached `completed` with no error twelve seconds after the fire. The row
was written before the walk through the shipped sealed writer, from a credential
held only in the process environment: never printed, never logged, never written
to any file here, never committed.

**ONE RUN NOW CARRIES C1, C2, C3, C6 AND C8.** Round 4 had to say that C1 and C2
were two pictures of two different conversations; they are not any more. C1 and
C2 are the same card in the same thread before and after one Confirm, C3 is that
run's schedule step, C6 is that same card after the one-off came due, and C8 is
that same run's detail afterwards. C7 is a second, never-armed run — it has to
be, since an armed run's setup scheduling step is behind it — and C5 rides on its
own untouched proposal whose shipped 30-minute window was allowed to actually run
out.

**Nothing pressed *Run now*.** The walk plan contains no such action, no context
was on the run page between Confirm and the fire, the stamp landed 143 ms after
the second the person stated, and the runtime named the release job itself
(`[trigger-release] released gate for run 9384a346-…`).

**TWO typed sentences in `capture-walk.json` changed, and they are named rather
than left to be noticed** — the one the person types in `state-the-schedule` and
the one they type in `expired-clock`, which are the plan's only two `type`
actions. Both now state the instant and the timezone. The deterministic bridge answered any sentence with a daily recurrence,
so the old wording ("a few minutes from now") never had to be complete; a real
model reads it as a person would and ASKS which timezone to use instead of
guessing, ending the turn in a question rather than a card. Stating the instant
is what a person does when they mean a particular one. Every cell id, every
context, every viewport and every assertion in the walk is unchanged.

**Five armed runs were discarded before the pictured one**, each for a stated
reason — `RUN-READBACK.md` lists them with their release stamps. Two of them
failed artifact materialization because this lane's own dev registry held no
published copy of the agent package; publishing it there is what let the pictured
run reach `completed`. That was a LANE gap, not a product finding. All five
released within 143 ms of the second they were armed for, with nobody on the run
page — five independent corroborations that the schedule fires on its own tick.

**One cell still carries a FAIL and says so:** C7, against the named drawing's
two-column frame. It is not a regression this PR introduces; it is a standing gap
between the drawing and the shipped setup wizard, which this slice does not
touch. `PLAN-WALK.md` carries the graded verdict for every picture, written after
looking at the pixels.

## Round 4 — the two cells that carried a FAIL, re-shot on the fixed card

> **History.** Round 5 re-shot all fourteen pictures, so none of round 4's pixels
> is committed any more. This section is kept because the conformance fixes it
> describes are still the reason C2 and C6 read the way they do.

Round 3 reported three honest FAILs. Two of them were conformance failures in the
settled branch of the one schedule renderer, and both are now fixed:

1. **C2** — an ADJUSTED-then-confirmed card drew a supersede line over its rows
   ("This card was adjusted before it was set — open the run to see the schedule
   that was set."), so it declined the sentence it exists for: §7.2, "the same
   card, with the same option rows, **shows the schedule as it stands** — no
   label, no summary box". The card now re-opens on the settled rows and says
   nothing over them. `superseded` stays a resolver answer and stays on the wire —
   Confirm still refuses on the same comparison — it simply stopped being chrome
   the plan does not define.
2. **C6** — a FIRED one-off drew a disabled **Save changes**. §7.2: "once a
   one-off has fired it cannot be changed", and Save changes is defined for the
   changeable state only. A fired one-off now draws **no floor at all**: no Save
   changes, no Cancel schedule, no Run now, and no status line standing in for
   them. The rows simply stand, read-only, on the server's schedule.

So **C2 and C6 were re-shot, and nothing else was**. They were walked on their own
new run through the SAME recipe `capture-walk.json` carries: the schedule stated
in the chat composer, the rows ADJUSTED on the card before Confirm (the
deterministic producer proposes a daily recurrence; the person chose *Schedule for
later* and put `2026-08-24 09:34` / `UTC` in), Confirm, and then the one-off left
to come due on its own tick — `released_at 2026-08-24 09:34:00.088+00`, 88 ms
after the second the person stated. Nothing pressed *Run now*: the walk plan has
no such action, no context in this round was on a run page, and the runtime logged
the release job opening the gate for this run by name (`RUN-READBACK.md` quotes
it — the stamp alone would not say WHO released, because *Run now* writes the same
one). The agent then
executed on the REAL model: `usage_events` records `provider openai`,
`model gpt-5.5-2026-04-23` at `09:34:04.876+00`, and the run reached `completed`
with no error five seconds after the fire.

**C1, C3, C5, C7 and C8 kept round 3's pixels at the time**, because the fix
touched only the settled branch of the renderer. (Round 5 has since re-shot all
fourteen — see the top of this file — so none of round 3's or round 4's pixels
are committed any more.) One consequence is stated rather than left to
be noticed: C1 and C2 are no longer two pictures of ONE conversation — C1 is round
3's thread and C2/C6 are round 4's — so the "one card, in one place, before and
after one press" reading is carried by C2's own record (one card instance, one
thread URL, Confirm gone from the card root) and by the walk's own actions — one
context, one page, one press between the two steps — instead of by a picture pair.
What a reader can check in the committed pixels is narrower and is stated as such:
C2 shows ONE settled card in that conversation with Confirm gone and Save changes
in its place.
`RUN-READBACK.md` and `TIMELINE.md` carry both runs, and the index count was
unchanged: four records replaced where they stood, 58 in, 58 out. (Round 5 then
replaced all ten S9d records the same way.)

Two things about round 4's environment are worth stating plainly, because round 3
had to report the opposite of the second one:

- **The chat turn is still the deterministic bridge**, and it is visible in the
  pictures in the assistant's own words ("CINATRA_UAT_OK: deterministic chat
  reply"). A real-model chat turn hands the tool catalogue to the provider as one
  provider-hosted MCP reference and needs a PUBLICLY reachable MCP URL, which this
  machine does not have. The bridge stands in for ONE decision — which tool the
  turn calls; the producer, the proposal token, the org boundary and the card are
  all the shipped path.
- **The agent's own execution used the REAL model, and no fallback was needed.**
  The agent runtime calls back into the shipped `/api/llm-bridge`, which resolved
  the instance's own sealed `openai_connection` row (`POST /api/llm-bridge 200`,
  served by run token for this run) — the 424 the toolbox load can raise without a
  public MCP URL did not occur, so nothing was removed on the clock and the
  scripted runtime never served this run. The row was written before the walk
  through the shipped sealed writer, from a credential held only in the process
  environment: never printed, never logged, never written to any file here.

## Round 3 — what the maintainer rejected, and what the proof set is now

> **History.** Round 5 re-shot all fourteen pictures. This section is kept because
> the two rulings it records are what §7.2/§7.4 were amended to say, and they are
> still the sentences C3 is graded against.

Round 2's run-page cell (C3) showed a composition the plan does not contain: the
schedule's configuration opened **inside the rail column, under its own row**,
with the **agentic run progress** card drawn beside it on a run that had never
executed. Two rulings followed, and both are now in plan (A):

1. §7.2 step 5 / §7.4 step 7 — "open that step to see the configuration or change
   it — **it opens to the right of the steps, never directly under a step, and no
   agentic run progress card is shown with it**."
2. "It makes absolutely no sense to show the agentic run progress card here" —
   the agent has not run; there is no progress to show.

The ratified drawing says the same thing about the surface these cells
photograph (`images/lifecycle-screens/design-run-surface-rail-and-gate.png`):
"a **step rail** down the left names the run's ordered steps, and the **run
detail** on the right shows the selected step … Selecting a step opens it on the
right … right here in the run detail, under the same rail, never as a standalone
document."

So the code changed (the schedule row is a rail ENTRY; its surface opens in the
run-detail column; a run with no execution record draws no progress section and
opens on the schedule step) and the proof set changed with it: the schedule is
now walked through its **three stages on both page hosts**, which is what a
reader has to be able to see.

## Cells

`capture-walk.json` is the executable plan, and it was walked. Every cell is
**light + dark**, the **full browser window** (no clip, no element handle, no
fullPage), and counted off the live page by the recorder. The two page controls
were photographed the same way but are NOT records — see below for exactly what
that does and does not buy.

| cell | stage | host | what the picture must show | filed as |
|---|---|---|---|---|
| C1 | first shown | chat | the stated one-off, rows editable, **Confirm** | record, light + dark |
| C2 | configured, not run | chat | the SAME card after Confirm: same rows, **Save changes** | record, light + dark |
| C6 | ran | chat | the same card after the one-off fired; Save changes no longer offered | record, light + dark |
| C7 | first shown | run page | the run's own scheduling step — "When should this run?", the three rows, **Continue** (§7.4 today, step 4) | **page control** — see below |
| C3 | configured, not run | run page | the rail on the LEFT with **Schedule** selected, the form in the run detail on the RIGHT, **no agentic run progress card anywhere in the window** | record, light + dark |
| C8 | ran | run page | the run's steps in the run detail, the schedule step still listed in the rail | **page control** — see below |
| C5 | expired (extra) | chat | still visible, still editable, **Confirm** alone on the floor | record, light + dark |
| C4 | — | review page | this run's real artifact review | DROPPED — see `TIMELINE.md` |

Fourteen pictures, all taken by **round 5**, and every one of them says which run
it stands on. **One armed run carries C1, C2, C3, C6 and C8** — the same card in
the same conversation before and after one Confirm, that run's schedule step, that
same card once the one-off came due, and that same run's detail afterwards. **C7 is
a second, never-armed run**, and that stage can only exist there, since an armed
run's setup scheduling step is behind it. **C5 rides on its own untouched
proposal**, whose shipped 30-minute window was allowed to actually run out.
`RUN-READBACK.md` gives every row, including the proposal-ref→consume-key join
that binds the conversation to the run. `PLAN-WALK.md` carries the graded verdict
for each picture, written after looking at the pixels. (Round 5's standing FAIL on
C7 against the named drawing is gone; round 7's section at the top of this file is
the current reading of every cell it re-shot.)

| file | sha256 | filed as |
|---|---|---|
| `C1__chat-first-shown__light.png` | `064fbd044500cf0d50bc46ca31aaea48a1ec2a64b653c5fc1f2c9a5b0b4207dc` | record `S9d-C1__schedule-card__chat_thread__pending` |
| `C1__chat-first-shown__dark.png` | `3d960614b45231411efdf971d366a88cdfb3fb902bb2a9e2392de21531d77aa3` | record `S9d-C1__schedule-card__chat_thread__pending__dark` |
| `C2__chat-configured__light.png` | `a56b17646f5b896cb31237ce4424b47584cf60ac4e71097e7a7dc34b2cd41eaf` | record `S9d-C2__schedule-card__chat_thread__decided` |
| `C2__chat-configured__dark.png` | `65a3d02ad9b46131b8ef75e9e176a78f3f9a373776d60117414fca4f1f8d63af` | record `S9d-C2__schedule-card__chat_thread__decided__dark` |
| `C5__chat-expired__light.png` | `ddd1973a5607cb2281606623ee3bae19328354a7844ee1521214a4e75fb31b7f` | record `S9d-C5__schedule-card__chat_thread__pending__expired` |
| `C5__chat-expired__dark.png` | `43cbeb53bd69d9afae925dbcd0e1f8ecce1938f39e1c15979cc8bf8165c529d2` | record `S9d-C5__schedule-card__chat_thread__pending__expired__dark` |
| `C3__run-page-configured__light.png` | `698f017dc575521f7d73219fbe1219cf946a2134d7093270e42417a2f25867d7` | record `S9d-C3__schedule-card__run_card__decided` |
| `C3__run-page-configured__dark.png` | `63ab1513f40133c57f7493b68d875e2245e3d4ae0e91b5448c8864504bda7c9d` | record `S9d-C3__schedule-card__run_card__decided__dark` |
| `C6__chat-ran__light.png` | `e87625ecab474290bf736c54aafca8dfd67f4661a4d7091d585b303fed2f3d3f` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire` |
| `C6__chat-ran__dark.png` | `ccabf74343e98b9118cee1ca7d434e69ab59dafe1e31e844bf1830dd2f56370e` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire__dark` |
| `C7__run-setup-scheduling-step__light.png` | `3ad925f93ea247b139c5643b7448add44862058826c4074a16458d0ee999317d` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C7__run-setup-scheduling-step__dark.png` | `17e8411014fcf00df2d0db4575bae8a340fb145e3c15163c9737b0861959379f` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C8__run-detail-after-fire__light.png` | `3831af1d87c0a6f4dd60a6b284149d23d472ecbaf2653448fcb792009e64c359` | page control (light) — no index record |
| `C8__run-detail-after-fire__dark.png` | `86fff475add5688313ea40b11e92b77a65ac601110e0eee0af6e2024a8a32514` | page control (dark) — no index record |
| `C9__run-setup-continue-armed__light.png` | `c65de76126d348f0a7cb38500712080b1df692964f5033519b491f36f3a7c780` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C9__run-setup-continue-armed__dark.png` | `8713f030d0aae34b8b438d09888de2fb3ad3ee8bdc9ba8bcca30220f06d96666` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10__run-setup-recommendation-step-opened__light.png` | `45ef0a12a66d0c53e7a44540e0cd7e676027639426a59ea8573a59394f9b6a11` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10__run-setup-recommendation-step-opened__dark.png` | `72afd7dc2714bf5cf025faee6d928793f13f6a96f9d3a48234c83bc7976083d2` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10b__run-setup-recommendation-row-closed__light.png` | `3a105639302e2315a3aa61209b958cb34e7849291e6242df33796c2b7778a216` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10b__run-setup-recommendation-row-closed__dark.png` | `b86589025965da31f054964d4ea4a23474c7b2e198e2ea2a679bcf173aa94caf` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10c__run-setup-recommendation-step-settled__light.png` | `fe5f67ba8f173f24950c45bc7c502dbf9ad76edb65b17d52797877d24de42d39` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C10c__run-setup-recommendation-step-settled__dark.png` | `cfc36d860ffe225c721a2e74b921c2fc6dca5818e4c7755dd3c964ce8d8e4f73` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C11__run-setup-review-step-opened__light.png` | `9b9a85ff45e566cd06c824050ae18c6dd2f67a4f572ed57fb5640b74e36ec86a` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C11__run-setup-review-step-opened__dark.png` | `cbb862c800ba20b3693f7712971fe00fba0b7a794398bdccc046d37bc1e88d7e` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C11b__run-setup-review-step-working__light.png` | `5f767ed075e0014c64832e0f688e6d4d80d10723f9443823ba7e8176ed68d195` | page control (light) — no index record — **re-shot 2026-08-26 (round 8)** |
| `C11b__run-setup-review-step-working__dark.png` | `f8013bda36f14676c3072529fee237c5266292e06143bdbc09315601d3ec5a86` | page control (dark) — no index record — **re-shot 2026-08-26 (round 8)** |

The two round 2's **C3** records were deleted from
`scripts/ci/chat-hitl-capture-index.json` (56 records → 54) together with their
two images: they photograph the rejected composition, and a record that
describes pixels the product no longer draws is worse than no record. Nothing
was edited in place and no record was hand-written — the index is
recorder-measured only, and the next walk writes the new ones.

Round 5 then replaced all ten S9d records where they stood — 58 records in, 58
out, the other 48 byte-identical and in the same order — and re-took the four page
controls. Each was written by `chat-hitl-capture-driver.mjs --walk` in this lane,
and none was edited afterwards. What a READER can check without taking that on
trust is narrower, and is what the record is worth: every S9d record's `sha256`
matches the committed PNG beside it, and its `assertions` are counts the image can
be read against. `recordedBy` is a field in a JSON file, not a signature — it says
which tool wrote the record, and it cannot prove it.

## The two cells this index cannot hold — filed as PAGE CONTROLS

C7 and C8 are real screens and they are photographed, but neither can be an
honest **record** here. Every record in
`scripts/ci/chat-hitl-capture-index.json` asserts
`[data-lifecycle-card-host="<host>"]` on the screen it photographs —
`requiredAssertionsFor` in `scripts/ci/lib/capture-record-contract.mjs` requires
it with or without a card kind — and:

- **C7** is the run's SETUP scheduling step, the shipped trigger screen
  (`packages/agents/src/trigger-screen-client.tsx`). It draws no lifecycle card.
- **C8** is the run detail after the fire, where the schedule is a rail **row**
  and its surface is not drawn. No card on the screen either.

Both readings were counted off the live pages and are `0` in
`page-controls.json`, so this is measured rather than asserted. Giving either
screen an anchor for the recorder to count would mean drawing something the plan
and the drawing do not define, and making the index accept a card-less record
would change the anti-fraud contract S9h owns.

So they are filed as PAGE CONTROLS, and it is worth being exact about how much
that is worth. Each is a real full-window picture in light and dark; its painted
anchor counts are read off the live page through the SAME `playwrightPage`
reader a walk cell is measured with, so the counts are measurements and not
claims. But the entry does **not** go through `observeWalkCell`, the
capture-record contract, the index schema or any CI gate: it is a sidecar this
round writes, with its PNG, sha256, framing, app-relative final path, resolved
theme and counts in `page-controls.json` (and the sha256 table above) and **no
index record** — each entry saying so in as many words:

> `"record": "NONE — not a lifecycle host; filed as the page control (see README.md)"`

`drivers/page-control.mjs` is the driver. It writes no verdict: the verdicts are
in `PLAN-WALK.md`, written from the pixels. A repository search found no earlier
sidecar of this shape, so this is a filing this round PROPOSES, not one it
inherits — which is the open question for the maintainer below.

## What the environment forced in rounds 3 and 4 — BOTH LIMITS ARE GONE

**Round 5 removed both of the limits below**, and they are kept here only so a
reader can see what changed and why the earlier pictures looked the way they did.
The public ingress the first limit needed now exists and is stated through the
product's own tunnel tab, so the chat turn runs on the real provider; and because
the real model reads the person's sentence as written, the one-off no longer has
to be corrected on the card, so the second limit's consequence never arises. See
"Round 5" at the top.

Two things in ROUNDS 3 AND 4 were not what the walk plan's note describes, and
both were environment limits rather than product findings. They were stated in
those rounds' `PLAN-WALK.md` verdicts and in `TIMELINE.md` rather than left for a
reader to notice.

1. **The assistant's own proposal came from the deterministic model bridge, not
   from a real model.** A real-model chat turn hands the platform's tool
   catalogue to the provider as ONE provider-hosted MCP reference, so it needs a
   PUBLICLY reachable MCP URL (`checkPublicMcpReachability`; the runtime refuses
   the turn outright without one, and the widget/chat tool build returns the
   "Cinatra MCP public URL is not configured" error). Opening a public ingress to
   a development server was not available for this round, so the chat surface ran
   on the deterministic bridge — which is visible IN the pictures, in the assistant's
   own words: "CINATRA_UAT_OK: deterministic chat reply." The bridge stands in
   for ONE decision, which tool the turn calls; the producer, the proposal token,
   the org boundary and the card are all the shipped path.
2. **Because that bridge only ever proposes a daily recurrence, the ONE-OFF was
   stated by the person ON THE CARD** — choosing *Schedule for later* and putting
   `2026-08-23 21:22` / `UTC` into the card's own fields before pressing Confirm.
   That is the plan's own sentence ("until you confirm, you change the schedule
   directly on the card — the rows are never locked behind a separate step"), so
   the path is a shipped one and the round exercises that sentence instead of
   only photographing it. Its one visible consequence in round 3 was the line C2
   and C6 drew above the rows — the shipped `SUPERSEDED_SCHEDULE_COPY`, "This card
   was adjusted before it was set — open the run to see the schedule that was
   set." Round 3 reported it as a FAIL against C2's plan sentence rather than
   papering over it; **that line is now gone** (see "Round 4" at the top), and
   round 4's C2/C6 are the same adjusted-then-confirmed path photographed on the
   fixed card.

**The agent's own execution used the REAL model.** That half needs no public
ingress: the agent runtime calls back into the shipped `/api/llm-bridge`, which
resolves the instance's own sealed `openai_connection` row. The row was written
before the walk through the shipped writer the setup wizard uses, from a
credential held only in the process environment — never printed, never logged,
never written to any file produced here, never committed.

**Nothing pressed *Run now*, in any round.** Round 3's one-off was released at
`released_at 2026-08-23 21:22:00.163+00`, 163 ms after the second the person
stated and seventeen minutes after the row was written; round 4's at
`released_at 2026-08-24 09:34:00.088+00`, 88 ms after its own stated second and
seven minutes after its row was written. The stamp itself proves RELEASE and not
WHO released — *Run now* writes the same one — so what each round can say for it
is set out in `RUN-READBACK.md`: round 3 has its walk's own actions and the
timing; round 4 has those plus the runtime's `[trigger-release]` lines naming the
release job for its run.

## Red first

`RED-FIRST.md` carries round 3's table: the four DOM facts of the reworked
composition, and the run-detail predicates, were written before the component was
touched and failed against `2ba505904` for the stated reasons.

## What is still owed on this round

- Nothing on the cells: all fourteen pictures are taken, graded and filed, and
  every one of them was re-shot by round 5 on a chain with nothing stood in. The
  index holds 58 records; round 5 replaced the ten S9d records where they stood
  and left the other 48 byte-identical. C7 and C8 are page controls with no
  record, by the reasoning above.
- C4 stays dropped. See `TIMELINE.md`.
- The maintainer's answer on whether the page-control filing is the one they
  want for C7 / C8 is still the open question. It is a shape this round proposes:
  a measured sidecar with no record and no gate behind it. The alternatives are
  to widen the record contract so a card-less screen can hold one, or to accept
  that these two stages are photographed but not indexed.
- ONE cell still FAILs a clause and is reported that way rather than softened:
  C7 (the named drawing's two-column frame — the setup wizard's page has neither
  column). It is not a regression this PR introduces; it is a standing gap between
  a drawing and the shipped setup wizard, and the slice does not touch that screen.
  The two FAILs round 3 reported — C2's supersede line and C6's disabled **Save
  changes** — were fixed in round 4 and are PASS again on round 5's own pixels.

## Owed elsewhere: six cells the Audit relabel left with old pixels

The **do not shoot here — a UI lane owns these** list. cinatra#2945 (merged)
relabelled the audit lane **Core analysis → Audit** everywhere a person can see
it, and six committed captures still show the retired word, so six index records
now describe text the product does not draw. **B1–B4** in
`evidence/2852-before-after/captures` photograph the review card's chip row and
its decision floor, whose heading `review-gate-card.tsx` changed from
`Core analysis · Suggestions` to `Audit · Suggestions`; **G5** and **G6** in
`evidence/2791-s9g-conformance/captures` photograph the audit card itself on the
run page and on the review page, whose heading `verification-summary-card.tsx`
changed from `Core analysis` to `Audit` and whose rail entry in
`run-step-rail.ts` changed with it. The re-shoot is a pixels-only round on a lane
with a browser: reach the same four surfaces the two rounds already reached
(B1 / B2 the page gate region and B3 / B4 a real transcript, on one run with
every suggestion accepted and then one chip dismissed; G5 the run page and G6 the
review page's verification view on an advisory audit), take each capture the way
its round took it, and re-record all six through
`scripts/audit/lib/chat-hitl-capture-driver.mjs` so the six index records are
replaced by measurements of the new pixels rather than edited in place — the
anchors these cells are graded on did not move, only the word on them did, so a
record whose hash still matches the old image is the only thing standing between
the index and the truth. Nothing about these six is fixed by this commit.

## Round 2, kept for the record

Round 2 walked the same path through the recorder and merged eight records
(48 → 56). Its four answers to round 1 still stand and are not re-litigated here:
full-window framing declared per cell and written into every record; no seeded
transcript and no hand-minted token; the summary box, the held-steps block and
the "Armed ·" line removed from the card on every host; and the two control
labels — `Cancel trigger` → **Cancel schedule**, `Release now` → **Run now**,
`data-action` ids unchanged. Plan (A) §7.2 now names those two controls itself,
so the open deviation round 2 recorded against that sentence is closed.
