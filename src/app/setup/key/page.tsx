// Deeplink: Initial setup wizard encryption-key step; navigated to from setup orchestration, not from app chrome.
// -----------------------------------------------------------------------------
// Setup wizard key gate for CINATRA_ENCRYPTION_KEY.
//
// Renders inline instructions for generating and configuring CINATRA_ENCRYPTION_KEY.
// Blocks forward progress until the env var is set (>= 32 chars). The page
// advances automatically on the next navigation once the variable is present.
//
// No reference to docs/operator-runbook.md — instructions are fully inline.
// All interactive elements from src/components/ui/* (Alert, Button) per
// CLAUDE.md UI Component Requirement. Only semantic tokens used — no raw
// Tailwind palette classes.
// -----------------------------------------------------------------------------

import { resolve } from "node:path";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";

import { ArrowRight } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Setup: Key" };

type SetupSecretKeyPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetupSecretKeyPage({ searchParams }: SetupSecretKeyPageProps) {
  await requireAuthSession();
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const stayRaw = resolvedSearchParams.stay;
  const stay = (Array.isArray(stayRaw) ? stayRaw[0] : stayRaw) === "1";

  const secretsKeyOk = (process.env.CINATRA_ENCRYPTION_KEY?.trim().length ?? 0) >= 32;
  const envLocalPath = resolve(process.cwd(), ".env.local");

  // If the key is already set, hop forward to the next incomplete step —
  // unless the operator clicked back here from the stepper (?stay=1).
  let nextHref = "/setup";
  if (secretsKeyOk) {
    const steps = await getSetupWizardSteps();
    const next = getFirstIncompleteStep(steps);
    if (!stay && (!next || next.id !== "key")) {
      redirect(next?.href ?? "/setup/complete");
    }
    nextHref = next?.href ?? "/setup/complete";
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-base font-semibold text-foreground">Set the encryption key</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Cinatra encrypts registry credentials at rest using a 32-byte encryption key. Set this
          environment variable before continuing.
        </p>
      </div>

      {secretsKeyOk ? (
        <Alert>
          <AlertTitle>Encryption key detected</AlertTitle>
          <AlertDescription>CINATRA_ENCRYPTION_KEY is set.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>CINATRA_ENCRYPTION_KEY is not set</AlertTitle>
          <AlertDescription>
            This page will advance automatically once the environment variable is set and the server
            has restarted.
          </AlertDescription>
        </Alert>
      )}

      <section
        aria-disabled={secretsKeyOk || undefined}
        className={cn("rounded-card border border-line bg-surface-strong p-6 shadow-sm", secretsKeyOk ? "pointer-events-none opacity-60" : "")}
      >
        <div>
          <p className="text-sm font-semibold text-foreground">Generate a key</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Run the command below in a terminal. It prints a 64-character hex string suitable for
            AES-256-GCM.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-control border border-line bg-surface-muted px-3 py-2 text-sm text-foreground">
            <code>openssl rand -hex 32</code>
          </pre>
        </div>

        <div className="mt-5">
          <p className="text-sm font-semibold text-foreground">Configure the key</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add the value to your environment as CINATRA_ENCRYPTION_KEY. For local development, append
            the line below to{" "}
            <code className="rounded-control border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-foreground">
              {envLocalPath}
            </code>
            , then restart the dev server.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-control border border-line bg-surface-muted px-3 py-2 text-sm text-foreground">
            <code>CINATRA_ENCRYPTION_KEY=&lt;paste-the-64-hex-character-output-here&gt;</code>
          </pre>
          <p className="mt-3 text-sm text-muted-foreground">
            In development this is generated automatically on first server boot and written to .env.local. Production deployments must set this explicitly to avoid losing access to encrypted data on restart.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            For long-lived deployments, set CINATRA_ENCRYPTION_KEY through your hosting
            provider&apos;s environment-variable administration (Vercel project settings,
            Docker secrets, your infrastructure repo, etc.). Once the variable is present and
            the server can read it, this page will advance automatically on the next navigation.
          </p>
        </div>
      </section>

      {secretsKeyOk ? (
        <div className="flex justify-end">
          <Button asChild>
            <Link href={nextHref}>
              Continue
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
