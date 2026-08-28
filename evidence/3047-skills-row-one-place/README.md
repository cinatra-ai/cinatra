# The skills row on the run page, in ONE place — measured on the real surface

cinatra#3047 criterion 4, on PR #3048's branch head. **One real run** of
`@cinatra-ai/blog-draft-writer-agent`, started from the app's own chat with a real model
provider through the real public MCP toolbox, created by the app's own dispatch and driven only
by pressing what the screens themselves draw. Four moments of that run, **light and dark in the
same browser context**, with the placement read off the LIVE DOM before every shutter.

Run **`67d76eb1-5806-4129-a555-e187b78bbf6d`**. Every number is selected in `RUN-READBACK.md`;
the order of events is in `TIMELINE.md`; every record the shipped recorder wrote is in
`capture-records.md` and `capture-records.json`.

## What criterion 4 asks, and what was measured

> *"Proved on a real run: full-window pictures, light and dark, of the run page at the HITL
> moment and at the review moment, graded against the drawing's section II placement with the
> ancestor assertions of criterion 1 read from the live DOM; batch 1's S2 is the schedule-moment
> baseline the two must match; recorded through the shipped capture recorder as
> `recommendation_hold` × `run_card` (held and settled)."*

Four moments were photographed, not two: the recommendation moment (held) and the schedule
moment are in as well, because the schedule moment is the baseline the other two are supposed to
match and the held reading is the one the rail step's own surface draws.

**The ancestor assertions, on all eight frames, without exception:**

| reading | every frame |
| --- | --- |
| `[data-lifecycle-card="recommendation_hold"]` roots on the page | **1** |
| that root's `closest("[data-run-detail-column]")` | **not null** |
| that root's `closest("[data-run-review-slot]")` | **null** |
| that root's `closest("[data-run-progress-panel]")` | **null** |
| roots counted INSIDE `[data-run-progress-panel]` | **0** |
| roots counted INSIDE `[data-run-review-slot]` | **0** |
| the root's own `data-lifecycle-card-host` | **`run_card`** |

And the same reading again with the rail step SELECTED, at each of the three settled moments
(criterion 2's *"selecting it opens the row without a second instance"*): **1** root, still
inside `[data-run-detail-column]`, still **0** inside the run-progress panel.

## Where the absence was measured, and where it could not be

Stated precisely rather than generalised. `AgenticRunPanel` returns EITHER a
`[data-run-review-slot]` section OR a `[data-run-progress-panel]` section — never both — so the
box the row must not be in is on the page at exactly one of the four moments:

| moment | `[data-run-progress-panel]` on the page | `[data-run-review-slot]` on the page | roots inside either |
| --- | --- | --- | --- |
| recommendation (held) | 0 — the panel does not render for a run on `pending_input` | 0 | — |
| **HITL setup (settled)** | **1** | 0 | **0** |
| schedule (settled) | 0 — the run-detail branch is `trigger`, which mounts no panel | 0 | — |
| **review (settled)** | 0 | **1**, reading `review` | **0** |

So *"the run-progress panel draws no copy"* is a DIRECT measurement at the HITL moment, where
the box is on screen with the settled row above it and nothing inside it; at the review moment
the same component's other section is on screen and carries none either. At the other two
moments there is no box to be absent from, and this round does not dress that up as the same
reading.

**The working moment was not photographed.** The issue names HITL, working and review as the
three moments the panel used to draw the second copy. This round photographed HITL and review,
which is what criterion 4 asks for; the working reading (`data-run-review-slot="working"`, the
placeholder before the gate mints) was not sampled, and its absence of a copy is therefore NOT
claimed here.

## The graded cells

Each cell: **requires** — the drawing's own words at the contract's pin, rendered with the
capture browser (`drivers/00-render-the-drawing.mjs`) and copied, not recalled; **shows** — what
was measured; **verdict**. PASS only where every clause shows.

The two drawings are read at the pin the capture contract carries
(`scripts/ci/lib/capture-record-contract.mjs`).

### P1 — the recommendation moment, HELD, the row as the rail step's own surface (light and dark)

**Requires**, app-artifact-review §II verbatim: *"A run can open on a recommendation. Where a run
begins by recommending the skills it proposes to use, that recommendation is the run's first
gate — it sits at the trigger position, the top entry on the step rail, ahead of the work steps
it would authorize. It renders as a chip-row: one chip per recommended skill, each carrying the
three affordances confirm, adjust and skip, so the human shapes what the run will do before it
does it."* and *"This section fixes where the chip-row lives — the trigger-gate entry at the head
of the rail, in the same two-column run frame as every other gate, its chip-row filling the run
detail while the rail carries the run's steps beside it."*; cards §V verbatim: *"The row is the
whole card. There is no heading plate above it and no row-level submit beneath it — nothing
states the question a second time, and nothing decides every skill at once."*

**Shows** — the rail carries exactly one gate row, reading `1 Recommendation`, and it is the
TOP entry (`[data-recommendation-rail-step]` **1**, `data-recommendation-step-selected="true"`,
`data-recommendation-step-settled="false"`; the rail column's own text is
`["1 Recommendation","1"]` — no other step exists yet). `[data-run-detail-column]` carries
`data-run-surface-selected-step="recommendation"`, and the step's whole surface is the row:
**1** `recommendation_hold` root, `data-lifecycle-card-state="held"`,
`data-lifecycle-card-host="run_card"`, inside `[data-run-detail-column]`, outside
`[data-run-review-slot]` and `[data-run-progress-panel]`. Four chips, and each carries all three
affordances: `[data-skill-action="confirm"]` **4**, `="adjust"` **4**, `="skip"` **4**, all
painted, counted INSIDE the card's own root by the shipped recorder. No heading plate above the
row and no row-level submit beneath it. Same composition and the same counts in dark.

**Verdict — PASS**, light and dark.

### P2 — the HITL setup moment, the row SETTLED, with the run-progress box beneath it (light and dark)

**Requires** — §II's placement clause again, and cards §V verbatim: *"The settled row is still
the whole card: each chip states its own outcome in place. Nothing is summarised above it, and
there is nothing left to press."*

**Shows** — the run is at its setup gate (`status=pending_approval`, gate
`setup-67d76eb1-…`, field `idea`). The rail reads `Recommendation` with
`data-recommendation-step-settled="true"`, and the run detail draws, in this order: the settled
chip row, then the `Agentic Run Progress` box with its `Awaiting input` badge and the agent's own
`Idea (optional)` field and `Continue`. **1** `recommendation_hold` root,
`data-lifecycle-card-state="decided"`, host `run_card`, inside `[data-run-detail-column]`;
`[data-run-progress-panel]` **1** on the page and **0** roots inside it; four chips reading
`CONFIRMED`, `ADJUSTED`, `CONFIRMED`, `SKIPPED` — each stating its own outcome in place, with
`[data-skill-action="confirm"|"adjust"|"skip"]` **0** inside the root. Nothing is summarised
above the row. Same composition and counts in dark.

**This is the frame the issue is about.** Batch 1's A4 photographed this same moment with the
row INSIDE the `Agentic Run Progress` box. Here the box is on screen, the row is above it, and
the box contains no copy.

**Verdict — PASS**, light and dark.

### P3 — the review moment, the settled row above the review card (light and dark)

**Requires** — §II's placement clause; and app-artifact-review §I verbatim: *"a gate step opens
the gate's own surface in place — a pending review renders the review gate … right here in the
run detail, under the same rail, never as a standalone document."*

**Shows** — the artifact review gate is on file
(`lifecycle-review:2a4391dfb07190415f554844ae0c7abc3dbf854387877e60c53d9d9bcca59912`, `pending`,
created 11:16:16.321Z). The rail reads `✓ Recommendation`, `✓ Step 1`, `Review`; the run detail
draws the settled chip row and, beneath it, the review gate in place —
`[data-run-review-slot]` **1** reading `review`, `[data-lifecycle-card="artifact_review_gate"]`
**1**. **1** `recommendation_hold` root, `decided`, host `run_card`, inside
`[data-run-detail-column]`, `closest("[data-run-review-slot]")` **null**, and **0** roots
counted inside that slot. Nothing is drawn as a standalone document.

One reading is stated rather than softened: in the LIGHT frame the review target's own body is
still drawing its loading skeleton (the frame was taken 22.5 s after the gate row was written);
the DARK frame, 3.9 s later, carries the rendered artifact —
`A Sustainable Weekly Publishing Rhythm for Small Teams`, `Blog Post Artifact`,
`@cinatra-ai/blog-post-artifact:post · revision 9ed41aaf-52d… · pinned`, `text/markdown`. That is
the review target's own load, not the subject of this criterion, and it is recorded because it is
what the picture shows.

**Verdict — PASS** for the placement, light and dark.

### P4 — the schedule moment, the settled row beside the rail (light and dark)

**Requires** — §II's placement clause. This is the moment batch 1's S2 already showed in the
right place, and criterion 4 makes it the baseline the other three must match.

**Shows** — the run is at `pending_trigger` and the run detail draws the settled chip row and,
beneath it, the scheduling step (`When should this run?` · `Run right after setup` ·
`Schedule for later` · `Recurring`). **1** `recommendation_hold` root, `decided`, host
`run_card`, inside `[data-run-detail-column]`, outside both named boxes. The rail reads
`Recommendation`, settled. Same composition and counts in dark.

**Verdict — PASS**, light and dark. The four moments now draw the row in the SAME place, which
is what the issue asked for: at the schedule moment it is where batch 1 found it, and at the
other three it has moved to join it.

## The record this round leaves in the canonical index, and one it does not touch

Eight records were written by the SHIPPED recorder (`observeWalkCell`) at the shutter, and
merged into the canonical index through the shipped `mergeWalkRecords`: **105 → 113 records, the
shipped validator accepts all 113**. **The recorder refused nothing** — zero refusals, and the
count is the count that was actually got, not a hope.

`evidence/2936-w6-captures/cells/A4__recommendation-card__run_card__decided__*` is LEFT WHERE IT
STANDS. It is a truthful record of what the head it was taken on drew, and it is the picture of
the placement this branch removes — so on this branch it can no longer be reproduced. It is not
retired here: retiring another round's record is that round's own call, and this round has no
finding that its record was false when it was made.

## The disclosed writes, and what was NOT written

1. **Four organization-owned skill assignments**, through the shipped
   `upsertCustomSkillAssignment`, read back through the shipped
   `getAssignedSkillIdsForAgent` — all four resolved (`drivers/02-assign-skills.test.ts`).
2. **Two provisioning writes** shared with the sibling rounds, made by the lane's own
   throwaway-world script rather than by a committed driver: the lane account's `role` column
   has `admin` APPENDED to it (never clobbered), and the account is inserted as an `owner`
   member of the organization the instance's own boot stamped the agent template with — the
   dispatch boundary refuses a stranger's org before a run exists.
3. **Three packages published** into the lane's own throwaway dev registry and read back from it
   (`registry-publish.json`), through
   `evidence/2936-w6-captures-batch-2/drivers/01-publish-run-packages.mjs`, which this round ran
   unchanged rather than copying.
4. The instance namespace was set through the app's own `/setup/name` step, the public origin
   through the app's own `/configuration/development?tab=tunnel` form (and read back by the app),
   and the model provider through the app's own `/setup/model` step
   (`evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs`), which sealed
   the connection itself.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status"` over
`evidence/3047-skills-row-one-place/drivers/` is **EMPTY**: no run, gate, park, record or review
task was inserted by this round's drivers and no status was written by hand. The run was found
BY DIFFERENCE against the rows that existed before the sentence was typed.

## The palette, and how the dark frames were made dark

The browser context is opened with **no `colorScheme` emulation at all**. The operating system's
`prefers-color-scheme` was read on every single frame and is `false` throughout; the app resolves
an unset preference to its light palette whatever the OS says
(`{"dark":false,"stored":null,"osPrefersDark":false}` before anything was pressed). Every dark
frame was made dark by pressing the header's own **Toggle theme** control, which is what stores
`theme=dark` and puts the class on `<html>`; both frames of every pair were taken in the SAME
context at the SAME moment of the SAME run, with no reload between them.

Every filed frame is measured in `frame-measurements.json`: 2880×1800 (1440×900 at device scale
2), and the mean luminance decoded from the file itself —

| pair | light | dark |
| --- | --- | --- |
| P1 recommendation, held | 237.81 / 255 | **11.11 / 255** |
| P2 HITL setup, settled | 237.82 | **13.13** |
| P3 review, settled | 236.63 | **16.92** |
| P4 schedule, settled | 236.56 | **14.41** |

No frame filed as dark is above 128/255. The frames carry no development pill: the dev server's
own dev-indicator control (`POST /__nextjs_disable_dev_indicator`, the endpoint the Next dev
toolbar's own "hide" affordance calls) was used, and it is disclosed as an environment action —
it is a development-toolbar preference and renders nothing of the product. The DOM reading
`devPill` in `run-walk.json` counts `nextjs-portal` host elements, which are still in the
document and draw nothing; the pictures are the reading that matters and they carry no pill.

## Provider evidence, and its limits

| read | value |
| --- | --- |
| `POST /api/mcp 200` callbacks from the provider's own servers over the lane's public origin, during the measured run | **5** |
| `[llm-bridge-run-select]` lines the agent runtime produced | **1** |
| scripted-provider lines in the server log | **0** |
| `CINATRA_TEST_LLM_PROVIDER` in the driving environment | **unset**, and absent from the lane's env file — the driver aborts if it is set |
| ingress refusals during the measured turns | **0** |
| ingress refusals on the warm-up probe before them | **0** |

**The limit, stated:** `cinatra.llm_usage` does not exist on an instance built from the
public-schema fixture (`relation "cinatra.llm_usage" does not exist`), so there is no per-call
token table to quote. The positive evidence is the five public-MCP callbacks, the bridge line,
the absent scripted lines, and the artifact the run actually produced and the review gate it
opened on it.

## The lane's own faults, recorded

Three runs preceded the measured one on this lane, and none of them is a reading of the product:

1. **Run `4ac55430-…`** — a DRIVER fault. The driver selected the recommendation rail step before
   answering the setup gate, and a selected gate step REPLACES the run detail, so the gate's own
   fields were not in the column the driver looked in. Left parked; no picture filed.
2. **Run `c64f197f-…`** — a driver/timing fault. The shutter fired before the run page's own
   two-column frame had painted, and the frame it caught was the agent's own screen rather than
   the run's. The driver now waits for `[data-run-detail-column]` and the rail step, and reloads
   if they do not arrive; no picture from that run is filed.
3. **Run `a4016a2f-…`** — a complete, correct walk whose frames were taken by the driver's own
   shutter, BEFORE the shipped recorder was wired into it. Superseded rather than filed: a
   picture that no shipped record was written for at the moment it was taken is not evidence this
   round will file.

The measured run is the fourth, and it is the only one any filed frame comes from.
