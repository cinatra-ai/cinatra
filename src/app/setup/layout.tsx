import { Suspense } from "react";

import { BrandMark } from "@/components/brand-mark";
import { getSetupWizardSteps } from "@/lib/setup-wizard";
import { PageHeader } from "@/components/page-header";
import { SearchParamToast } from "@/components/search-param-toast";
import { SetupStepNav } from "./setup-step-nav";
import { SETUP_FLASH_TOASTS } from "./setup-flash";

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const steps = await getSetupWizardSteps();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
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
