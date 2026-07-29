// Deeplink: Initial setup wizard AI-provider step; navigated to from setup orchestration, not from app chrome.
//
// PROVIDER-AGNOSTIC AI STEP (cinatra#2093, epic #2086 S6).
//
// Before S6 this page WAS the OpenAI connection form: the wizard hardcoded one
// provider, and "the key is saved" was treated as "setup is done". Now it is an
// orchestrator over the WIZARD-ELIGIBLE providers (declared via
// `cinatra.llmProvider` ABI v2 `wizardEligible`):
//
//   1. offer the eligible providers and record the owner's pick;
//   2. render THAT provider's own connection form;
//   3. run the READINESS SAGA, which is the only thing that commits
//      `llm_default_provider` — and only after proving the provider works
//      (on Anthropic: bulk consent + strict initial sync + a native-skills
//      probe against an actually-uploaded revision);
//   4. show the resulting receipt, or the actionable failure + fix-forward.
//
// Gemini is deliberately NOT offered here (`wizardEligible: false`): it is a
// perfectly valid global default, but admin-configured after setup.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { buildKnownWizardEligibleProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { readSetupReadinessState } from "@/lib/setup-readiness-saga";
import { describeMatcherProviderConstraint } from "@/lib/llm-purpose-policy";
import {
  readSetupProviderSelection,
  readSetupReadinessFailure,
} from "@/app/setup/ai/readiness-state";
import { selectSetupProviderAction, completeAiSetupAction } from "@/app/setup/ai/actions";
import { SetupOpenAIProviderStep } from "@/app/setup/ai/openai-provider-step";
import { SetupAnthropicProviderStep } from "@/app/setup/ai/anthropic-provider-step";

export const metadata: Metadata = { title: "Setup: AI" };

type SetupAiPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const PROVIDER_COPY: Record<string, { label: string; blurb: string }> = {
  openai: {
    label: "OpenAI",
    blurb:
      "Runs the assistant, agents and skill generation. Also the only provider that can run automatic skill matching today.",
  },
  anthropic: {
    label: "Anthropic",
    blurb:
      "Runs the assistant, agents and skill generation, and delivers your skills natively to Claude. Setup uploads your installed skills to your Anthropic workspace — you will be asked to confirm.",
  },
};

export default async function SetupAiPage({ searchParams }: SetupAiPageProps) {
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const stay = pickSearchParam(resolvedSearchParams.stay) === "1";

  const eligible = buildKnownWizardEligibleProviders();
  const selected = readSetupProviderSelection();
  const readiness = readSetupReadinessState();
  const failure = readSetupReadinessFailure();

  // Auto-forward once the step is genuinely done (a VALID receipt — not merely
  // a saved key), unless the operator came back via the stepper or a readiness
  // failure is still standing.
  //
  // The suppression keys off the DURABLE failure record rather than an `?error`
  // param: the failure is real state the operator has to act on, not a
  // one-shot flash. The transient flash itself goes through the wizard's
  // codes-only <SearchParamToast> (see setup-flash.ts) — this page never reads
  // notification text from the URL.
  const steps = await getSetupWizardSteps();
  const nextStep = getFirstIncompleteStep(steps);
  if (readiness.ready && !failure && !stay) {
    if (!nextStep || nextStep.id !== "ai") {
      redirect(nextStep?.href ?? "/setup/complete");
    }
  }
  const continueHref = !nextStep || nextStep.id === "ai" ? "/setup/complete" : nextStep.href;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-base font-semibold text-foreground">Choose your AI provider</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Cinatra runs on one provider by default. You can add and switch providers later in
          Administration.
        </p>
      </div>

      {/* Step 1 — the choice. */}
      <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
        <p className="text-base font-semibold text-foreground">Provider</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {eligible.map((provider) => {
            const copy = PROVIDER_COPY[provider] ?? { label: provider, blurb: "" };
            const installed = getLlmProviderSurface(provider) !== null;
            const isSelected = selected === provider;
            return (
              <form action={selectSetupProviderAction} key={provider}>
                <Input type="hidden" name="provider" value={provider} />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!installed}
                  aria-pressed={isSelected}
                  data-testid={`setup-provider-${provider}`}
                  className={[
                    "h-auto w-full flex-col items-start gap-1 whitespace-normal rounded-card border p-4 text-left",
                    isSelected ? "border-primary bg-primary/5" : "border-line hover:border-primary/50",
                  ].join(" ")}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">{copy.label}</span>
                    {isSelected ? <Check className="size-4 text-primary" aria-hidden /> : null}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {installed
                      ? copy.blurb
                      : `The ${copy.label} connector is not installed or active on this instance.`}
                  </span>
                </Button>
              </form>
            );
          })}
        </div>
      </section>

      {/* Step 2 — the chosen provider's own connection form. */}
      {selected === "openai" ? (
        <SetupOpenAIProviderStep searchParams={searchParams} />
      ) : selected === "anthropic" ? (
        <SetupAnthropicProviderStep />
      ) : (
        <Alert>
          <AlertTitle>Pick a provider to continue</AlertTitle>
          <AlertDescription>
            Choose OpenAI or Anthropic above, then enter that provider&apos;s credentials.
          </AlertDescription>
        </Alert>
      )}

      {/* Step 3 — the readiness run + its outcome. */}
      {selected ? (
        <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
          <p className="text-base font-semibold text-foreground">Finish AI setup</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {selected === "anthropic"
              ? "Cinatra will validate your key, ask your permission to upload your installed skills to your Anthropic workspace, upload them, and verify that Claude actually accepts them before saving this choice."
              : "Cinatra will validate your key and confirm the connection is ready before saving this choice."}
          </p>

          {readiness.ready && readiness.receipt ? (
            <Alert className="mt-4">
              <Check className="size-4" aria-hidden />
              <AlertTitle>AI setup complete</AlertTitle>
              <AlertDescription>
                {readiness.receipt.provider === "anthropic"
                  ? `Verified on ${new Date(readiness.receipt.completedAt).toLocaleString()}. ${readiness.receipt.syncedSkillCount ?? 0} skill(s) uploaded, and Claude accepted a container.skills request${readiness.receipt.probe?.disposable ? " (verified with a temporary probe skill, since no skills are installed yet)" : ""}.`
                  : `Verified on ${new Date(readiness.receipt.completedAt).toLocaleString()}.`}
              </AlertDescription>
            </Alert>
          ) : null}

          {!readiness.ready && failure ? (
            <Alert variant="destructive" className="mt-4" data-testid="setup-readiness-failure">
              <TriangleAlert className="size-4" aria-hidden />
              <AlertTitle>AI setup did not complete ({failure.step})</AlertTitle>
              <AlertDescription>
                <span className="block">{failure.message}</span>
                {failure.fixForward ? (
                  <span className="mt-2 block font-medium">{failure.fixForward}</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Honest constraint surfacing: skill auto-matching is pinned to
              OpenAI by a hard Batch-API dependency. Say so BEFORE the owner
              commits, not after they wonder why matching never runs. */}
          {describeMatcherProviderConstraint(selected) ? (
            <Alert className="mt-4" data-testid="setup-matcher-constraint">
              <AlertTitle>One feature needs OpenAI</AlertTitle>
              <AlertDescription>{describeMatcherProviderConstraint(selected)}</AlertDescription>
            </Alert>
          ) : null}

          <form action={completeAiSetupAction} className="mt-5 flex justify-end">
            <Input type="hidden" name="provider" value={selected} />
            <Button type="submit" data-testid="setup-run-readiness">
              {readiness.ready ? "Re-verify" : "Verify and save"}
            </Button>
          </form>
        </section>
      ) : null}

      {readiness.ready ? (
        <div className="flex justify-end">
          <Button asChild>
            <Link href={continueHref}>
              Continue
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
