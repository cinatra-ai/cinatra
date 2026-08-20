# cinatra#2841 — the redrawn skills-recommendation card (§V), on the live app

Head under proof: `23f92dee6371a5ad594c0fde2aae2680feac047d` (PR #2866), plus the
label fix and this evidence commit.

## What changed since the previous round

The `V1`–`V9` set was **re-shot in full** after eye-grading found a fourth
conformance defect the previous round photographed without noticing: every chip
printed the skill's **slug** (`blog-post-matcher`), while §V draws a
natural-language name (`Enrich contacts`) and the owning extension's manifest
declares one (`cinatra.displayName: "Blog Post Matcher Skill"`). The standing
platform rule is that a rendered name is the manifest `displayName`, never a
package identifier or a slug. The chip-row took the catalog `name`, which for an
extension-owned skill is its SKILL.md frontmatter name — the slug.

The fix resolves the manifest title **server-side, once**, in
`buildRecommendationCandidatesForAgent`, onto a new `RankedRecommendation.displayName`
carried by the scorer without ever being scored, and every place the card prints a
skill — held chips, settled chips, the `Adjust` panel title and the read-only
reading — reads that one field. Nothing is re-derived on the client and no map is
hardcoded. Where an extension declares no title, the label falls back to the
skill's catalog name, which is exactly what shipped before; the four skills below
all declare one.

The earlier `A1`–`A5` set was taken at `97b596c6e`, before the three graded
conformance findings were fixed, and with a local repair that was never on the
branch. **It is superseded and removed** — it photographed a settled row that
printed package ids, a card root that carried no kind/host/state marks, and a
drawing mark (`Adjusted`) the shipped code could not then reach. All three were
closed by `1d95dd06a`; `2cd1f31ba` + `50bdbeb79` then moved the settled-evidence
helper out of the `"use server"` module, which is why the branch now boots.

**The branch boots at this head.** `/api/health` 200, `/sign-in` 200, and every
cell below rendered with an empty `pageErrors` list.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`, on a dedicated lane
database on the verify Postgres (port 5634) and the verify Redis (port 6579),
loopback-only, with the branch's own extension tree and a raised
`CINATRA_BOOT_READY_TIMEOUT_MS`. Placeholder-only environment: **no model
credential of any kind exists on this host**, and none is used — no cell here
needs a model turn. It is **not** a production-equivalent build; the reason is
recorded and not re-derived (`evidence/2573-s7-conformance/README.md`).

Every record is labelled `dev-runtime`. Viewport 1228 at `deviceScaleFactor: 2`,
uncropped, full resolution.

## The seeding path — all shipped writers

1. First-admin sign-up + organization through the shipped Better-Auth routes
   (`drivers/lane-setup.mjs`, unchanged from `evidence/2047-flip`).
2. Four skills assigned to `@cinatra-ai/blog-draft-writer-agent` at
   `organization` ownership through the shipped writer
   `upsertCustomSkillAssignment`. `getAssignedSkillIdsForAgent` reads all four
   back.
3. `pending_input`, human-present runs on that template, each parked through
   **`maybeHoldRunForRecommendation`** — the one seam the run trigger uses. Every
   one answered `{held: true, reason: "core default fires recommendation"}` and
   left a `lifecycle_continuation_park` row with `checkpoint=recommendation`,
   `status=parked`.
4. Everything on screen after that is the shipped path: the card resolves through
   `getRunRecommendationHoldStateAction`, the candidate set through
   `resolveRecommendationCandidateSkillIds` → `getRunRecommendations`, and
   **every decision was made by pressing the chip's own button in a real
   browser.** Nothing was written into the decision store directly. The settled
   cells were shot on a run that was **parked and undecided when this pass
   started**: `V5` drove it to `decided` by pressing `Confirm`, `Adjust` →
   *Keep it in this run*, and `Skip` twice, and `V6`/`V9` then photographed what
   those presses left behind.

**The run intent was chosen, not the scores.** The scorer is deterministic:
`score = Σ intent-token hits × 0.08` (capped 0.35), recommended at `≥ 0.30`, so a
skill needs four prompt tokens in its own name/description to be recommended. The
seeded prompt — *"Draft a blog post from the attached resource that classifies the
brand voice and tone guide, and keep the editorial writing rules."* — puts three
of the four assigned skills over the threshold and leaves `web-research` under it.
That is what lets ONE settled row carry all three of §V's marks: a Confirmed, an
Adjusted, and a Skipped.

**Two lane repairs, stated.** (1) The fixture's `agent_templates.org_id` pointed
at an organization row that no longer exists, so every non-owner was refused
(`cross_org`) and the run-start dispatch was refused after the decision landed. It
was repointed to the lane's own organization before the final pass. (2) An RBAC
fixture had seeded a second organization named `Default`, unrelated to this lane
and carrying none of its users; it was removed before this pass so no stray
organization could appear in a switcher. Both are lane data, not code: they
change who may open the page, never what the card draws.

## The read-only reading — how it was actually reached

`canDecide === false` needs a session that clears run **read** and fails run
**execute**. It is the run's own shipped per-run auth-policy override
(`agent_runs.auth_policy`, the shape the agent Permissions tab writes), set to the
COMPLETE four-field policy:

```
{"runListVisibility":["workspace"],"runDataVisibility":["workspace"],
 "runExecuteVisibility":["owner"],"allowRunSharing":false}
```

Worth stating because it cost two failures: a PARTIAL policy object is dropped
silently. `parseAuthPolicySafe` runs the row through `AgentAuthPolicySchema`,
which requires all four fields; a two-field override fails validation, is treated
as a null override, and the run falls back to the owner-only default — so the
reader gets a 404 and the card never draws. The reader here is an ordinary org
`member` (not a platform admin, not a co-owner: `COOWNER_OPS` includes `execute`,
so a co-owner is not a read-only reader).

## Cells DELIVERED

The seven card cells are framed on the card root
`[data-lifecycle-card="recommendation_hold"]`; the two page cells are full page
because what they show is not inside the card. Paired light/dark cells use the
same run and the same frame selector, so the framing is identical.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `V1__…__held` | 1536×138 | Four chips on two rows — **`Blog Post Matcher Skill`, `Blog Writing Skill`, `Brand Voice Matcher Skill`, `Web Research Skill`**, each the owning extension's manifest `displayName`, never its slug — each in its own pill with **its own `Confirm` `Adjust` `Skip`** to the right of **its name**. No heading plate, no subtitle, no `Skills (n/m)` selector, no card-level submit: the row is the whole card. 4 chips, 12 buttons, 4 `data-chip-mark="undecided"`, **0 headings** and **0** `[data-action="confirm-run-recommendation"]` / `[data-action="skip-run-recommendation"]` inside the root. |
| `V2__…__held__dark` | 1536×138 | The same row, same framing, after pressing the shipped **Toggle theme** control; `document.documentElement` reports `dark`. Same 4/12/4 counts. |
| `V3__…__held__mid-decision` | 1536×138 | The same four chips mid-decision: `Blog Post Matcher Skill` carries a **green-tinted** ground (pressed `Confirm`), `Brand Voice Matcher Skill` an **amber-tinted** ground (went through `Adjust` → *Keep it in this run*), the other two are unchanged/undecided. Every chip still shows all three buttons, all still pressable. Counts: `confirmed`=1, `adjusted`=1, `undecided`=2, `settled`=0 — **the row is never decided as a unit.** |
| `V4__…__held__adjust-panel` | 2456×2320 | What `Adjust` opens: a right-hand **Sheet** over a blurred page — title **`Brand Voice Matcher Skill`** (the same label its chip prints, not the slug), `Recommended · rank 3 · score 0.35`, a `Scored on` list of eight `intent_token` features, and the pair `Keep it in this run` / `Leave it out`. **It does not draw in place** — it is portalled outside the card root, which is why this cell is full page. |
| `V5__…__settled` | 1436×122 | §V's settled row, all three marks at once and nothing to press: `Blog Post Matcher Skill ✓ CONFIRMED` (green tint), `Blog Writing Skill ✕ SKIPPED` (dashed edge, no fill, muted), `Brand Voice Matcher Skill ⇄ ADJUSTED` (amber tint). Each chip carries **the skill's DISPLAY NAME** — not its package id and not its slug — which is why the row now wraps to two lines where the slug row fitted on one. `button` count inside the root: **0**; `[data-lifecycle-card-state]`: **decided**. |
| `V6__…__settled__dark` | 1436×122 | The same settled row, same framing, in `dark` — the three tint tokens resolve in both palettes. |
| `V7__…__held__read-only` | 1536×186 | §V's read-only reading: all four chips — same four display names — with all twelve buttons **on screen and greyed/disabled**, and under the row the amber line **"Shaping this run needs run access on it."** `data-can-decide="false"`, `data-run-recommendation-restricted`=1. |
| `V8__…__held__trigger-position` | 2456×2320 | The held row in its page: the app shell, `Agents › Blog Draft Writer Agent`, the `Setup` / `Permissions` tabs, and the chip row sitting **directly under the tab strip with nothing above it** — no heading plate, no summary line. The four display names are legible at page scale. |
| `V9__…__decided__page` | 2456×2320 | The decided reading in its page, and the consequence: the run card has **advanced**. `Agentic Run Progress` / `Awaiting input`, the settled row at the **trigger position** inside it, and beneath the row the run's own required input — a single plain **Idea** field with **Continue**. The row sits ahead of the step it authorized, and nothing is summarised above it. |

## The grading, item by item against §V

| # | §V bullet | Answered by | Verdict |
|---|---|---|---|
| 1 | *"one chip per skill, each carrying its own Confirm, Adjust and Skip"* | V1, V2, V7, V8 | **PASS** — 4 chips × 3 buttons = 12, visible per chip. |
| 2 | *"The row is the whole card. There is no heading plate above it and no row-level submit beneath it"* | V1, V5, V8, V9 | **PASS** — 0 headings and 0 card-level submit actions inside the root, on the held row, the settled row and both page readings. |
| 3 | *"A skill is settled by pressing one of its own three affordances"* | V3 | **PASS** — two chips decided, two untouched, nothing released. |
| 4 | *"each chip then shows what it recorded"* / the settled example's three marks | V5, V6 | **PASS** — Confirmed, Adjusted **and** Skipped on one row. |
| 5 | Settled chips name the skill (`Enrich contacts`, not `@vendor/pkg:enrich`) | V1–V9 | **PASS** — every chip prints the owning extension's manifest `displayName` (`Blog Post Matcher Skill`), held and settled alike, and so does the `Adjust` panel's title. Not the package id, and — the defect this re-shoot closes — not the slug either. |
| 6 | *"there is nothing left to press"* | V5, V6, V9 | **PASS** — `button` count inside the root is 0. |
| 7 | *"Every chip keeps its three affordances on screen, disabled"* + the reason line | V7 | **PASS** — 12 disabled buttons and the restriction line. |
| 8 | Run page: the row sits at the trigger position, ahead of the work it authorizes | V8, V9 | **PASS** — V8 shows nothing above the row; V9 shows the row ahead of the input step it authorized. |
| 9 | The card root carries its kind / host / state marks | all nine | **PASS** — recorded verbatim per cell in `capture-results.json` → `rootAttributes`. |

The root carries, on every cell: `data-run-recommendation-chip-row`,
`data-conformance-id="run-chip-row"`,
`data-lifecycle-card="recommendation_hold"`, `data-lifecycle-card-host="run_card"`,
`data-variant="inline"`, and `data-lifecycle-card-state` — `held` on the five held
cells (plus `data-can-decide`), `decided` on the four settled/decided cells (plus
`data-run-recommendation-decision="confirmed"` and
`data-run-recommendation-settled="true"`).

## Where the label comes from

One field, resolved once, server-side. `buildRecommendationCandidatesForAgent`
(`@cinatra-ai/skills`) joins the on-disk extension scan's declared
`cinatra.displayName` onto each candidate by skill id, using the SAME
`deriveSkillRegistration` the ownership map uses; the scorer carries it through
as `RankedRecommendation.displayName` **without tokenizing it**, so adding the
title moved no score, no rank and no citation (pinned as a test). The card's
contract type carries exactly ONE label — `RecommendedSkillForChip.name` — fed
from that field, so the held chip, the `Adjust` panel and the settled row cannot
drift apart.

| Skill id | Catalog `name` (the slug) | Manifest `cinatra.displayName` | Printed |
|---|---|---|---|
| `@cinatra-ai/blog-post-matcher-skill:blog-post-matcher` | `blog-post-matcher` | `Blog Post Matcher Skill` | `Blog Post Matcher Skill` |
| `@cinatra-ai/blog-writing-skill:blog-writing` | `blog-writing` | `Blog Writing Skill` | `Blog Writing Skill` |
| `@cinatra-ai/brand-voice-matcher-skill:brand-voice-matcher` | `brand-voice-matcher` | `Brand Voice Matcher Skill` | `Brand Voice Matcher Skill` |
| `@cinatra-ai/web-research-skill:web-research` | `web-research` | `Web Research Skill` | `Web Research Skill` |

**The fallback, stated.** An extension that declares NO `cinatra.displayName`,
and a user-authored skill no extension owns at all, keep the catalog name — the
label that shipped before this join existed. Nothing is invented, and a failed
scan costs labels, never candidates. All four skills above declare a title, so
no cell here exercises the fallback; the unit suites do.

**Not widened.** The MCP "what skills fit this task" primitive still returns the
catalog `name` on its ranked rows. It is a machine-facing payload keyed on ids,
not a surface that prints a title, and §V does not reach it.

## Cells NOT delivered

| Cell | Why |
|---|---|
| the ADJUST panel drawn IN PLACE | Not drawn that way. `Adjust` opens a portalled Sheet outside the card root, so the "if it draws in place" arm does not apply. `V4` photographs what it actually opens. |
| a `dark` reading of the drawing | The ratified §V page has **no** dark variant — no `dark`, `data-theme` or `prefers-color-scheme` anywhere in it. `V2` and `V6` are shot anyway, through the shipped **Toggle theme** control, so the tint tokens are shown resolving in both palettes; they answer no drawing bullet the light cells do not already answer. |
| the card in the CHAT | The chat mount needs the conversation-origin hold (#2786, S9b), which is not on this branch. Named in the PR body as owed once S9b rebases. |
| a settled chip distinguishing *"skipped outright"* from *"inspected, then dropped"* | The NAMED RESIDUAL of `1d95dd06a`: `Adjust` → *Leave it out* is durably a REJECTED row, and the rejected half records only that the skill was not kept — so it reads back `Skipped`, which is what it is. Telling the two apart needs the rejected row to carry a third source, and this slice does not widen the store to get it. |

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — the records, in the shape
  `scripts/ci/lib/capture-record-contract.mjs` validates. **Registered** in
  `scripts/ci/chat-hitl-capture-index.json`.
- `capture-results.json` — the machine record beside the pixels, written by the
  same run: the counts, the root's own `data-*` attributes, the per-chip DOM
  read-out and the card's `innerText`.
- `drivers/` — the harness exactly as run: `walk.config.ts` + `walk.test.ts`
  (probe → assign → seed → hold → readback) and `capture.mjs` (the recorder,
  whose counting rules are written at the top of the file).

No credential, token, password or host identity appears in any file here.
