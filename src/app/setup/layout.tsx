import { Suspense } from "react";

import { BrandMark } from "@/components/brand-mark";
import { getSetupWizardSteps, type SetupWizardStep } from "@/lib/setup-wizard";
import { getAuthSession } from "@/lib/auth-session";
import { PageHeader } from "@/components/page-header";
import { SearchParamToast } from "@/components/search-param-toast";
import { SetupStepNav } from "./setup-step-nav";
import { SETUP_FLASH_TOASTS } from "./setup-flash";

// cinatra#2386 — the ONLY /setup/* route a sessionless visitor can ever reach
// is /setup/sign-up (the sole PUBLIC_EXACT_PATHS entry under this prefix;
// every other /setup/* route stays session-protected by the middleware
// guard). So "no session" here always means "rendering /setup/sign-up for an
// unauthenticated visitor" — a STATIC single-step progress chrome that never
// calls getSetupWizardSteps()/the readiness reader (no setup-status work, no
// readiness disclosure to an unauthenticated visitor). An authenticated
// visitor gets the real, live step rail as before.
const SESSIONLESS_SETUP_STEPS: SetupWizardStep[] = [
  { id: "sign-up", title: "Sign up", href: "/setup/sign-up", ready: false },
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
