# cinatra#2791 (S9g) — the conformance re-capture, on the CARD AXIS

The capture half of S9g. The hygiene half landed separately (#2899): the
review-page record class is fixed, the index holds records for all four hosts,
the dead reader is gone. What was still missing was the thing the criterion
actually asks for — a picture of **every lifecycle card kind, on every host it
renders on, in the states that kind has** — and the two S7-era chat cells that
the evidence gate had been carrying as grandfathered debt since #2821.

Both are addressed here. Nothing is rounded up: the cells that could not be
driven are listed with the exact line of shipped code that stops them.

## RE-SHOT at cinatra#2945 — G5 and G6, for the label in the pixels

`#2945` renamed the audit lane's display strings. `G5` and `G6` were photographed
before that landed, so their pixels read the old word in three places at once:
the card heading, the run rail's entry and the advisory body. **Both are
replaced** — new bytes, new hashes, and their records replaced IN PLACE in
`scripts/ci/chat-hitl-capture-index.json`. They now read **Audit** in all three,
and the advisory body reads *"Audit of 3 disclosed field(s)."*

The re-shoot did NOT re-use this round's `seedRepairVerification` call. The
verification record and the advisory behind the new pictures come from a repair
this lane drove through the shipped writers on a real run —
`recordChangesRequested` → a real successor artifact → `submitRepairResponse`,
whose own trigger wrote the record and ran the audit lane. The walk, the
recorder, the grading table and the store's own timestamps are in
`evidence/2945-audit-label/`; the timestamps are also in `TIMELINE.md` beside this
file.

`G8` is **untouched**: the §V row draws none of the renamed strings.

**`G1`, `G2` and `G3` are untouched too, and that is a residual rather than a
clean result.** They are review-gate cells whose gate carries suggestions, so
they draw §VIII's block heading — and opening them shows it still reads
`CORE ANALYSIS · SUGGESTIONS`. They were outside the six cells this round was
scoped to, so they are neither re-shot nor re-recorded here; the finding is
written down instead of being left for the next reader to discover. Whether any
of the other suggestion-carrying cells elsewhere in the index read the old word
was NOT swept in this round, and no claim is made about them.

## What is captured, and against what

The authority on **which kind reaches which host today** is not a table in an
epic. It is `LIFECYCLE_HOST_PARITY_RATCHET` in
`src/lib/lifecycle/lifecycle-host-parity-ratchet.ts`, which records only cells
that were read off a rendered card, plus an `owed` list of ruled cells that must
**not** be observed yet. This round captures what main renders, cell by cell,
and where a cell is absent it says whether that is an owed mount, an undrawn
card, or a host that never mounts the kind.

The drawings each cell is graded against are the audited plan's:
§III / §IX for the review gate, §V for the skills recommendation row,
§VI for the schedule proposal, §VII for the audit card.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js dev, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a **dedicated lane database** on the
verify Postgres and the verify Redis, loopback-only, with the branch's own
extension tree. **Placeholder-only environment: no model credential exists on
this host, and none is used.** It is **not** a production-equivalent build, and
the reason is not re-derived here — it is the fence finding recorded in
`evidence/2573-s7-conformance/README.md` and ruled on by the owner
(coordination-tracker entry 334, answer 3): the scripted-provider fence and the
lifecycle-seed fence make a production build and an LLM-backed dispatch mutually
exclusive by construction, so dispatch-dependent cells are captured on the
**labelled development runtime**. Every record below carries `build:
"development"` and `runtime: "dev-runtime"`.

The setup wizard's `secrets` and `ai` steps want a live Nango and a model
credential; neither exists here, so the app's own documented, prod-unreachable
browser-e2e switch `CINATRA_E2E_SETUP_BYPASS=true` is set. It bypasses the
wizard gate **only**, and it is on the path of nothing these pictures claim.
The lane database's boot-created `Default` organization was **deleted** before
the walk: with two organization rows the blog materializer refuses outright.

Every origin, credential and path the recorder used came from the environment.
Nothing host-identifying is written into this directory or into the index.

## The seeding path — all shipped writers

`drivers/walk.test.ts` is one walk with several steps, and every step is a call
into shipped code:

| Step | What ran |
|---|---|
| `PRODUCE` | `materializeBlogPostBodyArtifact` wrote a real artifact under a real run, which put a row in `artifact_produced_outbox`. |
| `GATE` | `sweepReviewOrchestration` minted the `artifact_review_gates` row (`gatesCreated: 1`, `status: "pending"`). |
| `SUGGEST` | `runSuggestionProducerLane` derived **three** §VIII suggestions from the artifact's own bytes through the shipped readers and froze them with `writeGateSuggestionSnapshot` (`status: "written"`). |
| `REF` | `encodeLifecycleGateRef` minted the opaque handle. No ref is assembled by hand anywhere in this round. |
| `VERIFY` | `seedRepairVerification` — the app's own in-process fixture — drove `createSemanticArtifact → emitArtifactReviewGate → recordChangesRequested → createSemanticArtifact → submitRepairResponse`, whose own trigger minted the `artifact_verification_records` row (`verificationRecordPresent: true`, `verificationOutcome: "drifted"`). This walk never writes that row; it drives the pipeline that does. |
| `ASSIGN` / `SEED_RUN_FOR_HOLD` / `HOLD` | the shipped assignment writer, then `maybeHoldRunForRecommendation`, which parked each run at the `recommendation` checkpoint (`held: true`, reason "core default fires recommendation"). |

The projector handed to the suggestion lane is the **type-aware drop-in the lane
documents**, used exactly as `evidence/2865-section-i-hierarchy` uses it: the
shipped default projector can disclose nothing a rule can fire on, so it
produces no suggestion at all on a current schema.

**What is stood in for, exactly:** the model layer. Where a card reaches a
transcript, the assistant turn is persisted through the app's own
`POST /api/assistants/threads` — the route the `/chat` client itself writes with
— carrying **only** the shipped envelope `{viewType, schemaVersion, ref}`. The
card resolves its own state server-side from that ref on mount, so nothing about
a gate is asserted by the seed: the transcript carries an addressing handle and
the server answers.

## How a record is made

`drivers/capture.mjs` drives a real browser and writes each record through the
**shipped observer** (`observeCapture`) over the **shipped Playwright port**
(`playwrightPage`). It supplies which page to open, which host the cell claims
and which kind and state it photographs; **every URL, frame and count in a
record is read off the page by the observer**, never handed to it. The observer
measures, shoots, and measures again, and refuses a cell whose screen moved
between the two.

Every cell was validated at the **audit tier** before being written — the
stricter of the two tiers, which requires painted counts, measured absences, a
pinned card instance and a labelled expectation on every observation — and each
one came back clean. Three cells were **refused** and are reported below rather
than reshaped until they passed; their measurements are in
`capture-results.json`.

Device scale 2, uncropped full-page frames.

## Cells DELIVERED — requires / shows / verdict

Every row below was graded by **looking at the pixels** beside the counts.

### `G1__review-card__chat_thread__pending.png` — 2456×2800

- **Requires** (§III/§IX, chat_thread, pending): the transcript's own
  `[data-conversation-list]`; the card root declaring
  `data-lifecycle-card="artifact_review_gate"` **and**
  `data-lifecycle-card-host="chat_thread"`; the §II decision floor present
  inside that root; on a `/chat` URL class.
- **Shows**: a real held gate in a real transcript — target *Connector rollout
  note* with its island at the `Floor · structured data` tier; §VIII's
  `CORE ANALYSIS · SUGGESTIONS` block with three before/after pairs
  (`artifact · sections · 0/1/2 · text`, each `REPLACE`, `NOW` beside
  `SUGGESTED`); the composer-binding row **"Replying to this review"** with its
  own sentence; the decision floor reading *"3 of 3 suggestions accepted — they
  ride this decision. A reject records them as not taken."*; the subordinate
  `DECISION RATIONALE` field on its dashed baseline; and `Comment` / `Reject` /
  `Approve`. At the foot of the same frame, the one primary composer.
- **Counted on that screen**: `[data-conversation-list]` 1/1 painted,
  `[data-lifecycle-card-host="chat_thread"]` 1/1, the card root 1/1,
  `[data-conformance-id="review-decision-bar"]` 1/1 inside the pinned root.
- **Verdict: CONFORMS.** This is the cell `C1__review-card__chat_thread__pending`
  claimed and could not answer.

### `G2__review-card__chat_thread__decided.png` — 2456×2800

- **Requires** (§IV, chat_thread, decided): the same three host anchors, plus
  `[data-lifecycle-card-state]` inside the root and the **absence** of the
  decision bar inside it.
- **Shows**: the *same transcript*, after a **real press of the card's own
  Approve control** with a rationale typed into the card's own note field. The
  card has re-resolved to its settled floor: a check glyph over **"Approved by
  Lane 2791 Capture"** and *"The gate is resolved and the run has been released
  to continue."* The suggestion chips are still drawn above it, now under
  *"These are the per-item choices this review recorded."* There is no decision
  bar, no Refresh, and nothing to press.
- **Counted**: `[data-lifecycle-card-state]` 1/1 in the root;
  `[data-conformance-id="review-decision-bar"]` **0** in the root, recorded as a
  measured absence rather than an omission.
- **Verdict: CONFORMS.** Pending → decided is one continuous interaction on one
  screen, not two unrelated screenshots. This is the cell
  `C2__review-card__chat_thread__decided` claimed.

### `G3__review-card__page_gate_region__pending.png` — 2456×3140

- **Requires** (§IX, page_gate_region, pending): the card root declaring
  `data-lifecycle-card-host="page_gate_region"`, the decision floor inside it,
  on the gate-region deep link `/agents/<vendor>/<package>/<runId>/review/<taskId>`.
- **Shows**: the **same component** the transcript draws, unframed in the page
  column under the run's step rail — `Review requested · Awaiting your decision`,
  the island, the three §VIII pairs, the accepted-count line, the rationale
  field and the same three controls. The page adds only its own chrome (the
  step rail, the "Ask Cinatra to suggest edits" prompt window).
- **Counted**: host declaration 1/1 frame-wide **and** 1/1 inside the pinned
  root; card root 1/1; decision bar 1/1 in the root.
- **Verdict: CONFORMS.** One card implementation, two hosts, differing only in
  the frame.

### `G5__audit-card__run_card__advisory.png` — 2456×2960 (re-shot at #2945)

- **Requires** (§VII, run_card, advisory): the card root declaring
  `data-lifecycle-card="verification_summary"` and
  `data-lifecycle-card-host="run_card"`, on a run-detail URL. §VII asks nothing,
  so it owes **no** control.
- **Shows** (as re-shot): `Audit` with the outcome pill **`Out-of-scope drift`**; the
  sentence that explains what that means; the revision pins
  (`98d31a95… → 5ef2e3fc…`); the before/after table with one row,
  `representation.resource`, carrying its own **`OUT OF SCOPE`** authorization
  mark, the before struck through and the after in place; and the
  `ADVISORY COMMENTS` panel with its `SERVICE` author-kind, the body
  *"Audit of 3 disclosed field(s)."* and the analysis provenance. The run rail's
  own entry beside it reads **Audit DRIFTED**. Nothing on the card can be pressed.
- **Counted**: host declaration 1/1 frame-wide and 1/1 in the root; card root
  1/1.
- **Verdict: CONFORMS.** This kind had **zero** cells before this round.

### `G6__audit-card__page_gate_region__advisory.png` — 2456×2960 (re-shot at #2945)

- **Requires**: the same, with `data-lifecycle-card-host="page_gate_region"`, on
  the review page's verification region (`?view=verification`, the run rail's
  Core-analysis entry).
- **Shows** (as re-shot): the **same renderer**, same chrome, same `Audit`
  heading, same pill, same pins, same marked row, same advisory panel — sitting unframed in the page column, with
  **no back link and no floor**, exactly as the plan's §8.4 sequence describes
  the as-designed page.
- **Counted**: host declaration 1/1 frame-wide and 1/1 in the root; card root
  1/1.
- **Verdict: CONFORMS.** S9e's "one core renderer, the page composes around it"
  is visible as the same drawing on two hosts.

### `G8__recommendation-card__run_card__held.png` — 2456×2960

- **Requires** (§V, run_card, held): the row's own root declaring
  `data-lifecycle-card="recommendation_hold"` and
  `data-lifecycle-card-host="run_card"`, with at least one of the three per-chip
  controls inside it.
- **Shows**: four chips — *Blog Idea Matcher Skill*, *Blog Image Matcher Skill*,
  *Blog Idea Authoring Skill*, *Blog Post Matcher Skill* — each carrying its own
  `Confirm` / `Adjust` / `Skip`. No heading plate, no row-level submit, no
  summary line: the row **is** the card, and the decision is per chip.
- **Counted**: host declaration 1/1 frame-wide and 1/1 in the root; card root
  1/1; `[data-skill-action="confirm"]` **4**, `adjust` **4**, `skip` **4**, all
  painted, all inside the pinned root.
- **Verdict: CONFORMS** to the §V redraw, re-shot at this head beside the
  committed V-series.

## Cells NOT delivered — the exact obstacle, in shipped code

| Cell | Why it is not here |
|---|---|
| `trigger_schedule_proposal` on **chat_thread** and **site_widget**, in every state — and **AC-3** with them | **§VI's card is not drawn on main.** `packages/chat/src/renderable-views/registry.tsx` still dispatches `trigger_schedule_proposal` to the S1 shell `LifecycleCard`. The shell renders `data-lifecycle-card` and `data-lifecycle-card-state` on one div and **no** `data-lifecycle-card-host` and **no** `[data-action]`, so a capture of it satisfies neither the contract's host anchor nor a pending state's control requirement. A picture taken anyway would photograph the S1 shell and file it under the ratified drawing — the exact mislabel the index exists to refuse. AC-3 asks for "the drawn schedule card"; the drawn card is owed by the slice that draws it. |
| `verification_summary` on **chat_thread** | **The record vocabulary, not the pixels.** The card was driven and drew: the transcript rendered it and the observer measured it. But `CAPTURE_STATES` in `scripts/audit/lib/chat-hitl-capture-recorder.mjs` is `["pending","decided"]`, and the audit tier requires a chat_thread record's `declaredState` to be one of those two. §VII resolves **`advisory`** — the card's own root says so — so the honest record is refused by the tier. Declaring it `pending` would owe controls §VII never draws; declaring it `decided` would contradict the root the picture shows. The refusal and its counts are in `capture-results.json`. The tier owes an `advisory` word; this round did not widen it under cover of a capture. |
| `artifact_review_gate` on **page_gate_region**, **decided** | **The card is never mounted.** The press landed — the gate is `resolved`, `disposition: "approve"`, with this reader recorded — but `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx` routes a settled gate through `loadReviewGateSurface` to a page-level `ReviewGateBlocked` panel ("This review is no longer open") *before* the card is composed. So on this host the settled **card** does not draw at all, while the same gate settled in a transcript draws it (G2). Recorded as a finding, not as a missing screenshot. |
| `recommendation_hold` on **chat_thread** and **site_widget** | **Ratcheted as OWED**, and must stay unobserved: `LIFECYCLE_HOST_PARITY_RATCHET` carries them as owed to cinatra#2786 (S9b) and cinatra#2790 / #2890 (S9f). Neither mount is on main on this branch's base. Capturing them would mean capturing a branch's promise. |
| `recommendation_hold` on **run_card**, settled | Already answered by committed records `V5`, `V6` and `V9` (evidence/2841-v-redraw), which this round leaves untouched. Pressing every chip's `Confirm` in the browser recorded no per-skill row and did not release the park, so the row stayed held; rather than file a held row under a settled name, the attempt is recorded in `capture-results.json`. |
| `artifact_review_gate` and `verification_summary` on **site_widget** | Review gate: already answered by committed records `C1`–`C3` (evidence/2754-island-wire) and `I4`/`I5` (evidence/2865-section-i-hierarchy). Verification: **not driven this round** — the provisioned-embed recipe was not run here, so the cell is owed rather than claimed. |

## Findings the pictures force

1. **A settled gate has two different faces depending on the host.** In a
   transcript the card re-resolves and *says what happened* — "Approved by …",
   with the recorded per-item choices still visible (G2). On the review page the
   route replaces the whole surface with a generic "no longer open" panel before
   the card exists. Same gate, same reader, same second; one host carries §IV's
   settled reading and the other does not.
2. **§VII is drawn identically on both composition hosts** (G5, G6) — the same
   chrome, pill, pins, marked row and advisory panel — which is what S9e's "one
   core renderer" is supposed to look like from outside.
3. **The artifact preview degrades to the generic read-only view on this lane**
   ("review target unavailable — slot 'detail', reason 'no-semantic-renderer'"):
   `@cinatra-ai/blog-post-artifact` declares no renderer, so the ladder resolves
   to its floor. Visible in G1, G2 and G3. It bears on nothing these cells claim
   — the card, its suggestions, its floor and its decision path are all real —
   but it is on screen, so it is stated.

## What this round changes outside this directory

- **`scripts/ci/chat-hitl-capture-index.json`** gains the six records above, each
  written by the shipped recorder and validated at the audit tier before it was
  written. Their `finalUrl` values are repo-style paths, the same spelling the
  committed records use.
- **`scripts/audit/chat-hitl-acceptance-manifest.json`** rows 1 and 15 now cite
  `G1` / `G2` where they cited `C1` / `C2`, and row 15's `gap` is restated cell
  by cell. The S7 pictures are **not** deleted and their directory is untouched:
  what is withdrawn is the citation of cells no record could answer.
- **`scripts/ci/chat-hitl-evidence-gate.rollout.json`** drops both
  `knownFindings` entries. They named this slice as the one that clears them,
  and they are cleared because the evidence now exists — not to quiet the gate.

## Gates, run on this tree, with real exits

Each gate was also run on a **pristine checkout of this branch's base**
(`origin/main`), so "green" is a change rather than a claim.

| Gate | On pristine `origin/main` | On this branch |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs --enforce` | **0** — but with **2 grandfathered** `evidence/unbound-cell` findings (`C1`, `C2`) | **0**, **no findings**, and **zero grandfathered entries**: `knownFindings` is now empty |
| `scripts/ci/chat-hitl-evidence-gate.mjs` (default) | 0, same two grandfathered | **0**, no findings |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **1** — 4 capture-index violations (rows 1 and 15 × 2 cells) | **0** — "manifest honest — 16 rows (10 MAPPED, 4 BUILT, 2 MISSING); every named proof exists in the tree. Capture index host-anchored — 34 record(s)." |
| `scripts/audit/chat-hitl-acceptance-gate.mjs --strict` | 1 | **1** — unchanged and correct: two criteria are legitimately MISSING |
| `scripts/audit/chat-hitl-retirement-gate.mjs` | 0 | **0** |
| `scripts/audit/chat-hitl-one-card-gate.mjs` | **1** | **1** — *pre-existing and untouched*: it fails while `trigger_schedule_proposal` is a placeholder and `recommendation_hold` has no mount on three hosts. It reads only production sources under `packages/` and `src/`, none of which this round changes. |

**The retirement is EARNED, not declared.** The two grandfathered findings are
gone because the cells they named now have records, not because an entry was
deleted from a policy file. Both halves of the pair — the evidence gate's
findings and the acceptance gate's four violations — are at **zero**.

`--strict` READY is **not** claimed. Rows 3 (AC-3) and 15 (AC-15) stay
`MISSING`, because §VI's card is not drawn and the card axis is not complete —
which is the honest state of the program, stated in the rows themselves.

## Ratchets struck, deliberately

Three pinned suites asserted the OLD state by design — they are red done-checks,
and the day the finding clears they must be struck or CI stays red for the wrong
reason. Each was updated with its reason inline, never relaxed:

- `scripts/audit/__tests__/chat-hitl-capture-index.test.mjs` — the screenshot
  inventory now lists the `G` cells; "exactly these chat_thread cells are unbound
  today" is now `[]`; and the CLI arm asserts the mirror image (no
  capture-index message, default mode green).
- `scripts/audit/__tests__/chat-hitl-acceptance-gate.test.mjs` — the evidence
  half is asserted silent and the default mode green, while the criteria half
  still reports NOT READY; the gap ratchet moves from `CARD AXIS MISSING` to
  `CARD AXIS PARTIAL` and additionally pins the §VI obstacle sentence.
- `scripts/ci/__tests__/chat-hitl-evidence-gate.test.mjs` — the grandfathering
  MECHANISM tests now run against a **fixture** policy (they used to derive their
  fixture from the live `knownFindings`, so they only exercised the mechanism
  while debt existed), plus a new ratchet asserting the live policy grandfathers
  **nothing** today.

## Files

- `captures/` — the six PNGs, uncropped, device scale 2.
- `capture-records.json` — this round's own twin of its index records: same
  bytes, same hashes, same recorder id.
- `capture-results.json` — every cell that was driven and **refused**, with the
  counts that produced the refusal, so each "not delivered" row above can be
  checked rather than taken on trust.
- `drivers/` — `walk.config.ts`, `walk.test.ts` (the shipped-writer walk),
  `lane-setup.mjs`, `seed-chat-thread.mjs`, `capture.mjs` (the recorder).
