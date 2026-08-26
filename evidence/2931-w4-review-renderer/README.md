# cinatra#2931 (W4) — the review card, photographed on the merged head

Every picture in this directory was taken on **2026-08-26**, on the branch head
with `main` `1fb86826b078` merged in, on a live dev instance, against **one real
agent run on the real provider** (`CINATRA_TEST_LLM_PROVIDER` unset — no scripted
provider, no stub, no seeded row). The whole previous capture set is **deleted**:
it was taken on the pre-merge base, and the merge changed the very thing the
first two cells are about, so nothing from it stays in the proof set.

## What the pictures are graded against

The ratified drawings, pinned at design commit **`458fb7ffce6c`**:

| Drawing | Section | What it fixes |
|---|---|---|
| `specs/app-lifecycle-cards.html` | **§II** | the review card in the thread; the **placeholder before it**; the in-place swap; one composer; no prompt window inside a conversation; no run-page link |
| `specs/app-artifact-review.html` | **§I** | the run surface: the rail, the placeholder in the run detail, and a gate opened **in the run detail** |
| `specs/app-artifact-review.html` | **§IV** | the target's immutable header and its representation slot |
| `specs/app-artifact-review.html` | **§V** | renderer provenance and the never-blank floor |
| `specs/app-artifact-review.html` | **§VI** | the decision floor — approve / reject / comment, over the rationale field |

## What the merged head changed, and why the set was re-shot

`main` `1fb86826b078` brought the run card's **slot** (cinatra#2997): one box in
the turn that holds either the placeholder or the review screen, a shared reader
(`useRunReviewSlot`) that both run panels use, the run's own seed route as that
reader's source, and the run page's panel reading the same slot. It also removed
the `Open the run page` link. The previous round graded the slot a **DEVIATION**
against §II and reported that the replacement never happened at all. On this head
it does. Both readings are photographed below, on the same run, in one browser
session that was never reloaded.

## The runtime, said first

* Head under proof: `29c5a866c028557e3a03fd846f8e4143a0fd4f0e`.
* Next.js dev on `http://localhost:3000`; the agent runtime container on `:3010`,
  reaching the app back at `http://host.docker.internal:3000`.
* The third-party page for the widget cell is served by a plain static server on
  `http://127.0.0.1:8088` while the app answers on `http://localhost:3000` —
  different origins **and different sites**. That distinction is measured, not
  asserted: see `RUN-READBACK.md`.
* The provider key was never written to a file: it lives in the database, sealed
  through the app's own provider form. `usage_events` carries the real calls.
* **No row was inserted by hand.** The only direct SQL this round issued was
  `SELECT`s for the readback. Every state change came from a control pressed in
  the browser.

## The run behind the pictures

| | |
|---|---|
| run | `55c141ee-42b0-4ccb-b3ce-98568a8293b9`, started from **one** turn typed into the chat (no `@`-mention), completed `11:05:46.591Z` |
| artifact | `ac090f07-8c76-46ad-9d07-8612216c6ce7`, type `@cinatra-ai/blog-post-artifact:post` |
| representation | revision `8c011e7e-903e-446e-84df-b415d8b7a194`, revision number **1**, form `file`, mime **`text/markdown`**, 19 799 bytes |
| review gate | `07e89419-6da7-412b-9b8f-63a6e9da5d1a`, minted `11:06:11.412Z`, **approved `11:14:31.553Z`** |
| audit row | `renderer_kind = first-party`, `renderer_package = NULL`, `renderer_digest = NULL` |

## The swap, measured

A `MutationObserver` on the card's own `data-run-review-slot` attribute recorded
every change of reading in the page that drew it. The chat page and the run page
each carried their own observer, and neither page was reloaded after the turn
was typed.

| when (UTC) | what | source |
|---|---|---|
| `11:01:02.977` | the ONE turn is typed into the chat | driver |
| `11:05:45.582` | the blog draft materializes — `@cinatra-ai/blog-post-artifact`, phase `finalized` | row |
| `11:05:46.401` | artifact + representation revision written | row |
| `11:05:46.591` | **the run terminates** | row |
| `11:05:47.173` | the slot reads `working` — the placeholder, in both hosts within 1 ms of each other | observer |
| `11:06:11.412` | the review gate is minted — **24.8 s after the run already ended** | row |
| `11:06:19.399` | the slot reads `review` — **8.0 s after the gate exists, 32.8 s after the run ended** | observer |
| `11:06:20.770` | the review card has mounted inside it | observer |

**No pull turn was sent.** Exactly one message was typed into the conversation —
the brief at `11:01:02.977` — and the swap happened 5 minutes later with the page
untouched. The four `Continue` presses in the log are the run's **own** gates (a
setup card and the schedule step), all of them before the run began working; the
last was at `11:02:37.900`, three minutes before the swap.

**And no completion notice was painted in front of the review.** The observer
records `working` → `review` with nothing in between. A completion notice removes
the slot attribute entirely, so it would have appeared in that record as a third
reading. It does not.

**The named limit stays, and is not fixed here.** The gate is still minted
**after** the run has terminated (24.8 s). What the merged head changes is that
the slot now HOLDS the placeholder across that window instead of flipping to a
completion notice, so the reader sees the placeholder become the review rather
than a "Run complete" that a review then has to displace. The minting order is
upstream of this slice and is left alone.

## The pictures, graded

Full-window captures, viewport **1440×900**, `deviceScaleFactor: 2`, **light and
dark**, taken through the app's own `Toggle theme` control. The dev runtime's
`<nextjs-portal>` overlay is removed before each shot — dev-server furniture, not
application UI. Every cell's required reading was asserted **immediately before
and immediately after** the shutter; a cell whose reading slipped was discarded
and re-taken, never banked.

### W0 — the slot while the run works, in the conversation

`captures/W0__placeholder__chat_thread__working__light.png` ·
`captures/W0__placeholder__chat_thread__working__dark.png`

**Requires** — §II: *"A run that will ask for a review carries, in the slot the
review card will fill, the run progress card — and while the run is working that
card is a placeholder for the review screen: the card frame, and a spinning
icon… It names no status, reports no result and draws nothing to press."* and
*"The card carries no link to the run page."*

**Shows** — in the assistant's turn, one card frame holding a spinning icon over
the empty review screen. **No heading, no status pill, no result sentence, no
control, no `Open the run page` link.** Counted on the screen at the moment of
each shot: `data-run-review-slot="working"`, 1 placeholder root, **0** card
roots, **0** Approve / **0** Reject / **0** Comment, `Re-check` absent,
`Open the run page` absent, `pending approval` absent — and all of it still true
when re-counted after the shutter.

**Verdict: PASS.** *Said plainly:* the assistant's own prose **below** the card
does name the run's state ("paused for human approval/input", an ITEM/DETAILS
table). That is the assistant's message, not the card; §II's four negatives are
about the card in the slot, and the card says nothing.

### W1 — the same slot after the output

`captures/W1__review-card__chat_thread__pending__light.png` ·
`captures/W1__review-card__chat_thread__pending__dark.png`

**Requires** — acceptance 1, *"A markdown draft under review renders through its
text rung in the chat"*; §II, *"The placeholder is replaced, in place, by the
review… the same slot, in the same turn. It happens on its own: the reader
neither asks for the card nor presses anything to bring it"*, and *"the composer
at the foot of the thread is where it is typed. No prompt window is drawn inside
a conversation"*; §IV, the immutable header; §VI, *"exactly three affordances"*.

**Shows** — the **same box**, now `Review requested` / `Awaiting your decision`:
the title `Why small teams lose a day a week to status reporting` with the
`Blog Post Artifact` chip; the mono line `@cinatra-ai/blog-post-artifact:post ·
revision 8c011e7e-903… · pinned · Ownership: organization · Visibility:
organization · text/markdown · updated 2026-08-26T11:05:46.401Z`; the target
**rendered as prose** through the host's own text rung; `Expand`; the
bound-composer row (`Replying to this review`); `DECISION RATIONALE (optional on
approve, expected on reject)` over `Comment` `Reject` `Approve`; one composer at
the foot of the thread; **no prompt window and no run-page link.** Counted:
`data-run-review-slot="review"`, 1 card root, 1 target island, island
`body=1 empty=0 targets=1`, **0** provenance regions, **0** `no-semantic-renderer`
diagnostics, **0** `Floor · structured data` chips, **0** Preview, **0** Download.

**Verdict: PASS**, and the *"it happens on its own"* clause is settled by the
observer record above rather than by the picture alone.

*The previous round's named limit is gone:* that round's producer wrote its whole
JSON envelope into the `text/markdown` representation, so the rung faithfully
rendered JSON. This run's producer wrote prose, and the rendered pane holds the
article.

### W2 — the same window, in the run detail

`captures/W2__placeholder__run_page__working__light.png` ·
`captures/W2__placeholder__run_page__working__dark.png`

**Requires** — §I: *"A run that will ask for a review carries, in the run detail,
the run progress card — and while the run is working that card is a placeholder
for the review screen: the card frame, and a spinning icon… It names no status,
reports no result and draws nothing to press."*

**Shows** — the run detail beside the rail, carrying the same wordless
placeholder. Same counts as W0, on the run page's own panel. Taken **inside the
same working window as W0**, two seconds apart, so the two hosts are the same
moment of the same run rather than two lucky windows.

**Verdict: PASS.** *One deviation, named:* while the run works, the rail carries
`1 Schedule` **alone**. §I draws the rail with the run's ordered steps and the
gate entry inline; this surface adds no `Review` entry on the plain run route,
and the review route does (W5). That is the rail's content, not the placeholder,
and it is pre-existing.

### W3 — the run detail after the output

`captures/W3__review-card__run_page__pending__light.png` ·
`captures/W3__review-card__run_page__pending__dark.png`

**Requires** — acceptance 1, *"on the run page"*; §I, *"a gate step opens the
gate's own surface in place — a pending review renders the review gate right here
in the run detail, under the same rail, never as a standalone document"*, and
*"It is replaced, in place, when the output is generated… It happens on its own:
there is nothing for the reader to open or press to bring it."*

**Shows** — the same box in the run detail, now the gate: the same header, the
same pinned line, the target rendered through the text rung, `Expand`, and the
decision floor. Counted: 1 card root, 1 island, island `body=1 empty=0
targets=1`, 0 floor diagnostics. The observer recorded this page's swap at
`11:06:19.409` — 10 ms after the chat's, with nothing pressed on either page.

**Verdict: PASS**, with the same rail deviation as W2.

### W5 — the review route

`captures/W5__review-card__review_page__pending__light.png` ·
`captures/W5__review-card__review_page__pending__dark.png`

**Requires** — acceptance 1, *"and on the review page"*; §I's *"never as a
standalone document"*; §IV, §V, §VI.

**Shows** — the gate's own route, which renders the same run surface with the
rail `1 Schedule` / `2 Review` and `Review` selected, so §I holds on this route
too. Same header, same pinned revision, the target in `RENDERED` beside
`RAW SOURCE`, the decision floor, and the run's prompt window at the foot.
0 Preview, 0 Download, 0 floor diagnostics.

**Verdict: PASS.** *One copy deviation, pre-existing:* §VI words the prompt
window *"Ask Cinatra about this review, or ask for changes to the work…"*; the
surface says *"Ask Cinatra to suggest edits to the fields above…"*.

### W7 — the same review inside a third-party application

`captures/W7__review-card__site_widget__pending__light.png` ·
`captures/W7__review-card__site_widget__pending__dark.png`

**Requires** — acceptance 1, *"inside a third-party application with no login
prompt"*; acceptance 2, *"The fallback face is gone from the card."*

**Shows** — the widget mounted in a frame on the third-party page, holding **this
run's** review: the same header, the same pinned revision `8c011e7e-903…`, the
target **rendered as prose** through the text rung, `Expand`, and `Comment`
`Reject` `Approve` over the rationale field, with the widget's own composer
beneath. **No sign-in control and no login prompt anywhere in the frame**
(`data-embed-signin` count 0, no sign-in copy). No provenance strip, no field
table, no `Floor · structured data`, no Preview, no Download.

Cross-site is **measured, not asserted**: the reader signed in through the
embed's **own hosted-PKCE popup**, so an app-origin session cookie exists in the
browser (`better-auth.session_token`, `domain=localhost`, `SameSite=Lax`), and
the island document request still went out with `cookie: absent`; the twelve
lifecycle resolves carry `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)`,
`x-cinatra-widget-origin: http://127.0.0.1:8088`. The wire table is in
`RUN-READBACK.md`.

**Verdict: PASS.** Two things are said plainly rather than framed away:

1. **The framing.** The widget conversation is a **kept** thread and already held
   earlier reviews, and the host page mounts the frame as a fixed 1180 px box, so
   the picture is scrolled to the card under proof — named by its pinned revision
   in the picture itself. Below the frame, the host page's own bridge log is
   visible: it names the frame's `src` and the `cinatra.embed.ready` →
   `cinatra.embed.context` handshake, which is host-page content, outside the
   frame.
2. **Why the swap is not pictured here.** The run panel deliberately withholds
   the slot's review on this host: the card's host declaration is `run_card`, a
   cookie-session host, so a panel mounted inside a widget frame would resolve
   with the frame's ambient cookie rather than the reader's own credential
   (`packages/agents/src/agentic-run-panel.tsx`, `widgetHostedPanel`). The card
   here is therefore reached through the widget conversation, and the cell proves
   what it claims to prove: the card renders, cross-site, with no login prompt.

### W9 — the decision, and the row it wrote

`captures/W9__review-card__review_page__decided__light.png` ·
`captures/W9__review-card__review_page__decided__dark.png`

**Requires** — acceptance 1, *"recorded as rendered"*; §VI, *"Approve and Reject
are terminal — they resolve the gate and hand the run its outcome."*

**Shows** — the same gate after **Approve** was pressed for real in the browser at
`11:14:30.782Z`: `Approved by Ops Operator Two`, `The gate is resolved and the
run has been released to continue`, and the decision controls gone (0 Approve,
0 Reject, 0 Comment).

```
artifact_review_audit
  gate_id                     07e89419-6da7-412b-9b8f-63a6e9da5d1a
  run_id                      55c141ee-42b0-4ccb-b3ce-98568a8293b9
  artifact_id                 ac090f07-8c76-46ad-9d07-8612216c6ce7
  representation_revision_id  8c011e7e-903e-446e-84df-b415d8b7a194
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  created_at                  2026-08-26 11:14:31.552523+00
```

**Verdict: PASS** — settled by the row, not by the screen alone, and the
production proof of `core__0097`: without the widened CHECK this insert rolls the
whole decision back and the gate never reaches `resolved`.
*One deviation, named:* §I says a resolved gate opens read-only with *"what was
decided, **and the reviewed target(s)**, kept for the run's audit trail"*. The
surface shows what was decided; the reviewed target is not drawn beside it.
Pre-existing, and outside this slice's renderer.

## Acceptance 3 — the floor gate

Run on this branch, on this checkout:

```
$ pnpm gate:artifact-review-floor
[artifact-review-floor] 2 of 28 artifact types would land on the metadata floor under review (25 packs scanned; defensive states excluded).
    floor: @cinatra-ai/dashboard-artifact:dashboard [@cinatra-ai/dashboard-artifact] form application/vnd.cinatra.dashboard+json
    floor: @cinatra-ai/drupal:node [@cinatra-ai/drupal-artifacts] form text/html
[artifact-review-floor] OK — no new fallbacks (2 baselined; the baseline may only shrink).
```

The two counted types are the two the plan defers by name, and they are the
checked-in baseline the count may only shrink away from.

## The grading table

| Cell | Host | Light | Dark | Verdict |
|---|---|---|---|---|
| W0 placeholder | chat thread | ✔ | ✔ | **PASS** — frame + spinner, no status, no result, nothing to press, no run-page link |
| W1 review card | chat thread | ✔ | ✔ | **PASS** — swapped in place, rendered through the text rung, one composer, no prompt window |
| W2 placeholder | run detail | ✔ | ✔ | **PASS** — same window as W0; rail carries `Schedule` alone (deviation, named) |
| W3 review card | run detail | ✔ | ✔ | **PASS** — gate in the run detail, swapped on its own; same rail deviation |
| W5 review card | review route | ✔ | ✔ | **PASS** — rail + gate + prompt window; prompt-window copy deviates from §VI |
| W7 review card | third-party application | ✔ | ✔ | **PASS** — rendered, no login prompt; cross-site measured on the wire |
| W9 decided | review route | ✔ | ✔ | **PASS** — `renderer_kind = first-party`; resolved reading omits the reviewed target (deviation, named) |

## What this round does NOT claim

1. **That the gate is minted before the run terminates.** It is not — 24.8 s
   after. Issue-tracked, stated, not fixed here.
2. **A widget-started run reaching a review gate,** or the automatic swap on the
   widget host — the panel withholds it there by design, with the file named
   above.
3. **The rail's contents on the plain run route,** and the resolved gate's
   omission of the reviewed target — both named above, both pre-existing.
