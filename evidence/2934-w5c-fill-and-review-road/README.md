# `evidence/2934-w5c-fill-and-review-road/` — the picture leg of cinatra#2934 (pull request 2998)

Re-taken **at the repaired head**, after the graded review of the previous leg found two defects in
the pictures themselves. On the real running app, signed in as **a run owner who is not a platform
administrator** (`Rita Owner`, `owner@example.com`, organization `member`). A real provider answered
every turn through the real public MCP toolbox over the instance's own public origin; the scripted
provider is set in nothing this leg started and the app server's own log carries **zero**
scripted-runtime lines. No stub, no seeded transcript, no edited pixel, and **no direct-SQL write of a
run, a gate, a park, a record or a review task** — every statement this leg made against the database
is a `select`. Full window, 1440x900 at device scale 2, uncropped, **light and dark**, switched
through the app's own theme control. Every capture was viewed before it was recorded.

Graded against the ratified drawing at the contract's pin `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`
— `app-artifact-review.html` §VI, §IX and §X, and `app-lifecycle-cards.html` §X. Those sections were
read at that pin and their sentences copied into the **requires** column verbatim, character for
character.

**The whole leg is re-taken. Nothing is carried.** The head this leg photographs repairs the two
defects the pictures exposed, and both repairs change what a window DRAWS — the assistant's line is
now rendered rather than printed, and the platform's fill sentence is worded differently — so every
predecessor capture is REPLACED rather than kept. Every run in this leg is new; the run ids below are
the ones in the frames.

## What the graded review asked for, and what these pictures answer

| the review's point | what this leg did |
|---|---|
| **A** — the window printed the assistant's markdown raw in four cells | Fixed at the source: the window draws the assistant's line with the renderer /chat draws it with. Every re-shot cell carries a DOM readback of the assistant's own bubble — the count of `<strong>` elements, of `<table>` elements, and of raw `**` and `\|` characters left in the text. |
| **B** — the platform's fill sentence spoke of the person in the third person | Fixed at the source. The sentence now reads `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` and is visible verbatim in the run-page, schedule and step-by-step cells. |
| **C** — the account footer was blank in one run's pictures | Grounded, and the frames are fixed. See *Three observations, grounded* below. Every capture in this leg records the footer text it was taken with; all twenty read `Rita Owner` + `owner@example.com`. |
| **D** — does the window draw an attached file beside the message? | Grounded: **it does not**, and that is a code fact, not an omission in the frame. See below. The readback stays the proof, as the review said it would have to. |
| **E** — does the panel-over-decision-bar treatment match the drawing? | Grounded against the drawing itself, rendered at the pin, and **measured in pixels**. It does not match. Recorded as a finding, not patched here. |

## The graded table

| capture | requires (verbatim from the drawing) | shows (measured) | verdict |
|---|---|---|---|
| [`run-page__fill-no-submit__light.png`](run-page__fill-no-submit__light.png) | §X, the run page's own reading: "Ask Cinatra to fill the fields above, or ask about this step… **Fills the fields the step is waiting for with what was asked for.** Nothing is submitted until the person presses the step's own button — unless the same message asks for it in so many words."<br>§X, the rule for every surface with a form: "The window fills **the fields the person can see** with what they asked for, and nothing is submitted until they press the screen's own button". | The setup gate of run `3fa04248` (`Agentic Run Progress` · `Awaiting input` · `Idea (optional)` · a live `Continue`). The person typed `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is`. **Measured off the rendered DOM, before → after: `field-idea` `""` → `A weekly publishing rhythm beats a burst of posts`** — the control the screen DRAWS holds the value. The answer above the box is the platform's own sentence, word for word: `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` Run `pending_approval` → `pending_approval`; `input_params` `{}`; `Continue` never pressed. The window's sentence reads `Ask Cinatra to fill the fields above, or ask about this step…`. Turn served on attempt 1, toolbox present. | **PASS** on both clauses, and the sentence is B's repair. |
| [`run-page__fill-no-submit__dark.png`](run-page__fill-no-submit__dark.png) | As above, dark theme, through the app's own theme control. | The same filled `Idea`, the same sentence, the same untouched `Continue` on the dark ground; account footer drawn. | **PASS**. |
| [`run-page__question-no-press__light.png`](run-page__question-no-press__light.png) | §X: "**A question about the step is answered as a question and touches no field.**" | Run `512836b7`. The person typed `what is this field for?`. **The answer is DRAWN, not printed** — DOM readback of the assistant's own bubble: `strong=1`, `raw ** = 0`, `raw \| = 0`; the word `idea` is a `<strong>` element and the quoted idea is a `<blockquote>`. This is the reading that FAILED the graded review. DOM readback of the form: `field-idea` unchanged — **no field changed**. Run `pending_approval` → `pending_approval`; no fill row for that message; no new gate row. Turn served on attempt 1. | **PASS**, and A's repair is visible in it. |
| [`run-page__question-no-press__dark.png`](run-page__question-no-press__dark.png) | As above, dark theme. | The same drawn answer (`strong=1`, `raw ** = 0`) and the same untouched field on the dark ground. | **PASS**. |
| [`run-page__submit-on-ask__light.png`](run-page__submit-on-ask__light.png) | §X: "nothing is submitted until they press the screen's own button, **unless the same message plainly asks for it to be submitted**".<br>`app-lifecycle-cards.html` §X: "**Filling the fields in front of the reader is not a press, so one message may fill and then press**"; the card "takes the loading state of §IV until the act comes back, then **settles in place in its own settled reading**"; "The answer in the turn reports what came back and adds nothing." | Run `ac70cd70`. The person typed `set the idea to "Why cadence beats bursts for blog reach" and send it`. The run's store holds **two** rows for that one message — a fill, then `Submitted.` The run moved `pending_approval` → `pending_trigger`, and what was sent is the person's own words: `agent_runs.input_params` = `{"idea": {"title": "Why cadence beats bursts for blog reach"}}`. The card settled in place: the frame is the run's own next reading — the scheduler form drawn, the window's sentence now `Ask Cinatra to set the schedule above, or ask about it…`. The assistant's line is `Submitted.` and adds nothing. | **PASS**. One message filled and then pressed, through the screen's own server action. |
| [`run-page__submit-on-ask__dark.png`](run-page__submit-on-ask__dark.png) | As above, dark theme. | The same resumed run and the same settled reading on the dark ground. | **PASS**. |
| [`schedule__fill-no-submit__light.png`](schedule__fill-no-submit__light.png) | §X, the schedule screen's own reading: "Ask Cinatra to set the schedule above, or ask about it… **Fills the scheduler form's own rows — when the run starts, its time, its timezone** — whether the schedule is being set for the first time or changed once it stands. The person presses the form's own button, unless the same message plainly asks for it to be submitted." | The unarmed scheduler form of `pending_trigger` run `ac70cd70`. The person typed `set it for tomorrow at 9 in the morning, Berlin time`. **Measured, before → after: `scheduledAt` `""` → `2026-08-29T09:00`**; the frame shows `Schedule for later` selected, `Run at` `08/29/2026, 09:00 AM`, `Timezone` `Europe/Berlin`. **Nothing was submitted**: run still `pending_trigger`, `cinatra.agent_run_triggers` **held no row** for it at that moment. The answer is the platform's own repaired sentence. | **PASS**. **Both siblings show the fill's own ask** — the review's specific complaint about the dark sibling. |
| [`schedule__fill-no-submit__dark.png`](schedule__fill-no-submit__dark.png) | As above, dark theme. | The same three filled rows, the same unpressed form, **and the same exchange in the panel** — the dark frame is no longer scrolled to an earlier one. | **PASS**. |
| [`armed-trigger__fill__light.png`](armed-trigger__fill__light.png) | §X, the armed-trigger tab's own reading: "Ask Cinatra to change this schedule, or ask about it… **Changes the schedule that stands** — until a one-off fires, and for a recurring schedule's future runs — through the tab's own controls. The schedule on screen is what is true." | The run's own `Schedule` tab on an **armed** run: the person set `Run at` `08/29/2026, 09:00 AM` and `Timezone` `Europe/Berlin` and pressed the form's own button; the trigger row reads `trigger_type=scheduled`, `scheduled_at=2026-08-29T07:00:00Z`, `timezone=Europe/Berlin`, `released_at=NULL`, and `agent_runs.status` is `armed`. The tab draws that schedule and the window beneath it carries its own sentence word for word. **No fill was attempted, and none is claimed.** | **RECORDED DEVIATION, not a pass** — unchanged, and the graded review acknowledged it. Code fact: `src/lib/lifecycle/run-window-turn.ts:216` (`boundScreenClaimForSurface`) — "The ARMED-trigger tab is deliberately among them and unchanged: the armed form is cinatra#2788's and is not built here." |
| [`armed-trigger__fill__dark.png`](armed-trigger__fill__dark.png) | As above, dark theme. | The same armed schedule and the same sentence on the dark ground. | **RECORDED DEVIATION**, as above. |
| [`review__question__light.png`](review__question__light.png) | §X, the review page's own reading: "…**A question is answered and files nothing.**"<br>§VI: "The decision floor is unchanged: approve, reject, comment." | A real review gate over real artifact-bound output — run `baa08154`, target `Why Weekly Publishing Beats a Burst of Posts` (`@cinatra-ai/blog-post-artifact:post`, revision `138644ea-99f…`, `text/markdown`), `Review requested` · `Awaiting your decision`, `RENDERED` and `RAW SOURCE` side by side. The person typed `what changed in this draft?`. **The answer is DRAWN**: DOM readback of the assistant's bubble — `strong=6`, `tables=1`, `raw ** = 0`, `raw \| = 0`. The pipe table the graded review photographed as a wall of pipes is a real `<table>` with `Created at` / `Review state` / `Run status` rows. **Readback after the turn**: gate still `pending`, `disposition` NULL; `artifact_review_dispositions` **0 rows**; `lifecycle_repair` **0 rows**; the decision bar reads `["Comment","Reject","Approve"]` before and after and the rationale field is empty both times. **Nothing was filed.** | **PASS**, and this is A's repair on the cell where it was worst. |
| [`review__question__dark.png`](review__question__dark.png) | As above, dark theme. | The same drawn table and bold, the same pending gate, the same untouched decision bar on the dark ground. | **PASS**. |
| [`review__request-changes__light.png`](review__request-changes__light.png) | §VI: "Typing a change request into it is how a reviewer requests changes… On submit, **the gate resolves changes-requested and a repair goes in flight** — the run takes the reviewer's note and works the target again — and the corrected version returns as a fresh review in the same run: a new review gate entry on the rail, beneath the one just resolved."<br>§X: "an explicit request for changes is placed by the card's own comment machinery, **word for word**". | The person typed `tighten the opening paragraph`. **Word for word, from the database**: `cinatra.lifecycle_repair` holds one row whose `findings` are `[{"id": "prompt-window", "message": "tighten the opening paragraph"}]` — the filed text EQUALS the typed text, character for character — `attempt=1`. The gate moved `pending` → `resolved`, `disposition=changes_requested`, `resolved_at=2026-08-28T03:56:22.518980Z`. The decision bar read `["Comment","Reject","Approve"]` before and `[]` after: the card settled into its own resolved reading, which the frame carries. `artifact_review_dispositions` stayed at **0** rows. | **PASS** on the three clauses this slice owns: filed word for word, changes-requested, repair in flight. **NOT REACHED**: the corrected version returning as a fresh review — see below. |
| [`review__request-changes__dark.png`](review__request-changes__dark.png) | As above, dark theme. | The same resolved reading and the same turned-back message on the dark ground. | **PASS** / **NOT REACHED** as above. |
| [`step-by-step__fill-no-submit__light.png`](step-by-step__fill-no-submit__light.png) | §X, the step-by-step reading: "Ask Cinatra to fill this step's fields, or ask about the run… The same filling, one step of a sequence: **the values land in the fields in view and the person presses the step's button.**" | Run `89f947a2`, the five-step rail with `1 Campaign setup` selected. The person typed `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is`. **Measured, before → after**: `field-offeringCompanyWebsite` `""` → `https://example.test`; `callToAction` `""` → `Book a 20-minute demo`; `field-senderName` `""` → `""`, left exactly as the message asked. Run stayed `pending_approval`, the gate's stored values stayed `{"stepNumber": 1}`, `input_params` stayed `{}` — nothing submitted, no button pressed. The answer is the platform's own repaired sentence. | **PASS** on every clause. |
| [`step-by-step__fill-no-submit__dark.png`](step-by-step__fill-no-submit__dark.png) | As above, dark theme. | The same rail, the same two filled fields, the same untouched `Sender name` and button on the dark ground. | **PASS**. |
| [`step-by-step__attachment-reaches-run__light.png`](step-by-step__attachment-reaches-run__light.png) | The plan: "A file attached beside your message travels with your answer to the waiting agent exactly as it does today. The new road must not swallow it into an ordinary chat message, and **must not leave it behind when the answer is finally sent**."<br>§X: "unless the same message plainly asks for it to be submitted". | The window's own paperclip uploaded the file (the app's own upload answered `201`) and the person typed `set the sender name to "Rita Owner" and send it`. The person's own window row carries `campaign-brief.txt`, digest `576038005379a871f562e47022857a40c30371a389a38d872d0accc9a4816d11`; the same message's fill row carries `{"senderName":"Rita Owner"}` and the next row says `Submitted.` The run advanced: a second gate row `{"stepNumber": 2}` materialized at `03:41:25.695801Z`, seconds after the `Submitted.` row at `03:41:27.197Z`. **The window draws no attachment chip beside the message, and by design — see observation D.** | **PASS**: the file reached the waiting run and was not left behind when the answer was sent. The proof is the readback, as the graded review anticipated. |
| [`step-by-step__attachment-reaches-run__dark.png`](step-by-step__attachment-reaches-run__dark.png) | As above, dark theme. | The same advanced run and the same exchange on the dark ground. | **PASS**. |
| [`step-by-step__draft-survives-reload__light.png`](step-by-step__draft-survives-reload__light.png) | §IX: "What survives a reload is therefore both — **the turns above the field and the reader's unsent draft in it**." | `please set the call to action to` was typed and **not sent**; the page was reloaded in the browser; the half sentence is still in the field. The field's own persistence key is `cinatra_hitl_assist_<templateId>_@cinatra-ai/email-outreach-agent:setup-form`, read out of the browser's own storage before the reload and matched after it. The run's store gained no row. | **PASS** on the draft half. The turns half is shown by the fill and attachment captures, whose exchange stands above the field. |
| [`step-by-step__draft-survives-reload__dark.png`](step-by-step__draft-survives-reload__dark.png) | As above, dark theme. | The same half sentence in the field after the same reload, on the dark ground. | **PASS**. |

## Three observations, grounded

### C — the blank account footer, and why it was blank

**Which identity.** The same one as every other frame: `Rita Owner` / `owner@example.com`, the run
owner, a member of the organization and **not** a platform administrator. Nothing about the identity
differed; the graded leg's own capture library signs every cell in as that person.

**Why it did not draw.** The code fact is `src/components/nav-user.tsx:29-37`: the footer reads the
session with `authClient.useSession()` and, while that read is `isPending`, renders `name` as `""`
and `email` as `""` — and the avatar's initials, derived from that empty name, as `""` too. A frame
taken inside that window photographs a person who is not there. It is the app shell's own loading
reading, deliberately quiet rather than a flash of a placeholder name.

**The measurement.** Same run, same page, same identity, two ways of taking the pair:

| how the pair was taken | footer at the shutter | waited |
|---|---|---|
| one page opened on the run, theme toggled in place (the graded leg's way) | blank, both frames | 60 s, never settled |
| one context per theme, themed on the app's own chrome BEFORE the run page opens | `Rita Owner` / `owner@example.com`, both frames | 0 s |

**What was done.** This is not a defect on this road's surfaces — `nav-user.tsx` is the application
shell, not a W5c surface — so it is **recorded as a residual at `src/components/nav-user.tsx:29-37`**
rather than patched here. What WAS fixed is the capture: `drivers/03-capture-lib.mjs` now takes each
theme in its own context and waits for the footer to draw before the shutter, and every capture
records the footer text it was taken with. All twenty frames in this leg read the person.

### D — the window does not draw an attached file beside the message

**The code fact.** The window's entry type carries three fields and no more:
`packages/agents/src/run-window-actions.ts:27-31` — `RunWindowEntry = { id: number; role: "user" |
"assistant"; content: string }` — and `toEntries` at `:65-77` builds those entries from the stored
rows, keeping `role` and `text` and nothing else. The panel renders `entry.content` and nothing else
(`packages/agents/src/hitl-conversation-panel.tsx`). So there is no attachment chip to draw, in
either theme, at this head.

**It is not lost — only undrawn.** The store keeps it: `run-window-conversation-store.ts:144`
declares `RunWindowAttachment`, `:377` reads a message's attachments back, and the person's own
message row for the attachment cell carries `campaign-brief.txt` with digest `576038005379a871…`.

**What was done.** Recorded as a code fact, exactly as the review said it should be if the window does
not draw one; the re-shot attachment cell therefore shows the exchange and the advanced run, and the
readback carries the file. No frame in this leg claims an attachment chip.

### E — the panel over the decision bar does not match the drawing

**What the drawing says**, `app-artifact-review.html` §VI at the pin, rendered with the capture
browser and read off the rendering: "**Beneath the decision bar** the run detail carries a
conversational prompt window". The section draws two SEPARATE stacked examples — *the decision bar*
(its rationale field and `Comment` / `Reject` / `Approve` complete and unobstructed), and beneath it
*the conversational prompt window*. §IX adds that the panel opens above the field and that "the
window itself … nothing about it moves". The drawing never puts the panel over the bar.

**What the app does**, measured on the review page at this head, both themes, identical numbers:

| measured | value |
|---|---|
| decision bar box | top `664`, bottom `794` (height `130` px), left `393`, right `1424` |
| window panel box | top `588`, bottom `822`, left `464`, right `1232` |
| vertical overlap | `130` px — **the bar's entire height** |
| horizontal overlap | `768` px of the bar's `1031` px width |
| `elementFromPoint` at the bar's own centre | an element **inside the panel** |

The window is a sticky element at the foot of the run detail, so the panel grows upward over the bar
rather than standing beneath it.

**What was done.** **MISMATCH, recorded as a finding, not patched here** — the review said a mismatch
is a finding, and the treatment is the review page's layout rather than this slice's fill road.

## The one clause this leg could NOT reach, and exactly why

§VI's "the corrected version returns as a fresh review in the same run" is **NOT REACHED**, and it is
recorded rather than simulated. After the change request the repair went in flight and created its own
run (`lifecycle-repair-run:a9fa4445-…`), which **parked on the producer agent's own setup gate**
(`status=pending_approval`); `lifecycle_repair.successor_gate_id` was still NULL after the wait, and
no second gate appeared on the rail. That is the repair route's behaviour, recorded on cinatra#2951 —
not this road's, which ends at "filed word for word, gate resolved changes-requested, repair in
flight". The graded review acknowledged the same.

## Provider evidence, and its limits

`cinatra.usage_events` on this instance: `openai` `gpt-5.5-2026-04-23` — **27** calls, 69,416 in /
3,827 out; `openai` `gpt-5.5` — **12** calls, 289,685 in / 3,138 out. The instance's own server log
for this leg: **56** `POST /api/mcp 200` callbacks from the provider's own servers over the
instance's public origin · **0** scripted-runtime lines · **0** `NO_LLM_PROVIDER` refusals · **0**
turns refused for a missing toolbox · **0** `424 Failed Dependency` and **0** MCP tool-enumeration
failures. The previous leg's single 424 did not recur: the route was warm before the first driver ran.

**Every pictured turn was served on its FIRST attempt with its toolbox present** — the per-turn
attempt records in the readbacks carry `toolboxMissing: false` and `platformCouldNotAnswer: false` for
attempt 1 in every cell, so the retry road (decided by the server's own log for that turn's own
window, never by whether the answer was the one wanted) was never taken.

**The limit, said rather than implied**: a zero on that list is the absence of that particular line
and nothing more. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this leg started — it is absent from
the instance's env file and unset in every shell that ran a driver — and the capture library refuses
to run at all where it can see it.

## Two observations recorded on the same footing

- **The producer run ends `failed` even though its output is real.** Run `baa08154` reached
  artifact-bound output, a review gate was minted over it, and the run row reads `status=failed`,
  `error=WayFlow task failed`. The review page itself says so in the frame — `Run status: Failed after
  producing the review artifact`. Recorded, not explained away.
- **A message that asks the assistant to READ an attachment is answered, honestly, that it cannot.**
  On a first pass the attachment cell was driven with `fill the brief from the file I attached and
  send it`; the answer was `I found the attached file **campaign-brief.txt**, but I can't read its
  contents from this screen.` — no fill, no submit. That is a true answer about a capability this
  road does not claim, so the cell was re-driven with the message the clause is actually about (a
  fill plus an explicit ask to send, with the file attached), on a fresh run. Both are recorded; the
  pictured one is the second.

## Reproducing this leg

The drivers in [`drivers/`](drivers) are the whole procedure, in order: the people and the instance
namespace through the app's own screens (`01`), the organization through the app's own invite/accept
road (`02`), the shared capture machinery (`03`), the surface cells (`05`, `06`), the run starts (`10`),
the instance's public origin through its own screen (`08`), the provider key through the setup form
(`09`, run from the operator's own machine so no credential is ever placed on the capture host), the
drive to a review gate with the person's own presses (`12`), the review readings (`13`), the armed tab
(`15`), and the pair-taker (`16`).

Two drivers changed for this leg, and both changes are recorded above: `03-capture-lib.mjs` reads the
window's bubbles by their own hook (the assistant's line is drawn markdown now and no longer carries
the class the old reader keyed on), addresses the panel's scroll container directly (which is what
left one dark sibling scrolled to an earlier exchange), and takes each theme in its own context after
waiting for the account footer to draw; `01-lane-setup.mjs` waits for the namespace form's own gate
and readback instead of a stopwatch, and signs in where an account it already created refuses a
second sign-up.
