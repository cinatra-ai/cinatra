# cinatra#2573 S7 — conformance capture on a production-equivalent build

Captured 2026-08-13 on host2 (`ordnas@192.168.0.36`) against a **real production
build** of this branch: `pnpm build` (Next.js 16.2.10, "Compiled successfully in
4.4min", TypeScript clean) followed by `next start` on `:3000` — not `next dev`.
Branch head under test: **`b63d64ad4ca4ad751cbf7b2359f9e8686cc15575`**.

The rows photographed here were written earlier by the **shipped stores** during
the S8d/S8f proof rounds (`emitArtifactReviewGate`, the repair pipeline, the
verification writer) and are still in that instance's database. This capture
**writes nothing**: it restores the run owner's own session
(`cinatra-uat@example.com`, which is the run's `run_by`) and photographs what the
shipped surfaces draw. The driver is `s7-conformance-capture.mjs`, reproduced
below as `conformance-capture.mjs`.

`results.json` is the machine record beside the pixels: per cell, the HTTP status,
the final URL, every `data-conformance-id` in the DOM, every
`data-lifecycle-card-state`, the island `<iframe>`'s `src` + `sandbox`, and any
page errors. A screenshot is never the only evidence.

## Cells DELIVERED

| Cell | What the DOM asserted |
|---|---|
| `review-card__page_gate_region__pending.png` | `review-gate-card`, `review-decision-bar`, `review-target-island`, `review-prompt-window`; **`data-lifecycle-card-state="pending"`**; one island `<iframe src="/lifecycle/review-island?ref=…" sandbox="allow-scripts allow-same-origin">`; zero page errors |
| `island__first_party__server_rendered.png` | `review-target-island-body`, `review-target`, **`review-provenance-native`** — the ladder's BUILD-MAP class, resolved server-side, drawn inside the frame with no decision chrome |
| `island__forged_ref__empty.png` | `review-target-island-empty` and nothing else — a ref that does not decode draws the ONE shared empty document, exactly as an unauthorized one does |

The first two together are the §III/§IV claim in one frame: the immutable target
header, the renderer-provenance chip, the build-time renderer's own rendering, the
"Expand" affordance on the clamped island, the decision-rationale field, and the
single floor (Comment / Reject / Approve) — the floor OUTSIDE the frame, drawn by
the card, on the page's gate region.

## Cells NOT delivered, and why — no cell is rounded up

| Cell | What actually happened |
|---|---|
| `review-card__page_gate_region__settled.png` | The route resolves a RESOLVED gate to its own route-level `review-gate-blocked` panel **before the card mounts**, so a direct URL cannot reach the card's `settled` state on this host. That state is reached by deciding a card in place, which is what `review-gate-card.test.tsx` ("settled: 'no longer open' with a Refresh, and NO decision floor") and the S2 photograph `evidence/2566-s2/s2-06-settled-no-longer-open.png` cover. The image here is the blocked panel, correctly labelled. |
| `verification-card__page_gate_region__advisory.png` | Redirected to the run surface (`run-surface` anchor). The verification record on this instance is bound to a gate whose `?view=verification` route did not resolve it for this reader. The advisory state is covered by `evidence/2577-parity/proof/final/V9r-REAL-verification-card-advisory.png` and by the card suite; it is NOT delivered here. |
| `review-card__run_card__host.png` | Redirected to the run's `/trigger` tab. `AgenticRunPanel` — the `run_card` host — renders only for `run.status !== "pending_input"`, and this proof run never left the pre-run state, so the run card was never mounted. |
| chat thread, site widget, all four cards × all six states | Not attempted. Reaching the chat and widget hosts needs an LLM-backed dispatch (the deterministic scripted provider) plus the widget's hosted sign-in, which is a proof round of its own — the shape S8d/#2577 ran. |

## Honest summary

This is a **partial** delivery of #2573's "conformance vs the S0 spec matrix (per
surface, per card, per state) on a production-equivalent build with recorded
screenshots". Three cells are real and on a production build; the full
4 cards × 4 surfaces × 6 states cross-product is not. The acceptance manifest row
for that criterion is `MISSING` with `partial: true` and this gap written out —
it is not marked green.

---

# Second round — the PRIMARY host, 2026-08-13

A second capture, on a **different host and a different build**, recorded in the
same structure and tagged `round: "primary"` in `results.json` so the two rounds
are never conflated. Build: `pnpm build` exit 0 (Next.js "Compiled successfully
in 78s", TypeScript clean at `--max-old-space-size=8192`) then `next start` —
`NODE_ENV=production`. Preview head under test:
**`579819c25edd79b724d30836cb2d9c8f87ad1f72`** = `origin/main` +
`origin/2573-d1` + `origin/2573-d2`, all three verified as ancestors.

Stack: `docker compose -p s7-visuals` (postgres, redis, verdaccio, nango-db,
nango-server) on **fresh volumes**; DB provisioned by `cinatra instance setup
dev` run from a `cinatra-cli` **origin/main** worktree; the actor is a first-run
admin registered through the app's own `/setup/account` form. Unlike the host2
round, this instance had **no pre-existing lifecycle rows** — every cell below
had to be produced, not merely photographed.

## Cell DELIVERED

| Cell | What the DOM asserted |
|---|---|
| `A3__run-detail__ordinary-non-held-run.png` | The run-detail screen for a real, ordinary (non-held) run created through the UI's own Run control. HTTP 200, **zero page errors**, `run-surface` present, the agentic panel drawn. **`recommendationChipRows: 0`** and **`decidedSummaryOccurrences: 0`** — the screen draws nothing where D-1 (#2710) deleted its parallel `RunRecommendationChipRow` mount, and the decided summary is not double-drawn on the agentic branch. This is the S7 visual round's evidence **A3**. |

## Cells NOT delivered — the AC-15 cells this round was sent to close

**The chat-host cells are not merely unattempted. They are UNREACHABLE on a
production-equivalent build, by two shipped fences**, and this supersedes the
first round's "Not attempted" line for them:

- `assertScriptedProviderNotProduction` (`packages/llm/src/scripted-test-provider.ts`)
  throws unless `CINATRA_RUNTIME_MODE === "development"` **and**
  `NODE_ENV !== "production"`.
- `lifecycleSeedEnvVerdict` FENCE 1a (`src/lib/test-support/lifecycle-seed-fence.ts`)
  returns `404 production-build` on `NODE_ENV === "production"` before it reads
  any other gate.

`next start` sets `NODE_ENV=production`, and Next inlines `process.env.NODE_ENV`
into the server bundle at build time, so neither fence can be lifted by an env
var at start. **A production-equivalent build and a scripted-provider dispatch
are mutually exclusive by construction on this branch** — so #2573's AC-15, which
asks for the chat-host cells *on a production-equivalent build*, cannot be
satisfied as written. The two honest routes are (1) write the gate rows on a
development runtime and photograph them under `next start` (the shape THIS
file's first round used, where the capture writes nothing), or (2) accept the
chat-host cells on a development runtime and say so on the cell.

| Cell | Why not delivered |
|---|---|
| `review-card__chat_thread__pending` | The fence above. A review card reaches chat only as a `DATA_PART` renderable view produced by an assistant turn. |
| `review-card__chat_thread__decided` | Same fence — the decided state is reached by deciding a card that was never mountable here. |
| `review-card__run_card__live-run` | The `run_card` host IS declared and drawn on this round (`AgenticRunPanel` renders for `status !== "pending_input"` — the delivered cell above is on that branch), but no lifecycle gate is bound to the run, so there is nothing for the host to mount: `lifecycleHosts: []`, `lifecycleCardStates: []`. This is a strictly better answer than the first round's, where the panel never mounted at all. |
| `recommendation-hold__run_card__held` | MEASURED: `cinatra.agent_assigned_skills` count = **0** against 28 registered skills. `maybeParkCheckpoint` parks only when the scorer returns a candidate, and candidates are bounded to the agent's already-assigned deliverable set, so every run returns `held:false, reason:"no recommendation candidates"`. No agent-level assignment control ships on the `/skills` detail page on this branch. |

## Honest summary for this round

One cell delivered, four named with measured reasons. The round's material
contribution is not the pixel but the **fence finding**: the AC-15 chat-host
cells are structurally unreachable under the criterion's own "production-
equivalent build" wording, which is a defect in the criterion, not a gap in the
capture. The acceptance manifest row stays `MISSING` with `partial: true`.
