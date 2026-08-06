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
// it scrolls horizontally (see the nav's overflow-x-auto) instead of
// wrapping labels.
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

export function SetupStepNav({ steps }: SetupStepNavProps) {
  const pathname = usePathname();
  const anyReady = steps.some((s) => s.ready);
  const firstIncompleteIndex = steps.findIndex((s) => !s.ready);

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
                  className={cn("h-0.5 w-10", step.ready ? "bg-success" : "bg-line")}
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
