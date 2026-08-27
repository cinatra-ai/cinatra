# `evidence/2934-w5c-fill-and-review-road/` — the picture leg of cinatra#2934 (pull request 2998)

Taken at head `a85b2bbaaeb51b3bea4f5dc16f9fdd65bda22e94`, on the real running app, signed in as **a run
owner who is not a platform administrator** (`Rita Owner`, `role=user`, organization `member`). A real
provider answered every turn through the real public MCP toolbox; the scripted provider is set in
nothing this leg started and the app server's own log carries **zero** scripted-runtime lines. No stub,
no seeded transcript, no edited pixel, no direct-SQL write of a run, a gate, a park, a record or a
review task. Full window, 1440x900 at device scale 2, uncropped, **light and dark**, switched through
the app's own theme control. Every capture was viewed before it was recorded.

Graded against the ratified drawing at the contract's pin `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`
— `app-artifact-review.html` §VI, §IX and §X, and `app-lifecycle-cards.html` §X. Those sections were
rendered in the capture browser and their sentences copied into the **requires** column verbatim,
character for character.

## What this leg found, in one paragraph

The fill road works, and it works exactly as the plan describes it — **on a screen whose gate schema
names the fields the person can see**. On the step-by-step screen the described values landed in the
step's own fields, the step's own button was untouched and nothing was submitted; a message that asked
in so many words filled and submitted through the same road, carrying the file attached beside it into
the gate's own resume. Three things do NOT hold, and the pictures say so rather than the prose: on the
**run page** the assistant reports "Placed in the fields on the person's screen" while the field in
view stays empty; on the **schedule screen** the window is offered the wrong screen's fields and
answers that it cannot set the schedule at all; and after a reload the **first** turn re-applies a fill
the person sent in an earlier message. Three cells could not be reached at all on this host, and the
reason is one flapping ingress, recorded below rather than worked around.

## The graded table

| capture | requires (verbatim from the drawing) | shows (measured) | verdict |
|---|---|---|---|
| [`run-page__fill-no-submit__light.png`](run-page__fill-no-submit__light.png) | §X, the run page's own reading: "Ask Cinatra to fill the fields above, or ask about this step… **Fills the fields the step is waiting for with what was asked for.** Nothing is submitted until the person presses the step's own button — unless the same message asks for it in so many words."<br>§X, the rule for every surface with a form: "The window fills **the fields the person can see** with what they asked for, and nothing is submitted until they press the screen's own button". | The setup gate of a `pending_approval` run (`Agentic Run Progress` · `Awaiting input` · `Idea (optional)` · a live `Continue`). The person typed `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is`. The assistant answered **"Placed in the fields on the person's screen. Nothing was submitted — they press the button."** and the run's store holds the fill row for that message with `values: {"title":"A weekly publishing rhythm beats a burst of posts"}`. **The `Idea` field is still empty in the picture** — DOM readback `field-idea` `""` → `""`, no field changed. Run `pending_approval` → `pending_approval`; the gate row is untouched; the assistant pressed nothing. | **FAIL** on "fills the fields the person can see". **PASS** on "nothing is submitted". The defect and its code fact are stated below. |
| [`run-page__fill-no-submit__dark.png`](run-page__fill-no-submit__dark.png) | As above, dark theme, through the app's own theme control. | The same empty field, the same answer, the same untouched button on the dark ground. | **FAIL** / **PASS** as above. |
| [`run-page__question-no-press__light.png`](run-page__question-no-press__light.png) | §X: "**A question about the step is answered as a question and touches no field.**" | The person typed `what is this field for?`. The answer names the step's own inputs and explains them. DOM readback: `field-idea` `""` → `""` — **no field changed**. Run `pending_approval` → `pending_approval`; no gate row created; no fill row written for that message. | **PASS**. |
| [`run-page__question-no-press__dark.png`](run-page__question-no-press__dark.png) | As above, dark theme. | The same answer and the same untouched field on the dark ground. | **PASS**. |
| [`run-page__submit-on-ask__light.png`](run-page__submit-on-ask__light.png) | §X: "nothing is submitted until they press the screen's own button, **unless the same message plainly asks for it to be submitted**".<br>`app-lifecycle-cards.html` §X: "**Filling the fields in front of the reader is not a press, so one message may fill and then press**"; "The answer in the turn reports what came back and adds nothing". | The person typed `set the idea to "Why cadence beats bursts for blog reach" and send it`. The run's store holds **two** rows for that one message: a fill with `values: {"title":"Why cadence beats bursts for blog reach"}` and then `Submitted.` The run moved on — `pending_approval` → `pending_trigger` — and the screen re-read itself: the form in the picture is the scheduler's (`Run at`), not the setup gate's. The assistant's line is `Submitted.` and adds nothing. | **PASS**. One message filled and then pressed, through the screen's own server action. |
| [`run-page__submit-on-ask__dark.png`](run-page__submit-on-ask__dark.png) | As above, dark theme. | The same resumed run and the same re-read screen on the dark ground. | **PASS**. |
| [`step-by-step__fill-no-submit__light.png`](step-by-step__fill-no-submit__light.png) | §X, the step-by-step reading: "Ask Cinatra to fill this step's fields, or ask about the run… The same filling, one step of a sequence: **the values land in the fields in view and the person presses the step's button.**"<br>The run-surface drawing §I — a two-column frame: a step rail naming the run's ordered steps, the selected step's surface in the run detail, the window under it. | The five-step rail with `1 Campaign setup` selected and `2 Account scope` · `3 Review recipients` · `4 Review drafts` · `5 Test & send` beneath it; that step's form and `Save & start run`. The person typed `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is`. **Measured, before → after**: `offeringCompanyWebsite` `""` → `https://example.test`; `callToAction` `""` → `Book a 20-minute demo`; `senderName` `""` → `""` (left as asked). The run stayed `pending_approval`, the gate's stored values stayed `{"stepNumber": 1}`, the run's `input_params` stayed `{}` — **nothing was submitted, and the assistant pressed no button**. The field beneath reads `Ask Cinatra to fill this step's fields, or ask about the run…`. | **PASS** on every clause. |
| [`step-by-step__fill-no-submit__dark.png`](step-by-step__fill-no-submit__dark.png) | As above, dark theme. | The same rail, the same two filled fields, the same untouched `Sender name` and the same untouched button on the dark ground. | **PASS**. |
| [`step-by-step__draft-survives-reload__light.png`](step-by-step__draft-survives-reload__light.png) | §IX: "What survives a reload is therefore both — **the turns above the field and the reader's unsent draft in it**." | `please set the call to action to` was typed into the window and **not sent**; the page was reloaded in the browser; the half sentence is still in the field. The field's own persistence key is `cinatra_hitl_assist_<templateId>_@cinatra-ai/email-outreach-agent:setup-form`, read out of the browser's storage before the reload and matched after it. Nothing was sent, and the run's store gained no row. | **PASS** on the draft half. The turns half is shown by the fill and attachment captures, whose exchange stands above the field after their own reloads. |
| [`step-by-step__draft-survives-reload__dark.png`](step-by-step__draft-survives-reload__dark.png) | As above, dark theme. | The same half sentence in the field after the same reload, on the dark ground. | **PASS**. |
| [`step-by-step__attachment-reaches-run__light.png`](step-by-step__attachment-reaches-run__light.png) | The plan: "A file attached beside your message travels with your answer to the waiting agent exactly as it does today. The new road must not swallow it into an ordinary chat message, and **must not leave it behind when the answer is finally sent**."<br>§X: "unless the same message plainly asks for it to be submitted". | A file was attached through the window's own paperclip (the app's own upload answered `201`) and the person typed `set the sender name to "Rita Owner" and send it`. The person's own window row carries the attachment — `filename campaign-brief.txt`, `mime text/plain`, `size 130`, `digest fc229281…`. The same message's fill row carries `{"senderName":"Rita Owner"}` and the next row says `Submitted.` **The app's own runtime log shows what actually went to the waiting agent**: the resumed task's last history entry is `{"text":"{\"stepNumber\":1,\"senderName\":\"Rita Owner\"}","attachments":[{…campaign-brief.txt…, size 130, digest fc229281…}]}`. The run advanced — a new gate row `@cinatra-ai/email-outreach-agent:list-picker` at `stepNumber 2` materialized at `18:52:40Z` — and the picture shows step 2's surface. | **PASS**: the file reached the waiting run and was not left behind when the answer was sent, and the values sent were the screen's own with this message's fill over them. |
| [`step-by-step__attachment-reaches-run__dark.png`](step-by-step__attachment-reaches-run__dark.png) | As above, dark theme. | The same advanced run and the same exchange on the dark ground. | **PASS**. |
| [`schedule__fill-no-submit__light.png`](schedule__fill-no-submit__light.png) | §X, the schedule screen's own reading: "Ask Cinatra to set the schedule above, or ask about it… **Fills the scheduler form's own rows — when the run starts, its time, its timezone** — whether the schedule is being set for the first time or changed once it stands. The person presses the form's own button, unless the same message plainly asks for it to be submitted." | The scheduler form of a `pending_trigger` run (`When should this run?` · `Run right after setup` · `Schedule for later` · `Run at` · `Timezone`). The person typed `schedule this for later — tomorrow at 09:00 in the Europe/Berlin timezone`. The turn was served **with** its toolbox and the instance's public origin was answering. The answer: **"This screen can't schedule the run. It only has these fields: title / summary / outline. Use the schedule controls on the run screen to set August 28, 2026 at 09:00 Europe/Berlin."** DOM readback: `scheduledAt` `""` → `""` — **no scheduler row changed**; no fill row was written. | **FAIL** on "fills the scheduler form's own rows". **PASS**, trivially, on "nothing is submitted". The code fact is stated below. |
| [`schedule__fill-no-submit__dark.png`](schedule__fill-no-submit__dark.png) | As above, dark theme. | The same refusal and the same untouched scheduler rows on the dark ground. | **FAIL** / **PASS** as above. |

## The three defects, each with the code fact that makes it one

**1. On the run page the fill is recorded and reported, and never reaches the field in view.**
The fill's closed set is read from the interrupt's own JSON-Schema `properties`
(`src/lib/lifecycle/bound-screen-fill.ts` — "The screen's own field names, read out of the form schema
it published"). For this gate the stored `agent_run_hitl_gates.input_schema` is
`{"type":"object","title":"idea","properties":{"title":…,"summary":…,"outline":…},"x-object-text-property":"title"}`
— the INNER object of the template's single `idea` property. The screen renders that whole object as
ONE field, `field-idea`, bound through `x-object-text-property`. So the fill legitimately places
`title`, `packages/agents/src/agentic-run-panel.tsx:517` merges `{title: …}` into `bufferedHitlValue`,
and the screen has no field of that name to paint. The person is told the values were placed on their
screen while their screen shows nothing. The SUBMIT road is unaffected — the server consumes the same
inner shape, which is why `submit-on-ask` moves the run on with the value the person asked for.

**2. On the schedule screen the window is offered the wrong screen's fields.** The bound screen for a
`pending_trigger` run is still the run's HITL gate row, whose schema is the setup step's
(`title`/`summary`/`outline`) — the surface in view is the scheduler form, whose rows are `Run at` and
`Timezone` and are not in that schema at all. The model answered truthfully from what it was given:
"This screen can't schedule the run. It only has these fields". The drawing's schedule reading is not
satisfied by this slice. The pull request's Deviation 1 names the ARMED schedule's form as owed
elsewhere; this is the **unarmed** scheduler form, which §X and the plan's §6 sentence both name.

**3. After a reload, the first turn re-applies a fill from an earlier message.**
`packages/agents/src/use-run-window-conversation.ts:76` seeds `fillCountRef` at `0` on mount, and the
load effect that fills `entries` from the store never seeds it from the fills the run already holds. Its
own rule at `:150` — "Only a fill this turn ADDED is applied. A screen re-reading the run must not
re-apply a fill the person has since edited away" — is therefore false for the first turn after any
page load: `fills.length > 0` holds, and the run's most recent stored fill is written into the fields.
**Measured**: on a freshly loaded step-by-step screen the three fields read `""` before the turn; the
turn placed **no** fill (its rows carry none); after it the fields read `https://example.test` and
`Book a 20-minute demo` — the values of a fill sent in an earlier message.

## One recorded observation, not a clause

The window's bubbles render the model's answer as raw markdown — pipe tables and `**bold**` appear
literally in the exchange (visible in `run-page__question-no-press__*`). The drawing's §IX fixes the
turns' shape, not their formatting, and no clause of this slice is about it. Recorded, not graded.

Two more, on the same footing: the answer on the run page names the step's inputs as `title`,
`summary` and `outline` while the screen labels the single field `Idea` — the same nesting that causes
defect 1; and a message that attaches a file and asks the assistant to READ it is answered "I don't
have access to any attached file in this prompt window" even though the file is on the person's own
row. The plan's clause is that the file reaches the waiting run, which it does; whether the model may
read it is not a sentence this slice owns.

## The three cells this leg could NOT reach, and exactly why

Not softened, not simulated, and not photographed from anything but a real run:

- **the armed-trigger tab** (a described change landing in the tab's own controls),
- **the review page, a typed question answered and nothing filed**,
- **the review page, a typed request for changes filed through the card's own Comment control, the gate
  resolving changes-requested, the repair in flight and the fresh review beneath the resolved one**.

All three need a run that has actually executed — an armed schedule that stands, and artifact-bound
output that opens a review gate. Every attempt was stopped by the same thing: **the instance's own
public origin flaps on this host**. The app is explicit about the consequence in its own words. When
the ingress is slow the runtime refuses the turn outright —
`[assistant-runtime] public MCP URL … is unreachable (no response within 2500ms) — refusing to run the
turn without Cinatra tools (#1699)`, **9 times** in this session. When it is slow at the moment the
agent itself calls back, the run is stopped — the WayFlow task ended with
`RuntimeError: error executing POST request to …/api/llm-bridge: 500, {"error":"Internal server error","detail":"The AI provider could not reach this instance's public MCP server … (HTTP 424 Failed Dependency), so the agent run was stopped."}`
and the run row reads `status=failed`, `error=WayFlow task failed`. Measured directly against that
origin during this leg: three consecutive requests answered `000` after a 12 s timeout, then `200` a
minute later, then `000` again for 30 s at a stretch. The funnel was left exactly as it was found — it
is not this lane's to change.

`cinatra.artifact_review_gates` therefore holds **0** rows on this instance, and there is no review
page to photograph. The two review fixtures and the armed-trigger reading remain **owed**.

## Reproducing this leg

`drivers/01-lane-setup.mjs` (the people and the instance namespace, through the app's own screens) ·
`drivers/02-join-organization.mjs` (the administrator invites, the person accepts — no membership row
written by hand) · `drivers/03-capture-lib.mjs` (the shared machinery: DOM field readback, the app's
own theme control, the full-window shot, and the one retry, which is decided by the SERVER'S OWN LOG
and never by whether the answer was the one wanted) · `drivers/04-run-page-cells.mjs` ·
`drivers/05-step-by-step-cells.mjs` · `drivers/06-surface-cells.mjs` · `drivers/07-start-run-for-review.mjs`
(the person's own press, which is how the review run was attempted).

The readbacks these produced are beside them: `run-page-readback.json`,
`step-by-step-readback.json`, `step-by-step-attachment-readback.json`,
`step-by-step-attachment-send-readback.json`, `schedule-readback.json`
and `timeline.jsonl` — the driver's own clock, line by line.

See [`TIMELINE.md`](TIMELINE.md), [`RUN-READBACK.md`](RUN-READBACK.md) and
[`capture-records.md`](capture-records.md).
