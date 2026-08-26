# cinatra#2931 (W4) — the reviewed work, drawn by its own renderer, on the merged head

Every picture in this directory was taken on **2026-08-26**, on branch head
**`1c3649503d511942538c626d4ebc964e50e1302c`**, on a live dev instance, against
**two real agent runs on the real provider** — `CINATRA_TEST_LLM_PROVIDER` unset,
no stub, no scripted provider, no seeded row. The previous set is **replaced in
full**: it was shot before `main` pinned the corrected draft-writer agent, and the
draft the card renders is the very thing that pin changes.

## The pin, checked three ways before a single picture was taken

`main` now pins `@cinatra-ai/blog-draft-writer-agent` at
**`03a27f524d59f90f635ee98c1b5900c4bc9f7f6e`** — *"content holds the draft, not a
second copy of the answer"* — and this head carries that pin. On the instance that
took these pictures:

| what | reading |
|---|---|
| `cinatra-dev-extensions.lock.json` | `{"packageName":"@cinatra-ai/blog-draft-writer-agent","resolvedSha":"03a27f524d59f90f635ee98c1b5900c4bc9f7f6e"}` |
| the checked-out package (`sync-dev-extensions --pinned`) | `git rev-parse HEAD` = `03a27f524d59f90f635ee98c1b5900c4bc9f7f6e` |
| the installed package | `package.json` version **0.1.4** |
| the app's own boot scan | `[cinatra:extensions:agent] @cinatra-ai/blog-draft-writer-agent v0.1.4 upserted` |
| the registry row it wrote | `agent_templates.package_version = 0.1.4`, `updated_at 2026-08-26 16:14:02+00` |

And the draft the pictures show is the proof that reached the screen: the
persisted representation is **6 351 bytes of `text/markdown`** that begins
`## Where the hours actually go` and contains **zero** occurrences of
`"content":`. No JSON envelope appears in any target in this set.

## The two runs

The plan's six cells are not staged from one another. **One run is left pending**
and carries every pending reading; **a second run is decided** and carries the
decided one.

| | run | what it carries |
|---|---|---|
| **pending** | `579d0473-4b5d-40b9-9d79-8126560bbf06` | W0, W1, W3, W5, W7 — still `pending` in `artifact_review_gates` as this is written |
| **decided** | `8bfc1191-eeca-4b6a-ac86-a636f476c28e` | W9 — Approve pressed for real in the browser |

Both were started by **one** turn typed into the chat (no `@`-mention). Every
`Continue` in the log is one of the run's **own** gates — a setup card and the
schedule step — pressed in the browser before the run began writing.

## The pending run, measured

A `MutationObserver` on the card's own `data-run-review-slot` attribute recorded
every change of reading. The conversation and the run page each carried their own
observer and **neither page was reloaded after the turn was typed.**

| when (UTC) | what | source |
|---|---|---|
| `16:45:44.290` | the ONE turn is typed into the conversation | driver |
| `16:46:05.134` | the run row is created | row |
| `16:46:10.663` · `16:46:38.105` · `16:47:04.418` | the run's own gates are answered (setup card, schedule step, setup card) | driver |
| `16:49:28.147` | the draft model call — `blog-draft-writer-agent`, `openai gpt-5.5-2026-04-23`, 38 762 in / 1 816 out | ledger row |
| `16:49:29.202` | the blob is written — 6 351 bytes, `text/markdown` | row |
| `16:49:29.614` | representation revision **1** is written | row |
| `16:49:29.802` | **the run terminates** | row |
| `16:49:30.322` | the slot reads `working` — the placeholder, in both hosts within **1 ms** of each other | observer |
| `16:49:45.075` | the review gate is minted — **15.3 s after the run had already ended** | row |
| `16:49:46.823` | the slot reads `review` in the conversation — 1.7 s after the gate exists | observer |
| `16:49:47.929` | the review card has mounted inside it | observer |

**No pull turn was sent.** One message was typed, four minutes earlier, and the
swap happened with the page untouched. **No completion notice was painted in
front of the review**: a completion notice removes the slot attribute entirely, so
it would stand in that record as a third reading. It does not.

**The named limit stays, and is not fixed here.** The gate is still minted after
the run terminates (15.3 s). What this head changes is that the slot *holds* the
placeholder across that window instead of flipping to a completion notice. The
minting order is upstream of this slice.

## How the pictures were taken

Full-window captures, viewport **1440×900**, `deviceScaleFactor: 2`, **light and
dark**, through the app's own `Toggle theme` control on the app hosts. The dev
runtime's `<nextjs-portal>` overlay is removed before each shutter — dev-server
furniture, not application UI. Every cell's required reading was asserted
**immediately before and immediately after** the shutter; a frame whose reading
slipped was discarded, never banked.

The captures are graded against the plan's own drawings for these two screens —
**§II, the review card in the thread** (in the rendering that also fixes the
placeholder before it) and **§I, the agent run surface — steps, gates & detail**.
Each cell below quotes the plan sentence it is held to, then what the pixels show,
then a verdict. Where the surface differs from the drawing the difference is
**named**, never softened.

---

### W0 — the placeholder in the conversation, while the agent works

`captures/W0__placeholder__chat_thread__working__light.png` ·
`captures/W0__placeholder__chat_thread__working__dark.png`

**The plan says** — *"While the agent works, the conversation shows basically just
a card (maybe even an empty review screen) with a spinning icon."*

**§II requires** — *"A run that will ask for a review carries, in the slot the
review card will fill, the run progress card — and while the run is working that
card is a placeholder for the review screen: the card frame, and a spinning icon
… It names no status, reports no result and draws nothing to press."* and
*"The card carries no link to the run page. No `Open the run page` link is drawn
beneath it."*

**Shows** — in the assistant's turn, one card frame holding a spinning arc over
the empty review screen's outline. Counted on the screen at each shutter, and
re-counted after it: `data-run-review-slot="working"`, **1** placeholder root,
**0** card roots, **1** spinner, **0** Approve / **0** Reject / **0** Comment,
`Agentic Run Progress` absent, `Re-check` absent, `Open the run page` absent,
`pending approval` absent, **0** target islands.

**Verdict: PASS on every clause §II words.** *Two differences from the drawn
example, named:* the example draws the heading **`Agentic Run Progress`** above the
spinner and leaves the rest of the card empty; the shipped card draws **no
heading** and fills the frame with the **empty review screen's own outline**
instead. Both readings satisfy the section's sentence — frame plus spinner, no
status, no result, nothing to press — and the shipped one is the closer reading of
the plan's *"maybe even an empty review screen"*, but the example and the surface
are not the same picture and that is said here rather than glossed.

*Said plainly:* the assistant's own prose **below** the card does name the run's
state (`pending_approval`, a RUN / STATUS / NEXT STEP table). That is the
assistant's message, not the card; §II's four negatives are about the card in the
slot, and the card says nothing.

### W1 — the review card in the conversation, pending

`captures/W1__review-card__chat_thread__pending__light.png` ·
`captures/W1__review-card__chat_thread__pending__dark.png`

**The plan says** — *"Once the agent is done and the output generated, that card is
automatically replaced with the 'Review requested' screen — in place."* and
*"The card always shows you something; it is never blank. Three presentations
ship, and the renderer decides which, never the screen it is read on."*

**§II requires** — the review card filling the assistant's turn: *"the target panel
naming what is under review and pinning its exact revision, then the decision
floor that governs it"*; the bound composer row above the floor; *"No prompt
window is drawn inside a conversation"*; and *"Three affordances, weighted apart:
Comment quiet at the left, Reject in the destructive treatment and Approve primary
at the right, over the optional rationale field."*

**Shows** — the **same box**, now `Review requested` / `Awaiting your decision`:
the title `Why Small Teams Lose a Day a Week to Status Reporting` with the
`Blog Post Artifact` chip; the mono line `@cinatra-ai/blog-post-artifact:post ·
revision f1fcb330-373… · pinned · Ownership: organization · Visibility:
organization · text/markdown · updated 2026-08-26T16:49:29.614Z`; the draft
**rendered as prose** through the host's own text rung; `Expand`; the bound
composer row `Replying to this review — Your next chat message becomes a comment
on this review. Press again to chat normally.`; `DECISION RATIONALE (optional on
approve, expected on reject)` over `Comment` `Reject` `Approve`; one composer at
the foot of the thread. Counted: `data-run-review-slot="review"`, **1** card root,
**1** target island, island `body=1 empty=0 targets=1`, **1** Approve / **1**
Reject / **1** Comment, **0** `no-semantic-renderer` diagnostics, **0**
`Floor · structured data` chips, **0** Preview, **0** Download, `Open the run
page` absent, no prompt window.

**Verdict: PASS**, and *"it happens on its own"* is settled by the observer record
above rather than by the picture alone. *Two differences from the drawn example,
named:* the example's target panel carries a **renderer-provenance row**
(`Outreach` · `type renderer · detail`) above the rendered body; this surface
carries a `RENDERED` label instead and draws no provenance row. The example draws
no `Expand` control; this surface does.

### W3 — the run page, pending

`captures/W3__review-card__run_page__pending__light.png` ·
`captures/W3__review-card__run_page__pending__dark.png`

**The plan says** — *"The target ladder: build-time renderer, runtime renderer,
metadata floor — the renderer decides, never the host."*

**§I requires** — the two-column frame, *"a step rail down the left"* and
*"the run detail on the right"*; and *"a gate step opens the gate's own surface in
place — a pending review renders the review gate (§III–§VII) right here in the run
detail, under the same rail, never as a standalone document"*, the gate carrying
*"gate header, review target(s), decision bar and the prompt window"*.

**Shows** — the run surface: the rail at the left, the review gate opened **in the
run detail** with the same header, the same pinned revision, the draft rendered as
prose by the same renderer, `Expand`, and the decision floor. Counted: **1** card
root, **1** island, island `body=1 empty=0 targets=1 rendered=true`, **0** floor
diagnostics, **1**/**1**/**1** Approve/Reject/Comment. The observer recorded this
page's swap at `16:49:47.114` — 291 ms after the conversation's, with nothing
pressed on either page.

**Verdict: PASS on the ladder and on the in-place gate. Two named DEVIATIONS from
§I, both pre-existing and outside this slice's renderer:**

1. **The rail does not carry the gate.** §I: *"The rail lists the run's steps in
   order, merged so that a gate is not a page of its own but a step in the run …
   The step the run is paused on is highlighted; steps already passed sit above
   it, steps still to come below."* On this route the rail carries `1 Schedule`
   **alone** — no `Review` entry, no passed/paused/to-come treatment — while the
   review gate is open in the detail beside it.
2. **No prompt window under the gate.** §I draws the gate's surface as *"gate
   header, review target(s), decision bar **and the prompt window**"*. On this
   route the prompt window is absent; it is drawn on the review route (W5).

### W5 — the review page, pending

`captures/W5__review-card__review_page__pending__light.png` ·
`captures/W5__review-card__review_page__pending__dark.png`

**The plan says** — *"The target ladder: build-time renderer, runtime renderer,
metadata floor — the renderer decides, never the host."*

**§I requires** — that the review page be *"the same run surface"* with the review
step selected, *"never as a standalone document"*, the gate carrying its header,
its target(s), the decision bar and the prompt window.

**Shows** — the gate's own route drawing the **run surface**: the rail
`1 Schedule` / `2 Review` with `Review` selected, the gate in the detail column,
the same header and pinned revision `f1fcb330-373…`, the draft in `RENDERED`
beside `RAW SOURCE` (the raw pane opening `## Where the hours actually go`), the
decision floor, and the run's prompt window at the foot. Counted: **1** card,
**1** island, island `rendered=true rawsource=true`, **0** floor diagnostics,
**0** Preview, **0** Download.

**Verdict: PASS — it is the run surface, not a standalone document. Two named
deviations, both pre-existing:**

1. **The rail's step treatment.** §I draws passed steps with a check, the paused
   step highlighted with its own small-caps state line, and steps to come open;
   this rail draws numbered discs and a selected state.
2. **The prompt-window copy.** §VI words it *"Ask Cinatra about this review, or
   ask for changes to the work…"*; the surface says *"Ask Cinatra to suggest edits
   to the fields above…"*.

### W7 — the same review card inside a third-party application

`captures/W7__review-card__site_widget__pending__light.png` ·
`captures/W7__review-card__site_widget__pending__dark.png`

**The plan says** — *"The card always shows you something; it is never blank.
Three presentations ship, and the renderer decides which, never the screen it is
read on."*

**Requires** — the same review card inside another application's conversation, the
target drawn by its renderer, and **no login prompt**.

**Shows** — a plain page on another origin mounting the Cinatra widget in an
iframe, holding **this run's** card: `Review requested` / `Awaiting your
decision`, the title, the `Blog Post Artifact` chip, the pinned revision
`f1fcb330-373…`, the draft **rendered as prose**, `Expand`, and `Comment`
`Reject` `Approve` over the rationale field, with the widget's own composer
beneath. Counted inside the frame: **1** card, **1** island, island
`body=1 empty=0 targets=1 rendered=true`, **1**/**1**/**1**
Approve/Reject/Comment, **0** `data-embed-signin` controls, **no** sign-in copy
anywhere in the frame, **0** floor diagnostics, **0** Preview, **0** Download.

**Cross-site is measured, not asserted.** The reader signed in through the frame's
**own** hosted-PKCE popup, so an app-origin session cookie exists in the browser
(`better-auth.session_token`, `domain=localhost`, `SameSite=Lax`, `httpOnly`) —
and the island document request still went out with `cookie: absent`, while the
lifecycle resolves carry `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)` and the host page's own origin in
`x-cinatra-widget-origin`. The host page is served by a plain static server on a
different origin **and a different site** from the app.

**Verdict: PASS — the card renders whole, cross-site, with no login prompt. One
named DEVIATION, reproducible:** in the widget host the card's chrome follows the
dark theme but the **target island keeps its light palette** — the island is a
nested document whose theme is fixed when it mounts, and the embed frame draws no
theme control of its own. On the app hosts the island does follow the theme
(compare W1 and W3 dark, where the rendered pane is dark). Both W7 frames were
mounted with the theme already set, so this is the surface's reading and not the
driver toggling after the fact.

*Said plainly:* the widget conversation reaches the card by asking for it — the
turn typed into the widget names the run under proof, because five reviews from
earlier rounds are also pending on this instance and the assistant otherwise
answers with whichever one it finds. The run panel deliberately withholds the
slot's automatic swap on this host (`packages/agents/src/agentic-run-panel.tsx`,
`widgetHostedPanel`), so the automatic replacement is **not** claimed for the
widget; what this cell proves is that the card renders, cross-site, with no login
prompt.

### W9 — the review page, decided

`captures/W9__review-card__review_page__decided__light.png` ·
`captures/W9__review-card__review_page__decided__dark.png`

**The plan says** — *"One card, one gate."*

**Requires** — the decided reading of the same card: the decision recorded, the
floor closed, no Approve / Reject / Comment left. §I adds that a resolved gate
*"opens read-only: what was decided, **and the reviewed target(s)**, kept for the
run's audit trail"*, and that it *"stays on the rail as read-only history — its
entry keeps its place and records how it was settled"*.

**Shows** — the second run's gate after **Approve** was pressed for real in the
browser at `16:57:22.415Z`: `Approved by Ops Operator Two`, *"The gate is resolved
and the run has been released to continue"*, and the decision controls gone —
**0** Approve, **0** Reject, **0** Comment. The row it wrote:

```
artifact_review_audit
  id                          f147412a-8cb6-4120-ba80-88e92d72fc44
  gate_id                     51abc733-6a53-4d66-96e5-a896e439fd0a
  run_id                      8bfc1191-eeca-4b6a-ac86-a636f476c28e
  artifact_id                 79948515-3c23-46f5-b83c-48b35f5c3839
  representation_revision_id  a5b82be2-432e-4962-b43f-7dd7d36dfaf1
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  created_at                  2026-08-26 16:57:23.200555+00
```

**Verdict: PASS — settled by the row, not by the screen alone, and the production
proof of `core__0097`: without the widened CHECK this insert rolls the whole
decision back and the gate never reaches `resolved`. Two named DEVIATIONS from §I,
both pre-existing:**

1. **The reviewed target is not kept beside the decision.** The surface shows what
   was decided; the target it was decided on is not drawn.
2. **The rail does not record how the gate was settled** — and on this reading it
   carries `1 Review` alone, having dropped the `Schedule` entry the same run's
   rail carried while the gate was pending (W5).

---

## The grading table

| Cell | Host | Light | Dark | Verdict |
|---|---|---|---|---|
| W0 placeholder | the conversation, working | ✔ | ✔ | **PASS** — frame + spinner, no status, no result, nothing to press, no run-page link; drawn example's heading absent (named) |
| W1 review card | the conversation, pending | ✔ | ✔ | **PASS** — swapped in place on its own, drawn as prose by its renderer, one composer, no prompt window; no provenance row (named) |
| W3 review card | the run page, pending | ✔ | ✔ | **PASS** on the ladder and the in-place gate; the rail carries no gate entry and no prompt window (2 deviations, named) |
| W5 review card | the review page, pending | ✔ | ✔ | **PASS** — the same run surface, rendered beside raw source, floor, prompt window; rail treatment and prompt copy (2 deviations, named) |
| W7 review card | a third-party application | ✔ | ✔ | **PASS** — rendered whole, no login prompt, cross-site measured on the wire; the island keeps its light palette in dark (1 deviation, named) |
| W9 decided | the review page, decided | ✔ | ✔ | **PASS** — `renderer_kind = first-party`; the reviewed target and the rail's settled state are missing (2 deviations, named) |

## What this round does NOT claim, and what it dropped

1. **That the gate is minted before the run terminates.** It is not — 15.3 s
   after. Stated, issue-tracked, not fixed here.
2. **The automatic swap on the widget host.** The run panel withholds it there by
   design, with the file named above; W7 claims the render and the absence of a
   login prompt, nothing more.
3. **`W2`, the placeholder in the run detail, is not in this set.** It is not one
   of the plan walk's six cells for this round, and its dark frame could not be
   held: the run page's slot turned to `review` at `16:49:47.114` and that frame's
   shutter is logged at `16:49:47.284`, its re-count after the shutter came back
   false, and the pixels show the detail panel already emptied — the frame does
   not show what its name claims. Rather than ship a
   picture whose reading had slipped, or stage a third run for a cell the walk
   does not ask for, both `W2` files are removed. The same window's chat-side
   reading is W0, and it is verified true before and after its shutter.
4. **The rail's contents**, the missing prompt window on the plain run route, and
   the resolved gate's omission of the reviewed target — all named above, all
   pre-existing, all outside this slice's renderer.

Row-level readback, hashes and stamps: [`capture-records.md`](capture-records.md).
