# cinatra#2841 — the redrawn skills-recommendation card (§V), on the live app

Head under proof: `97b596c6e` (PR #2866), plus this evidence commit.

## READ THIS FIRST — the branch as pushed does not boot

At `97b596c6e` the app does not compile, and the failure is total: **every route
500s**, including `/`, `/sign-in`, `/api/health` and every `/api/auth/*` endpoint.
The compiler's own words, read off the running dev server:

```
./packages/agents/src/run-recommendation-actions.ts:133:17
Server Actions must be async functions.
> 133 | export function decidedSkillsFromEvidence(
      |                 ^^^^^^^^^^^^^^^^^^^^^^^^^
Ecmascript file had an error
```

`run-recommendation-actions.ts` opens with `"use server"`, and this commit added
a NON-async export to it (`decidedSkillsFromEvidence`, new in `97b596c6e`).
Next refuses the module, and the module sits in the server graph, so nothing
renders at all. The component suites do not catch it because they never go
through the server-actions compiler.

**The pictures below were taken with ONE named local repair that is NOT
committed and is NOT on the branch:** the `export` keyword on
`decidedSkillsFromEvidence` was removed, making it module-private. The function
has exactly one caller — `getRunRecommendationHoldStateAction`, in the same
file — and no test imports it, so the repair changes no behaviour and no
pixel; it only lets the module compile. The branch still needs the real fix
(this repair, or an async wrapper) before it can run anywhere.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`, on a dedicated lane
database on the verify Postgres (port 5634) and the verify Redis (port 6579),
loopback-only, with the branch's own extension tree. Placeholder-only
environment: **no model credential exists on this host**, and none is used — no
cell here needs a model turn. It is **not** a production-equivalent build; the
reason is recorded and not re-derived (`evidence/2573-s7-conformance/README.md`).

## The seeding path — all shipped writers

1. First-admin sign-up + organization through the shipped Better-Auth routes
   (`drivers/lane-setup.mjs`, unchanged from `evidence/2047-flip`).
2. Four skills assigned to `@cinatra-ai/blog-draft-writer-agent` at
   `organization` ownership through the shipped writer
   `upsertCustomSkillAssignment` — the same row the agent-settings surface
   writes. `getAssignedSkillIdsForAgent` reads all four back.
3. Three `pending_input`, human-present runs on that template.
4. Each parked through **`maybeHoldRunForRecommendation`**, the one seam the run
   trigger uses. All three answered
   `{held: true, reason: "core default fires recommendation"}` and left a
   `lifecycle_continuation_park` row with `checkpoint=recommendation`,
   `status=parked`.
5. Everything on screen after that is the shipped path: the card resolves
   through `getRunRecommendationHoldStateAction`, the candidate set through
   `resolveRecommendationCandidateSkillIds` → `getRunRecommendations`, and every
   decision was made by **pressing the chip's own button** in a real browser.

The lane DB's boot-created `Default` organization was deleted before the walk —
a second organization breaks the materializer path this stack shares.

## Cells DELIVERED

Viewport 1228 at `deviceScaleFactor: 2`; the four card cells are framed on the
card root `[data-conformance-id="run-chip-row"]`, the two page cells are full
page because what they show is not inside the card.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `A1__recommendation-card__run_card__held` | 1536×138 | Four chips on two rows — `blog-post-matcher`, `blog-writing`, `brand-voice-matcher`, `web-research` — each in its own pill with **its own `Confirm` `Adjust` `Skip`** to the right of the name. No heading, no subtitle, no card-level submit, no collapsible selector: the row is the whole card. 4 chips, 4×3 = 12 buttons, 4 chips `data-chip-mark="undecided"`. |
| `A2__recommendation-card__run_card__held-mid-decision` | 1536×138 | The same four chips. Chip 1 now carries a **green-tinted** ground and edge (pressed Confirm), chip 2 an **amber-tinted** ground and edge (went through Adjust → "Keep it in this run"), chips 3 and 4 are unchanged white/undecided. Every chip still shows all three buttons, all still pressable. Counts: `confirmed`=1, `adjusted`=1, `undecided`=2. **The live chip carries its mark as colour only — no word and no icon appears on a pressed-but-unreleased chip.** |
| `A2b__recommendation-card__run_card__held-adjust-panel` | 2456×2160 | What ADJUST opens: a right-hand **Sheet** over a blurred page — title `blog-writing`, `Recommended · rank 2 · score 0.32`, a `Scored on` list of four `intent_token` features each `(+0.08)`, and the pair `Keep it in this run` / `Leave it out`. **It does not draw in place**, so it cannot be framed on the card; that is why this cell is full page. |
| `A3__recommendation-card__run_card__settled` | 1536×190 | Three settled chips stacked, each stating its own outcome in place and **nothing to press**: `@cinatra-ai/blog-post-matcher-skill:blog-post-matcher ✓ CONFIRMED` (green tint), `@cinatra-ai/blog-writing-skill:blog-writing ✕ SKIPPED` (dashed edge, no fill, muted), `@cinatra-ai/brand-voice-matcher-skill:brand-voice-matcher ✓ CONFIRMED`. `button` count inside the root: **0**. |
| `A4__recommendation-card__run_card__held-read-only` | 1536×186 | The same four chips with all twelve buttons **on screen and greyed/disabled**, and under the row the amber line **"Shaping this run needs run access on it."** `data-run-recommendation-restricted` = 1. |
| `A5__recommendation-card__run_card__decided-page` | 2456×2560 | The DECIDED reading in its page: the app shell, `Agents › Blog Draft Writer Agent`, the `Setup` / `Permissions` tabs and a `Run agent` button, with the settled row sitting directly under the tab strip — four chips, `CONFIRMED / SKIPPED / CONFIRMED / CONFIRMED`. Nothing is summarised above the row. |

## Findings the pictures force — read these against the drawing

1. **The `Adjusted` mark is unreachable on a settled row.**
   `decidedSkillsFromEvidence` maps `selectionSource === user_forced` to
   `adjusted`. But `deriveConfirmedSelection` (packages/skills, `selection.ts`)
   stamps `user_forced` only for an id that is **not in the scored recommendation
   set at all**, and the chip row offers exactly that scored set (recommended
   *and* below-threshold candidates alike). So every chip the reader keeps —
   through Confirm *or* through Adjust — is written `recommended_confirmed` and
   reads back as **Confirmed**. Measured, twice: in `A3` the chip decided by
   `Adjust → Keep it in this run` came back `CONFIRMED`, and the two
   `data-forced="true"` chips did too. §V's three settled marks reduce to two on
   screen.
2. **The settled chip and the held chip do not label the same thing.** Held
   chips read `blog-writing`; settled chips read
   `@cinatra-ai/blog-writing-skill:blog-writing`. The settled row prints the
   skill **id**, the live row prints the **name**.
3. **The live pressed chip states nothing in words.** A pressed-but-unreleased
   chip changes colour only (`A2`); the `Check` / `SlidersHorizontal` / `X`
   icon and the `Confirmed` / `Adjusted` / `Skipped` label exist only on
   `SettledChip`.
4. **The capture contract cannot be satisfied by any truthful
   `recommendation_hold` record** — see `capture-records.json`. It requires
   `[data-lifecycle-card="recommendation_hold"]` and
   `[data-lifecycle-card-host="run_card"]`, and the shipped card emits neither
   attribute anywhere (only `ReviewGateCard` emits `data-lifecycle-card-host`).
   A `decided` capture additionally owes `[data-lifecycle-card-state]`, which the
   settled row also does not carry. Every record here prints the contract's
   verdict verbatim instead of being edited to pass, and none is registered in
   `scripts/ci/chat-hitl-capture-index.json`.

## What it took to reach the READ-ONLY reading (two honest failures first)

`canDecide === false` needs a reader who clears run **read** and fails run
**execute**. Two attempts drew **no card at all** (`rootCount` 0 — the card
renders nothing rather than a refusal, by design):

- an ordinary `member` of the run's organization;
- an `admin` of the run's organization.

In both, `enforceRunAccess(..., "read", ...)` refuses a non-owner under the
default `owner`-only policy, so `getRunRecommendationHoldStateAction` answers
`{state:"none"}`. The delivered `A4` uses the run's **shipped per-run
auth-policy override** (`agent_runs.auth_policy` — the same shape the agent
Permissions tab writes) set to `runDataVisibility:["org"]`,
`runExecuteVisibility:["owner"]`. Worth stating for the drawing's sake: a run
co-owner is *not* a read-only reader either — `COOWNER_OPS` includes `execute`.

## Cells NOT delivered

| Cell | Why |
|---|---|
| the ADJUST panel drawn IN PLACE | Not drawn that way. `Adjust` opens a portal Sheet outside the card root, so the brief's "if it draws in place" arm does not apply. `A2b` photographs what it actually opens. |
| a settled chip reading `Adjusted` | **Not reachable** — finding 1 above. No picture is claimed for a state the shipped code cannot produce. |

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` / `capture-results.json` — the records (each with the
  contract's own verdict on it) and the machine record, written by the same run.
- `drivers/` — the harness exactly as run: `walk.config.ts` + `walk.test.ts`
  (probe → assign → seed → hold → readback) and `capture.mjs` (the recorder,
  whose counting rules are written at the top of the file).

No credential, token, password or host identity appears in any file here.

Assisted-by: Claude Code (claude-opus-5)
