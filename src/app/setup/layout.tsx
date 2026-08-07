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
// `ready: false` (nothing is disclosed, nothing is clickable — SetupStepNav
// renders an all-incomplete rail as plain pills). The conditional Connections
// step is deliberately absent: whether it applies is itself a status read the
// sessionless branch must never perform; the live rail adds it after sign-up
// when it is relevant.
const SESSIONLESS_SETUP_STEPS: SetupWizardStep[] = [
  { id: "sign-up", title: "Account", href: "/setup/account", ready: false },
  { id: "key", title: "Key", href: "/setup/key", ready: false },
  { id: "name", title: "Name", href: "/setup/name", ready: false },
  { id: "ai", title: "Model", href: "/setup/model", ready: false },
];

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuthSession();
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
        <PageHeader title="Setup" actions={<BrandMark size={30} />} />

        <SetupStepNav steps={steps} />

        {children}
      </div>
    </main>
  );
}
