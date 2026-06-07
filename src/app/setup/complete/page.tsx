// Deeplink: Initial setup completion landing; navigated to from the setup wizard, not from app chrome.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isSetupWizardComplete } from "@/lib/setup-wizard";

export const metadata: Metadata = { title: "Setup Complete" };

export default async function SetupCompletePage() {
  const complete = await isSetupWizardComplete();

  if (!complete) {
    redirect("/setup");
  }

  return (
    <section className="rounded-card border border-line bg-surface-strong p-8 shadow-sm text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-success/30 bg-success/10">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-7 w-7 text-success">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">Setup complete</h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        The required connections are configured. To enable all functionality, configure the remaining API connections on the LLM page.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/connectors"
          className="inline-flex rounded-control bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/80"
        >
          Configure remaining connectors
        </Link>
        <Link
          href="/"
          className="inline-flex rounded-control border border-line px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-surface-muted"
        >
          Skip for now
        </Link>
      </div>
    </section>
  );
}
