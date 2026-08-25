# cinatra#2931 W4 — the review card includes the artifact's renderer

The same markdown draft rendered on its own artifact page and showed **"no type
renderer resolved"** under review — a technical notice, a table of fields, and a
Preview and a Download link. Inside a third-party application those two links
were dead ends that demanded a login which never exists there.

This directory is the visual evidence that the card now includes exactly the
renderer the page includes, taken on a live instance, on real runs, against the
real provider.

## The runtime the pictures were taken on

The real surface, never a fixture route: `pnpm dev` (Next.js / Turbopack,
`CINATRA_RUNTIME_MODE=development`) on a dedicated lane database and a dedicated
lane Redis, with the branch's own extension tree synced at its lock SHAs
(`node scripts/ci/sync-dev-extensions.mjs --pinned`, 112 packages) before the
boot. The agent runtime (WayFlow) was brought up from the checkout's own compose
profile. Viewport 1228 wide at device scale factor 2 for this round's own
driver; the widget cells keep the shipped island driver's own frame (1056 wide).

`CINATRA_TEST_LLM_PROVIDER` was never set. The instance's LLM provider was
configured through the app's own provider form, so the app sealed the connection
itself, and the drafts were written by that provider through the shipped
`/api/llm-bridge` step.

## The path the pictures were taken on

The shipped path, end to end. Nothing wrote a gate by hand.

1. A turn typed into `/chat` asked for the Blog Draft Writer Agent. The
   conversation's assistant created the run.
2. The run's setup card and its schedule moment were answered on the screens the
   product shows them on.
3. The agent wrote a **`text/markdown`** artifact — the exact row that used to
   floor: `@cinatra-ai/blog-post-artifact:post` ships no renderer of its own.
4. The app's own review-orchestration sweep minted the `artifact_review_gates`
   row and its review task.
5. The gate's card was opened on each host in turn, and the artifact's own page
   was opened beside it for the same artifact at the same pinned revision.
6. **Approve** was pressed for real on the review page, and the audit row was
   read back out of the database.

`RUN-READBACK.md` carries every row with its timestamp.

## The cells

| Cell | Host | Ground | What is visibly on screen |
|---|---|---|---|
| `W1__review-card__chat_thread__pending` | chat thread | light | The card in the conversation, the markdown target **rendered**, **no** provenance strip above it, **no** "no renderer resolved" sentence, **no** field table, **no** Preview / Download. The decision floor reads `Comment` `Reject` `Approve`. |
| `W2__review-card__chat_thread__pending__dark` | chat thread | dark | The same card on the dark ground, set through the app's **own** theme control and verified on the pixels. |
| `W3__review-card__site_widget__pending` | third-party page | light | The same card inside the embed on a page served by **another site**, the island painted, **no login prompt anywhere in the frame**. |
| `W4__review-card__site_widget__pending__expanded` | third-party page | light | The same third-party card with the island's own **Expand** pressed. |
| `W5__review-card__run_card__not-parked` | run detail | light | **A refusal, not a pass.** See below. |
| `W7__review-card__page_gate_region__pending` | review page | light | The gate region: the draft rendered as prose, the decision floor beneath it, the prompt window at the foot. |
| `W8__review-card__page_gate_region__pending__dark` | review page | dark | The same, dark ground, through the app's own theme control. |
| `W9__artifact-page__detail__markdown` | artifact page | light | The **page control**: the artifact's own page for the SAME artifact at the SAME pinned revision. Card and page show the same thing — the whole claim, side by side. |
| `W10__review-card__page_gate_region__decided` | review page | light | The same gate after a real press of **Approve**: "Approved by Lane Reviewer", decision controls gone. Its audit row reads `renderer_kind = first-party`. |
| `W11__review-card__site_widget__refused` | third-party page | light | The **negative control** from the shipped island driver: one character of the island credential flipped. The island draws its single empty answer, the card is unmoved, and no sign-in form appears in third-party chrome. |

## The before, and where it is

The `site_widget` cells were taken with the **unmodified** shipped island driver
`evidence/2754-island-wire/drivers/03-capture-island.mjs`, so W3 is directly
comparable to that round's C1 on `main`. Its README describes what C1 shows
there, in its own words: *"the provenance chip `Floor · structured data`, and the
metadata floor (`type` / `mime` / `revision` + `Preview` `Download`)"*. Every one
of those is gone from W3, on the same host, through the same driver, and the
draft is in their place.

## What is NOT here, and why

**`run_card` — the review card on the run DETAIL page (W5).** On this instance no
run ever parked at a review moment: the sweep minted each gate **after** its run
had already terminated, so the run detail draws its terminal card and the review
card is not on that screen. W5 records that, with the count taken on the screen
(zero card roots). This is a lifecycle question about when a run parks, not about
which renderer the card includes, and it is filed here as an open block rather
than papered over.

**A dark ground for the widget cells.** The shipped island driver takes no theme,
and this round did not modify it — its records are worth more unmodified than a
dark picture is worth.

**The `no-renderer` state (the maintainer's Q3).** Not reachable truthfully on
this instance: every artifact type the run could produce resolves either a
package renderer or the host's text rung, so nothing floors. The Q3 wording is
pinned by a unit test instead
(`src/app/artifacts/[id]/__tests__/review-target-mount.test.tsx`), which asserts
the exact line and that nothing is drawn beneath it.

## Two things the pictures show that this slice does not fix

* The meta line still prints **`organization · organization`** — the plan's own
  honesty fix, which this slice did not make. It is visible in W1, W3, W7 and W8.
* The card renders the artifact's real bytes. Run 2's blog-post artifact holds
  the agent's whole JSON envelope, so W1/W2/W3 show that envelope rendered;
  run 3's holds clean markdown, so W7/W8/W9 read as an article. The card is
  faithful in both — what differs is what the agent stored.
