"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
// IMPORT SITE MATTERS: the state model comes from `@/lib/setup-step-state`, not
// from `@/lib/setup-wizard`. This is a client component, and the wizard module's
// transitive graph reaches `import "server-only"` — pulling the resolver from
// there compiles the server graph into the client bundle and every setup page
// 500s ("'server-only' cannot be imported from a Client Component module").
import {
  resolveSetupStepState,
  type SetupStepState,
  type SetupWizardStep,
} from "@/lib/setup-step-state";
import { cn } from "@/lib/utils";

type SetupStepNavProps = {
  steps: SetupWizardStep[];
};

// whitespace-nowrap (#2483 review): a pill label must never break across
// lines. The rail is a max-content row — when it outgrows the wizard column
// the CONNECTORS give way (see connectorWidthClass) instead of the labels, and
// only if that is not enough does the nav scroll (overflow-x-auto).
const PILL_BASE =
  "flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-semibold uppercase tracking-wide";
// The three states of `specs/app-setup.html` §III, at rest. There is no fourth
// treatment: a step the operator has passed is `done`, uniformly, however it
// was satisfied (the owner's 2026-08-07 decision on cinatra#2502 dropped the
// skipped/partial state the issue originally proposed).
const PILL_AT_REST: Record<SetupStepState, string> = {
  done: "border border-success/30 bg-success/10 text-success",
  current: "border border-primary bg-primary/10 text-primary",
  upcoming: "border border-line bg-surface-strong text-muted-foreground",
};

// §IV — "A navigable pill is fully dressed as a link, IN WHICHEVER STATE IT IS
// WEARING": the tint lifts on hover and it takes a 2px focus ring in its own
// state colour.
//
// cinatra#2502 (owner, 2026-08-08): the rail's one navigable UPCOMING pill —
// the return link the rail offers after the operator has gone BACK to a
// completed step — was a real <Link> with none of that dress. No hover
// response for a mouse user, no focus ring at all for a keyboard one. A
// focusable link that gives no ring back is not a link the operator can use.
// The lift is white → `surface-muted` and the ring is drawn in the upcoming
// pill's own muted colour, matching what the done pill has always had.
//
// `current` has no entry on purpose: the pill for the page on screen is never a
// link (§IV), so there is no navigable-current state to dress.
const PILL_AS_LINK: Partial<Record<SetupStepState, string>> = {
  done: "transition hover:bg-success/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40",
  upcoming:
    "transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground/40",
};

// cinatra#2505 — the connector rule is the rail's only spare space, so a rail
// denser than the accepted four-step drawing spends it.
//
// MEASURED on the running wizard (Chromium, the acceptance suite's 1440×1100
// desktop viewport; every number below is off the live rail, not estimated):
//
//   wizard column (max-w-2xl)                            672.00px
//   four-step sessionless rail                           446.72px   fits
//   five-step authenticated rail, three steps checked    690.03px   +18.03px
//
// The fifth pill is the SECRETS step, and each completed step widens its own
// pill by the check glyph (+22.00px measured). At five pills the row ran past
// the scrollport and the trailing Model pill was cut off — reported in
// cinatra#2505 and flagged in #2476's proof rather than passed silently.
//
// The fit strategy is the issue's "tighter pill spacing", applied ONLY to the
// denser rail: the 40px rule halves to 20px once a fifth step is present. Not a
// new drawing — the same rule, the same pills, the same order, on a rail that
// has one more thing to say. Concretely:
//
//   five-step rail, three checks   690.03 − 4×20 = 610.03px   (61.97px spare)
//   five-step rail, four checks    712.03 − 4×20 = 632.03px   (39.97px spare)
//
// cinatra#2502 made the Secrets step UNCONDITIONAL, so every rail the wizard
// draws — the sessionless forecast included — is now a five-step rail and this
// rule fires throughout. The rule itself is unchanged and still reads the
// rail's own length, so a four-step rail (should the wizard ever draw one
// again) keeps the 40px measure the #2477 review accepted.
//
// Why a step-count rule rather than a CSS-elastic one: the rail is
// `ol > li > [connector, pill]` inside a `w-max` row, and a flex item's
// content-based minimum size freezes a definite-width child — a `min-width` on
// the connector does NOT let it give way (measured: identical 40px connectors
// and an identically clipped Model pill). Making it elastic requires
// `min-width: 0` on the `li`, which ALSO destroys the row's honest minimum: the
// rigid pills would then overlap each other instead of the nav scrolling.
// Clipping is bad; overlapping is worse. A shorter rule keeps every existing
// invariant — pills never shrink, labels never wrap, and a rail that still
// cannot fit (a sixth step, some future longer label) degrades to exactly
// today's horizontal scroll rather than to overlapping text.
const DENSE_RAIL_STEP_COUNT = 5;
const connectorWidthClass = (stepCount: number) =>
  stepCount >= DENSE_RAIL_STEP_COUNT ? "w-5" : "w-10";

export function SetupStepNav({ steps }: SetupStepNavProps) {
  const pathname = usePathname();
  const anyDone = steps.some((s) => s.status === "done");
  const firstIncompleteIndex = steps.findIndex((s) => s.status !== "done");
  // Read once per render from the rail's OWN length, not from a route or a
  // feature flag: whatever puts a fifth pill on the rail, the rail fits.
  const connectorWidth = connectorWidthClass(steps.length);

  return (
    <nav aria-label="Setup progress" className="mb-8 overflow-x-auto">
      {/* w-max + mx-auto: centered while the rail fits, horizontally
          scrollable (never label-wrapping) once it doesn't. */}
      <ol className="mx-auto flex w-max items-center gap-2">
        {steps.map((step, index) => {
          const isActive = pathname === step.href;
          // §III precedence, resolved in one place: done → current → upcoming,
          // and DONE WINS over current. A step the operator navigates back to
          // is both passed and on screen; it stays green and checked, and
          // `aria-current` below — not the colour — reports where they are.
          const state = resolveSetupStepState(step, isActive);
          // §III: the check glyph belongs to `done` alone. No other state
          // draws it, including a `current` pill sitting on a passed step
          // (which resolves to `done` above and therefore keeps its check).
          const showCheck = state === "done";
          // Navigable when:
          //   • the step is complete and we're not already on it, OR
          //   • it's the first incomplete step AND at least one other step is
          //     complete (so the operator has some progress to navigate against).
          // Subsequent incomplete steps stay non-clickable.
          //
          // cinatra#2477 — the sign-up step is the one exception: its pill is
          // NEVER a link. The bootstrap form can only render once (before the
          // first account exists); afterwards /setup/account unconditionally
          // redirects forward, so a link would be a silent bounce.
          const isFirstIncomplete = step.status !== "done" && index === firstIncompleteIndex;
          const isNavigable =
            !isActive &&
            step.id !== "sign-up" &&
            (step.status === "done" || (isFirstIncomplete && anyDone));

          const pillClasses = cn(
            PILL_AT_REST[state],
            isNavigable ? PILL_AS_LINK[state] : undefined,
          );

          const pillContent = (
            <>
              {showCheck ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                  <path
                    fillRule="evenodd"
                    d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : null}
              {step.title}
            </>
          );

          return (
            <li key={step.id} className="flex items-center gap-2">
              {index > 0 ? (
                <div
                  aria-hidden="true"
                  // §III: the connector leading INTO a done step is solid
                  // sea-green, so the passed prefix of the rail reads as one
                  // continuous green run; every other connector is the hairline.
                  className={cn("h-0.5", connectorWidth, state === "done" ? "bg-success" : "bg-line")}
                />
              ) : null}
              {isNavigable ? (
                <Link
                  href={`${step.href}?stay=1`}
                  className={cn(PILL_BASE, pillClasses)}
                  aria-current={isActive ? "step" : undefined}
                >
                  {pillContent}
                </Link>
              ) : (
                <span
                  className={cn(PILL_BASE, pillClasses)}
                  aria-current={isActive ? "step" : undefined}
                >
                  {pillContent}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
