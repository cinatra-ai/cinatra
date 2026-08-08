"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SetupWizardStep } from "@/lib/setup-wizard";
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
const PILL_READY =
  "border border-success/30 bg-success/10 text-success";
const PILL_READY_LINK =
  "border border-success/30 bg-success/10 text-success transition hover:bg-success/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40";
const PILL_ACTIVE =
  "border border-primary bg-primary/10 text-primary";
const PILL_INACTIVE =
  "border border-line bg-surface-strong text-muted-foreground";

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
// The fifth pill is the CONDITIONAL Connections step, which joins the rail
// whenever Nango is not connected (src/lib/setup-wizard.ts), and each completed
// step widens its own pill by the check glyph (+22.00px measured). At five
// pills the row ran past the scrollport and the trailing Model pill was cut
// off — reported in cinatra#2505 and flagged in #2476's proof rather than
// passed silently.
//
// The fit strategy is the issue's "tighter pill spacing", applied ONLY to the
// denser rail: the 40px rule halves to 20px once a fifth step is present. Not a
// new drawing — the same rule, the same pills, the same order, on a rail that
// has one more thing to say. Concretely:
//
//   five-step rail, three checks   690.03 − 4×20 = 610.03px   (61.97px spare)
//   five-step rail, four checks    712.03 − 4×20 = 632.03px   (39.97px spare)
//
// The four-step rail is deliberately untouched — it is the layout the #2477
// review accepted and #2483 shipped, and it never needed the space.
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
  const anyReady = steps.some((s) => s.ready);
  const firstIncompleteIndex = steps.findIndex((s) => !s.ready);
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
          const showCheck = step.ready;
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
          const isFirstIncomplete = !step.ready && index === firstIncompleteIndex;
          const isNavigable =
            !isActive &&
            step.id !== "sign-up" &&
            (step.ready || (isFirstIncomplete && anyReady));

          const pillClasses = step.ready
            ? isNavigable
              ? PILL_READY_LINK
              : PILL_READY
            : isActive
              ? PILL_ACTIVE
              : PILL_INACTIVE;

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
                  className={cn("h-0.5", connectorWidth, step.ready ? "bg-success" : "bg-line")}
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
