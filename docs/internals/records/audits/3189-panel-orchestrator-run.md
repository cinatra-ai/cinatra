# Orchestrator run panel: the clauses that reach it (cinatra#3189)

This record covers the `orchestrator-run-panel` row of the shared-panels wave: the "Sub-agents" card that an
orchestrator's run page draws. The rows below are each clause of the drawings that reaches the panel, its standing on
main, and the findings it leaves with a named owner. No drawing has a section that governs the panel itself, so its own
content takes the uncovered-UI disposition (U1) and is not graded clause by clause. The one exception is the inline
cancel error, which the Alert clause of the components drawing governs (D3).

| Item | Value |
|---|---|
| Drawings read | design main `635da007`: `specs/app-artifact-review.html` (I, "The agent run surface — steps, gates & detail", L366), `specs/app-agents.html` (III, "Per-tab assignment", L539; IV, "The run view — the conditional widen", L600), `specs/app-lifecycle-cards.html` (V, "The recommendation card", L779) and `specs/app-components.html` (Badge / Pill, L471; Alert / Alert dialog, L772) |
| Pins | `tests/e2e/design/conformance-pins.json` at `faee0830` has no `app-artifact-review`, `app-agents` or `app-lifecycle-cards` entry. Its `app-components` manifest `d1d40b0c…` equals the manifest at design main `635da007`. No row below depends on pin drift |
| Code read | cinatra main `faee0830`: `packages/agents/src/orchestrator-run-panel.tsx` (183 lines), its host `packages/agents/src/orchestrator-screens.tsx` and the node it draws, `packages/agents/src/orchestrator-sub-agent-node.tsx` |
| Not in this record | `orchestrator-stepper-panel` (its own record) |
| Method | A row quotes its clause verbatim with its section and line, and reads the standing on main ("meets", "departs" or "n/a") with file and line. This record changes no product code |

## Fixed by this pull request

| id | Clause (drawing) | Standing on main | Fix and test |
|---|---|---|---|
| - | none | - | This record names no product fix |

## Settled, no change

| id | Clause (drawing) | Reading |
|---|---|---|
| OR1 | "The run view, wherever it is hosted" / "Live run progress fills the frame, and the frame — not the body — is what responds when the panel is marked as wide output (§IV)." (agents III, L579-582) | meets. The screen mounts the panel in `AgentPanelBody role="frame"` (`orchestrator-screens.tsx:279`, `:286`) |
| OR2 | "What counts as wide monitoring output is a property the panel declares — it is not measured off the render, and it is not something a tab can claim by being a particular tab." (agents IV, L607); "A run view with ordinary progress output is a Wide frame like every panel in §III" (agents IV, L605) | meets. The panel declares no wide output (`orchestrator-run-panel.tsx:45-51`, `:137-182`), so the frame stays Wide |
| OR3 | "This started-by relationship is separate from an orchestrator's parent relationship." (artifact-review I, "Runs this run started", L416) | n/a. The panel lists an orchestrator's own children (`nodes`, `orchestrator-run-panel.tsx:158-174`), not the runs a run started. The "Runs this run started" list (L401-416) therefore does not govern it |
| OR4 | "Where the run card draws a step’s Continue itself, in the run’s own view and in an orchestrated run’s step view, it holds that Continue too, by the rule above." (lifecycle-cards V, L857) | n/a. The panel draws no Continue. Its own control is "Cancel run" (`orchestrator-run-panel.tsx:144-151`), and each child row draws a Setup or Run link (`orchestrator-sub-agent-node.tsx:88-89`, `:112-114`), neither of them a Continue |

## Findings left with a named owner

| id | Clause (drawing) | Standing on main | Owner |
|---|---|---|---|
| U1 | Uncovered-UI disposition. No section of the four drawings above draws the panel. Artifact-review I draws a run as a rail-and-detail frame (L370); the only list of other runs it draws is "Runs this run started" (L401-416), and L416 says that list is separate from an orchestrator's parent relationship. A search of every `specs/*.html` at `635da007` for "orchestrat" and "sub-agent" finds only L416 and lifecycle-cards L857, and a search for "cancel run" finds none | uncovered. Undrawn: the "Sub-agents" card and title (`orchestrator-run-panel.tsx:138-142`), the destructive "Cancel run" (`:144-151`), the 3 s status poll (`:100-123`) and the child-status overlay (`:66-77`). The inline cancel error (`:177-179`) is not undrawn: a clause governs it (D3). Per the issue's rule, it follows the uncovered-UI disposition process and is not graded against an invented section. Drawing coverage comes first (a design-spec change) | to file in project 12 |
| D1 | "The status roster never rides on a Badge. Anything that stands for a run, approval or lifecycle state takes the status pill and its fixed roster (V), so one state is never drawn two ways on two screens." (components, Badge / Pill, L493) | departs. The panel derives each child run's state (`orchestrator-run-panel.tsx:66-77`, `:163`) and passes it to the node, which draws it as `<Badge variant="outline">{displayStatus}</Badge>` (`orchestrator-sub-agent-node.tsx:110`), with raw values such as `pending-hitl` | to file in project 12 |
| D2 | "The surface is a two-column frame: a step rail down the left names the run's ordered steps, and the run detail on the right shows the selected step." (artifact-review I, L370) | departs at the screen that hosts the panel, if I governs an orchestrator run. `OrchestratorRunScreen` draws no step rail: it stacks the HITL panel, the readiness alerts and this panel in one column (`orchestrator-screens.tsx:279-293`). The drawing names no exception for an orchestrator run, and draws none. This reading depends on U1 | to file in project 12 (with U1) |
| D3 | "Inline alerts for warnings and errors; AlertDialog for destructive confirmations. Use the destructive variant (red) for terminal failures, warning (mustard) for cautions, info (indigo) for neutral notices." (components, Alert / Alert dialog, L784). The worked destructive example draws a tinted ground, a border and a leading icon (L781), and "Each status variant is one recipe at its own colour — background tinted from that colour, border at higher alpha, and the icon in the colour itself — never a solid status fill behind body text." (L785) | departs. When `cancelOrchestratorAction` returns `{ ok: false, error }` the panel keeps the text (`orchestrator-run-panel.tsx:127-135`) and draws it as a bare `<p className="text-sm text-destructive">` (`:177-179`): red text on the card ground, with no tint, border or icon. The Alert primitive's destructive variant exists (`src/components/ui/alert.tsx:13-14`), and the sibling stepper panel draws its error in `<Alert variant="destructive">` (`orchestrator-stepper-panel.tsx:372-375`). Two neighbouring clauses are not read as departures: "AlertDialog for destructive confirmations" in the same sentence (no drawing says that "Cancel run" takes a confirmation; the drawn one is for "Cancel schedule", lifecycle-cards VI.1, L1212-1213, and the action stays in U1) and "Errors swap helper text colour to brand red and add aria-invalid to the input" (components, Form / Field / Label, L757), which is a field's error and does not reach a button's action error | to file in project 12 |

## Notes

1. D2 is a finding on the host screen, not on this file. It is listed here because the panel is the run detail of that
   screen. If the drawing coverage of U1 draws an orchestrator run outside the rail-and-detail frame, D2 falls away.
2. The `Sub-agents` heading (`text-sm font-semibold`) and the node row's `soft-panel rounded-card` ground have no
   drawn value to grade against. They are part of U1 and are not read as departures.
3. No test file for this panel exists on main (`git ls-tree` at `faee0830`), although
   `packages/agents/src/__tests__/schema-field-renderer-hide-submit.test.tsx:19` names
   `tests/orchestrator-run-panel.test.tsx`.
4. This record grades the clauses that say which primitive a kind of content takes: the status pill for a run state
   (D1) and the Alert for an inline error (D3). It does not grade what a Button, Card or Separator variant itself draws;
   those are primitive-level clauses, and the panel's use of them (`Button variant="destructive" size="sm"`, `Card`,
   `Separator`, `orchestrator-run-panel.tsx:138-155`) is outside this record.
