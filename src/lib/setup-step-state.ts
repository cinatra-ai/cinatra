/**
 * The setup wizard's STEP-STATE MODEL — the three states of the step rail and
 * the rule that resolves them. Design spec `specs/app-setup.html` revision 0.3.0 §III.
 *
 * WHY THIS IS ITS OWN MODULE, and not part of `setup-wizard.ts`.
 *
 * The step rail (`src/app/setup/setup-step-nav.tsx`) is a CLIENT component: it
 * reads `usePathname()` to know which step is on screen. It therefore needs the
 * resolver as a VALUE, and `setup-wizard.ts` cannot supply one — that module
 * derives readiness from the provider-commit machine, the Nango status reader
 * and the instance-identity store, whose transitive graph reaches
 * `import "server-only"`. Importing the resolver from there compiles the entire
 * server graph into the client bundle and the wizard 500s on every step page.
 *
 * So the model lives here, with NO imports at all: pure types plus one total
 * function. `setup-wizard.ts` re-exports it, so server callers keep their single
 * import site and nothing has two names.
 */

/**
 * The three states a rail pill can render — §III, "Three states, and only
 * three". There is no fourth: no skipped, no partial, no past-incomplete. A
 * step the operator has PASSED is `done`, uniformly, however it was satisfied
 * (owner decision on cinatra#2502, 2026-08-07). If a step offered an optional
 * field and the operator left it blank, the step is still done and still
 * carries its check.
 */
export type SetupStepState = "done" | "current" | "upcoming";

/**
 * What the SERVER can say about a step: it has been passed, or it has not.
 *
 * `current` is deliberately not one of these. Being the page on screen is a
 * property of the request's URL, not of the wizard's progress, so it is
 * resolved at render time by `resolveSetupStepState` below.
 */
export type SetupStepStatus = Exclude<SetupStepState, "current">;

export type SetupWizardStep = {
  id: string;
  title: string;
  href: string;
  status: SetupStepStatus;
};

/**
 * §III precedence — done → current → upcoming, and **done wins**.
 *
 * The two states collide whenever the operator navigates BACK to a step they
 * have already passed: that step is both passed and the page on screen. The
 * spec resolves it in favour of `done` — "passed is always checked" — and
 * reports "where am I?" separately through `aria-current`, which the rail sets
 * on the on-screen pill whatever colour it is wearing. So the visual state
 * answers *have I done this?* and the accessible state answers *where am I?*,
 * and neither has to lie to cover for the other.
 */
export function resolveSetupStepState(
  step: Pick<SetupWizardStep, "status">,
  isOnScreen: boolean,
): SetupStepState {
  if (step.status === "done") return "done";
  return isOnScreen ? "current" : "upcoming";
}
