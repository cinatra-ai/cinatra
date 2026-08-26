# cinatra#2931 (W4) — the review card, re-photographed against the ratified drawings

Every picture in this directory was taken on **2026-08-26**, on a live dev
instance, against **real agent runs on the real provider**
(`CINATRA_TEST_LLM_PROVIDER` unset — no scripted provider, no stub, no seeded
row). The earlier capture set that stood here was **deleted**: it predates the
drawings this round grades against, so nothing stale is left in the proof set.

## What the pictures are graded against

The ratified drawings, pinned at design commit **`458fb7ffce6c`**:

| Drawing | Section | What it fixes |
|---|---|---|
| `specs/app-lifecycle-cards.html` | **§II** | the review card in the thread; the placeholder before it; one composer; no prompt window inside a conversation; no run-page link on the card |
| `specs/app-artifact-review.html` | **§IV** | the target's immutable header and its representation slot |
| `specs/app-artifact-review.html` | **§V** | renderer provenance and the never-blank floor |
| `specs/app-artifact-review.html` | **§VI** | the decision floor — approve / reject / comment, with the rationale field |
| `specs/app-artifact-review.html` | **§I** | the run surface: the rail, and a gate opened **in the run detail** |

## The runtime, said first

* Head under proof: `f7e9565975d6c80fe160a3ee0605b7d4d435829a` (this branch, merged onto `main` `a790f71eb653`), on a fresh checkout with its own database, cloned from a sibling development database and migrated (`core__0097` applied by the app's own migrator).
* `pnpm dev` (Next.js dev, Turbopack) on `http://localhost:3000`; the agent runtime container on `:3010`, which reaches the app back at `http://host.docker.internal:3000`.
* The third-party page for the widget cell is served by a **plain static server on `http://127.0.0.1:8088`** while the app answers on `http://localhost:3000`. Different origins **and different sites**: a cookie set for `localhost` cannot ride a subresource of a `127.0.0.1` top-level document. That distinction is the whole widget cell, and it is **measured**, not asserted — see `RUN-READBACK.md`.
* The provider key was never written to a file here: it lives in the database, sealed through the app's own provider form. `usage_events` carries the real calls.
* No row was inserted by hand. The only direct SQL this round issued was `CREATE DATABASE` for this instance's own database and `SELECT`s for the readback. The widget instance row and its connect-site were written by the two **shipped** writers the CMS OAuth exchange itself calls (`evidence/2754-island-wire/drivers/02-seed-widget-site.mts`, run unmodified).

## The run behind the pictures

| | |
|---|---|
| run | `06474965-644f-4ffa-9c6a-c6c1ebde492b`, started from a turn typed into the chat (no @-mention), completed `07:22:02.333Z` |
| artifact | `4c0cada5-04e4-4d55-a7d5-9df172d5da77`, type `@cinatra-ai/blog-post-artifact:post` |
| representation | revision `34d8be8d-09f2-45ff-ad2e-bccf7237a130`, revision number **1**, declared mime **`text/markdown`**, 5 789 bytes |
| review gate | `28ebc08b-45a2-4210-818e-0f01a6d7e9ef`, minted `07:22:10.830Z`, **approved `07:58:20.849Z`** |
| audit row | `renderer_kind = first-party`, `renderer_package = NULL`, `renderer_digest = NULL` |

A second run, `f98093d7-c16d-4f8f-aeea-244ddbc34c04`, was started to photograph
the slot **while a run is working** (cell W0) and is also the second card in the
widget frame. Its gate is left pending on purpose.

## The pictures, graded

Full-window captures, viewport **1440×900**, `deviceScaleFactor: 2`, **light and
dark**, taken through the app's own `Toggle theme` control. The dev runtime's
`<nextjs-portal>` overlay is removed before each shot — dev-server furniture, not
application UI.

### W1 — the conversation

`captures/W1__review-card__chat_thread__pending__light.png` ·
`captures/W1__review-card__chat_thread__pending__dark.png`

**Requires** — acceptance 1: *"A markdown draft under review renders through its
text rung in the chat"*; §IV: *"a header that names what is under review and
fixes it in place: the artifact's display title over a mono meta line carrying
its type, the pinned representation revision … and the read-only row facts the
host authorized"*; §VI: *"exactly three affordances: Approve (primary), Reject
(destructive), and Comment"*; §II: *"the composer at the foot of the thread is
where it is typed. No prompt window is drawn inside a conversation"*; *"The card
carries no link to the run page."*

**Shows** — the review card in the assistant's turn. Header
`Why weekly status reports quietly cost small teams a day a week` with the
`Blog Post Artifact` chip; the mono line
`@cinatra-ai/blog-post-artifact:post · revision 34d8be8d-09f… · pinned · Ownership: organization · Visibility: organization · text/markdown · updated 2026-08-26T07:22:19.717Z`;
the target rendered through the host's own text rung (`RENDERED`, and `RAW
SOURCE` beside it in the wider frames); `Expand`; the bound-composer row
(`Replying to this review`); `DECISION RATIONALE (optional on approve, expected
on reject)` over `Comment` `Reject` `Approve`; one composer at the foot of the
thread and **no prompt window in the conversation**; **no link to the run page on
the card**. Counted: 1 card root, 1 target island, island `body=1 empty=0
targets=1`, **0 provenance regions, 0 `no-semantic-renderer` diagnostics, 0
`Floor · structured data` chips, 0 Preview links, 0 Download links.**

**Verdict: PASS** for the rung, the header, the floor and the composer.
**One named limit, not this slice's doing:** the producer wrote its whole JSON
envelope into the `text/markdown` representation, so the text rung faithfully
renders that envelope rather than prose. The card shows exactly what the
representation holds — which is the claim under test — but a reader wanting the
article reads JSON. That belongs to the artifact's producer, not to the card.

### W0 — the slot before the card

`captures/W0__placeholder__chat_thread__working__light.png` ·
`captures/W0__placeholder__chat_thread__working__dark.png`

**Requires** — §II: *"A run that will ask for a review carries, in the slot the
review card will fill, the run progress card — and while the run is working that
card is a placeholder for the review screen: the card frame, and a spinning icon
… It names no status, reports no result and draws nothing to press."* and *"The
placeholder is replaced, in place, by the review … It happens on its own."*

**Shows** — the slot at `07:43:04Z`, while run `f98093d7` was working: the run
progress card carrying a **status pill** (`pending approval`), a **result
sentence** (`Run paused — awaiting human approval before continuing.`), two
**controls** (`Review approval`, `Re-check`) and an `Open the run page` link
beneath it. No spinning icon, no bare card frame.

**Verdict: DEVIATION** — three of the drawn placeholder's four negatives fail
(it names a status, it reports a result, it draws things to press).

**And the replacement never happens.** In both runs the review gate is minted
**after** the run has already terminated — `07:22:02.333Z` → gate `07:22:10.830Z`,
and `07:43:14.199Z` → gate `07:43:19.183Z` (`RUN-READBACK.md`). So no run ever
parks at a review moment, the slot flips straight from the progress card to
`Run complete`, and §II's *"replaced, in place, by the review … on its own"* is
not what the conversation does. The card in W1 was reached by asking the
conversation for it. **This is upstream of this slice** — which renderer the card
mounts is not in question when the card is not put in the slot — and it is filed
here as a defect rather than papered over.

### W3 — the run page

`captures/W3__review-card__run_page__pending__light.png` ·
`captures/W3__review-card__run_page__pending__dark.png`

**Requires** — acceptance 1: *"… on the run page"*; §I: *"a gate step opens the
gate's own surface in place — a pending review renders the review gate (§III–§VII)
right here in the run detail, under the same rail, never as a standalone
document."*

**Shows** — the run surface with the rail `1 Schedule` / `2 Review`, the `Review`
entry selected, and the gate drawn in the run detail beside it: `Review
requested` / `Awaiting your decision`, the same immutable header and pinned line,
the target rendered in `RENDERED` beside `RAW SOURCE`, `Expand`, the decision
floor, and the run's prompt window at the foot. 1 card root, 1 island, island
`body=1 empty=0 targets=1`, 0 floor diagnostics.

**Verdict: PASS.** *(This corrects the previous round's REFUSED reading of this
host: the gate is reached by selecting its entry on the rail, exactly as §I
draws it.)*
**One copy deviation, pre-existing:** §VI words the prompt window *"Ask Cinatra
about this review, or ask for changes to the work…"*; the surface says *"Ask
Cinatra to suggest edits to the fields above…"*.

### W5 — the review page

`captures/W5__review-card__review_page__pending__light.png` ·
`captures/W5__review-card__review_page__pending__dark.png`

**Requires** — acceptance 1: *"… and on the review page"*; §IV, §V, §VI as above.

**Shows** — the gate's own route for this review, which renders the same run
surface with the `Review` step selected (so §I's *"never as a standalone
document"* holds on this route too). Same header, same pinned line, same rendered
target, same floor. 1 card root, 1 island, `body=1 empty=0 targets=1`, 0 floor
diagnostics, 0 Preview / Download.

**Verdict: PASS.**

### W7 — inside a third-party application

`captures/W7__review-card__site_widget__pending__light.png` ·
`captures/W7__review-card__site_widget__pending__dark.png`

**Requires** — acceptance 1: *"inside a third-party application with no login
prompt"*; acceptance 2: *"The fallback face is gone from the card."*

**Shows** — the top-level document is the third-party page (`A third-party site
(a plain page on another origin, not the Cinatra app)`), and the Cinatra widget
is mounted in its frame. Inside it: `Review requested` / `Awaiting your
decision`, the same header and pinned line for the same artifact and the same
pinned revision, the target **rendered** through the text rung, `Expand`, and the
decision floor `Comment` `Reject` `Approve` over the rationale field. **No
sign-in control and no login prompt anywhere in the frame** (`data-embed-signin`
count 0). No provenance strip, no field table, no `Floor · structured data`, no
Preview and no Download.

The reader is signed in through **the embed's own hosted-PKCE popup** — a
top-level window on the app origin — so a session cookie exists in the browser,
and the island document request still went out with **no cookie at all**
(`cookie: absent`, `x-cinatra-widget-user-token: absent` on the document;
`cookie: absent`, `widgetUserToken: present (cwu_)`,
`x-cinatra-widget-origin: http://127.0.0.1:8088` on both lifecycle resolves).
The wire is in `RUN-READBACK.md`.

**Verdict: PASS.**

**Where the run was started, and why.** The turn that pulls this card was typed
into the widget's own composer and answered by the real model; the run itself was
**not** started from the widget, because it cannot be. A widget delegation gets a
**closed, kind-keyed** tool allowlist: the kind's single `*_content_editor_run`
CMS-edit primitive plus four **read-only** lifecycle pulls
(`packages/mcp-server/src/delegated-widget-tool-policy.ts:63`, `:84`, `:103`).
`artifact_review_gate_render` is in that read set, which is why the card can be
reached here; no agent-run start primitive is in it at all, so no widget-started
run exists that could reach a review gate. The cell is therefore delivered as the
brief's second branch: **this run's review, pictured where the conversation can
reach it.**

### W9 — the decision, and the row it wrote

`captures/W9__review-card__review_page__decided__light.png` ·
`captures/W9__review-card__review_page__decided__dark.png`

**Requires** — acceptance 1: *"recorded as rendered"*; §VI: *"Approve and Reject
are terminal — they resolve the gate and hand the run its outcome."*

**Shows** — the same gate after **Approve** was pressed for real in the browser
at `07:58:19.941Z`: `Approved by Ops Operator Two`, `The gate is resolved and the
run has been released to continue`, and the decision controls gone (0 Approve, 0
Reject, 0 Comment).

```
artifact_review_audit
  gate_id                     28ebc08b-45a2-4210-818e-0f01a6d7e9ef
  run_id                      06474965-644f-4ffa-9c6a-c6c1ebde492b
  artifact_id                 4c0cada5-04e4-4d55-a7d5-9df172d5da77
  representation_revision_id  34d8be8d-09f2-45ff-ad2e-bccf7237a130
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  created_at                  2026-08-26 07:58:20.84878+00
```

**Verdict: PASS** — settled by the row, not by the screen alone. The row is also
the production proof of `core__0097`: without the widened CHECK this insert rolls
the whole decision back and the gate never reaches `resolved`.

## Acceptance 3 — the floor gate

Run on this branch, on this checkout:

```
$ pnpm gate:artifact-review-floor
[artifact-review-floor] 2 of 28 artifact types would land on the metadata floor under review (25 packs scanned; defensive states excluded).
    floor: @cinatra-ai/dashboard-artifact:dashboard [@cinatra-ai/dashboard-artifact] form application/vnd.cinatra.dashboard+json
    floor: @cinatra-ai/drupal:node [@cinatra-ai/drupal-artifacts] form text/html
[artifact-review-floor] OK — no new fallbacks (2 baselined; the baseline may only shrink).
```

Exit status 0. The two counted types are the two the plan defers by name, and
they are the checked-in baseline the count may only shrink away from.

## What this round does NOT claim

1. **The placeholder, and the in-place replacement** — W0. Filed above with the
   row timestamps that cause it.
2. **A widget-started run reaching a review gate** — impossible on the shipped
   policy, with the file and lines that make it so (W7).
3. **Prose in the rendered pane** — the producer's envelope, named in W1.
