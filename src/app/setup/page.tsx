import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";

export const metadata: Metadata = { title: "Setup" };

export default async function SetupPage() {
  const steps = await getSetupWizardSteps();
  const next = getFirstIncompleteStep(steps);

  if (!next) {
    redirect("/");
  }

  redirect(next.href);
}
