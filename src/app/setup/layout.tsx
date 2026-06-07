import { Suspense } from "react";

import { BrandMark } from "@/components/brand-mark";
import { getSetupWizardSteps } from "@/lib/setup-wizard";
import { PageHeader } from "@/components/page-header";
import { SetupStepNav } from "./setup-step-nav";
import { SetupToast } from "./setup-toast";

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const steps = await getSetupWizardSteps();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <Suspense fallback={null}>
        <SetupToast />
      </Suspense>
      <div className="w-full max-w-2xl">
        <PageHeader title="Setup" actions={<BrandMark size={30} />} />

        <SetupStepNav steps={steps} />

        {children}
      </div>
    </main>
  );
}
