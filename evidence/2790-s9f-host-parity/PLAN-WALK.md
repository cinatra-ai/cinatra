# cinatra#2790 (S9f) — the plan walk, cell by cell

Every cell this lane presents, with the EXACT plan sentences that govern the
surface and the state it shows. The quotes are copied character-for-character
from the ratified plan page `PLAN: Agents Lifecycle` in the engineering wiki;
each one is an exact substring of that page and can be grepped against it.

Read it as a contract: a cell that shows something no quoted sentence sanctions
does not belong here, and a sentence that sanctions something the cell does not
show is a quote that should not have been used.


CELL: R1__recommendation-card__page_gate_region__decided
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R2__recommendation-card__page_gate_region__decided__above-gate
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: R3__recommendation-card__page_gate_region__decided__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R4__recommendation-card__page_gate_region__decided__above-gate__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: W1__recommendation-card__site_widget__held__column
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the schedule card's actions have no UI caller anywhere.

CELL: W2__recommendation-card__site_widget__held__column__dark
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the schedule card's actions have no UI caller anywhere.

CELL: W3__recommendation-card__site_widget__settled__column
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **Decisions ride the widget's own proof.** The decide route selects the widget branch from the presented `cwu_` header with **no** session fallback, so a decision from a widget frame can never be recorded against whoever else is signed in on that browser (`src/app/api/lifecycle-views/decide/route.ts:176-194`).
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H1__recommendation-card__site_widget__held
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H2__recommendation-card__site_widget__held__dark
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H3__recommendation-card__site_widget__held__mid-decision
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H4__recommendation-card__site_widget__settled
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **Decisions ride the widget's own proof.** The decide route selects the widget branch from the presented `cwu_` header with **no** session fallback, so a decision from a widget frame can never be recorded against whoever else is signed in on that browser (`src/app/api/lifecycle-views/decide/route.ts:176-194`).

CELL: S3__review-card__chat_thread__pending
PLAN> **It appears** when a run reaches a review gate — in the conversation where the run lives, and on the run page.
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: S3__review-card__chat_thread__pending__dark
PLAN> **It appears** when a run reaches a review gate — in the conversation where the run lives, and on the run page.
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> Everyone who looks at that run — in the chat, in the widget, on the run page, on the review page — sees the same card.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: S4__recommendation-card__page_gate_region__decided
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.

CELL: S4__recommendation-card__page_gate_region__decided__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Everyone who looks at that run — in the chat, in the widget, on the run page, on the review page — sees the same card.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.



## The REWORK proof set — RE-SHOT WITH BOTH STOOD-IN LEGS REMOVED (cinatra#2890)

**These eight cells were re-shot, and the reason is the chain rather than the
picture.** The records they replace came from a round whose chain had two
stood-in legs: the CHAT TURN took the deterministic pre-router (it named the
agent package and carried embedded `inputParams`, so the server dispatched the
run itself and no model was consulted for the turn), and the AGENT'S OWN STEP
was served by the scripted runtime, because this instance had no public MCP
ingress and the real provider's toolbox fetch answered `424 Failed Dependency`.
Neither is allowed to stand as proof.

**Both legs are real here, and each one is checkable rather than promised.** The turn names the
agent by its DISPLAY name and carries NO package token in either form the
pre-router reads — no `@cinatra-ai/<slug>`, no `cinatra_<slug>`. That detector
requires BOTH a verb AND a package reference, so it returns null, the hard
server-side dispatch never fires, and the SOFT directive is never prepended
either. The ONLY thing that can turn this turn into a run is the real model
calling `agent_run` through this instance's own public MCP toolbox.

The turn DOES state the idea as an object, and that is worth separating from what
the withdrawn round did, because it looks similar and is not. The withdrawn
turn's JSON mattered because that turn ALSO named the package: the pre-router
matched, dispatched server-side, and read the JSON on its own brace-matched fast
path — no model anywhere. With no package token there is no pre-router to reach,
so nothing in the platform can read this object at all; the model has to read it
and pass it. It is stated because the agent needs it: MEASURED across nine real
runs on this lane, a dispatch that carries no `inputParams` parks the run on the
agent's setup field and then on its trigger, and neither surface on this branch
draws a control for that trigger state — so the run never executes and R6 has
nothing decided-and-run to photograph. `drivers/12-real-chain-sequence.mjs` fails
LOUD on that state rather than photographing it.

The sealed `openai_connection` row is READ ON BOTH SIDES OF THE STEP — timeline
rows `T1c` (before) and `T3a` (after the step's own model call). There is no
provider window in the driver and no clear step. Two point reads are what that
claims: they bracket the call, which is what the earlier round's removal broke;
they do not prove uninterrupted presence, and the prose does not say they do.

**The scripted runtime is ruled out for the AGENT'S STEP by the code's own
ordering, and that is the decisive fact.** `resolveConfiguredLlmRuntime` — the
resolver `/api/llm-bridge` takes, which is the seam the agent-run model call goes
through — reaches the scripted runtime only as a LAST RESORT, *"after every real
candidate failed to resolve"*, and its own comment says an install WITH a
configured provider never reaches that line. Rows `T1c` and `T3a` read a real
sealed provider back on BOTH sides of the step. So the step could not have been
served by the scripted runtime whatever any environment says.

**For the CHAT TURN the ordering is the other way round, and this page says so
rather than blurring it.** `orchestrateStreamImpl` checks the flag FIRST and
returns the scripted stream before any provider is resolved. What the records
carry for that leg is an environment read — `serverScriptedProviderEnv: null`,
with `serverEnvReadFrom: "process-table"`, the pid read, `serverEnvHopsFromListener: 1`
and `serverEnvTokensSeen: 63` beside it. It is an ANCESTOR read: the Next server
rewrites its argv, so the listening process prints no environment and the read
walks one hop up. That asymmetry is stated plainly — a non-null answer would be
proof of presence and aborts the sequence; a null answer is CONSISTENT WITH
absence and is not by itself a proof of it, because a child can be given a
variable its parent never had. The lane started the server with the variable
explicitly unset and every shutter's read agrees with that; the residual — a
variable injected into the child alone — is not closed by any committed field,
and is named here instead of being papered over.

The driver additionally refuses to start if its OWN environment carries the flag;
that is the weaker half and is labelled `driverScriptedProviderEnv` so the two can
never be read as the same measurement.

**What is measured on every cell, and what each measurement is worth.** Each
record carries a `providerEvidence` block read at the instant of the shutter.

FIVE OF ITS FIELDS ARE NEGATIVE SCREENS — `preRouterShortCircuits`,
`preRouterAttempts`, `scriptedRuntimeLines`, `noProviderRefusals`,
`mcpDependencyFailures` — all zero on all eight cells. A screen is worth what a
screen is worth: a hit proves a problem, a zero is the absence of that particular
line. Two of them are deliberately broad, which is the safe direction for
something whose only power is to stop the shoot. The claim does not rest on them.

ONE FIELD IS AN ENVIRONMENT READ with a stated asymmetry:
`serverScriptedProviderEnv`, with `serverEnvReadFrom`, `serverEnvReadOfPid`,
`serverEnvHopsFromListener: 1` and `serverEnvTokensSeen: 63` beside it so a reader
can re-run the same two commands and weigh the answer. Presence would be proof;
absence at one hop up is consistent, not conclusive. See above.

ONE FIELD IS POSITIVE: `publicMcpCallbacks` — `POST /api/mcp` hits. The raw count
is cumulative over the lane session, so what carries anything is
`deltaSinceStart`, which rises **0 → 3 → 5** across the eight cells while
`bridgeRunSelects` rises **0 → 1**. The driver ABORTS a shutter whose delta has
not moved. Its LIMIT is stated too: the request log does not record which caller
made the POST, and this branch's scripted self-MCP path also posts to `/api/mcp`
on the LOCAL url — so a moving delta proves the instance's own MCP surface was
exercised during the sequence, not, on its own, who exercised it.

**The run in these pictures RAN, on the real model, and produced a real
artifact.** `agent_runs.status = completed`, `error` empty, one `representation`
row, one processed `artifact_produced_outbox` event and one `artifact_review_gates`
row. `RUN-READBACK.md` reads all of it out of the database. Every earlier round in
this lane had to disclose a downstream failure at this point; this one has none to
disclose.

The run-page pair is numbered R5/R6 rather than R1/R2 because R1-R4 in this lane
are already the REVIEW-PAGE cells; the host token in each name (`run_card`) says
which surface it is.

Every `DRAWING-CHECK>` below was written by VIEWING the picture and comparing it
to the plan sentence and the named drawing.

CELL: S1__recommendation-card__chat_thread__held
PLAN> You ask the assistant, in the chat or the widget, to run an agent that has recommended skills.
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the assistant's reply carries the chip row and NOTHING else that belongs to a started run — one chip per skill with its own Confirm / Adjust / Skip, no heading plate, no row-level submit, and no agentic run progress card anywhere in the turn / shows: the whole chat window in one frame; the person's own turn at the top, naming the agent by its display name and no package ("Please have the Blog Draft Writer Agent write me a blog draft. Here is the idea it should work from: {…}"), and under it the assistant's OWN reply — "The blog draft run is waiting for your **Confirm or Skip** on the recommendation card in this conversation." — carrying FOUR chips: Blog Writing Skill, Blog Post Matcher Skill, Brand Voice Matcher Skill, Web Research Skill, each with its own Confirm, Adjust and Skip and no other control. No heading plate above them, no submit below them. NO agentic run progress card anywhere in the turn: the record's frame count for `[data-inline-run-card]` reads **0**. The run has produced nothing: representation, produced-outbox and review-gate row counts all read **0** in the database at the instant of the shutter (`dbAt`), with the park `parked` at `recommendation` / verdict: PASS
DRAWING-CHECK> chain: `providerEvidence` on this record — `preRouterShortCircuits: 0` and `preRouterAttempts: 0` (the deterministic dispatch never fired), `serverScriptedProviderEnv: null` read from the app server's own process table (`serverEnvReadFrom: "process-table"`, 63 environment tokens seen), and `deltaSinceStart.publicMcpCallbacks: 3` — three hosted-provider callbacks reached this instance between the sequence's baseline and this shutter. What this record CAN say about the reply is that it is not the platform's synthesized dispatch line — that line is absent from the turn and `preRouterShortCircuits` reads 0. Which model produced its wording is not something this record measures, and the phrasing is not offered as if it were. The withdrawn record's reply read "Dispatched @cinatra-ai/blog-draft-writer-agent (runId: 8ff25a9b-…, status: pending_input)", which is the line the SERVER writes when it dispatches without a model; no such line is anywhere in this turn.
DRAWING-CHECK> binding: this record's `runId` is bound to this turn by the driver's NARROWED fallback — every run started by this actor since the sequence began — and that set held EXACTLY ONE row (`runIdCandidates: 1` in `logs/realchain-sequence-state.json`). The driver refuses when it holds more than one, so the binding is unambiguous rather than merely newest.

CELL: S1__recommendation-card__chat_thread__held__dark
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same window and the same held turn in the dark palette — chip row present, no run progress card / shows: the identical window on the dark ground; the same four chips with the same three controls each, legible against the dark surface; no heading plate, no row-level submit, and no run progress card (`[data-inline-run-card]` still **0**) / verdict: PASS

CELL: R5__recommendation-card__run_card__held
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> On the run page the same row sits at the **trigger position**, the top entry on the step rail, ahead of the work steps it would authorize.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the run page for the same run while the recommendation is held — the two-column frame, the step rail on the left with the recommendation at the trigger position, and the recommendation read in the run detail on the right under that same rail, never as a standalone document, with nothing inline under the rail row and no run progress beside a run that has not run / shows: the run page for the SAME run id the chat cells photograph; the two-column frame is drawn (`surfacePresent: true`, `surfaceChildren: 2`, both instrumented columns at 1); on the LEFT the rail carries `① Recommendation` — the numeral in the filled circle, the title highlighted as the open step (`railStepSelected: "true"`, `railStepSettled: "false"`, `railStepIndicatorText: "1"`, `railStepIndicatorHasCheckGlyph: false`); on the RIGHT the four chips stand in the run detail, each with its own Confirm / Adjust / Skip (the three `[data-skill-action]` counts all read 4 inside the card root); the chip row is a descendant of the run-detail column and NOT of the rail column and NOT of the rail row (`chipRowInDetailColumn: true`, `chipRowInRailColumn: false`, `chipRowInsideRailRow: false`); and there is no "Agentic Run Progress" section anywhere on the screen (heading count **0**) / verdict: PASS on the trigger position, the surface placement and the absent progress — with ONE READING STATED rather than glossed: the rail here carries the gate row ALONE (`railRowLabels: ["1Recommendation"]`). A run that has not executed contributes no step entries of its own, so "ahead of the work steps it would authorize" is shown here as a POSITION without the steps it precedes. R6 is where that completes: on the decided page the same rail reads `Recommendation`, `Step 1`, `Review`.

CELL: R5__recommendation-card__run_card__held__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same run page and the same held state in the dark palette / shows: the identical two-column framing on the dark ground — `① Recommendation` on the left with its numeral, the four undecided chips in the run detail on the right, no progress section; the same measured containment (`chipRowInDetailColumn: true`) and the same `railStepSelected: "true"` / verdict: PASS, with the same stated rail reading as the light cell

CELL: S2__recommendation-card__chat_thread__decided
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the settled chips in the same reply, each stating its own outcome with nothing left to press, and the agentic run progress card with no skills button row and nothing selectable inside it / shows: the same conversation and the same reply slot — same sentence, same position. The row has SETTLED IN PLACE and each chip now states its own outcome: `Blog Post Matcher Skill ADJUSTED`, `Blog Writing Skill ✓ CONFIRMED`, `Web Research Skill ✓ CONFIRMED`, with no Confirm / Adjust / Skip left on any of them (all three root-scoped `[data-skill-action]` counts read **0**, and every chip's `actions` array is empty). The `Agentic Run Progress` card is drawn with the decision — not before it — carrying the run's own in-flight `Draft Context` gate and its `Continue`, and there is NO skills button row inside it (`[data-hitl-skill-picker]` reads **0** while `[data-inline-run-card]` reads **1**). The hold reads `released` in the database at this instant / verdict: PASS — with one reading stated rather than glossed: the SKIPPED skill (Brand Voice Matcher) is not drawn in the settled row at all, so the settled row shows what was KEPT rather than every decision taken. That is this branch's settled reading, and the plan sentence ("showing what you chose") admits it; a reader who wants the skip on screen would not find it here.

CELL: S2__recommendation-card__chat_thread__decided__dark
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same settled turn in the dark palette — settled chips, the run progress card, no skills button row inside it / shows: the identical window on the dark ground; the same three settled chips with their outcome words, the `Agentic Run Progress` card below them with the `Draft Context` gate and `Continue`, and no skills button row inside it (`[data-hitl-skill-picker]` **0**) / verdict: PASS

CELL: R6__recommendation-card__run_card__decided
SECTION> plan (A) §6.2 step 3 · §6.4 step 4 · §6.2's run-page bullet — the three sentences quoted next, in that order. Each PLAN> line stays an exact substring of the plan page.
PLAN> You confirm (the run starts with your selection) or skip (the recommendation is recorded as skipped, nothing is selected, and the run proceeds with its default skill set). The card settles in place and shows what you chose. The agentic run progress card appears once the skills are decided; no skill inside it can be selected.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected. **End state: shaped and started, in the conversation you were already in.**
PLAN> On the run page the same row sits at the **trigger position**, the top entry on the step rail, ahead of the work steps it would authorize.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the drawing's own sentence for a settled gate — "A resolved gate stays on the rail as read-only history" — read on the run page after the decision: the `Recommendation` entry still on the rail, in the place it held while the question was live, drawn in its COMPLETED reading (the check in the circle in place of the numeral, the title unhighlighted because it is no longer the selected step); the run detail beside it showing the run's OWN panel rather than the gate's surface; the settled chips wherever this branch draws them; and nothing selectable inside the card / shows, MEASURED (every value below is a field of this cell's own record): the two-column frame is `RunSurfaceRail`'s own — `surfacePresent: true`, `surfaceChildren: 2`, both instrumented columns at 1. The rail's ordered rows are `railRowLabels: ["Recommendation", "Step 1Review"]` — the settled gate entry FIRST, ahead of the run's own work step and the review step after it. `railStepSettled: "true"`, `railStepSelected: "false"`, `railStepText: "Recommendation"`; the indicator's own text is EMPTY and it holds an `svg` (`railStepIndicatorText: ""`, `railStepIndicatorHasCheckGlyph: true`) — a check where a numeral would be. Three chips, all settled, none with any action left: `[data-skill-action="confirm"|"adjust"|"skip"]` all count **0** inside the card root, and each chip's `actions` array is empty. The chip row is a descendant of the run-detail column and NOT of the rail column and NOT of the rail row (`chipRowInDetailColumn: true`, `chipRowInRailColumn: false`, `chipRowInsideRailRow: false`), and one `Agentic Run Progress` heading is on screen. / and READ OFF THE PIXELS (looked at, not measured — these clauses are a person's reading of the image, labelled so nobody mistakes them for record fields): the rail reads `✓ Recommendation`, `✓ Step 1`, `▣ Review` down the left, with `Recommendation` drawn at the SAME weight as the rows beneath it, so the settled row reads as history rather than as the open step; the run detail on the right is the run's own `Agentic Run Progress` card carrying a `completed` pill, the three settled chips `Blog Post Matcher Skill ADJUSTED` / `Blog Writing Skill ✓ CONFIRMED` / `Web Research Skill ✓ CONFIRMED` inside it, and under them `Run complete — This run finished. Its output is in the run transcript below.` with `Start new run`. Nothing anywhere in the card can be pressed to change a skill. / verdict: PASS — with two readings stated rather than glossed. (a) The settled chips sit inside the Agentic Run Progress card rather than above it; the plan sentence puts the settled row and the progress card together without ordering them, so this is where this branch draws them and the picture says so plainly. (b) The SKIPPED skill (Brand Voice Matcher) is not drawn in the settled row at all — three chips for four decisions — the same settled reading S2 records in the chat. One cross-cell comparison is also named as one: "the place it held while the question was live" is R5's own record, which measured `① Recommendation` at the trigger position on the same surface.

CELL: R6__recommendation-card__run_card__decided__dark
SECTION> plan (A) §6.4 step 4 · §6.2's run-page bullet — the two sentences quoted next, in that order.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> On the run page the same row sits at the **trigger position**, the top entry on the step rail, ahead of the work steps it would authorize.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same decided run page in the dark palette — the settled `Recommendation` entry still on the rail with its check, the run's own panel in the run detail beside it, the settled chips with nothing left to press / shows, MEASURED: the same run, the same shutter contract (1440x1700 CSS px at deviceScaleFactor 2, `framing: "window"`), and a record whose `runSurface` block is field-for-field the light cell's — `railRowLabels: ["Recommendation", "Step 1Review"]`, `railStepSettled: "true"`, `railStepSelected: "false"`, `railStepIndicatorHasCheckGlyph: true`, both instrumented columns at 1, `chipRowInDetailColumn: true`, three chips with empty `actions`, all three `[data-skill-action]` counts **0** inside the card root. `themeClass` carries `dark`. / and READ OFF THE PIXELS: `✓ Recommendation`, `✓ Step 1`, `▣ Review` on the left, all legible on the dark ground; the `Agentic Run Progress` card on the right with its `completed` pill; the same three chips reading `ADJUSTED` / `CONFIRMED` / `CONFIRMED`; `Run complete` and `Start new run` below them / verdict: PASS, with the same two stated readings as the light cell

## What these eight cells now show, and the one reading that stands

**The chain is real end to end, and that is the point of the re-shoot.** The turn
is answered by the model; the model starts the run through the platform's own
tool over the public MCP toolbox; the person decides each chip on the shipped
card; the run executes on the same sealed provider row it was created under and
writes a real artifact. No leg of that is stood in for, and the driver refuses to
start under the one env var that could make a leg scriptable.

**R6 (both palettes) draws the recommendation's settled rail entry.** The pair
this branch first filed did not: on this agent's branch the run panel inside the
run detail hosts the recommendation card once the run has started
(`screenHostsRecommendationCard` is false for the `agentic` panel), and the screen
used to contribute a rail step only where the SCREEN hosts that card — so at the
moment the question was decided the `Recommendation` row stopped being drawn and
`RunSurfaceRail` stopped being rendered with it. `64c0b1412` separates the two
questions: `recommendationRailEntry` answers whether the entry EXISTS and how it
READS, and the screen's own host gate keeps answering only what SURFACE the step
opens (a settled entry opens none — the decided summary it stands for is already
inside the panel). The pictures are where that is read: the entry is on the rail,
first, with its check, and both of `RunSurfaceRail`'s instrumented columns are
present.

**The R5 rail reading stands, and it is a property of the state rather than a
defect of the branch.** While the run is still held the rail carries ONLY the gate
row, because a run that has not executed contributes no step entries of its own —
so R5 shows "ahead of the work steps it would authorize" as a position without the
steps it precedes. R6 is where that completes: on the decided page the rail reads
`Recommendation`, `Step 1`, `Review`, and the gate entry is visibly ahead of both.

**Nothing downstream failed this time.** Every earlier round in this lane had to
disclose a failure after the pictured states — a model call that answered
`503 NO_LLM_PROVIDER`, a provider that could not reach the public MCP server
(`424 Failed Dependency`), or an artifact materialization that found no title in
what a scripted model returned. This run completed: `agent_runs.status =
completed`, no error, one representation, one processed produced-outbox event and
one review gate. `RUN-READBACK.md` reads all of it out of the database.
