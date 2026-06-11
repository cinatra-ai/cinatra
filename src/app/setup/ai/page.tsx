// Deeplink: Initial setup wizard AI-provider step; navigated to from setup orchestration, not from app chrome.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { saveOpenAIConnectionAction } from "@/app/campaigns/actions";
import { DEFAULT_OPENAI_MODEL_ID } from "@cinatra-ai/agents/llm-provider-policy";
import { readOpenAIConnection } from "@/lib/openai-connection-store";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
// Every OpenAI reader resolves through the `llm-provider-surface` capability
// the openai connector registers at activation (lazy/guarded host-access
// cutover). Connector absent → the degraded info state below
// replaces the connection form.
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";

export const metadata: Metadata = { title: "Setup: AI" };

// "Standard" is the human label of the "default" tier (see OPENAI_SERVICE_TIER_OPTIONS).
const REQUIRED_SERVICE_TIER = "default" as const;

type SetupOpenAIPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SetupOpenAIPage({ searchParams }: SetupOpenAIPageProps) {
  const resolvedSearchParams = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const openAISurface = getLlmProviderSurface("openai");
  if (!openAISurface) {
    // Degraded mode: the openai connector is not installed/active on this
    // host. Render an explanatory state instead of a connection form that
    // could never validate or save.
    return (
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-base font-semibold text-foreground">OpenAI credentials</p>
        </div>
        <Alert>
          <AlertTitle>OpenAI connector unavailable</AlertTitle>
          <AlertDescription>
            The OpenAI connector extension is not installed or active on this instance, so the
            default LLM provider cannot be configured here. Install/activate it (or configure a
            different provider in Administration) and reload this step.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const connection = readOpenAIConnection();
  const configuredConnection = (await openAISurface.getConfiguredConnection?.(
    connection ?? undefined,
  )) as { apiKey?: string; projectId?: string; organizationId?: string; availableModels?: string[]; serviceTier?: string; defaultModel?: string } | null | undefined;
  const isConnected =
    openAISurface.isConnectionReady?.(configuredConnection ?? connection ?? undefined) === true;
  const hasApiKey = Boolean(configuredConnection?.apiKey || connection?.apiKey);
  const errorMessage = pickSearchParam(resolvedSearchParams.error);
  const stay = pickSearchParam(resolvedSearchParams.stay) === "1";

  let availableModels = connection?.availableModels ?? configuredConnection?.availableModels ?? [];
  if (configuredConnection?.apiKey) {
    try {
      const fetchedModels = await openAISurface.listAvailableModels?.({
        projectId: configuredConnection.projectId,
        organizationId: configuredConnection.organizationId,
      });
      if (fetchedModels && fetchedModels.length > 0) {
        availableModels = fetchedModels;
      }
    } catch {
      // Keep the last validated model list if the live refresh fails.
    }
  }
  availableModels = openAISurface.filterVisibleModels?.(availableModels) ?? availableModels;
  const selectableModels = new Set(
    openAISurface.filterSelectableModels?.(availableModels) ?? availableModels,
  );

  // Auto-forward to next incomplete step unless the operator explicitly came
  // back here via the stepper (?stay=1) or there's an error to surface.
  const steps = await getSetupWizardSteps();
  const nextStep = getFirstIncompleteStep(steps);
  if (isConnected && !errorMessage && !stay) {
    if (!nextStep || nextStep.id !== "ai") {
      redirect(nextStep?.href ?? "/setup/complete");
    }
  }
  const continueHref =
    !nextStep || nextStep.id === "ai" ? "/setup/complete" : nextStep.href;

  const lockedServiceTier = REQUIRED_SERVICE_TIER;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-base font-semibold text-foreground">OpenAI credentials</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Configure your secret key, project, and organization from platform.openai.com.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        OpenAI is the default LLM provider for Cinatra. After setup, you can update this OpenAI
        configuration and add other providers (Anthropic, Gemini, etc.) in Administration.
      </p>

      {isConnected ? (
        <Alert>
          <AlertTitle>OpenAI connection saved</AlertTitle>
          <AlertDescription>
            Your OpenAI API key, as well as the project and organization ID and other administration
            have been configured.
          </AlertDescription>
        </Alert>
      ) : null}

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {/* Card 1: API key + project + organization */}
      <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
        <form action={saveOpenAIConnectionAction} className="grid gap-4">
          <input type="hidden" name="redirectTo" value="/setup/ai?stay=1" />
          <Field>
            <FieldLabel>API key</FieldLabel>
            <Input
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={hasApiKey ? "••••••••••••••••" : "sk-..."}
            />
          </Field>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Project ID</FieldLabel>
              <Input name="projectId" defaultValue={connection?.projectId ?? ""} />
            </Field>
            <Field>
              <FieldLabel>Organization ID</FieldLabel>
              <Input name="organizationId" defaultValue={connection?.organizationId ?? ""} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit">{hasApiKey ? "Change" : "Save"}</Button>
          </div>
        </form>
      </section>

      {/* Card 2: Service tier + default model */}
      <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
        <p className="text-base font-semibold text-foreground">Additional administration</p>
        {!hasApiKey ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Save your API key above to unlock these settings.
          </p>
        ) : null}
        <form action={saveOpenAIConnectionAction} className="mt-5">
          <input type="hidden" name="redirectTo" value="/setup/ai?stay=1" />
          <fieldset disabled={!hasApiKey} className="grid items-start gap-4 sm:grid-cols-2 disabled:opacity-50">
            <Field>
              <FieldLabel>Service tier</FieldLabel>
              <input type="hidden" name="serviceTier" value={lockedServiceTier} />
              <Select value={lockedServiceTier} disabled={!hasApiKey}>
                <SelectTrigger>
                  <SelectValue placeholder="Standard" />
                </SelectTrigger>
                <SelectContent>
                  {(openAISurface.serviceTierOptions ?? []).map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={option.value !== lockedServiceTier}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                Standard is required to ensure Cinatra&apos;s base functionality.
              </span>
            </Field>
            <Field>
              <FieldLabel>Default model</FieldLabel>
              {availableModels.length > 0 ? (
                <Select
                  name="defaultModel"
                  defaultValue={
                    connection?.defaultModel && selectableModels.has(connection.defaultModel)
                      ? connection.defaultModel
                      : DEFAULT_OPENAI_MODEL_ID
                  }
                  disabled={!hasApiKey}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model} value={model} disabled={!selectableModels.has(model)}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input name="defaultModel" defaultValue={connection?.defaultModel ?? DEFAULT_OPENAI_MODEL_ID} />
              )}
            </Field>
            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit">Save</Button>
            </div>
          </fieldset>
        </form>
      </section>

      {/* Continue lives outside any card and only appears when the connection is live. */}
      {isConnected ? (
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
