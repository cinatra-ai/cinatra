import { Suspense } from "react";

import { BrandMark } from "@/components/brand-mark";
import { getSetupWizardSteps, type SetupWizardStep } from "@/lib/setup-wizard";
import { getAuthSession } from "@/lib/auth-session";
import { PageHeader } from "@/components/page-header";
import { SearchParamToast } from "@/components/search-param-toast";
import { SetupStepNav } from "./setup-step-nav";
import { SETUP_FLASH_TOASTS } from "./setup-flash";

// cinatra#2386 — the ONLY /setup/* route a sessionless visitor can ever reach
// is /setup/account (the sole PUBLIC_EXACT_PATHS entry under this prefix;
// every other /setup/* route stays session-protected by the middleware
// guard). So "no session" here always means "rendering /setup/account for an
// unauthenticated visitor" — a STATIC progress chrome that never calls
// getSetupWizardSteps()/the readiness reader (no setup-status work, no
// readiness disclosure to an unauthenticated visitor). An authenticated
// visitor gets the real, live step rail as before.
//
// cinatra#2477 (owner acceptance review) — the static chrome shows the FULL
// step rail (the account step is step 1 of it), not a lone "Account" pill, so the
// signup page carries the same indicator as every other setup page. The list
// is a hardcoded forecast of the wizard's unconditional steps: every entry is
// `status: "upcoming"` (nothing is disclosed, nothing is clickable — the rail
// renders an all-unpassed list as plain pills, and §IV's return link has
// nothing to offer when no step is done).
//
// cinatra#2502 (owner, 2026-08-08) — SECRETS IS ON THIS RAIL. "Always visible,
// never hidden by state" covers the signed-out first screen too: a step that
// appears only once there is a session is exactly the conditional presence the
// requirement removes. It was previously left out on the grounds that its
// applicability was itself a status read — but that reasoning only held while
// the step WAS conditional. It is now unconditional (src/lib/setup-wizard.ts),
// so drawing it here reads nothing and discloses nothing: a pill that is always
// drawn says nothing about the instance behind it.
//
// The rail stays a FORECAST, not a status — no step is done, no checkmark, no
// green connector, nothing clickable. Only the PRESENCE of the entry is
// unconditional; its state is not.
const SESSIONLESS_SETUP_STEPS: SetupWizardStep[] = [
  { id: "sign-up", title: "Account", href: "/setup/account", status: "upcoming" },
  { id: "key", title: "Key", href: "/setup/key", status: "upcoming" },
  { id: "name", title: "Name", href: "/setup/name", status: "upcoming" },
  { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "upcoming" },
  { id: "ai", title: "Model", href: "/setup/model", status: "upcoming" },
];

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuthSession();

  // The registration answer given on the first-account step is held in the
  // operator's own browser until an admin account exists to own it; this is the
  // first authenticated screen after that account is created, so it is where
  // the answer reaches the instance. It is a no-op for everyone else: not an
  // admin, no held answer, or an instance that already carries an answer of its
  // own, and it never throws (src/lib/bootstrap-registration-choice.ts). The
  // module is loaded here, inside the session branch, so the sessionless chrome
  // still reads nothing at all.
  if (session) {
    const { applyPendingBootstrapRegistrationChoice } = await import(
      "@/lib/bootstrap-registration-choice"
    );
    await applyPendingBootstrapRegistrationChoice(session);
  }

  const steps = session ? await getSetupWizardSteps() : SESSIONLESS_SETUP_STEPS;

  return (
    <main className="flex min-h-screen flex-col items-center justify-start px-5 py-12">
      {/* Codes-only flash island (replaces the retired SetupToast). /setup is a
          shell-bypass route where useNotify() is unavailable, so wizard action
          outcomes sink to bare cinatraToast via <SearchParamToast>. The static
          code->message map lives in ./setup-flash; a crafted ?error=<text> that
          isn't a known code maps to nothing and is never toasted. */}
      <Suspense fallback={null}>
        <SearchParamToast toasts={SETUP_FLASH_TOASTS} />
      </Suspense>
      <div className="w-full max-w-2xl">
        {/* align="center" — the actions slot here is the fixed-height brand
            MARK, not a control row. Top-aligned it sat visibly lower than the
            "Setup" title (cinatra#2528). */}
        <PageHeader title="Setup" actions={<BrandMark size={30} />} align="center" />

        <SetupStepNav steps={steps} />

        {children}
      </div>
    </main>
  );
}
