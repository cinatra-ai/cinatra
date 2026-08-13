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
