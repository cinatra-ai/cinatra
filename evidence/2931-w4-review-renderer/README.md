# cinatra#2931 (W4) — the reviewed work, drawn by its own renderer, on the merged head

Every picture in this directory was taken on a live dev instance, against **real
agent runs on the real provider** — `CINATRA_TEST_LLM_PROVIDER` unset, no stub, no
scripted provider, no seeded row.

**Three cells were re-taken on `d0db4293d72b4554bf1c4b00fc7d5363c82375b3`** — the
run page (**W3**) and the review page (**W5**, **W9**), because that head is a
merge of `main` at `35e369ed68a6446b0125cfecaee6aa993742a961`, which carries the
first-time run page's two-column setup rail (cinatra#2970 / cinatra#2975) and the
schedule surfaces (cinatra#3006). Those three surfaces are re-shot rather than
carried forward, from **two fresh real runs** started on this head.

The other three cells — **W0**, **W1** and **W7** — **stand unchanged**, and are
**byte-identical** to `bda322574903` : the conversation and the third-party
application are untouched by the rail. Checked three ways before anything was
written: the git blob ids of all twelve capture files are identical between
`bda322574903` and this head, the six standing files' `sha256` values recomputed
from the committed blobs equal the values already recorded in
[`capture-records.md`](capture-records.md), and only the six W3/W5/W9 files are
replaced by this commit.

## The pin, checked before a single picture was taken

`main` pins `@cinatra-ai/blog-draft-writer-agent` at
**`03a27f524d59f90f635ee98c1b5900c4bc9f7f6e`** — the revision whose `draft` field
holds the draft **as prose** rather than a JSON envelope — and this head carries
that pin. On the instance that took these pictures:

| what | reading |
|---|---|
| the checked-out package (`sync-dev-extensions --pinned`) | `git rev-parse HEAD` = `03a27f524d59f90f635ee98c1b5900c4bc9f7f6e` |
| the app's own boot scan | `[cinatra:extensions:agent] @cinatra-ai/blog-draft-writer-agent 0.1.4 upserted` (the leading v of the printed token is dropped for the repository's version-token rule) |
| the agent runtime the runs actually reached | `/.health` → `{"status":"ok","agents":29,"failed":0,"failed_agents":[]}` |

**And the proof that reached the screen, not just the lock.** Both persisted
drafts are `text/markdown` blobs holding prose:

```
resource 8d54bb47-73cd-475f-8e7a-aadd67599fad   text/markdown   6 086 bytes
  sha256 00f42c92d1663dbcb067e16543feb126c0ba48d40eb70ecca5946fc48e004699
  begins "## Why the ritual drifts once the dashboard is automatic"
  occurrences of the JSON-envelope key `"content":`  →  0

resource ace23d46-7efb-472a-91ac-37ea9fa41626   text/markdown   5 734 bytes
  sha256 e003f30c647e4d984701415d1742c030dc77789efc5e5484f7ad3465aacc6516
  begins "## The cost a recurring meeting hides"
  occurrences of the JSON-envelope key `"content":`  →  0
```

**No JSON envelope appears in any target in this set.**

## The two runs behind the re-taken cells

The re-taken cells are not staged from one another. **One run is left pending**
and carries both pending readings; **a second run is decided** and carries the
decided one. Both were started by **one** turn typed into the chat, both carry
`human_present = t`, and every gate either one paused on was answered by a press
in the browser.

| | run | gate | what it carries |
|---|---|---|---|
| **pending** | `88634469-a0d1-47be-94a4-473cbb25bf75` | `534ca557-f45e-4ff0-9d7a-468cb0e1ef27` — still `pending` as this is written | **W3**, **W5** |
| **decided** | `ef14a5dd-1d1a-4a1f-8762-d55b55e985c0` | `f079f282-7bf8-4105-ba01-db115dc89326` — `resolved` / `approve` | **W9** |

The pending run's gate was **still `pending` after the second run's Approve was
pressed** — re-read from the row afterwards — so no cell in this pair was staged
from a state the other changed.

## The run behind the standing cells, measured

A `MutationObserver` on the card's own `data-run-review-slot` attribute recorded
every change of reading. The conversation and the run page each carried their own
observer and **neither page was reloaded after the turn was typed.**

This record belongs to the run behind **W0** and **W1**, the two conversation
cells that stand unchanged in this commit; the swap it measures is what those two
cells show. **W3**, **W5** and **W9** were re-taken on the merged head against the
two runs measured in the next section, and claim nothing from this timeline;
**W7** was taken against its own run and claims nothing from it either.

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

**What this head changes** is that the slot *holds* the placeholder across the
minting window instead of flipping to a completion notice.

## The two re-taken runs, measured

Every timestamp below is either a row read back from the instance database or a
line the driver wrote as it pressed a control. Nothing is estimated.

### The pending run — `88634469-a0d1-47be-94a4-473cbb25bf75` (W3, W5)

| when (UTC) | what | source |
|---|---|---|
| `00:23:41.426` | the ONE turn is typed into the conversation | driver |
| `00:24:05.632` | the run row is created | row |
| `00:24:11.688` · `00:24:12.837` | the run's own setup field is filled and `Continue` pressed, in the chat card | driver |
| `00:24:39.261` | the run page's schedule step is answered — **Run right after setup**, then `Continue` | driver |
| `00:25:09.422` | the run's context gate is answered — `Continue`, no eligible context | driver |
| `00:27:40.590` | the draft model call — `blog-draft-writer-agent`, `openai gpt-5.5-2026-04-23`, 38 744 in / 1 683 out | ledger row |
| `00:27:42.578` | the blob is written — 6 086 bytes, `text/markdown` | row |
| `00:27:43.332` | representation revision **1** is written | row |
| `00:27:43.719` | **the run terminates** | row |
| `00:28:00.208` | the review gate is minted — **16.5 s after the run had already ended** | row |
| `00:36:33` / `00:36:47` | **W3** light / dark | shutter |
| `00:40:08` / `00:40:22` | **W5** light / dark | shutter |

### The decided run — `ef14a5dd-1d1a-4a1f-8762-d55b55e985c0` (W9)

| when (UTC) | what | source |
|---|---|---|
| `00:39:39.530` | the ONE turn is typed into the conversation | driver |
| `00:39:59.017` | the run row is created | row |
| `00:40:04.757` · `00:40:05.855` | the run's own setup field is filled and `Continue` pressed | driver |
| `00:44:42.736` · `00:44:44.938` | the schedule step is answered — **Run right after setup**, then `Continue` | driver |
| `00:51:05.783` | the context gate is answered — `Continue` | driver |
| `00:51:45.805` | the draft model call — `blog-draft-writer-agent`, `openai gpt-5.5-2026-04-23`, 38 717 in / 1 701 out | ledger row |
| `00:51:47.253` | the blob is written — 5 734 bytes, `text/markdown` | row |
| `00:51:47.911` | representation revision **1** is written | row |
| `00:51:48.217` | **the run terminates** | row |
| `00:51:51.254` | the review gate is minted — **3.0 s after the run had already ended** | row |
| `00:54:23.451` | **Approve** is pressed in the browser, over a typed rationale | driver |
| `00:54:24.546` | the audit row is written and the gate reaches `resolved` | row |
| `00:54:32` / `00:54:44` | **W9** light / dark | shutter |

**The named limit stays, and is not fixed here.** The gate is still minted after
the run terminates — 16.5 s and 3.0 s on these two runs. The minting order is
upstream of this slice.

**One failed run is disclosed rather than dropped.** A first attempt at the
pending run, `49e4f31b-f87c-4b35-a2a9-36858614fbf2`, is `failed` in
`agent_runs`. The cause is environmental and was read from the app's own log:
`[wayflow] dispatch failed for run 49e4f31b… : TypeError: fetch failed` — the
agent runtime container had been stopped by this instance's own `dev:stop` before
the run was armed, so the dispatch had nothing to reach. The runtime was restarted
(`/.health` → `agents: 29, failed: 0`) and the two runs above were driven after
that. Nothing about that failed run appears in any picture.

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

**Re-taken on `d0db4293d72b4554bf1c4b00fc7d5363c82375b3`.** Route:
`/agents/cinatra-ai/blog-draft-writer-agent/88634469-a0d1-47be-94a4-473cbb25bf75`
— asserted from `location.pathname` at each shutter, in both themes.

**The plan says** — *"The target ladder: build-time renderer, runtime renderer,
metadata floor — the renderer decides, never the host."*

**§I requires, every clause** — *"A run is one page, read down a rail."* ·
*"The surface is a two-column frame: a step rail down the left names the run's
ordered steps, and the run detail on the right shows the selected step."* ·
*"Nothing about the run lives on a separate page — every step, and every gate that
pauses the run, is reached by selecting its entry on the rail and reads in the
same run."* · *"The rail lists the run's steps in order, merged so that a gate is
not a page of its own but a step in the run: the ordinary work steps, and — inline
at the point the run reached it — a gate entry."* · *"The step the run is paused
on is highlighted; steps already passed sit above it, steps still to come below."*
· *"Selecting a step opens it on the right."* · *"A gate step opens the gate's own
surface in place — a pending review renders the review gate (§III–§VII) right here
in the run detail, under the same rail, never as a standalone document."* · and
the drawn example's gate carrying *"gate header, review target(s), decision bar
and the prompt window"*.

**Shows** — the run surface, two columns, light and dark alike. The **rail**
carries two entries in order, connected by a rule: `Step 1` with the completed
circle above `Review` with the gate's own glyph — the gate is an entry **on the
rail**, not a page of its own. The **detail column** holds the gate opened in
place: `Review requested` / `Awaiting your decision`, the title *Keeping Weekly
Reviews Useful When Reporting Is Automated*, the `Blog Post Artifact` chip, the
pinned revision `5b1be384-0a7…` with `text/markdown` and its update stamp, the
draft **rendered as prose** by the artifact's own renderer, `Expand`, and the
decision floor — the rationale field over `Comment` `Reject` `Approve`. Counted at
each shutter, both themes: **1** card root, **1** target island, **1** iframe,
island `body=1 empty=0 targets=1 rendered=true`, **1**/**1**/**1**
Approve/Reject/Comment, **0** `no-semantic-renderer` diagnostics, **0**
`Floor · structured data` chips, **0** Preview, **0** Download.

**Verdict: PASS on the ladder, on the two-column frame, on the merged gate entry
and on the gate opened in place. Four named DEVIATIONS, all measured, all
pre-existing and outside this slice's renderer:**

1. **The rail does not read `Schedule / Recommendation / Review` on this route.**
   It reads `Step 1` / `Review`. The three-row setup rail of cinatra#2970 is
   real on this head, but it is the **`/trigger`** route's rail, not the run
   page's: read live on this head at
   `/agents/cinatra-ai/blog-draft-writer-agent/ef14a5dd-…/trigger`, the rows come
   back as `1 Schedule` (`data-run-surface-rail-selected="true"`),
   `2 Recommendation` (`reached="false"`, `aria-disabled="true"`,
   `action="recommendation-step-unavailable"`) and `Review`
   (`reached="true"`, **`settled="true"`**, `action="open-review-step"`) — the
   `RunSurfaceRailRow` rows of `packages/agents/src/run-surface-rail.tsx`. The run
   page pictured here composes its own rail instead
   (`data-conformance-id="run-step-rail"`), whose entries carry
   `data-rail-kind` / `data-rail-status` rather than those anchors. Two rails,
   two vocabularies, and the picture names which one this route draws.
2. **The paused step is not highlighted, and this is measured rather than
   eyeballed.** §I: *"The step the run is paused on is highlighted."* The drawn
   example gives it a coloured rule, a shaded row and its own small-caps state
   line (`AWAITING YOUR DECISION`). Read from the computed styles of the two rail
   entries on this page: the passed work step (`kind=step`,
   `status=completed`) and the paused gate (`kind=gate`, `status=pending`) come
   back with the **same** ink `rgb(21, 33, 58)`, the **same** font weight `400`
   and the **same** background `rgba(0, 0, 0, 0)`. Nothing distinguishes the
   paused row but its glyph.
3. **The work step is named by position, not by what it did.** §I has the rail
   name *"the ordinary work steps"* (the drawn example: `Fetched Q3 cohort`,
   `Drafted re-engagement email`). This rail says `Step 1`.
4. **No prompt window under the gate on this route.** §I draws the gate's surface
   as *"gate header, review target(s), decision bar **and the prompt window**"*.
   Measured on this page: `/Ask Cinatra/` matches **0** times in either theme. It
   is drawn on the review route (W5).

**Not exercised by this cell:** §I's resolved-gate history. This run has no
resolved gate, so the rail has nothing to keep. W9 reads that clause.

### W5 — the review page, pending

`captures/W5__review-card__review_page__pending__light.png` ·
`captures/W5__review-card__review_page__pending__dark.png`

**Re-taken on `d0db4293d72b4554bf1c4b00fc7d5363c82375b3`**, from the same pending
run. Route:
`/agents/cinatra-ai/blog-draft-writer-agent/88634469-…/review/lifecycle-review%3A79a42743…`
— asserted from `location.pathname` at each shutter, in both themes.

**The plan says** — *"The target ladder: build-time renderer, runtime renderer,
metadata floor — the renderer decides, never the host."*

**§I requires** — that the gate be reached *"by selecting its entry on the rail"*
and read *"in the same run"*; that a gate step open *"in place — … right here in
the run detail, under the same rail, **never as a standalone document**"*; the
gate carrying *"gate header, review target(s), decision bar and the prompt
window"*; and the rail *"names the run's ordered steps"* with *"the step the run
is paused on … highlighted"*.

**Shows** — the gate's own route drawing the **run surface**, not a document: the
rail `1 Schedule` above `2 Review`, with `Review` in the selected treatment, and
the gate in the detail column beside it. The same header and pinned revision
`5b1be384-0a7…`, the draft in **`RENDERED`** prose beside its **`RAW SOURCE`**
markdown — the raw pane opening `## Why the ritual drifts once the dashboard is
automatic`, which is byte-for-byte how the persisted blob begins — `Expand`, the
decision floor, and the run's prompt window at the foot
(`Ask Cinatra to suggest edits to the fields above…`). Counted at each shutter,
both themes: **1** card, **1** island, **1** iframe, island
`body=1 empty=0 targets=1 rendered=true rawsource=true`, **1**/**1**/**1**
Approve/Reject/Comment, **0** floor diagnostics, **0** `no renderer resolved`,
**0** Preview, **0** Download, and `/Ask Cinatra/` matching (the prompt window is
present on this route, unlike W3's).

**Verdict: PASS — it is the same run surface with the review step selected, never
a standalone document, and the target is drawn by its renderer beside its raw
source. Three named DEVIATIONS:**

1. **The box directly under the review is today's decision box, not the drawing's
   prompt window.** §I orders the gate *"gate header, review target(s), decision
   bar and the prompt window"*; here the `DECISION RATIONALE` box sits
   immediately under the target and the prompt window is pushed to the foot of
   the page. **This is a known deviation owned by cinatra#2995** — named here,
   not hidden, and not fixed by this slice.
2. **The rail's step treatment differs from the drawing's.** §I draws passed steps
   with a check, the paused step highlighted with its own small-caps state line,
   and steps still to come open below. This rail draws numbered discs and a
   selected state, and `1 Schedule` carries no check.
3. **The prompt window's copy.** §VI words it *"Ask Cinatra about this review, or
   ask for changes to the work…"*; the surface says *"Ask Cinatra to suggest edits
   to the fields above…"*.

### W7 — the same review card inside a third-party application

`captures/W7__review-card__site_widget__pending__light.png` ·
`captures/W7__review-card__site_widget__pending__dark.png`

**Re-taken on `011da4d6133a16e81a3f79a9ce0dcbb9b6fba8a0`** — this is the cell the
colour-scheme defect was seen in, and the head now carries its fix.

**The plan says** — *"The card always shows you something; it is never blank.
Three presentations ship, and the renderer decides which, never the screen it is
read on."*

**Requires** — the same review card inside another application's conversation, the
target drawn by its renderer, whole, and **no login prompt**.

**Shows** — a plain page on another origin mounting the Cinatra widget in an
iframe, holding **this run's** card: `Review requested` / `Awaiting your
decision`, the title, the `Blog Post Artifact` chip, the pinned revision
`85de01bf-711…` with `text/markdown`, the draft **rendered as prose**, `Expand`,
and `Comment` `Reject` `Approve` over the rationale field, with the widget's own
composer beneath. Counted inside the frame, both themes: **1** card, **1** island,
island `body=1 empty=0 targets=1 rendered=true`, **1**/**1**/**1**
Approve/Reject/Comment, **0** `data-embed-signin` controls, **no** sign-in copy
anywhere in the frame, **0** floor diagnostics, **0** `no renderer resolved`,
**0** Preview, **0** Download.

**The dark defect is fixed, and the fix is measured, not asserted.** The earlier
pair showed the card's chrome dark and the target island a **white panel with dark
ink**. On this head the island in the third-party application is **dark**: its
ground measures `rgb(13,24,42)` — the same value the island paints on the
first-party run page in dark (W3) — and the draft is light ink on it. The whole
target panel is inside the island document, not the card: the island's own text is
the title, the chip, the pinned-revision line and the rendered prose, while the
card contributes only the header and the decision floor.

**One named DEVIATION, measured on both hosts so the claim is exact:** the target
chip's **pill outline** is not drawn inside the third-party application in dark.
Scanning the chip's border rows: on the first-party run page in dark the border
sits at `rgb(37,47,63)` against the island ground `rgb(13,24,42)` — and it is
there **both** when the island mounts dark and when it repaints into dark, checked
separately — while inside the third-party application in dark the brightest pixel
across those same rows is `rgb(14,25,44)`, indistinguishable from the ground. In
light the pill is drawn on both hosts. The chip's label stays legible; what is
missing is its outline. Ground, ink and every other reading follow the host on
both — this is one border token that does not, and it is named here rather than
left to be found.

**Cross-site is measured, not asserted.** The reader signed in through the frame's
**own** hosted-PKCE popup, so an app-origin session cookie exists in the browser
(`better-auth.session_token`, `domain=localhost`, `SameSite=Lax`, `httpOnly`) —
and the island document request still went out with `cookie: absent`, while the
two lifecycle resolves per capture carry `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)` and the host page's own origin in
`x-cinatra-widget-origin`. The host page is served by a plain static server on a
different origin **and a different site** from the app. Both frames were taken in
a fresh browser context with an **empty** cookie jar.

**Verdict: PASS — the card renders whole, cross-site, with no login prompt, and
the island now follows the host's colour scheme in both themes. One named
deviation: the chip's pill outline in dark, above.**

*Said plainly:* the widget conversation reaches the card by asking for it — the
turn typed into the widget names the run and the pinned revision under proof,
because reviews from earlier rounds are also pending on this instance and the
assistant otherwise answers with whichever one it finds. The run panel deliberately
withholds the slot's automatic swap on this host
(`packages/agents/src/agentic-run-panel.tsx`, `widgetHostedPanel`), so the
automatic replacement is **not** claimed for the widget; what this cell proves is
that the card renders, cross-site, in the host's own colour scheme, with no login
prompt.

### W9 — the review page, decided

`captures/W9__review-card__review_page__decided__light.png` ·
`captures/W9__review-card__review_page__decided__dark.png`

**Re-taken on `d0db4293d72b4554bf1c4b00fc7d5363c82375b3`**, from the **second**
run. Route:
`/agents/cinatra-ai/blog-draft-writer-agent/ef14a5dd-…/review/lifecycle-review%3A77e016c0…`
— asserted from `location.pathname` at each shutter, in both themes.

**The plan says** — *"One card, one gate."*

**§I requires, for a resolved gate** — *"A resolved gate stays on the rail as
read-only history — its entry keeps its place and records how it was settled
(approved, rejected, changes requested), so the rail is the run's whole lifecycle
at a glance, not just its live tip."* and *"A resolved gate opens read-only: what
was decided, and the reviewed target(s), kept for the run's audit trail."*

**Shows** — the same route after **Approve** was pressed for real in the browser
at `00:54:23.451`, over a rationale typed into the card's own field: a single card
carrying the double-check mark, **`Approved by Ops Operator Two`** and *"The gate
is resolved and the run has been released to continue."* The decision controls are
gone — counted at each shutter, both themes: **0** Approve, **0** Reject, **0**
Comment, **1** card root. The rail keeps `1 Schedule` above `2 Review`. The row it
wrote:

```
artifact_review_audit
  id                          51b718dc-9e43-464f-a241-ec2c5055c3bc
  gate_id                     f079f282-7bf8-4105-ba01-db115dc89326
  run_id                      ef14a5dd-1d1a-4a1f-8762-d55b55e985c0
  artifact_id                 e98f02e5-cb3a-40c1-8a52-b47bccd205a3
  representation_revision_id  43e75a37-3bc8-4322-9da7-8a01ec30a49c
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  created_at                  2026-08-27 00:54:24.54582+00

artifact_review_gates  f079f282-…  status resolved  disposition approve
  resolved_by  2660f48b-6a11-423a-afdd-a148139bf86d   (the signed-in reviewer)
  resolved_at  2026-08-27 00:54:24.54582+00
```

**Verdict: PASS on the plan's words — one card, one gate, the decision recorded
and the floor closed, settled by the row and not by the screen alone. Two named
DEVIATIONS from §I, both measured on this head:**

1. **The reviewed target is not kept beside the decision.** §I: a resolved gate
   *"opens read-only: what was decided, **and the reviewed target(s)**, kept for
   the run's audit trail."* The settled card holds the decision line and nothing
   else — the card's whole text at each shutter is
   `Approved by Ops Operator Two / The gate is resolved and the run has been
   released to continue.` The target is on the audit trail (the row above pins
   both `artifact_id` and `representation_revision_id`); it is not on the screen.
2. **This route's rail does not record how the gate was settled — but another
   one does, and the difference is exact.** §I's history clause asks the resolved
   entry to *"record how it was settled"*. Measured on this page in both themes:
   `[data-run-surface-rail-settled="true"]` → **0**, and the `Review` row keeps
   its numeral `2` rather than taking the completed circle. The reason is that
   the review page's rail is its own component — `ReviewRunSteps`
   (`review-run-steps.tsx`), an inert stepper the page hands `activeStep =
   reviewIndex` — which has no settled reading at all. The settled reading of
   cinatra#2975 lives in `RunSurfaceRailRow`
   (`packages/agents/src/run-surface-rail.tsx`), whose row draws
   `{settled ? <Check/> : displayStep}` with *"the title unhighlighted"*, gated by
   `runReviewStepSettled({ reading, gateStatus })` in
   `packages/agents/src/run-review-slot-reading.ts`. Read live on this head for
   **this same decided run**, that row is drawn and it is settled:
   - `/trigger` → the `Review` row comes back `reached="true"`,
     **`settled="true"`**, and its indicator's text is **empty** — the completed
     circle standing in place of the numeral, exactly as §I asks.
   - the **run page** → its own rail entry reads `kind=gate`,
     **`status=resolved`**, and its text is **`ReviewAPPROVE`** — the entry keeps
     its place and records the disposition.

   So the clause is honoured on the run page and on the setup rail, and is
   **absent on the review page**, which is the route this cell pictures. That is
   the deviation, named precisely rather than softened.

## The grading table

| Cell | Host | Light | Dark | Verdict |
|---|---|---|---|---|
| W0 placeholder | the conversation, working | ✔ | ✔ | **PASS** — frame + spinner, no status, no result, nothing to press, no run-page link; drawn example's heading absent (named) |
| W1 review card | the conversation, pending | ✔ | ✔ | **PASS** — swapped in place on its own, drawn as prose by its renderer, one composer, no prompt window; no provenance row (named) |
| **W3** review card | the run page, pending | ✔ | ✔ | **PASS** on the ladder, the two-column frame, the merged gate entry and the gate opened in place; the rail reads `Step 1 / Review` and not the setup rail's three rows, the paused step is not highlighted (measured: same ink, weight and ground as the passed step), the work step is named by position, no prompt window (**4 deviations, named**) |
| **W5** review card | the review page, pending | ✔ | ✔ | **PASS** — the same run surface with the review step selected, never a standalone document, rendered beside raw source; the box under the review is today's decision box rather than the drawing's prompt window (**cinatra#2995**), rail treatment, prompt copy (**3 deviations, named**) |
| W7 review card | a third-party application | ✔ | ✔ | **PASS** — rendered whole, no login prompt, cross-site measured on the wire, and the island follows the host's colour scheme in both themes; the chip's pill outline is not drawn in dark (1 deviation, measured on both hosts) |
| **W9** decided | the review page, decided | ✔ | ✔ | **PASS** on the plan's words — one card, one gate, floor closed, `renderer_kind = first-party` in the row; the reviewed target is not kept beside the decision, and this route's rail records no settled state while `/trigger` (`settled="true"`, empty indicator) and the run page (`status=resolved`, `ReviewAPPROVE`) both do (**2 deviations, named**) |

## What this round does NOT claim

1. **That the gate is minted before the run terminates.** It is not — 16.5 s and
   3.0 s after, on the two runs measured here. Stated, not fixed here.
2. **That the setup rail of cinatra#2970 appears on the run page.** It does not;
   it is the `/trigger` route's rail. W3 names where each rail is drawn and what
   each one reads, from live anchors.
3. **That the resolved gate reads as history on every route.** It does not — the
   review page's own rail has no settled reading. W9 names the two routes that do
   and the one that does not.
4. **The automatic swap on the widget host.** The run panel withholds it there by
   design; W7 claims the render and the absence of a login prompt, nothing more.
5. **That the box under the review is the drawing's prompt window.** It is not —
   it is today's decision box, a known deviation owned by cinatra#2995.
6. **Any reading for `W2`.** It is not one of this walk's cells and is not in this
   set.

Row-level readback, hashes and stamps: [`capture-records.md`](capture-records.md).
