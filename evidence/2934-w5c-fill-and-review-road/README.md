# `evidence/2934-w5c-fill-and-review-road/` — the picture leg of cinatra#2934 (pull request 2998)

Re-taken after a graded review failed five cells **on the pixels**: the fill cells showed empty fields
under a sentence that said the fields were filled, and one cell was a picture of the platform's
"Not authorized" page. This leg answers that with a measurement, corrects the method, and re-shoots
the five.

On the real running app, signed in as **a run owner who is not a platform administrator**
(`Rita Owner`, `owner@example.com`, organization `member`). A real provider answered every turn
through the real public MCP toolbox over the instance's own public origin; the scripted provider is
set in nothing this leg started. No stub, no seeded transcript, no edited pixel, and **no direct-SQL
write of a run, a gate, a park, a record or a review task** — every statement this leg made against
the database is a `select`. Full window, 1440x900 at device scale 2 (every file 2880x1800),
uncropped, **light and dark**, switched through the app's own theme control. Every capture was viewed
before it was recorded.

Graded against the ratified drawing at the contract's pin `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`
— `app-artifact-review.html` §VI, §IX and §X, and `app-lifecycle-cards.html` §X. Those sections were
read at that pin and their sentences copied into the **requires** column verbatim.

## The leg note: what the previous leg's README claimed, and what its pictures showed

**Said plainly, because it is the review's central complaint.** The previous README recorded, for the
run-page, schedule and step-by-step fill cells, DOM readings such as `field-idea "" → A weekly
publishing rhythm beats a burst of posts` and marked them **PASS** — while the frames filed beside
those readings showed the fields at their placeholders. **Both halves were true of different pages.**
The readings were taken in the context that SENT the turn; the frames were taken in a second context
that never received it. A row that pairs a reading from one page with a picture of another is not
evidence, and those four rows should have read FAIL. They are corrected below.

**The method is corrected, not argued.** Every frame in the re-shot cells is taken **in the same
context that sent the turn**, with the theme chosen through the app's own control in that context
**before** the run page opens, and the field's value read out of the DOM **immediately before and
immediately after the shutter**. A frame is only filed when both reads agree; every re-shot frame's
record carries `domAgreedAcrossTheShutter: true`. Where a turn cannot be sent twice, the cell gets
**one run per theme** — the run ids are in the table.

## The diagnosis, measured on a real run

The question the review asked: was the value written to the store but never applied to the field in
view (a), applied and then lost on a reload or re-render (b), applied only after the frame was taken
(c), or photographed on a page that never received the fill (d)?

**One run, one context, one fill, four readings** — run `d46a8013`, light theme, the same browser
context throughout:

| moment | `field-idea` read off the DOM | frame | window rows |
|---|---|---|---|
| before the turn | `""` | — | 0 |
| at the shutter, immediately before it | `A weekly publishing rhythm beats a burst of posts` | [`diagnosis__fill-in-context__light.png`](diagnosis__fill-in-context__light.png) | 2 |
| at the shutter, immediately after it | `A weekly publishing rhythm beats a burst of posts` | (same frame) | 2 |
| after `page.reload()` in **the same context** | `""` | [`diagnosis__fill-in-context__after-reload__light.png`](diagnosis__fill-in-context__after-reload__light.png) | 2 |

**(d) alone holds, and the road did not regress.** The value was in the DOM at the instant of the
frame — in that context, in every one of the twelve re-shot frames — so (a) is excluded; it did not
move across the shutter, so (c) is excluded; and it was lost only by a **reload**, which is (b) only
in the sense the code intends and describes.

**The code fact under it.** `packages/agents/src/use-run-window-conversation.ts` applies a fill from
ONE place: the value `send()` returns. The load on mount sets `entries` and nothing else
(`:87-104`), and the hook keeps no fill counter at all — its removal is this slice's own repair, and
the comment at `:74-85` says why: "The SERVER names the turn instead, so `outcome.fills` is already
only this message's rows". So **a page that did not receive the turn has nothing to apply**, and a
fresh context opened on the same run draws the exchange back (it is kept with the run) with the form
untouched. The previous leg's capture library opened exactly such a context for every pair.

**The panel's new rendering path did not detach the fill.** `hitl-conversation-panel.tsx` is
presentational — it draws `conversation` and calls the parent's `onSubmit`; the fill travels on the
parent's own `send()` return, which the panel never touches. Pinned by a test that renders through
the new path:
`packages/agents/src/__tests__/run-window-fill-through-drawn-panel.test.tsx` mounts the REAL panel
over a real field, sends a turn, and asserts the assistant's line is DRAWN (a `<strong>`, a real
`<table>`, zero raw `**`) **and** that the field holds what the turn placed. It is a live wire, not a
snapshot: dropping the effect in the screen's own submit makes it fail with
`expected '' to be 'A weekly publishing rhythm'` — the graded review's picture, in a test.

## An observation, recorded with its code fact

**An unsubmitted fill does not survive a reload.** The exchange does (§IX keeps it with the run); the
values do not, because nothing re-applies a fill on mount — by design, and the design's reason is the
comment quoted above: a screen re-reading the run must not re-apply a fill the person has since
edited away. **Whether it SHOULD survive is a product question for the closeout, not a clause of this
road**, and it is recorded here rather than decided.

## What the graded review asked for, and what these pictures answer

| the review's point | what this leg did |
|---|---|
| **1** — explain the contradiction with a measurement | Done above: same run, same context, DOM and frame in the same instant, before and after a reload. **(d)** holds; no regression in the road. |
| **2** — a red-first test through the new panel path | `run-window-fill-through-drawn-panel.test.tsx`, red when the effect is dropped, green as the code stands. |
| **3** — why the attachment frame was the "Not authorized" page | Reproduced and named: it is not the window's access rule. See below. |
| **4** — re-shoot the five failing cells, values visibly in the fields | Twelve frames re-shot in the turn's own context; the values are in the frame and in the DOM at the shutter. |
| **5** — the reds at the graded head | Answered on the pull request; the two `js/polynomial-redos` alerts are fixed at their source in this commit. |

## The two things the last grading asked for, and what was measured

| the point | what this leg did |
|---|---|
| **1** — fill-and-send refused half the time: diagnose the cause, fix it, red-first test, re-shoot the two frames on runs that were not retried | Three of the four folded causes are excluded by the refused runs' own rows (above); the fourth — the control the CALL named — is removed as a free variable, because the server already decided it. `lent-action-fill-and-send.test.ts` is red without the change and green with it, and the four properties that must not move are asserted beside it. Both frames re-shot on fresh runs, attempt 1, no retry. |
| **2** — the review page's window overlays the decision bar; place it beneath, add a render test, re-shoot the two review cells | Measured on this head **before**: bar `741–793` px, window `564–900` px, **vertical overlap 52 px** (the bar's whole height), horizontal `1029` of `1029`, and `elementFromPoint` at the bar's centre landing **inside the window**. **After**: window `980–1316`, **overlap 0**, the bar's centre resolving **inside the bar** — and 0 overlap at every width from 600 px to 1440 px. `run-window-placement.test.tsx` pins both facts that make it (document order, and no out-of-flow positioning). All four review cells re-shot. |
| **also** — the composer's accessible name | The leftover `Apply AI suggestion` is gone. The send control's name is **derived from the window's own sentence**, per surface, so the two cannot drift; a test asserts it for each of the five. |

## The graded table

Twelve frames are **re-shot at this head, in the turn's own context**. Eight are **carried unchanged**
from the graded head — the review passed them, and the only product file this head changes
(`markdown-render-core.ts`) is a rewrite whose output is byte-identical on 200 021 differential
inputs, so nothing those eight frames show can have moved. Each carried row says so.

| capture | requires (verbatim from the drawing) | shows (measured) | verdict |
|---|---|---|---|
| [`run-page__fill-no-submit__light.png`](run-page__fill-no-submit__light.png) | §X, the run page's own reading: "Ask Cinatra to fill the fields above, or ask about this step… **Fills the fields the step is waiting for with what was asked for.** Nothing is submitted until the person presses the step's own button — unless the same message asks for it in so many words."<br>§X, for every surface with a form: "The window fills **the fields the person can see** with what they asked for, and nothing is submitted until they press the screen's own button". | **RE-SHOT IN THE TURN'S OWN CONTEXT.** The setup gate of run `44915a33` (`Agentic Run Progress` · `Awaiting input` · `Idea (optional)` · a live `Continue`). The person typed `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is`. **In the frame the `Idea` box reads `A weekly publishing rhythm beats a burst of posts`**, and the DOM read either side of the shutter reads the same (`domAgreedAcrossTheShutter: true`). The answer above the box is the platform's own sentence, word for word: `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` Run `pending_approval` → `pending_approval`; `Continue` never pressed. Turn served on attempt 1, toolbox present. sha256 `040ee8f4…50`, mean luminance `234.4/255`. | **PASS** — and this is the cell the graded review failed. |
| [`run-page__fill-no-submit__dark.png`](run-page__fill-no-submit__dark.png) | As above, dark theme, through the app's own theme control. | Run `a6f9ac69`. The same filled `Idea`, the same sentence, the same untouched `Continue` on the dark ground; account footer drawn. DOM at the shutter: `field-idea = A weekly publishing rhythm beats a burst of posts`. sha256 `454dd525…80`, mean luminance `19.5/255`. | **PASS**. |
| [`run-page__question-no-press__light.png`](run-page__question-no-press__light.png) | §X: "**A question about the step is answered as a question and touches no field.**" | **RE-SHOT.** Same run `44915a33`, the next turn: `what is this field for?`. **The field still holds the earlier fill in the frame** — `field-idea = A weekly publishing rhythm beats a burst of posts` at the shutter — so the answer and the picture agree, which is what the graded review found they did not. No field changed by this turn. The answer is drawn markdown. sha256 `0be1bb5f…44`, mean luminance `236.8/255`. | **PASS**. |
| [`run-page__question-no-press__dark.png`](run-page__question-no-press__dark.png) | As above, dark theme. | Run `a6f9ac69`, same reading, same untouched field on the dark ground. sha256 `c2a9aa01…22`, mean luminance `17.2/255`. | **PASS**. |
| [`run-page__submit-on-ask__light.png`](run-page__submit-on-ask__light.png) | §X: "nothing is submitted until they press the screen's own button, **unless the same message plainly asks for it to be submitted**".<br>`app-lifecycle-cards.html` §X: "**Filling the fields in front of the reader is not a press, so one message may fill and then press**"; the card "settles in place in its own settled reading". | **RE-SHOT ON A RUN THAT WAS NOT RETRIED**, after the repair to the press road. Run `ae9912c7`, third turn of its own conversation: `set the idea to "Why cadence beats bursts for blog reach" and send it`. **Served on attempt 1** (`turnAttempts: [{attempt: 1, toolboxMissing: false, platformCouldNotAnswer: false}]`) — nothing was re-sent to obtain this frame. The run's store holds **two** rows for that one message — a fill, then `Submitted.` — and the run moved `pending_approval` → `pending_trigger`. The card settled in place: the frame is the run's own next reading, the scheduler form, and the window's sentence is now `Ask Cinatra to set the schedule above, or ask about it…`. sha256 `ddddf3d4…29`, mean luminance `234.8/255`. | **PASS**. |
| [`run-page__submit-on-ask__dark.png`](run-page__submit-on-ask__dark.png) | As above, dark theme, chosen through the app's own control in the same context, before the turn. | **RE-SHOT ON A RUN THAT WAS NOT RETRIED.** Run `e4be1fe6`, the same three-turn conversation, **served on attempt 1**. `pending_approval` → `pending_trigger`, the same two rows, the same settled scheduler reading on the dark ground; the account footer draws the run's owner. sha256 `9fad7474…f8`, mean luminance `18.8/255`. | **PASS**. |
| [`schedule__fill-no-submit__light.png`](schedule__fill-no-submit__light.png) | §X, the schedule screen's own reading: "Ask Cinatra to set the schedule above, or ask about it… **Fills the scheduler form's own rows — when the run starts, its time, its timezone** — whether the schedule is being set for the first time or changed once it stands. The person presses the form's own button, unless the same message plainly asks for it to be submitted." | **RE-SHOT IN THE TURN'S OWN CONTEXT.** The unarmed scheduler form of run `44915a33`. The person typed `set it for tomorrow at 9 in the morning, Berlin time`. **In the frame `Schedule for later` is selected and `Run at` reads `08/29/2026, 09:00 AM`**; the DOM either side of the shutter reads `scheduledAt = 2026-08-29T09:00`. Nothing submitted — the form's own button was not pressed. sha256 `57313828…52`, mean luminance `233.8/255`. | **PASS** — the graded review's "form untouched" is answered. |
| [`schedule__fill-no-submit__dark.png`](schedule__fill-no-submit__dark.png) | As above, dark theme. | Run `a3faf470`, the same filled row on the dark ground; DOM at the shutter `scheduledAt = 2026-08-29T09:00`. sha256 `13f924dd…52`, mean luminance `20.4/255`. | **PASS**. |
| [`step-by-step__fill-no-submit__light.png`](step-by-step__fill-no-submit__light.png) | §X, the step-by-step reading: "Ask Cinatra to fill this step's fields, or ask about the run… The same filling, one step of a sequence: **the values land in the fields in view and the person presses the step's button.**" | **RE-SHOT IN THE TURN'S OWN CONTEXT.** Run `9cd8283f`, the five-step rail with `1 Campaign setup` selected. The person typed `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is`. **In the frame `Offering company website` reads `https://example.test` and `Call to action` reads `Book a 20-minute demo`, and `Sender name` is empty** — exactly as the message asked; the DOM either side of the shutter reads the same three values. Nothing submitted. sha256 `7eb4f650…07`, mean luminance `234.1/255`. | **PASS** — the graded review's "three placeholders" is answered. |
| [`step-by-step__fill-no-submit__dark.png`](step-by-step__fill-no-submit__dark.png) | As above, dark theme. | Run `b2005bef`, the same rail, the same two filled fields, the same untouched `Sender name` on the dark ground. sha256 `1a392130…a0`, mean luminance `20.2/255`. | **PASS**. |
| [`step-by-step__attachment-reaches-run__light.png`](step-by-step__attachment-reaches-run__light.png) | The plan: "A file attached beside your message travels with your answer to the waiting agent exactly as it does today. The new road must not swallow it into an ordinary chat message, and **must not leave it behind when the answer is finally sent**." | **RE-SHOT, AND THE CELL NOW SHOWS THE STEP AND THE MESSAGE.** Run `84d7beb6`: the window's own paperclip uploaded `campaign-brief.txt` (the app's own upload answered `201`) and the person typed `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo" — the campaign brief is attached for this run`. The frame carries the step (`1 Campaign setup` of five), the person's message, the platform's fill sentence and the two filled fields. **The person's own window row carries the file**: `campaign-brief.txt`, digest `576038005379a871f562e47022857a40c30371a389a38d872d0accc9a4816d11`, `originKind: upload`. **The "finally sent" half is proven on run `52e7165a`** (the route probe below): the same paperclip, a message that asked for the send, and the run's rows read fill → `Submitted.`, with a second gate row `{"stepNumber": 2}` materializing seconds later — the file was on the submitted message, not left behind. sha256 `0bd1b57f…6c`, mean luminance `234.1/255`. | **PASS**, and the frame is no longer the "Not authorized" page — see the finding that explains why it was. |
| [`step-by-step__attachment-reaches-run__dark.png`](step-by-step__attachment-reaches-run__dark.png) | As above, dark theme. | Run `eafd85cc`, the same upload (`201`), the same message, the same two filled fields and the same fill sentence on the dark ground. sha256 `516db9ea…8a`, mean luminance `20.2/255`. | **PASS**. |
| [`step-by-step__draft-survives-reload__light.png`](step-by-step__draft-survives-reload__light.png) | §IX: "What survives a reload is therefore both — **the turns above the field and the reader's unsent draft in it**." | **CARRIED from the graded head, where the review passed it.** `please set the call to action to` was typed and **not sent**; the page was reloaded in the browser; the half sentence is still in the field, read out of the browser's own storage before the reload and matched after it. sha256 `61f2a5ee…31`, mean luminance `238.2/255`. | **PASS** (carried). |
| [`step-by-step__draft-survives-reload__dark.png`](step-by-step__draft-survives-reload__dark.png) | As above, dark theme. | **CARRIED.** The same half sentence after the same reload on the dark ground. sha256 `4af0db3e…ec`, mean luminance `13.4/255`. | **PASS** (carried). |
| [`armed-trigger__fill__light.png`](armed-trigger__fill__light.png) | §X, the armed-trigger tab's own reading: "Ask Cinatra to change this schedule, or ask about it… **Changes the schedule that stands** — until a one-off fires, and for a recurring schedule's future runs — through the tab's own controls. The schedule on screen is what is true." | **CARRIED.** The run's own `Schedule` tab on an **armed** run; the tab draws the schedule that stands and the window beneath it carries its own sentence word for word. **No fill was attempted, and none is claimed.** sha256 `f8a015d2…7e`, mean luminance `234.4/255`. | **RECORDED DEVIATION, not a pass** — unchanged, and the graded review acknowledged it. Code fact: `src/lib/lifecycle/run-window-turn.ts` (`boundScreenClaimForSurface`) — the armed-trigger tab is deliberately outside this slice. |
| [`armed-trigger__fill__dark.png`](armed-trigger__fill__dark.png) | As above, dark theme. | **CARRIED.** The same armed schedule and the same sentence on the dark ground. sha256 `fe84889b…de`, mean luminance `21.7/255`. | **RECORDED DEVIATION**, as above. |
| [`review__question__light.png`](review__question__light.png) | §X, the review page's own reading: "…**A question is answered and files nothing.**"<br>§VI: "**Beneath the decision bar** the run detail carries a conversational prompt window"; "The decision floor is unchanged: approve, reject, comment." | **RE-SHOT, on a real review gate over real artifact-bound output, after the window was placed beneath the bar.** Run `8820dcfc`, one run per theme, themed through the app's own control before the turn, photographed in the context that typed. The person typed `what changed in this draft?`. **The two boxes do not touch**: the decision bar `325–377` px (52 px tall), the window `564–900` px, **vertical overlap 0 px**, and `elementFromPoint` at the bar's centre resolves **inside the bar** (`barCentreResolvesInsideTheBar: true`, `barCentreResolvesInsideTheWindow: false`, `windowPlacement: "in-flow"`). Readback after the turn: gate still `pending`, `disposition` NULL, `artifact_review_dispositions` **0 rows**, the decision bar unchanged (`Comment · Reject · Approve`) and the rationale field empty. **Nothing was filed.** sha256 `9530153d…a8`, mean luminance `236.5/255`. | **PASS** — and this is the cell the graded review failed. |
| [`review__question__dark.png`](review__question__dark.png) | As above, dark theme. | **RE-SHOT.** Run `8aafcdcc`, its own run for this theme. The same measurement in this context: bar `325–377`, window `564–900`, **vertical overlap 0 px**, the bar's centre resolving inside the bar. The same pending gate and untouched decision bar on the dark ground. sha256 `989f03b0…c8`, mean luminance `21.7/255`. | **PASS**. |
| [`review__request-changes__light.png`](review__request-changes__light.png) | §VI: "Typing a change request into it is how a reviewer requests changes… On submit, **the gate resolves changes-requested and a repair goes in flight**".<br>§X: "an explicit request for changes is placed by the card's own comment machinery, **word for word**". | **RE-SHOT** on run `8820dcfc`, the next turn of that same context. The person typed `tighten the opening paragraph`. **Word for word, from the database**: `cinatra.lifecycle_repair` holds one row whose `findings` carry `tighten the opening paragraph` — the filed text EQUALS the typed text. The gate moved `pending` → `resolved`, `disposition=changes_requested`. `artifact_review_dispositions` stayed at **0** rows. The decision bar is gone from this frame because **the gate has settled** — a resolved gate carries no decision floor and no comment channel, which is the page's own rule, not an overlap. sha256 `7e94cac4…22`, mean luminance `238.2/255`. | **PASS** on the three clauses this slice owns. |
| [`review__request-changes__dark.png`](review__request-changes__dark.png) | As above, dark theme. | **RE-SHOT** on run `8aafcdcc`. The same resolved gate, the same repair row carrying the typed words, the same settled card on the dark ground. sha256 `68e4c47c…12`, mean luminance `20/255`. | **PASS**. |

Every dark frame measures `13.4`–`21.7` of 255 and every light frame `233.8`–`238.2`: the palettes
are the app's own, switched through its own control, never a colour-scheme emulation.

## The "Not authorized" frame: what it actually was

**Reproduced deliberately**, on run `52e7165a`, in one driving context, with the readback in
[`after-submit-route-probe.json`](after-submit-route-probe.json):

| moment | address the browser is on | fields the page draws |
|---|---|---|
| before the turn | the run's own step-by-step page | `field-offeringCompanyWebsite`, `callToAction`, `field-senderName` |
| after the message that asked for the send | **`/not-authorized`** | none |
| the same address re-opened in a second context | **`/not-authorized`** (HTTP 200) | none |

**It is not the window's access rule, and not this slice's road.** The submit succeeded — the run's
rows read fill → `Submitted.` and a second gate row `{"stepNumber": 2}` was written. The step the run
advanced TO is the email agent's `Account scope` step, whose renderer calls
`fetchAvailableLists()` — and that server action opens with `requireAdminSession()`
(`packages/agents/src/list-picker-actions.ts:41`), which redirects a non-admin to `/not-authorized`.
So the run's own owner is bounced off their own run the moment the run reaches that step, whether the
page was re-opened in a second context or never left the first.

**Recorded, not patched here.** It is a real defect and it is worth its own issue — a run owner who is
not a platform administrator cannot use step 2 of an agent they started — but the gate belongs to a
step renderer that predates this slice, and an admin-gate change is not a line this evidence commit
may carry. The re-shot attachment cell therefore stands on the fill road, where the step stays in
view, and the submit road is proven by run `52e7165a`'s readback.

## Three further observations, recorded on the same footing

- **A message that asks for the press was sometimes refused authority — FIXED, not recorded.** The
  previous leg recorded two of four submit-asking turns coming back `This message is not allowed to
  operate that control. Nothing was done.` **with the FILL of the same message applied**. That
  combination is itself a measurement, and it excludes three of the four causes
  `src/lib/lifecycle/lent-action-mcp.ts` folds into that one sentence: the fill's own gates prove the
  grant was on the frame, verified, and matched the card and the person; and the runs' rows show no
  spend, so it was not an already-spent grant either. What was left is the one thing the CALL still
  supplied for itself — **the control it named**. Which control a message may press is the SERVER'S
  answer, decided at send time from the card's kind and sealed into the grant; an argument whose only
  correct value the server already holds cannot add safety, and can only ever produce a refusal. It is
  now **optional**: a call with the ref alone presses the control this message was granted, a call
  naming a different one is refused exactly as before, and the refusal sentence is byte-identical for
  every cause, so an unauthorised caller learns exactly as little as it did. The server now also
  **writes which of the four causes refused** to its own log (`[lent-action] refused: cause=…`) and
  never to the answer, so this can be read rather than inferred next time.
  **Measured at this head, after the repair: 8 fill-and-send turns on 8 real runs — one message, the
  three-message conversation the previous leg used, and two other phrasings — were honoured on the
  first attempt, every one `pending_approval` → `pending_trigger` with `Submitted.`, and the
  refusal log is empty (0 lines).** The two filed `submit-on-ask` frames are two of those eight, and
  neither was retried.

- **The window's assistant is not handed the attachment's text.** Asked to fill a step FROM an
  attached brief, the answer was `I don't see the campaign brief attached here.` (light, run
  `9cd8283f`) and `I don't see the campaign brief content in this prompt window.` (dark, run
  `b2005bef`) — both read out of the run's own stored rows. The code fact is
  `src/lib/lifecycle/run-window-turn.ts`: the turn calls `runAssistantTurn` with
  `messages: [...history.map((m) => ({ role: m.role, content: m.text })), { role: "user", content:
  prompt }]` — text only. The file is kept with the run (the person's row carries it with its digest)
  and travels with a submit; what it does not do is reach the model as content. The clause this road
  owns is "reaches the waiting agent", and it does; being readable BY the window's assistant is not a
  clause anyone has written, so this is recorded rather than treated as a failure.
- **The window does not draw an attached file beside the message.** Unchanged code fact:
  `RunWindowEntry` carries `id`, `role` and `content`, and the panel renders those. No frame in this
  leg claims an attachment chip.

## The one clause this leg could NOT reach, and exactly why

§VI's "the corrected version returns as a fresh review in the same run" is **NOT REACHED**, and it is
recorded rather than simulated. After the change request the repair went in flight and created its own
run, which parked on the producer agent's own setup gate; `lifecycle_repair.successor_gate_id` was
still NULL after the wait, and no second gate appeared on the rail. That is the repair route's
behaviour, recorded on cinatra#2951 — not this road's, which ends at "filed word for word, gate
resolved changes-requested, repair in flight". The graded review acknowledged the same.

## Reproducing this leg

The drivers in [`drivers/`](drivers) are the whole procedure, in order: the people and the instance
namespace through the app's own screens (`01`), the organization through the app's own invite/accept
road (`02`), the shared capture machinery (`03`), the surface cells (`05`, `06`), the run starts
(`10`), the instance's public origin through its own screen (`08`), the provider key through the setup
form (`09`, run from the operator's own machine so no credential is ever placed on the capture host),
the drive to a review gate with the person's own presses (`12`), the review readings (`13`), the armed
tab (`15`), and the pair-taker (`16`).

**Three drivers are new or changed for this leg**, and each change is a correction the graded review
asked for:

- `18-cell-in-turn-context.mjs` — **the correction**. One cell, one theme, in the context that sends
  the turn: the theme is chosen on the app's own chrome before the run page opens, the account footer
  is waited out in that same context, the turn is sent, the DOM is read immediately before and
  immediately after the shutter, and the record carries both reads plus
  `domAgreedAcrossTheShutter`. It also carries the diagnosis: a reading marked `diagnose` reloads the
  page in that same context and is read and photographed again.
- `19-frame-luminance.mjs` — every filed frame's sha256, size and mean luminance, decoded by the same
  engine that took it, with no image library and nothing re-rendered.
- `21-after-submit-route-probe.mjs` — the address the step-by-step screen lands on after the submit,
  what the driving context draws there, and what a second context draws at the same address.

**One edit to a log, declared.** `timeline.jsonl` is the drivers' own clock and is otherwise untouched.
Two of its lines belonged to the superseded attachment attempt described above and named the brief by a
working file name that identifies the capture host; those two lines were removed rather than reworded,
and the reading they belonged to is in no picture and no table.

`16-reshoot-cell.mjs` — the previous leg's shoot-only pair-taker — is kept for the readings whose
state lives with the RUN, and its own header now says which readings those are and which they are
not.
