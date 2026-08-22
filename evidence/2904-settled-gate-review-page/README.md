# cinatra#2904 — the settled review card on the review page, on a real path

A review gate that a person had already decided drew no card at all on the review
page. The route's own loader answered `{kind:"blocked", reason:"no-longer-pending"}`
for **every** non-pending gate, and the page returned the generic grey panel before
`ReviewGateCard` was mounted — so the transcript said "Approved by …" and the
review page said "This review is no longer open" about the same gate at the same
moment. The loader now separates the two states the card's own resolver has always
separated (`resolved` → settled, `unavailable` → nothing), and this directory is
the evidence that the shipped renderer draws the settled reading on this host,
photographed on the running app from a state the real flow produced.

## The path these pictures were taken on

**The real one. No stand-in was needed and none was used.**

1. A run is seeded and `materializeBlogPostBodyArtifact` writes a real artifact
   under it, which puts a row in `artifact_produced_outbox`.
2. `sweepReviewOrchestration` — the shipped sweep — mints the
   `artifact_review_gates` row and its review task. Nothing writes a gate by hand.
3. The review page for that gate is opened in a browser and the card is on screen
   with its live floor (**P1**).
4. **Approve (or Reject) is pressed on the card, in the browser.** The decision
   travels the shipped path; nothing here calls a server action directly and
   nothing writes a disposition into the database.
5. **The route is reloaded.** That reload is the whole claim: the page's own
   SERVER loader runs again, on a gate it now finds RESOLVED, and what it composes
   is what these pictures show (**P2**, **P4**). The dark cells (**P3**, **P5**)
   open the same two gates fresh in a new context, taking no decision at all.
6. The negative control (**P6**, **P7**) opens the same run with a review task id
   no gate was ever emitted for, so the loader answers `unavailable`.

The lane's own read-back straight afterwards, from its database:

```
run cafdc215…  status resolved  disposition approve  resolved_by → "Dana Reviewer"
run 3044501c…  status resolved  disposition reject   resolved_by → "Dana Reviewer"
run 94265eef…  status pending   disposition —        (the P1 control, still open)
```

So the outcome each card names is the disposition the store recorded, and the
name each card prints is the display name of the account that pressed the button.

**Runtime:** the dev server (`pnpm dev`, Next.js with Turbopack,
`CINATRA_RUNTIME_MODE=development`) against a lane-private Postgres and Redis on
loopback, placeholder-only environment, no real model credential on this host.
Viewport 1228 wide, **device scale factor 2**. Every record carries the class the
document actually resolved, so a "dark" cell is dark because the document said so
and not because its name says so.

## The grading table

Graded by opening each PNG and reading it against the plan text quoted in
`PLAN-WALK.md`.

| Capture | Requires | Shows | Verdict |
|---|---|---|---|
| `captures/P1__review-card__page_gate_region__pending.png` | THE CONTROL. The pending composition unchanged: one card on `page_gate_region` with the "Review requested" header and its pill, the pinned target, the rationale field and the live Comment / Reject / Approve floor, the run-step rail beside it and the prompt window at the foot; no settled anchor anywhere | Exactly that — "Review requested" · "Awaiting your decision", the target "Pricing page revision note" on the Floor treatment with its type/mime/revision read, "Decision rationale (optional on approve, expected on reject)", and Comment / Reject / Approve. `review-gate-settled` and `data-review-outcome` measured **0** inside the card root | **PASS** — the reference the decided cells are read against |
| `captures/P2__review-card__page_gate_region__decided.png` | THE READING UNDER TEST. After a real Approve press and a RELOAD: one card root on this host with `data-lifecycle-card-state="settled"`, the settled panel naming the outcome and the decider, no decision bar, no Refresh, no blocked panel, no prompt window | One card, state `settled`, and inside it the success-tinted double-check over **Approved by Dana Reviewer** and "The gate is resolved and the run has been released to continue." Nothing to press anywhere on the page | **PASS**. Against `origin/main@269ceb194` this same URL renders the grey panel and **no card DOM at all** |
| `captures/P3__review-card__page_gate_region__decided__dark.png` | The same reading on the dark ground, with the tokens resolving to it | The identical panel, outcome word and decider on the dark ground; document class `dark`; a different image hash from the light cell | **PASS** |
| `captures/P4__review-card__page_gate_region__decided__rejected.png` | The REJECTED outcome, on a second real gate decided by a real Reject press: the destructive treatment, the outcome named, `data-review-outcome="rejected"` | The ringed × over **Rejected by Dana Reviewer** and "The gate is resolved and the reviewed work has been turned back." No floor, no Refresh | **PASS** — and the word is read off the recorded disposition, never guessed |
| `captures/P5__review-card__page_gate_region__decided__rejected__dark.png` | The rejected reading on the dark ground | The identical rejected panel on the dark ground, document class `dark`, own hash | **PASS** |
| `captures/P6__review-page-blocked__unavailable.png` | THE NEGATIVE CONTROL. A gate that does not exist must draw the generic blocked panel and **no card**: an unavailable gate never becomes settled-card DOM | The grey panel — ringed ×, "This review is no longer open", "The gate was already decided or the run moved on.", **Refresh** — and no card. Card anchors measured **0**, blocked anchors **1** | **PASS** — the half of this change that had to not move |
| `captures/P7__review-page-blocked__unavailable__dark.png` | The same negative control on the dark ground | The identical blocked panel, same six counts, still no card DOM | **PASS** |

Hashes, and the anchors that separate the readings — measured inside the card's
own root where the card exists, and frame-wide where the claim is that it does
not. `absent` is written down as an observation rather than left silent.

| Cell | sha256 | doc class | card root | `data-lifecycle-card-state` | `review-decision-bar` | `review-gate-settled` | `data-review-outcome` | `review-gate-blocked` |
|---|---|---|---|---|---|---|---|---|
| P1 | `553f5bb46b5e…` | `cinatra` | 1 | `pending` | **1** | 0 | 0 | 0 |
| P2 | `0c35f653a2e6…` | `cinatra` | 1 | **`settled`** | 0 | **1** | **1** (`approved`) | 0 |
| P3 | `28cd0db4d050…` | **`dark`** | 1 | **`settled`** | 0 | **1** | **1** (`approved`) | 0 |
| P4 | `1e5bc450af43…` | `cinatra` | 1 | **`settled`** | 0 | **1** | **1** (`rejected`) | 0 |
| P5 | `6bc0933746f4…` | **`dark`** | 1 | **`settled`** | 0 | **1** | **1** (`rejected`) | 0 |
| P6 | `fd89ef72713d…` | `cinatra` | **0** | — | 0 | **0** | **0** | **1** |
| P7 | `ad4286142390…` | **`dark`** | **0** | — | 0 | **0** | **0** | **1** |

That is the whole change in two rows: a decided gate now draws the card that names
what happened, and a gate that does not exist still draws no card at all.

## Where the records live

P1–P5 are registered in the canonical index,
`scripts/ci/chat-hitl-capture-index.json`, as the P-group — each written by the
ONE shared recorder (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`,
`cinatra-lifecycle-capture-recorder@1`) and validated at the **audit** tier before
it was written. `drivers/capture.mjs` supplies the scenario and a page port over
Playwright, and nothing else: the counting rules, the card-instance pin, the
stability re-measure that fails a capture whose screen moved between the numbers
and the shutter, and the record shape all come from the recorder — so `recordedBy`
names a fact rather than carrying a label.

**P6 and P7 are deliberately NOT in that index, and their absence is a finding
rather than an omission.** Every record in it is a measurement of a lifecycle
card, and these two cells exist precisely to show that no card is drawn. Asking
the recorder for a record would be asking it to measure a card that must not
exist. Their counts and hashes are in `capture-results.json` beside the pictures,
and in the table above.

## What is here

```
README.md            this file — the path, the runtime, the grading table
PLAN-WALK.md         every cell against the verbatim governing text
capture-results.json what the recorder and the page port actually measured
captures/            the seven graded pictures
drivers/             what produced them, end to end
  lane-setup.mjs           the lane's own account and organization, through the shipped auth routes
  collapse-to-one-org.mjs  the lane joins the instance's existing organization instead of adding a second
  walk.config.ts           the vitest config the walk runs under
  walk.test.ts             PRODUCE / GATE / READBACK — the shipped writers only
  capture.mjs              the browser round: press, reload, measure, shoot
```

`collapse-to-one-org.mjs` is there because `pnpm setup:dev` bootstraps an
organization and the sign-up route creates another, and the blog-artifact
materializer is single-tenant: it refuses to resolve an owner while two exist. The
lane joins the existing organization rather than working around the refusal.
