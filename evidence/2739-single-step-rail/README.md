# cinatra#2739 — one step rail on the flow-agent run detail

Visual proof for the Email Outreach Agent run detail (the E12 regression case in
`evidence/2370-s4-e2e/E12`).

| File | What it shows |
| --- | --- |
| `01-before-two-rails.png` | The composition the screen mounted BEFORE the fix: the page-level `RunStepRailPanel` AND `OrchestratorStepperPanel`, which raises its own `StepperColumn`. The same five steps appear twice, side by side — left plain, right with the ⓘ tooltips. This is the reported defect. |
| `02-after-one-rail.png` | The composition AFTER the fix: the screen stands down (`screenHostsStepRail`), and the panel's live column is the only rail. It carries the union — the ⓘ tooltips and the live active step it always had, plus the review deep links (`Review APPROVED`, `Core analysis VERIFIED`, the pending `Review` gate) that only the page-level rail used to draw. |
| `measurements.json` | The rail/affordance counts the browser reported for each frame. `railCount` goes 2 → 1; `gateLinks` stays 2 and `infoTriggers` stays 3, so nothing was lost with the retired mount. |

## How the frames were produced

Both frames are a real Chromium render of the REAL components with the app's
real stylesheet — not a mockup:

- The React tree is the shipped `packages/agents/src/run-step-rail-panel.tsx` and
  `packages/agents/src/orchestrator-stepper-panel.tsx`, bundled with Vite.
- The CSS is the app's own `src/app/globals.css`, compiled by the repo's
  Tailwind v4 pipeline, so tokens, spacing and typography are the shipped ones.
- Only the panel's server actions, its run-stream hook and the right-pane
  siblings the rail does not exercise are stubbed. The run is rendered in the
  `running` state, whose stage card is the panel's own `SpinnerCard`.
- Chromium, viewport 1280×900, deviceScaleFactor 2, screenshot of the run-detail
  frame.
- Fixture: the email-outreach five-step policy spine plus a resolved gate, its
  verification, and a pending gate.

The harness that builds these frames is a throwaway; it is not committed. The
assertions it makes visible are locked permanently by
`packages/agents/src/__tests__/orchestrator-stepper-single-rail.test.tsx` (one
rail element in every run state; the union of behaviours) and
`packages/agents/src/__tests__/instance-screens-single-step-rail.test.ts` (the
screen's ownership predicate and its whole branch table).

## Deviation

The issue asks for the screenshot on a production-equivalent build. The
`/agents` run-detail route needs the canonical long-lived dev infrastructure —
real WayFlow mounts, real credentials, the canonical BullMQ queue — that
`tests/e2e/config/agents-run.config.ts` attaches to, which is the owner's own
dev environment. This proof therefore renders the real components with the real
stylesheet instead of booting that stack. The regression case, the fixture shape
and the pixels are the run detail's; the surrounding page chrome is not.
