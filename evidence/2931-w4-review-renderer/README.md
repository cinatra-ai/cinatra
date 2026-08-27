# cinatra#2931 (W4) — the reviewed work, drawn by its own renderer, on this head

Every picture in this directory was taken on a live dev instance, against **real
agent runs on the real provider** — `CINATRA_TEST_LLM_PROVIDER` unset, no stub, no
scripted provider, no seeded row.

**W9 is re-taken on `73c201854cecfe50c8036a32b5f7489111acb99c`**, the head whose
newest commit makes the decided reading keep the reviewed target. The previous W9
pair carried a named deviation — *the reviewed target is not kept beside the
decision* — and that deviation is exactly what this head's commit fixes. The new
pair comes from **one fresh real run**, brought to its review and then **Approved
for real in the browser**, over a rationale typed into the card's own field.

**The other five cells stand byte-identical.** W7 was re-taken on
`f20bb3ff6372fe3d6882f490a9289512a21a95f1`; W3 and W5 on
`d0db4293d72b4554bf1c4b00fc7d5363c82375b3`; W0 and W1 have stood since
`1c3649503d511942538c626d4ebc964e50e1302c`. Checked three ways before anything was
written: `git status` reports exactly the two W9 files modified, the git blob ids
of the other ten are identical to `4f908562ef443d0af9681edccfa7862d04b2023a`, and
their `sha256` values recomputed from the files on disk equal the values already
recorded in [`capture-records.md`](capture-records.md).

**What changed on the screen, and what did not.** The decided card is now the
pending card with the decision taken out of it and the decision itself put in its
place. Held against its own pending reading — taken from the **same gate**, three
minutes earlier, in the same browser session: the target panel, its type chip, its
pinned revision and the draft drawn as prose are **the same**; the `Awaiting your
decision` pill, the `DECISION RATIONALE` field, `Comment` / `Reject` / `Approve`
and the composer are **gone**; and a line naming who decided stands where the floor
was. The pinned revision reads `a31b40a9-ca65-4994-9040-20dd83f8d859` in **both**
readings — the frozen revision the decision was taken on, never a later one.

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

## The run behind W9, on this head

**W9's pair is its own run**, started on
`73c201854cecfe50c8036a32b5f7489111acb99c`, brought to its review and **decided in
the browser**. It claims nothing from the runs behind the other five cells, and
they claim nothing from it.

| | run | gate | what it carries |
|---|---|---|---|
| **decided** | `0770c32a-e1dc-4edb-884a-744dad88fdac` — `completed`, `human_present = t` | `f6f5c67e-8974-4fb0-a461-5c82efc6b3ca` — `resolved` / `approve`, `reopen_count 0` | **W9** light and dark |

Both W9 frames were taken against **this one resolved gate**, and the row was read
back as `resolved` / `approve` before either shutter. The reviewed work is
`text/markdown`, 6 493 bytes, and its first byte is `#`: prose, with **zero**
occurrences of `"content":` — no JSON envelope reached the target. The draft was
written by the pinned agent on the real provider (`openai` /
`gpt-5.5-2026-04-23`, 38 733 input / 1 746 output tokens, `agent_label =
blog-draft-writer-agent`).

## The runs behind the cells carried forward

Each cell carried forward keeps the run it was taken against, recorded in the
commit its files came from: `88634469-a0d1-47be-94a4-473cbb25bf75` with gate
`534ca557-f45e-4ff0-9d7a-468cb0e1ef27` (**W3**, **W5**),
`4dfd78f9-4d4e-43a5-8d9e-9f334908efd3` with gate
`fb69f4b6-c086-4e51-abdb-8531776a8005` (**W7**), and
`579d0473-4b5d-40b9-9d79-8126560bbf06` (**W0**, **W1**). Nothing in this commit
re-reads or re-claims them; their sections below are left as they were written.

## The run behind W7, on this head

**W7's pair is its own run**, started on
`f20bb3ff6372fe3d6882f490a9289512a21a95f1` and left **pending** at its review. It
claims nothing from the runs above and they claim nothing from it.

| | run | gate | what it carries |
|---|---|---|---|
| **pending** | `4dfd78f9-4d4e-43a5-8d9e-9f334908efd3` — `completed`, `human_present = t` | `fb69f4b6-c086-4e51-abdb-8531776a8005` — `pending`, `disposition` null, `resolved_by` null | **W7** light and dark |

Both W7 frames were taken against **this one pending gate**, and the row was read
back after the second frame and was still `pending`. The reviewed work is
`text/markdown`, 6 086 bytes, and its first byte is `#`: prose, with **zero**
occurrences of `"content":` — no JSON envelope. The draft was written by the
pinned agent on the real provider (`openai` / `gpt-5.5-2026-04-23`, 38 736 input /
1 592 output tokens, `agent_label = blog-draft-writer-agent`).

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

## The two review-page runs, measured

Every timestamp below is either a row read back from the instance database or a
line the driver wrote as it pressed a control. Nothing is estimated. The first run
is the one W3 and W5 were taken against and is carried forward unchanged; the
second is this commit's own, and is the run W9 is re-taken from.

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

### The decided run — `0770c32a-e1dc-4edb-884a-744dad88fdac` (W9, this head)

| when (UTC) | what | source |
|---|---|---|
| `04:25:13.869` | the ONE turn is typed into the conversation | driver |
| `04:25:36.291` | the run row is created | row |
| `04:26:01.077` · `04:26:02.178` | the run's own setup field is filled and `Continue` pressed, in the chat card | driver |
| `04:34:47.604` · `04:34:49.745` | the run page's schedule step is answered — **Run right after setup**, then `Continue` | driver |
| `04:44:31.378` | the run's context gate is answered — `Continue`, no eligible context for `draftContext` | driver |
| `04:45:05.617` | the draft model call — `blog-draft-writer-agent`, `openai gpt-5.5-2026-04-23`, 38 733 in / 1 746 out | ledger row |
| `04:45:06.670` | the materialization is finalized — representation revision `a31b40a9-ca6…` | row |
| `04:45:07.063` | the blob is written — 6 493 bytes, `text/markdown` | row |
| `04:45:07.703` | **the run terminates** | row |
| `04:45:27.913` | the review gate is minted — **20.2 s after the run had already ended** | row |
| `04:49:06.575` | the **pending** reading is measured, in the same session, as the reference the decided one is held against | driver |
| `04:49:07.753` | **Approve** is pressed in the browser, over a rationale typed into the card's own field | driver |
| `04:49:08.649` | the audit row is written and the gate reaches `resolved` | row |
| `04:49:19.537` / `04:49:34.403` | **W9** light / dark | shutter |

**The named limit stays, and is not fixed here.** The gate is still minted after
the run terminates — 16.5 s on the pending run and 20.2 s on this one. The minting
order is upstream of this slice.

**One failed run is disclosed rather than dropped.** A first attempt at the
pending run, `49e4f31b-f87c-4b35-a2a9-36858614fbf2`, is `failed` in
`agent_runs`. The cause is environmental and was read from the app's own log:
`[wayflow] dispatch failed for run 49e4f31b… : TypeError: fetch failed` — the
agent runtime container had been stopped by this instance's own `dev:stop` before
the run was armed, so the dispatch had nothing to reach. The runtime was restarted
(`/.health` → `agents: 29, failed: 0`) and the two runs above were driven after
that. Nothing about that failed run appears in any picture.

**This round's own failed run is disclosed too.**
`bc634422-3be9-4327-aa78-778b2c98fc9a` is `failed` in `agent_runs` — a first
attempt at the decided run, with the same environmental cause read from the app's
own log: `[wayflow] dispatch failed for run bc634422… : TypeError: fetch failed`.
The agent runtime container had stopped when the dev server it is bound to was
signalled, so the dispatch had nothing to reach. The runtime was restarted
(`/.health` → `200`, `agents: 29, failed: 0`) and the pictured run was driven after
that. No picture in this commit shows it.

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

**Re-taken on `f20bb3ff6372fe3d6882f490a9289512a21a95f1`.** This is the cell the
dark-palette defect was seen in, and this head carries its fix. Both frames come
from one fresh real run left pending at its review.

**The plan says** — *"The card always shows you something; it is never blank.
Three presentations ship, and the renderer decides which, never the screen it is
read on."*

**Requires** — the same review card inside another application's conversation: the
target panel naming the work and pinning its revision, the target drawn by its
renderer, the decision floor with the rationale field and Comment / Reject /
Approve, the card **whole**, and **no login prompt**. In dark the island renders
dark like the widget around it, and every token resolves as on the run page.

**Shows** — a plain page on another origin mounting the Cinatra widget in an
iframe, holding **this run's** card: `Review requested` / `Awaiting your
decision`; the title *Handover Notes That Survive a Rotation*; the `Blog Post
Artifact` chip; the pinned revision line `@cinatra-ai/blog-post-artifact:post ·
revision d41e0d95-d1e… · pinned · Ownership: organization · Visibility:
organization · text/markdown · updated 2026-08-27T02:23:41.386Z`; the draft
**rendered as prose** ("Why handover notes rot the week after they are written…");
`Expand`; `DECISION RATIONALE (optional on approve, expected on reject)` over its
field; and `Comment` `Reject` `Approve`, with the widget's own composer beneath.
Counted inside the frame, both themes: **1** card, **1** island, island `body=1
empty=0 targets=1 rendered=true`, **1**/**1**/**1** Approve/Reject/Comment, **0**
`data-embed-signin` controls, **no** sign-in copy anywhere in the frame, **0**
floor diagnostics, **0** `no renderer resolved`, **0** Preview, **0** Download.

**The chip's pill outline is drawn in dark. Measured, not asserted.** The reading
is taken from the committed PNGs themselves: the chip's own border rows are sampled
at device scale 2, and the brightest pixel across them is compared with the panel
ground sampled just outside the pill.

| host, scheme | panel ground | chip outline pixel | contrast | drawn |
|---|---|---|---|---|
| third-party application, **dark** — this head | `rgb(13,24,42)` | `rgb(37,47,63)` | **24** | **yes** |
| third-party application, dark — *superseded frame* | `rgb(13,24,42)` | `rgb(14,25,44)` | 2 | no |
| **first-party run page, dark** — this head | `rgb(13,24,42)` | `rgb(37,47,63)` | **24** | yes |
| third-party application, **light** — this head | `rgb(255,255,255)` | `rgb(222,224,227)` | 33 | yes |

The two hosts now measure **the same colour on the same ground**, which is the
claim the fix makes. Both values are exactly what compositing predicts: the dark
hairline is `rgba(255,255,255,0.1)`, and `0.1×255 + 0.9×(13,24,42)` is
`(37,47,63)`; the light hairline is `rgba(21,33,58,0.14)`, and over white that is
`(222,224,227)`. The superseded frame's `rgb(14,25,44)` is the same light hairline
composited over the **dark** panel — the arithmetic of the defect, and why it read
as the ground.

**The header meta line resolves in the dark palette too.** The pinned-revision
line under the title is `text-muted-foreground`, one of the nine aliases the fix
completes. Its ink measures `rgb(144,161,185)` inside the third-party application
in dark — the dark palette's `--muted` (`#90a1b9`) — and `rgb(144,161,185)` on the
first-party run page in dark. In light it measures `rgb(90,100,119)`, the light
palette's `--muted` (`#5a6477`). The computed styles read out of the same mounted
documents agree: `--border` resolves to `#ffffff1a` at the chip and
`--muted-foreground` to `#90a1b9` at the meta line, on **both** hosts, while the
island's own document root inside the widget still resolves `#15213a24` and
`#5a6477` — which is precisely the shape of the defect the fix addresses, now
confined to a root nothing paints from.

**A third alias moved with them, and it is visible.** `Approve` is
`--primary`, also in the completed set. Its fill inside the third-party
application in dark measures `rgb(226,232,240)` on this head and `rgb(54,78,129)`
in the superseded frame; the first-party run page in dark measures
`rgb(226,232,240)`. The button that used to paint the light palette's primary
inside a dark widget now paints what the run page paints.

**Cross-site is measured, not asserted.** The reader signed in through the frame's
**own** hosted-PKCE popup, so an app-origin session cookie exists in the browser
(`better-auth.session_token`, `domain=localhost`, `SameSite=Lax`, `httpOnly`) —
and the island document request still went out with `cookie: absent`, while the
lifecycle resolves per capture carry `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)` and the host page's own origin in
`x-cinatra-widget-origin`. The host page is served by a plain static server on a
different origin **and a different site** from the app. Both frames were taken in
a fresh browser context with an **empty** cookie jar.

**Verdict: PASS — the card renders whole, cross-site, with no login prompt, and in
dark the island renders dark with the chip's pill outline drawn and every measured
token resolving to the same value as on the run page. The deviation this cell
carried in the previous round is resolved, and the resolution is measured on both
hosts.**

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

**Re-taken on `73c201854cecfe50c8036a32b5f7489111acb99c`**, against this commit's
own run, decided in the browser. Route:
`/agents/cinatra-ai/blog-draft-writer-agent/0770c32a-…/review/lifecycle-review%3A582f16f5…`
— asserted from `location.pathname` at each shutter, in both themes.

**The plan says** — *"One card, one gate."*

**§I requires** — *"A resolved gate stays on the rail as read-only history — its
entry keeps its place and records how it was settled"*, and *"A resolved gate opens
read-only: what was decided, and the reviewed target(s), kept for the run's audit
trail."*

**Shows** — the settled reading of the same card, drawn in this order: the gate
header `Review requested` **without** the `Awaiting your decision` pill; the **same
target panel** the pending reading drew — the title *Writing Down Decisions So They
Aren't Argued Twice*, the `Blog Post Artifact` chip, and the pinned revision line
`@cinatra-ai/blog-post-artifact:post · revision a31b40a9-ca6… · pinned ·
Ownership: organization · Visibility: organization · text/markdown · updated
2026-08-27T04:45:21.715Z` — with the draft drawn **as prose by its own renderer**
inside the island (`RENDERED` beside `RAW SOURCE`, the raw pane opening `## Why a
settled decision drifts back open`), and `Expand`; then the decision line
**`Approved by Ops Operator Two`** over *"The gate is resolved and the run has been
released to continue."*

**Held against its own pending reading.** Both columns were counted in the live DOM
in the same browser session, three minutes apart, on the same gate — the left at
`04:49:06`, before `Approve`, the right at each shutter after it.

| reading | pending, `04:49:06` | decided, at the shutter |
|---|---|---|
| island present | `1` | **`1`** |
| island `data-review-reading` | `pending` | **`decided`** |
| island `data-target-count` | `1` | **`1`** |
| pinned revision, full, from the panel's own `title` | `a31b40a9-ca65-4994-9040-20dd83f8d859` | **`a31b40a9-ca65-4994-9040-20dd83f8d859`** |
| the draft, drawn by its renderer | 12 874 chars · 35 `<p>` · 10 headings | **12 874 chars · 35 `<p>` · 10 headings** |
| a JSON envelope anywhere in the target | none | **none** |
| `Awaiting your decision` pill | present | **absent** |
| `Approve` / `Reject` / `Comment` | `1` / `1` / `1` | **`0` / `0` / `0`** |
| rationale field (`DECISION RATIONALE`) | `1` | **`0`** |
| `<textarea>` anywhere in the card | `1` | **`0`** |
| controls anywhere inside the island | `0` | **`0`** |
| buttons left in the card | `Expand`, `Comment`, `Reject`, `Approve` | **`Expand`** |
| the prompt window at the foot | present | **absent** |
| decision line | — | **`Approved by Ops Operator Two`** |

**The revision drawn is the frozen one, three ways.** The gate's `pinned_targets`
holds `representationRevisionId a31b40a9-ca65-4994-9040-20dd83f8d859`; the island
printed that same id in **both** readings; and the audit row the decision itself
wrote records `representation_revision_id a31b40a9-ca65-4994-9040-20dd83f8d859`
with `renderer_kind first-party`. What was approved is what was shown.

**The island follows the host's scheme.** `data-island-color-scheme` reads `light`
at the light shutter and `dark` at the dark one, and the target panel, its chip and
both panes paint the dark palette in the dark frame.

**Deviation, named — this route's rail records no settlement.** §I asks a resolved
gate's entry to *"keep its place and record how it was settled."* Half of that
clause holds here and half does not, and both halves are read from the rail's own
anchors on this page **after** the decision: the rail column reads `1 Schedule` ·
`2 Review`, so the Review entry **keeps its place** and stays selected — but
`[data-run-surface-rail-settled]` matches **0** elements, and no row carries a
settled state or a disposition. That is the route's own stepper
(`review-run-steps.tsx`), which derives only `completed` / `active` / `disabled`
from the active step index and has **no settled reading at all**. It is untouched
by this head's commit and is not fixed here. The `/trigger` route's rail does carry
`settled="true"`, and the run page's rail records `status=resolved`.

**A correction to the previous round's record.** That round named a second
deviation for this cell — *"the rail … no longer lists Schedule"*. It does list it:
that reading was taken from the stepper element alone
(`[data-review-run-steps]` → `2 | Review`), while the schedule entry is a sibling
drawn beside it in the same rail column. Read from the column on this head, after
the decision: `1 Schedule` (`data-action="open-schedule-step"`) above `2 Review`
(`data-action="open-review-step"`). **That deviation is withdrawn**; the
settled-state one stands.

**Verdict: PASS — the decided reading keeps the reviewed target read-only under a
gate header with no awaiting pill, drawn by the target's own renderer from the same
frozen revision the decision was taken on, with nothing left to press and no
rationale field. The previous round's deviation — the reviewed target not kept
beside the decision — is resolved, and its second deviation is withdrawn as
mis-measured. One deviation stands, named: this route's rail records no
settlement.**

## The grading table

| Cell | Host | Light | Dark | Verdict |
|---|---|---|---|---|
| W0 placeholder | the conversation, working | ✔ | ✔ | **PASS** — frame + spinner, no status, no result, nothing to press, no run-page link; drawn example's heading absent (named) |
| W1 review card | the conversation, pending | ✔ | ✔ | **PASS** — swapped in place on its own, drawn as prose by its renderer, one composer, no prompt window; no provenance row (named) |
| **W3** review card | the run page, pending | ✔ | ✔ | **PASS** on the ladder, the two-column frame, the merged gate entry and the gate opened in place; the rail reads `Step 1 / Review` and not the setup rail's three rows, the paused step is not highlighted (measured: same ink, weight and ground as the passed step), the work step is named by position, no prompt window (**4 deviations, named**) |
| **W5** review card | the review page, pending | ✔ | ✔ | **PASS** — the same run surface with the review step selected, never a standalone document, rendered beside raw source; the box under the review is today's decision box rather than the drawing's prompt window (**cinatra#2995**), rail treatment, prompt copy (**3 deviations, named**) |
| **W7** review card | a third-party application | ✔ | ✔ | **PASS** — rendered whole, no login prompt, cross-site measured on the wire, and in dark the island renders dark with the chip's **pill outline drawn**: `rgb(37,47,63)` on ground `rgb(13,24,42)`, the same reading as the first-party run page in dark, against `rgb(14,25,44)` (the ground) in the superseded frame; the meta line's `text-muted-foreground` measures `rgb(144,161,185)` on both hosts (**the previous round's 1 deviation is resolved; 0 open**) |
| **W9** decided | the review page, decided | ✔ | ✔ | **PASS** — the reviewed target is **kept read-only** under the gate header (no awaiting pill), drawn by its own renderer from the **same** frozen revision `a31b40a9-ca6…` the pending reading pinned, then the decision line `Approved by Ops Operator Two`; `0`/`0`/`0` Approve/Reject/Comment, `0` rationale fields, `0` `<textarea>`, `0` controls inside the island, `renderer_kind = first-party` in the audit row (**the previous round's “target not kept” deviation is resolved and its “rail no longer lists Schedule” one is withdrawn as mis-measured — the column reads `1 Schedule · 2 Review`; 1 deviation stands: this route's rail records no settled state**) |

## What this round does NOT claim

1. **That the gate is minted before the run terminates.** It is not — 16.5 s and
   20.2 s after, on the two runs measured here. Stated, not fixed here.
2. **That the setup rail of cinatra#2970 appears on the run page.** It does not;
   it is the `/trigger` route's rail. W3 names where each rail is drawn and what
   each one reads, from live anchors.
3. **That the resolved gate reads as history *on the rail* on every route.** It
   does not — the review page's own stepper has no settled reading at all, so its
   Review entry keeps its place but records nothing about how the gate was
   settled. W9 names the routes that do and the one that does not. The *other*
   half of that clause — a resolved gate opening read-only with the reviewed
   target kept — is what this commit adds, and W9 does claim it.
4. **The automatic swap on the widget host.** The run panel withholds it there by
   design; W7 claims the render and the absence of a login prompt, nothing more.
5. **That the box under the review is the drawing's prompt window.** It is not —
   it is today's decision box, a known deviation owned by cinatra#2995.
6. **Any reading for `W2`.** It is not one of this walk's cells and is not in this
   set.

Row-level readback, hashes and stamps: [`capture-records.md`](capture-records.md).
