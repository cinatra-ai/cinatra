# cinatra#2933 lifecycle-b W5b — the picture leg

The prompt window outside the chat, photographed on the real running app at the
PR head. On all five surfaces a run owner who is **not** a platform administrator
types **"what is this step waiting for?"** and a real model answers **from that
run's own recorded state**, without the person naming a run, a step or an id.
The exchange is there after a browser reload.

Full-window captures at 1440x900, device scale 2 (2880x1800 px), light and dark,
taken through the app's own theme control. Every capture was viewed before it was
recorded. Environment, run ids, timestamps and every answer are in
`capture-records.md`.

## Graded against

- `specs/app-artifact-review.html` **§VI**, **§IX** and **§X** at design
  `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f` (masthead **v0.5.0**), rendered and
  read before grading.
- `specs/app-lifecycle-cards.html` **§X** at the same commit — byte-identical to
  the text at `fe2182547d4a`.
- The ratified run-surface drawing (§I of the same spec): a two-column frame, a
  step rail naming the run's ordered steps on the left, the selected step's
  surface in the run detail on the right, the window under it.

### What changed in the drawing since `fe2182547d4a`

The previous capture set was graded against `fe2182547d4a`. Three things moved,
and all three bear on this slice:

1. **§IX now draws the persistence this slice ships.** "The exchange is kept with
   the run … it is stored with the run, it is **there after a reload**, and it can
   be read later beside the run." The old paragraph — "not a record of it … it
   does not come back after a reload" — is gone. The paired design correction the
   PR body recorded as owed has landed, so §IX is now graded as conformance
   rather than as a named stale sentence.
2. **§IX now draws the gate-kind behaviour this slice ships.** "When the run
   reaches a gate of a different kind the panel **closes** … what was said is not
   discarded with it — the exchange stays with the run and opens again on the
   next click into the field."
3. **§VI's offered sentence changed, and a new §X fixes one sentence per
   surface.** §X ("One window, five readings") draws the empty field on each of
   the five surfaces with its own sentence. This is the per-surface wording the
   PR body recorded as "owed a drawing". The drawing now exists, and the product
   does not match it on any of the five — recorded as Deviation 1 below.

| Surface | §X requires in the empty field | The product shows |
|---|---|---|
| run page | `Ask Cinatra to fill the fields above, or ask about this step…` | `Ask Cinatra to suggest edits to the fields above…` |
| step-by-step | `Ask Cinatra to fill this step's fields, or ask about the run…` | `Ask Cinatra to suggest edits to the fields above…` |
| schedule | `Ask Cinatra to set the schedule above, or ask about it…` | `Ask Cinatra to suggest edits to the fields above…` |
| armed-trigger | `Ask Cinatra to change this schedule, or ask about it…` | `Ask Cinatra to suggest edits to the fields above…` |
| review | `Ask Cinatra about this review, or ask for changes to the work…` | `Ask Cinatra to suggest edits to the fields above…` |

## The rule this set is here to prove

> Outside the chat, the prompt window is a conversation about that run, kept per run.

On all five mounts the answer came from the run's own state. **No answer asked
"which step do you mean?" and none asked for an id.** The claim holds on all
five. Every answer is quoted with its run id and timestamps in
`capture-records.md`.

## The captures

| Capture | Requires | Shows | Verdict |
|---|---|---|---|
| `run-page__box-placeholder__light` | §IX: no panel above an empty exchange, the window is the field alone until the first message. §X: the run page's own sentence in the empty field. | The setup gate of a `pending_approval` run (`Idea`, a live `Continue`) with the field alone at the foot of the page, no panel above it — and the field reads `Ask Cinatra to suggest edits to the fields above…`. | **DEVIATION 1** — panel/placement conform; the sentence is not §X's. |
| `run-page__box-placeholder__dark` | as above, dark theme. | The same, on the dark ground; the same sentence. | **DEVIATION 1** — same. |
| `run-page__exchange-after-reload__light` | §IX: turns not a transcript — the reader's turn right-aligned on the primary ground, the assistant's left-aligned on the muted surface, at most four-fifths of the panel, line breaks kept, no author label, no avatar, no timestamp; the exchange is there after a reload. | After a browser reload, the panel above the field holds `what is this step waiting for?` right-aligned on the indigo ground in white and the model's own answer left-aligned on the muted surface — an answer that names **this run's** gate (`@cinatra-ai/agent-builder:schema-field-fallback`), its task (`setup-d345e546-…`) and its missing fields (`title`, `summary`, `outline`). No label, avatar or time. | **PASS.** |
| `run-page__exchange-after-reload__dark` | as above, dark theme. | The same two turns after the reload, same answer. The reader's bubble is the theme's own primary — a light ground with ink text, not the light theme's indigo-in-white. | **PASS on shape; DEVIATION 5** on the dark bubble ground. |
| `schedule__box-placeholder__light` | §IX as above. §X: the schedule screen's own sentence. Run-surface drawing: two columns — the rail on the left, the selected step's surface in the run detail, the window under it. | The setup run page of a `pending_trigger` run: the rail `1 Schedule` (selected) · `2 Recommendation` · `3 Review` on the left, the scheduler form (`When should this run?` / `Run right after setup` / `Schedule for later` / `Recurring`) in the detail column, the field alone beneath the frame. Sentence not §X's. | **DEVIATION 1** — frame and placement conform; the sentence is not §X's. |
| `schedule__box-placeholder__dark` | as above, dark theme. | The same rail, form and field on the dark ground; the same sentence. | **DEVIATION 1** — same. |
| `schedule__exchange-after-reload__light` | §IX turns-not-transcript and kept-with-the-run, as above. | After a reload, the person's turn right-aligned and the model's answer left-aligned, naming **this run** (`Blog Draft Writer Agent (5)`), its agent (`@cinatra-ai/blog-draft-writer-agent`) and its status (`pending_trigger`), and saying it waits for its trigger. The panel opens over the lower half of the scheduler form, which is the panel's own placement. | **PASS.** |
| `schedule__exchange-after-reload__dark` | as above, dark theme. | The same exchange and the same answer on the dark ground. | **PASS on shape; DEVIATION 5** on the dark bubble ground. |
| `armed-trigger__box-placeholder__light` | §IX as above. §X: the armed-trigger tab's own sentence. Run-surface drawing as above. | The run's persistent `Schedule` tab, selected in the strip, with the armed recurring schedule as it stands — `Recurring`, every `1 week(s)`, on `Wed`, at `09:00`, `UTC`, with `Save changes` — the rail beside it and the field alone beneath. Sentence not §X's. | **DEVIATION 1** — frame, tab and schedule conform; the sentence is not §X's. |
| `armed-trigger__box-placeholder__dark` | as above, dark theme. | The same tab, schedule and field on the dark ground; the same sentence. | **DEVIATION 1** — same. |
| `armed-trigger__exchange-after-reload__light` | §IX as above. | After a reload, the person's turn and an answer that reads **this run's own schedule row**: `armed`, `Trigger type Recurring`, `Cron 0 9 * * 3`, `Timezone UTC`, "Every Wednesday at 09:00 UTC". The window names the run it sits under — it is not a list of the runs this person can see. | **PASS.** |
| `armed-trigger__exchange-after-reload__dark` | as above, dark theme. | The same exchange and answer on the dark ground. | **PASS on shape; DEVIATION 5** on the dark bubble ground. |
| `step-by-step__box-placeholder__light` | §IX as above. §X: the step-by-step screen's own sentence. Run-surface drawing as above. | The five-step rail (`1 Campaign setup` selected → `5 Test & send`), the first gate's form in the detail column (`Offering company website`, `Call to action`, `Sender name`, `Save & start run`), the field alone beneath with the paperclip offered. Sentence not §X's. | **DEVIATION 1** — rail, detail and placement conform; the sentence is not §X's. |
| `step-by-step__box-placeholder__dark` | as above, dark theme. | The same rail, form and field on the dark ground; the same sentence. | **DEVIATION 1** — same. |
| `step-by-step__exchange-after-reload__light` | §IX as above. | After a reload, the person's turn right-aligned and the answer left-aligned, naming **step 1** and the three fields the step is waiting for (`Offering company website`, `Call to action`, `Sender name`) as `Empty`. The rail and the gate's form stand unchanged behind the panel. | **PASS.** |
| `step-by-step__exchange-after-reload__dark` | as above, dark theme. | The same exchange and answer on the dark ground. | **PASS on shape; DEVIATION 5** on the dark bubble ground. |
| `review__box-placeholder__light` | §VI: one decision bar — the rationale field `Add a note for the run and the audit trail…` labelled `DECISION RATIONALE (optional on approve, expected on reject)`, then `Comment`, `Reject` (destructive) and `Approve` (primary) — with the conversational prompt window beneath it. §X: the review page's own sentence. | The review page of a run that produced a `Blog Post Artifact` (`Why a Weekly Publishing Rhythm Beats a Burst of Posts`), `Review requested` · `Awaiting your decision`, the rail `1 Schedule` · `2 Review`, the decision bar exactly as drawn, and the window's field beneath. Sentence not §X's. Above the bar the review target is **not rendered**: the card shows `review target unavailable — slot "detail", reason "no-semantic-renderer"` and the generic read-only view. | **DEVIATION 1** (sentence) **and DEVIATION 2** (the review target falls through to the never-blank floor instead of a type renderer). The decision bar itself is **PASS**. |
| `review__box-placeholder__dark` | as above, dark theme. | The same page, bar, field, sentence and unrendered target on the dark ground. | **DEVIATION 1 + DEVIATION 2** — same; decision bar **PASS**. |
| `review__exchange-open__light` | §IX turns-not-transcript. §VI: "typing a change request into it is how a reviewer requests changes … on submit the gate resolves changes-requested and a repair goes in flight"; there is no dedicated request-changes button. `app-lifecycle-cards.html` §X: a typed comment lands word for word. | The person's turn right-aligned, the model's answer left-aligned, and above them the gate already resolved — `Changes requested by Rita Owner` — because the same keystroke that sent the message filed the change request. The answer names **this run** (`Blog Draft Writer Agent (9)`, `Run status Completed`) but reports `Waiting on **Nothing**` while the review gate it sits on was pending. | **PASS** on §VI's resolve-on-submit and on §IX's turn shape; **DEVIATION 3** — the answer is wrong about what the screen is waiting for. |
| `review__exchange-open__dark` | as above, dark theme. | The same three things on the dark ground, the same answer. | **PASS / DEVIATION 3** as above; **DEVIATION 5** on the dark bubble ground. |
| `review__exchange-after-reload__light` | §IX: "The window is drawn only for a person who may answer the run" — where there is nothing to answer, no window and no exchange. | After the reload the gate is resolved (`Changes requested by Rita Owner` · "The gate is resolved and the reviewed work has been turned back for repair") and there is **no window and no field** on the page. The exchange itself is not lost — both rows stand in the run's store, listed in `capture-records.md`. | **PASS** against §IX's access rule; **DEVIATION 4** against this recipe's "the exchange open after a reload", for this one surface only. |
| `review__exchange-after-reload__dark` | as above, dark theme. | The same resolved reading and the same absent window on the dark ground. | **PASS / DEVIATION 4** as above. |
| `run-page__no-respond-access__light` | §IX: a person without respond access **never sees the box**, rather than a field that would be refused. | A signed-in ordinary member who does not own the run (`Ben Bystander`) is refused the run itself — `404 — Page not found`. No window, no exchange, no field. | **PASS.** |
| `run-page__no-respond-access__dark` | as above, dark theme. | The same refusal on the dark ground. | **PASS.** |
| `schedule__no-respond-access__light` | as above. | The same member on the schedule step's route: `404 — Page not found`, no window, no field. | **PASS.** |
| `schedule__no-respond-access__dark` | as above, dark theme. | The same refusal on the dark ground. | **PASS.** |
| `armed-trigger__no-respond-access__light` | as above. | The same member on the armed run's `Schedule` tab: `404 — Page not found`, no window, no field. | **PASS.** |
| `armed-trigger__no-respond-access__dark` | as above, dark theme. | The same refusal on the dark ground. | **PASS.** |
| `step-by-step__no-respond-access__light` | as above. | The same member on the stepped run: `404 — Page not found`, no window, no field. | **PASS.** |
| `step-by-step__no-respond-access__dark` | as above, dark theme. | The same refusal on the dark ground. | **PASS.** |
| `review__no-respond-access__light` | as above. | The same member on the review page: `Not authorized` — "You don't have access to this review. This review belongs to an agent run you're not authorized to see." No window, no exchange, no field. | **PASS.** |
| `review__no-respond-access__dark` | as above, dark theme. | The same refusal on the dark ground. | **PASS.** |

## Deviations, named

1. **The per-surface sentence is not the one the drawing now fixes — on all five
   surfaces.** §X of `app-artifact-review.html` at the graded design commit draws
   a different sentence in the empty field of each of the five surfaces (table
   above). Every surface in this set shows the one string
   `Ask Cinatra to suggest edits to the fields above…`. The PR body's Deviation 1
   states the mechanism ships (a per-surface prop) and no pixel moves because the
   wording "is owed a drawing"; that drawing now exists, so this is a difference
   between the ratified drawing and the product, not an open question. It affects
   the ten `box-placeholder` captures and is visible in the twelve others that
   photograph the field.

2. **The review target is not rendered.** On the review page the artifact card
   reads `review target unavailable — slot "detail", reason "no-semantic-renderer"`
   and falls through to the never-blank floor (§V) — the generic read-only view
   with type, mime, revision and Preview/Download. §IV draws the target's own
   representation. The decision bar, the window and the gate all behave as drawn
   above it. This is not introduced by this slice — it is the same reading the
   previous capture set photographed — and it is a renderer-resolution state, not
   a window state.

3. **On the review page the answer reports that nothing is being waited on, while
   the review gate is pending.** `review__exchange-open__*` shows the answer
   giving `Waiting on **Nothing**` and `Run status Completed` for a run whose
   artifact review gate was open at that moment — on the very screen that was
   waiting for the person's decision. Reproduced on two independent review gates
   (`98bd8d43…` and `1e1cc4ef…`), so it is systematic rather than a one-off. The
   cause is in what the frame carries: the PR body states the frame is built from
   the run's paused HITL gate and its schedule; an **artifact review gate is
   neither**, so it does not reach the model. The answer is still the run's own
   state and still names the run without being told which one — the slice's claim
   holds — but the answer is materially wrong on the surface where it matters
   most.

4. **The review window's exchange cannot be photographed after a reload.** The
   same keystroke that sends the message files the review's change request (§VI:
   "there is no dedicated 'request changes' button"), so the gate resolves and the
   window is correctly gone on the next paint (§IX's access rule). The exchange IS
   kept with the run — both rows stand under `message_type='window'` for run
   `1e1cc4ef-04cb-4eb6-9262-9599cd776d25`, listed in `capture-records.md`.
   `review__exchange-open__*` photographs that same surface a moment earlier.

5. **Dark-theme bubble ground.** §IX draws the reader's turn "on the indigo ground
   in white". The window paints it with the same design token in both themes, so
   in dark theme the ground is the theme's own light primary with ink text. Same
   token, dark value — recorded, not counted against the light-theme drawing.

6. **The run page draws no two-column frame at a pre-execution setup gate.** The
   run-surface drawing draws every run-page state as a two-column frame with a
   step rail. `run-page__box-placeholder__*` and `run-page__exchange-after-reload__*`
   show a single centred column: the run has no ordered steps and no gate step yet,
   so the screen renders the run detail alone. The four other surfaces in this set
   — the schedule step, the armed-trigger tab, the step-by-step screen and the
   review page — all draw the rail. This is the frame's shape, not the window's;
   the window is drawn, is gated on the run's access, and answers per run.

7. **The tool-less capture is not in this set.** The platform's own sentence for a
   model that cannot operate anything is reached only on a conversation-only
   provider. On this instance the provider is committed through the app's own
   setup and there is no product path to a conversation-only one, so the state
   cannot be reached through the product. Named rather than faked.

8. **Warm-up turns are on runs that were never photographed.** The first turns on
   a cold public-MCP path are refused by the runtime's own 2.5 s reachability
   probe and store the platform's "could not answer just now" line. Rather than
   delete rows, those turns were left on two runs that no capture photographs
   (`b32afdb2…` and `69066a5c…`, listed in `capture-records.md`) and every
   photographed run carries exactly one real exchange. No pixel was edited, no
   transcript was seeded, no assistant was stubbed.
