# cinatra#2047 re-acceptance — D-8 + OBS-1 fix evidence

The re-acceptance closed with two PRODUCT DEFECTS blocking the
`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` flip. This lane fixes both and proves
the chain the flip makes load-bearing works end to end **for an org that
actually holds the artifact pack's claim**:

    produce → serve → review gate decidable → typed changes-request accepted

## Layout

- `logs/walk-steps.txt` — the LIVE walk transcript (both fences ON, this lane's
  own stack). Every store read-back verbatim, plus the two verbatim UI strings
  that invert the defects.
- `logs/integration-suites.txt` — the 8 real-Postgres suites (62/62), including
  the new four-rung suite and every ratified suite this change touches.
- `logs/unit-semantic-assertion.txt` — the pure assertion-builder contract (10/10).
- `logs/codex-round1-verdict.txt`, `logs/codex-round2-verdict.txt` — the codex
  rounds verbatim (round 1 caused a design change; see the PR ledger).
- `screenshots/` — the run-embedded review surface, live.
- `drivers/` — the walk harness + the isolated-Chromium UI driver + the lane
  signup driver, as run.

## The two verbatim UI strings that matter

| | re-acceptance (defect) | this lane (fixed) |
|---|---|---|
| review target | `review target unavailable — reason "revision-not-member"` | `review target unavailable — slot "detail", reason "no-semantic-renderer"` — the target RESOLVED; the floor is the unrelated, pre-existing "pack renderer not org-installed on this dev stack" caveat |
| typed changes-request | BLOCKED (`tombstoned-base`) | `Changes requested. The reviewed work has been turned back for repair — a repair is now in flight.` |

## Screenshots

- `screenshots/D8-01-review-target-renders.png` — the pinned target renders with
  its real revision / mime / Preview / Download and the Approve·Reject·Comment
  floor.
- `screenshots/D8-02-changes-request-before.png` / `-after.png` — the typed
  prompt-window changes-request and its accepted response.

## Stated caveats (unchanged from the re-acceptance)

1. **Fence posture.** Both lifecycle fences default OFF on `origin/main`; this
   walk flipped them ON. Everything live here describes the intended end state
   under an operator flip.
2. **The org's claim.** The blog-post pack's dedicated claim is active for the
   walk org through the shipped claim-activation path, not through a
   marketplace install (the lane's local registry refuses auth — the same
   constraint the re-acceptance recorded). The collision D-8 described is a
   property of the code paths, and the real-Postgres suite drives it from a
   seeded claim independently.
3. **Renderer degradation.** The pack's own renderer is not org-installed on
   this dev stack, so the target renders through the generic read-only view.
   Unrelated to these defects and explicitly distinguished above.
4. **Scoped out, tracked:** the CONTEXT/PIN path (`context-resolver.ts`,
   `context-selection-finalize.ts`) still routes a claimed row through the
   snapshot branch only. That is UNCHANGED behaviour — this change neither
   regresses nor widens it — and closing it means coordinating the
   snapshot-candidate rule, the resolver and both finalizer SQL sites. Codex
   round 2 agreed the scoping is defensible with a follow-up.
