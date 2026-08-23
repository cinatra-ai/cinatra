# cinatra#2931 W4 — the review card includes the artifact's renderer

The same markdown draft rendered on its own artifact page and showed **"cannot
render"** under review. The card resolved its renderer by the artifact page's
ladder minus the ladder's last rung — the first-party renderer for declared text
forms — so a blog draft, an email body, a note: every text artifact reached the
reviewer as a technical notice with a Preview and a Download link instead of as
the work itself. Inside a third-party application those two links were dead ends
that demanded a login which never exists there.

This directory is the visual evidence for the fix. **It is not filled in yet.**

## STATUS: THE CAPTURES ARE OWED

The code and the tests for this slice were produced on a machine with **no
browser and no dev server** — a tests-only host. Nothing in this directory was
photographed, and no claim below is proven until it is. Every cell in
`PLAN-WALK.md` is marked **NOT CAPTURED**, and the pull request is **not
presentable** until a capture lane on a UI host has replaced each of those marks
with a real image, a real record and a verdict read off the pixels.

What a capture lane must NOT do: fill a verdict from the test results, from the
diff, or from this document. A cell is graded by looking at the picture.

## The runtime the captures must be taken on

The real surface, never a fixture route: `pnpm dev` (Next.js / Turbopack,
`CINATRA_RUNTIME_MODE=development`) against a lane-private Postgres and Redis on
loopback, placeholder-only environment. Extensions synced pinned
(`node scripts/ci/sync-dev-extensions.mjs --pinned`) BEFORE the boot, so the
renderer registries resolve the universe the gate counts. Viewport 1228 wide,
device scale factor 2. The widget cells are taken inside a genuinely third-party
host page through the embed, signed in through the widget's own flow — never
through a first-party cookie borrowed from another tab.

## The path the pictures must be taken on

The shipped path, end to end. Nothing writes a gate by hand.

1. An agent run writes a **markdown** artifact (`text/markdown`) whose type ships
   no renderer of its own — the exact row that used to floor.
2. `sweepReviewOrchestration` mints the `artifact_review_gates` row and its
   review task.
3. The gate's card is opened on each of the four hosts in turn, and the artifact
   page for the SAME artifact and the SAME pinned revision is opened beside it.
4. A second target with a MIME nothing renders (no package renderer, no declared
   text form) is opened for the negative control, so the "cannot render" reading
   is photographed where it is still correct.

## The cells this slice owes

Cell names follow the committed capture-record vocabulary
(`scripts/ci/lib/capture-record-contract.mjs`): the host token is one of
`chat_thread`, `site_widget`, `run_card`, `page_gate_region`.

| Cell | Requires |
|---|---|
| `W1__review-card__chat_thread__pending` | The markdown draft **rendered** inside the card in the conversation — the prose of the draft on screen, the provenance strip reading the build-time tier, and NO "No type renderer resolved" sentence, NO field table, NO Preview / Download links. |
| `W2__review-card__chat_thread__pending__dark` | The same card on the dark ground, opened fresh. Same reading. |
| `W3__review-card__site_widget__pending` | The same draft rendered inside the card in a third-party page, through the embed, **with no login prompt anywhere in the frame**. |
| `W4__review-card__site_widget__pending__dark` | The same, dark ground. |
| `W5__review-card__run_card__pending` | The same draft rendered in the run page's card. |
| `W6__review-card__run_card__pending__dark` | The same, dark ground. |
| `W7__review-card__page_gate_region__pending` | The same draft rendered in the review page's gate region, with its decision floor and the prompt window at the foot. |
| `W8__review-card__page_gate_region__pending__dark` | The same, dark ground. |
| `W9__artifact-page__detail__markdown` | The artifact page for the SAME artifact at the SAME pinned revision — the side-by-side proof that page and card now show the same thing. Not a lifecycle host; filed as the page control. |
| `W10__review-card__page_gate_region__no-renderer` | The negative control: a target nothing renders. The card says so and shows nothing else — no field table, no Preview / Download. |
| `W11__review-card__page_gate_region__defensive` | A defensive state (a target whose pinned revision is no longer live) keeps its own honest reading, and is NOT drawn as a fallback. |

## Grading

Each cell is graded against the ratified drawing on the engineering wiki page
`PLAN: Agents Lifecycle (A)` §4.2 — design `specs/app-lifecycle-cards.html` §II
(the card in the thread), §III (what the target shows), §IV (the review states) —
at the pinned design commit. **No screen is redrawn by this slice**: the card's
frame stays exactly as §4 draws it, and only what the target area shows changes.
A capture whose frame differs from the drawing is a FAIL, not a new drawing.

`PLAN-WALK.md` carries the per-cell `PLAN>` lines, copied verbatim, that each
capture is read against.
