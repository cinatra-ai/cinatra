# `evidence/2934-w5c-fill-and-review-road/` — the picture leg of cinatra#2934 (pull request 2998)

Taken at head `270d1f8ab4227c0e7e3fae764767362f427c69be`, on the real running app, signed in as **a run
owner who is not a platform administrator** (`Rita Owner`, `role=user`, organization `member`). A real
provider answered every turn through the real public MCP toolbox over the instance's own public
origin; the scripted provider is set in nothing this leg started and the app server's own log carries
**zero** scripted-runtime lines. No stub, no seeded transcript, no edited pixel, and **no direct-SQL
write of a run, a gate, a park, a record or a review task** — every statement this leg made against
the database is a `select`. Full window, 1440x900 at device scale 2, uncropped, **light and dark**,
switched through the app's own theme control. Every capture was viewed before it was recorded.

Graded against the ratified drawing at the contract's pin `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`
— `app-artifact-review.html` §VI, §IX and §X, and `app-lifecycle-cards.html` §X. Those sections were
read at that pin and their sentences copied into the **requires** column verbatim, character for
character.

**The whole leg is re-taken at this head. Nothing is carried.** The three repairs this head landed
touch the fill projection (`bound-screen-controls.ts`), the schedule surface's own binding
(`schedule-form-screen.ts`) and the window's fill application (`use-run-window-conversation.ts`) —
the last of which every window shares — so every predecessor capture is REPLACED rather than kept.

## What this leg found, in one paragraph

The two readings that failed at `35548b3c` now pass on the real screen: on the **run page** the value
lands in the `Idea` control the screen actually draws, and on the **schedule screen** a described
schedule lands in the scheduler form's own rows with nothing submitted. The three cells the previous
host could not reach were reached here: the **armed-trigger tab** is photographed and recorded as the
named deviation it is, and the review page's **question** and **request for changes** are both taken
on a real gate over real artifact-bound output — the request is filed word for word through the card's
own Comment control, the gate resolves changes-requested and a repair goes in flight carrying the
person's own words. One half of that last cell is NOT reached and is recorded rather than simulated:
the repair run parks on the producer agent's own setup gate and that run has no page, so the corrected
version did not return as a fresh review while this leg was open.

## The graded table

| capture | requires (verbatim from the drawing) | shows (measured) | verdict |
|---|---|---|---|
| [`run-page__fill-no-submit__light.png`](run-page__fill-no-submit__light.png) | §X, the run page's own reading: "Ask Cinatra to fill the fields above, or ask about this step… **Fills the fields the step is waiting for with what was asked for.** Nothing is submitted until the person presses the step's own button — unless the same message asks for it in so many words."<br>§X, the rule for every surface with a form: "The window fills **the fields the person can see** with what they asked for, and nothing is submitted until they press the screen's own button". | The setup gate of run `fc9f58d7` (`Agentic Run Progress` · `Awaiting input` · `Idea (optional)` · a live `Continue`). Its gate schema is the object-valued case the defect lived in: `{"type":"object","title":"idea","properties":{"title":…,"summary":…,"outline":…},"x-object-text-property":"title"}` with `field_name` `idea`. The person typed `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is`. **Measured off the rendered DOM, before → after: `field-idea` `""` → `A weekly publishing rhythm beats a burst of posts`** — the control the screen DRAWS now holds the value. The answer above the box reads `Placed in the fields on your screen. Nothing was submitted — press the button when ready.` The run stayed `pending_approval`, the gate row is untouched, `input_params` stayed `{}`, and `Continue` was never pressed. The window's own sentence reads `Ask Cinatra to fill the fields above, or ask about this step…`. | **PASS** on both clauses. This is the reading that FAILED at `35548b3c`. |
| [`run-page__fill-no-submit__dark.png`](run-page__fill-no-submit__dark.png) | As above, dark theme, through the app's own theme control. | The same filled `Idea`, the same answer, the same untouched `Continue` on the dark ground. | **PASS**. |
| [`run-page__question-no-press__light.png`](run-page__question-no-press__light.png) | §X: "**A question about the step is answered as a question and touches no field.**" | The person typed `what is this field for?`. The answer names the step's own input and explains it, and says in so many words that it "does **not** submit or publish anything by itself". DOM readback: `field-idea` `A weekly publishing rhythm beats a burst of posts` → unchanged — **no field changed**. Run `pending_approval` → `pending_approval`; no fill row was written for that message; no gate row created. | **PASS**. |
| [`run-page__question-no-press__dark.png`](run-page__question-no-press__dark.png) | As above, dark theme. | The same answer and the same untouched field on the dark ground. | **PASS**. |
| [`run-page__submit-on-ask__light.png`](run-page__submit-on-ask__light.png) | §X: "nothing is submitted until they press the screen's own button, **unless the same message plainly asks for it to be submitted**".<br>`app-lifecycle-cards.html` §X: "**Filling the fields in front of the reader is not a press, so one message may fill and then press**"; "the card takes the loading state of §IV until the act comes back, then **settles in place in its own settled reading**"; "The answer in the turn reports what came back and adds nothing". | The person typed `set the idea to "Why cadence beats bursts for blog reach" and send it`. The run's store holds **two** rows for that one message — a fill, then `Submitted.` The run moved `pending_approval` → `pending_trigger`, and **what was sent is the person's own words**: `agent_runs.input_params` = `{"idea": {"title": "Why cadence beats bursts for blog reach"}}`. The card settled in place: the frame is the run's own next reading — breadcrumb `Schedule`, the rail `1 Schedule` · `2 Recommendation` · `3 Review`, the scheduler form drawn, the window's sentence now `Ask Cinatra to set the schedule above, or ask about it…`. The assistant's line is `Submitted.` and adds nothing. | **PASS**. One message filled and then pressed, through the screen's own server action. |
| [`run-page__submit-on-ask__dark.png`](run-page__submit-on-ask__dark.png) | As above, dark theme. | The same resumed run and the same settled reading on the dark ground. | **PASS**. |
| [`schedule__fill-no-submit__light.png`](schedule__fill-no-submit__light.png) | §X, the schedule screen's own reading: "Ask Cinatra to set the schedule above, or ask about it… **Fills the scheduler form's own rows — when the run starts, its time, its timezone** — whether the schedule is being set for the first time or changed once it stands. The person presses the form's own button, unless the same message plainly asks for it to be submitted." | The unarmed scheduler form of `pending_trigger` run `a5613ebb` (`When should this run?` · `Run right after setup` · `Schedule for later` · `Recurring`). The person typed `set it for tomorrow at 9 in the morning, Berlin time`. **Measured, before → after: `scheduledAt` `""` → `2026-08-28T09:00`**; in the frame `Schedule for later` is the SELECTED row, `Run at` reads `08/28/2026, 09:00 AM` with `Friday` beneath it and `Timezone` reads `Europe/Berlin`. **Nothing was submitted**: the run stayed `pending_trigger` and `cinatra.agent_run_triggers` held **no row** for it. The window's sentence reads `Ask Cinatra to set the schedule above, or ask about it…`. | **PASS**. This is the reading that FAILED at `35548b3c`, where the window was offered the setup gate's schema and answered that it could not schedule the run at all. |
| [`schedule__fill-no-submit__dark.png`](schedule__fill-no-submit__dark.png) | As above, dark theme. | The same three filled rows and the same unpressed form on the dark ground. | **PASS**. |
| [`armed-trigger__fill__light.png`](armed-trigger__fill__light.png) | §X, the armed-trigger tab's own reading: "Ask Cinatra to change this schedule, or ask about it… **Changes the schedule that stands** — until a one-off fires, and for a recurring schedule's future runs — through the tab's own controls. The schedule on screen is what is true." | The run's own `Schedule` tab on an **armed** run: the person set `Run at` to `08/29/2026, 09:00 AM` with `Timezone` `Europe/Berlin` and pressed the form's own button; the trigger row reads `trigger_type=scheduled`, `scheduled_at=2026-08-29T07:00:00Z`, `timezone=Europe/Berlin`, `released_at=NULL`, and `agent_runs.status` is `armed`. The tab draws that schedule and the window beneath it carries its own sentence, `Ask Cinatra to change this schedule, or ask about it…`, word for word. **No fill was attempted, and none is claimed.** | **RECORDED DEVIATION, not a pass.** The code fact: `src/lib/lifecycle/run-window-turn.ts:216` (`boundScreenClaimForSurface`) says in so many words that "The ARMED-trigger tab is deliberately among them and unchanged: the armed form is cinatra#2788's and is not built here" — the tab names the RUN, and an armed run has no waiting screen for a fill to land on. Deviation 1 of the pull request. |
| [`armed-trigger__fill__dark.png`](armed-trigger__fill__dark.png) | As above, dark theme. | The same armed schedule and the same sentence on the dark ground. | **RECORDED DEVIATION**, as above. |
| [`review__question__light.png`](review__question__light.png) | §X, the review page's own reading: "Ask Cinatra about this review, or ask for changes to the work… Places an explicit request for changes by the card's own comment machinery, word for word; the gate resolves changes-requested and a repair goes in flight (§VI). **A question is answered and files nothing.**"<br>§VI: "The decision floor is unchanged: approve, reject, comment." | A real review gate on real artifact-bound output — run `aced3514`, gate `40533412`, target `Why Weekly Publishing Beats a Burst of Posts` (`@cinatra-ai/blog-post-artifact:post`, revision `079eae33-9ae…`, `text/markdown`), `Review requested` · `Awaiting your decision`, with `RENDERED` and `RAW SOURCE` side by side. The person typed `what changed in this draft?`. The answer compares the two revisions by their own timestamps and sizes and closes with "The review gate is still pending. You can **Approve** or **Reject** with the review bar, or type requested edits here to send it back for repair." **Readback after the turn**: the gate is still `pending` with `disposition` NULL; `cinatra.artifact_review_dispositions` holds **0** rows for the run; `cinatra.lifecycle_repair` holds **0** rows; the decision bar reads `["Comment","Reject","Approve"]` before and after, and the rationale field is empty both times. **Nothing was filed.** | **PASS**. |
| [`review__question__dark.png`](review__question__dark.png) | As above, dark theme. | The same answer, the same pending gate and the same untouched decision bar on the dark ground. | **PASS**. |
| [`review__request-changes__light.png`](review__request-changes__light.png) | §VI: "Typing a change request into it is how a reviewer requests changes; there is no dedicated "request changes" button. On submit, **the gate resolves changes-requested and a repair goes in flight** — the run takes the reviewer's note and works the target again — and the corrected version returns as a fresh review in the same run: a new review gate entry on the rail, beneath the one just resolved."<br>§X: "an explicit request for changes is placed by the card's own comment machinery, **word for word**". | The person typed `tighten the opening paragraph`. **Readback, word for word**: `cinatra.lifecycle_repair` holds one row with `findings` = `[{"id": "prompt-window", "message": "tighten the opening paragraph"}]` — the comment text EQUALS the typed text, character for character — `status=dispatched`, `attempt=1`, `route=producer_repair`. The gate moved `pending` → `resolved` with `disposition=changes_requested`, `resolved_at=2026-08-28T00:27:23.082771Z`. The card settled into its own resolved reading, which the frame carries: **`Changes requested by Rita Owner` · "The gate is resolved and the reviewed work has been turned back for repair."**, the `Awaiting your decision` badge and the decision bar gone with it. The repair went in flight as its own run — the app's log: `[human-gate-park] run=lifecycle-repair-run:f312794a-… parked on setup field 'idea'` — carrying the person's words in its own `input_params.lifecycleRepairRequest.findings`. | **PASS** on the three clauses this slice owns: filed word for word through the card's own machinery, the gate resolved changes-requested, and a repair in flight. **The fresh review beneath the resolved one is NOT reached** — see below; it is recorded, not simulated. |
| [`review__request-changes__dark.png`](review__request-changes__dark.png) | As above, dark theme. | The same resolved reading and the same turned-back message on the dark ground. | **PASS** / **NOT REACHED** as above. |
| [`step-by-step__fill-no-submit__light.png`](step-by-step__fill-no-submit__light.png) | §X, the step-by-step reading: "Ask Cinatra to fill this step's fields, or ask about the run… The same filling, one step of a sequence: **the values land in the fields in view and the person presses the step's button.**" | The five-step rail with `1 Campaign setup` selected and `2 Account scope` · `3 Review recipients` · `4 Review drafts` · `5 Test & send` beneath it; that step's form and `Save & start run`. The person typed `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is`. **Measured, before → after**: `field-offeringCompanyWebsite` `""` → `https://example.test`; `callToAction` `""` → `Book a 20-minute demo`; `field-senderName` `""` → `""`, left exactly as the message asked. The run stayed `pending_approval`, the gate's stored values stayed `{"stepNumber": 1}`, `input_params` stayed `{}` — **nothing was submitted and no button was pressed**. | **PASS** on every clause. |
| [`step-by-step__fill-no-submit__dark.png`](step-by-step__fill-no-submit__dark.png) | As above, dark theme. | The same rail, the same two filled fields, the same untouched `Sender name` and button on the dark ground. | **PASS**. |
| [`step-by-step__attachment-reaches-run__light.png`](step-by-step__attachment-reaches-run__light.png) | The plan: "A file attached beside your message travels with your answer to the waiting agent exactly as it does today. The new road must not swallow it into an ordinary chat message, and **must not leave it behind when the answer is finally sent**."<br>§X: "unless the same message plainly asks for it to be submitted". | A file was attached through the window's own paperclip (the app's own upload answered `201`) and the person typed `set the sender name to "Rita Owner" and send it`. The person's own window row carries the attachment — `filename campaign-brief.txt`, `mime text/plain`, `size 133`, `digest 576038005379a871…`; the same message's fill row carries `{"senderName":"Rita Owner"}` and the next row says `Submitted.` **What actually reached the waiting agent** is the resumed task's own history, in the app's log: `{"text":"{\"stepNumber\":1,\"senderName\":\"Rita Owner\"}","attachments":[{…"digest":"576038005379a871…","mime":"text/plain","title":"campaign-brief.txt"…}]}` — the screen's own values with this message's fill over them, and the file with them. The run advanced: a second gate row with `{"stepNumber": 2}` materialized at `00:50:14Z`, and the picture shows step 2's surface with `Campaign setup` checked. | **PASS**: the file reached the waiting run and was not left behind when the answer was sent. |
| [`step-by-step__attachment-reaches-run__dark.png`](step-by-step__attachment-reaches-run__dark.png) | As above, dark theme. | The same advanced run and the same exchange on the dark ground. | **PASS**. |
| [`step-by-step__draft-survives-reload__light.png`](step-by-step__draft-survives-reload__light.png) | §IX: "What survives a reload is therefore both — **the turns above the field and the reader's unsent draft in it**." | `please set the call to action to` was typed into the window and **not sent**; the page was reloaded in the browser; the half sentence is still in the field. The field's own persistence key is `cinatra_hitl_assist_<templateId>_@cinatra-ai/email-outreach-agent:setup-form`, read out of the browser's own storage before the reload and matched after it. Nothing was sent, and the run's store gained no row. | **PASS** on the draft half. The turns half is shown by the fill and attachment captures, whose exchange stands above the field. |
| [`step-by-step__draft-survives-reload__dark.png`](step-by-step__draft-survives-reload__dark.png) | As above, dark theme. | The same half sentence in the field after the same reload, on the dark ground. | **PASS**. |

## The one clause this leg could NOT reach, and exactly why

**The corrected version returning as a fresh review beneath the resolved one (§VI) did not happen while
this leg was open.** Not softened and not simulated. What is true, measured:

1. the repair is real and in flight — `cinatra.lifecycle_repair` row `f312794a`, `status=dispatched`,
   `route=producer_repair`, carrying `findings=[{"id":"prompt-window","message":"tighten the opening paragraph"}]`;
2. it created its own run, `lifecycle-repair-run:f312794a-…`, whose `input_params` carry the whole
   `lifecycleRepairRequest` including the person's words;
3. that run PARKED instead of working — the app's own log line is
   `[human-gate-park] run=lifecycle-repair-run:f312794a-… parked on setup field 'idea'`, and the run row
   reads `status=pending_approval` with a HITL gate whose `field_name` is `idea` and whose stored values
   are the repair request itself;
4. the parked run has **no page to answer it on**: `/agents/cinatra-ai/blog-draft-writer-agent/<that run id>`
   renders the app's own `404 — Page not found` (the run id carries the `lifecycle-repair-run:` prefix).

So the person cannot carry the repair forward from the product, and no successor gate was minted
(`lifecycle_repair.successor_gate_id` is NULL after ten minutes of waiting). This is a run-lifecycle
observation about the repair route, not about the road this slice builds: everything between the typed
sentence and the dispatched repair is measured above and holds.

## Two observations recorded on the same footing

- **The producer runs of this leg end `failed` even though their output is real.** Both blog-draft runs
  reached artifact-bound output and had review gates minted over it (`b3f16977`, `40533412`), and both
  run rows read `status=failed`, `error=WayFlow task failed`. One of the two has a named cause in the
  app's own log: the FIRST call to `/api/llm-bridge` on a cold development server compiled the route for
  75 s, and inside that window the provider's hosted connector could not fetch the instance's tool list
  over the public origin — `The AI provider could not reach this instance's public MCP server … (HTTP 424
  Failed Dependency), so the agent run was stopped.` Warming that route before the run removed the 424
  for the rest of the leg (one occurrence in the whole session, against 51 successful provider callbacks).
- **The window's exchange is per run, not per surface.** The armed tab's frame carries the turns typed
  on that run's schedule screen, because §X's five readings are five readings of ONE window and the
  exchange is one per run. It is the drawing's own rule, and it is what the picture shows.

## Reproducing this leg

`drivers/01-lane-setup.mjs` (the people and the instance namespace, through the app's own screens) ·
`drivers/02-join-organization.mjs` (the administrator invites, the person accepts — no membership row
written by hand) · `drivers/08-public-origin.mjs` (the instance's public origin typed into the app's own
development configuration screen and read back off the re-rendered field) ·
`drivers/09-provider-key.mjs` (the provider committed through the app's own `/setup/model` form, driven
from the operator's own machine against that public origin, with the key read from the environment the
vault wrapper provides and never printed, logged or written to disk) ·
`drivers/03-capture-lib.mjs` (the shared machinery: DOM field readback, the app's own theme control, the
full-window shot with the panel re-opened and held at its bottom per §IX, and the one retry, which is
decided by the SERVER'S OWN LOG and never by whether the answer was the one wanted) ·
`drivers/10-start-run.mjs` · `drivers/11-ingress-probe.mjs` (the disclosed warm turn, on the chat page and
never on a run whose window is photographed) · `drivers/04-run-page-cells.mjs` ·
`drivers/05-step-by-step-cells.mjs` · `drivers/06-surface-cells.mjs` ·
`drivers/12-drive-run-to-review.mjs` (the person's own presses, which is how the review run was produced) ·
`drivers/13-review-cells.mjs` · `drivers/14-carry-repair-forward.mjs` · `drivers/15-armed-trigger-tab.mjs` ·
`drivers/07-start-run-for-review.mjs` (kept from the previous leg).

The readbacks these produced are beside them: `run-page-readback.json`, `schedule-readback.json`,
`step-by-step-readback.json`, `review-readback.json`, `armed-trigger-readback.json`,
`drive-run-readback.json`, `start-runA2.json`, `start-runC.json`, and `timeline.jsonl` — the driver's own
clock, line by line.

See [`TIMELINE.md`](TIMELINE.md), [`RUN-READBACK.md`](RUN-READBACK.md) and
[`capture-records.md`](capture-records.md).
