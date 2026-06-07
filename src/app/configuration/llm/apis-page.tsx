import type { Metadata } from "next";
import { getAnthropicAPIStatus, CLAUDE_MODELS } from "@cinatra-ai/anthropic-connector";
import { getGeminiAPIStatus } from "@cinatra-ai/gemini-connector";
import { getConfiguredOpenAIConnection } from "@cinatra-ai/openai-connector";
import { NangoManagedApiCard } from "@cinatra-ai/sdk-ui/nango";
import { getNangoFrontendConfig, getNangoStatus, getPrimarySavedNangoConnection } from "@/lib/nango";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { saveOpenAIConnectionAction } from "@/app/campaigns/actions";
import { Label } from "@/components/ui/label";
import { readDefaultLlmProviderFromDatabase, readDefaultImageProviderFromDatabase, readObjectsClassificationModelFromDatabase, readAgentCreationLlmProviderFromDatabase, readAgentCreationModelFromDatabase, readAnthropicSkillSyncEnabledFromDatabase } from "@/lib/database";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DefaultProvidersCard } from "@/app/configuration/llm/_default-llm-select";
import { Input } from "@/components/ui/input";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
// Direct per-icon imports avoid Turbopack having to process the 3,412-line
// barrel file and 10,000+ icon files in @icons-pack/react-simple-icons (59 MB).
// Tree-shaking is irrelevant here: the package sideEffects:false flag doesn't
// prevent Turbopack from parsing the entire re-export barrel to resolve
// symbols. Direct file imports keep compilation memory bounded.
import { LinkedInSettingsPage } from "@cinatra-ai/linkedin-connector/settings-page";
import { AnthropicSettingsContent } from "@cinatra-ai/anthropic-connector/settings-page";
import { ExternalMcpSettingsPage } from "@/lib/external-mcp-settings-page";
import { ConnectorSettingsDialog } from "@/components/connector-settings-dialog";
import { readOpenAIConnection } from "@/lib/openai-connection-store";
import {
  getDefaultOpenAIServiceTier,
  isOpenAIConnectionReady,
  listAvailableOpenAIModels,
  filterVisibleOpenAIModels,
  filterSelectableOpenAIModels,
  OPENAI_SERVICE_TIER_OPTIONS,
} from "@cinatra-ai/openai-connector";
// ---------------------------------------------------------------------------
// OpenAI modal content — async server component (backs ?modal=openai overlay)
// ---------------------------------------------------------------------------

async function OpenAIModalContent() {
  const connection = readOpenAIConnection();
  const nangoStatus = getNangoStatus();
  const nangoFrontendConfig = getNangoFrontendConfig();
  const defaultServiceTier = getDefaultOpenAIServiceTier();
  const configuredConnection = await getConfiguredOpenAIConnection(connection ?? undefined);
  const isConnected = isOpenAIConnectionReady(configuredConnection ?? connection ?? undefined);
  const connectionServiceReady = nangoStatus.status === "connected";
  const hasNangoConnection = Boolean(getPrimarySavedNangoConnection("openai"));

  let availableModels = connection?.availableModels ?? configuredConnection?.availableModels ?? [];
  if (configuredConnection?.apiKey) {
    try {
      const fetchedModels = await listAvailableOpenAIModels({
        projectId: configuredConnection.projectId,
        organizationId: configuredConnection.organizationId,
      });
      if (fetchedModels.length > 0) {
        availableModels = fetchedModels;
      }
    } catch {
      // Keep the last validated model list if the live refresh fails.
    }
  }
  availableModels = filterVisibleOpenAIModels(availableModels);
  const selectableModels = new Set(filterSelectableOpenAIModels(availableModels));
  const promptCachingEnabled = configuredConnection?.promptCachingEnabled ?? isAppDevelopmentMode();

  return (
    <ConnectorSettingsDialog closeHref="/configuration/llm">
      <NangoManagedApiCard
        connectorKey="openai"
        title="OpenAI API"
        description="Connect OpenAI through Nango for Cinatra's model-backed workflows."
        badge={isConnected ? "Connected" : hasNangoConnection ? "API key provided" : "Setup required"}
        isConnected={hasNangoConnection || isConnected}
        usesConnectUI={true}
        connectLabel="API key"
        reconnectLabel="API key"
        reconnectConnectionId={getPrimarySavedNangoConnection("openai")?.connectionId}
        nangoFrontendConfig={nangoFrontendConfig}
        connectionServiceReady={connectionServiceReady}
        naked
      >
        <form action={saveOpenAIConnectionAction} className="mt-5 grid items-start gap-4 border-t border-line pt-5 sm:grid-cols-2">
          <input type="hidden" name="redirectTo" value="/configuration/llm?modal=openai" />
          <Field>
            <FieldLabel>Project ID</FieldLabel>
            <Input name="projectId" defaultValue={connection?.projectId ?? ""} />
          </Field>
          <Field>
            <FieldLabel>Organization ID</FieldLabel>
            <Input name="organizationId" defaultValue={connection?.organizationId ?? ""} />
          </Field>
          <Field>
            <FieldLabel>Service tier</FieldLabel>
            <select
              name="serviceTier"
              defaultValue={connection?.serviceTier ?? defaultServiceTier}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            >
              {OPENAI_SERVICE_TIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel>Default model</FieldLabel>
            {availableModels.length > 0 ? (
              <>
                <select
                  name="defaultModel"
                  defaultValue={connection?.defaultModel && selectableModels.has(connection.defaultModel) ? connection.defaultModel : "gpt-5.4"}
                  className="rounded-control border border-line bg-surface-strong px-4 py-3"
                >
                  {availableModels.map((model) => (
                    <option key={model} value={model} disabled={!selectableModels.has(model)}>
                      {model}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <Input name="defaultModel" defaultValue={connection?.defaultModel ?? "gpt-5"} />
                <span className="text-xs font-normal text-muted-foreground">
                  Save a working key first to load available models.
                </span>
              </>
            )}
          </Field>
          <Field>
            <FieldLabel>Prompt caching</FieldLabel>
            <select
              name="promptCachingEnabled"
              defaultValue={promptCachingEnabled ? "on" : "off"}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </Field>
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit">Save</Button>
          </div>
        </form>
      </NangoManagedApiCard>
    </ConnectorSettingsDialog>
  );
}

// ---------------------------------------------------------------------------
// Gemini connection is configured on the connector's own setup page
// (/connectors/cinatra-ai/gemini-connector/setup). The host LLM page only shows
// connected status (getGeminiAPIStatus) and links there — it never imports the
// connector's setup form/action by name (IoC mirror gate: core must not
// name an extension's setup/action code).
// ---------------------------------------------------------------------------

type APIsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export const metadata: Metadata = { title: "LLM" };

export default async function APIsPage({ searchParams }: APIsPageProps) {
  const [
    claudeStatus,
    geminiStatus,
    configuredOpenAIConnection,
    resolvedSearchParams,
  ] = await Promise.all([
    Promise.resolve(getAnthropicAPIStatus()),
    Promise.resolve(getGeminiAPIStatus()),
    getConfiguredOpenAIConnection(),
    (searchParams ?? Promise.resolve({})) as Promise<Record<string, string | string[] | undefined>>,
  ]);
  const savedIntegration = pickSearchParam(resolvedSearchParams.saved);
  const currentDefaultProvider = readDefaultLlmProviderFromDatabase();
  const openaiConnected = Boolean(configuredOpenAIConnection?.apiKey);
  const anthropicConnected = claudeStatus.status === "connected";
  const geminiConnected = geminiStatus.status === "connected";

  // Compute smart default for image generation provider.
  // Priority: saved preference (if still connected) → Gemini → OpenAI.
  const savedImageProvider = readDefaultImageProviderFromDatabase();
  const imageProviderConnected: Record<string, boolean> = {
    openai: openaiConnected,
    anthropic: anthropicConnected,
    gemini: geminiConnected,
  };
  const currentImageProvider: string =
    savedImageProvider && imageProviderConnected[savedImageProvider]
      ? savedImageProvider
      : geminiConnected
        ? "gemini"
        : "openai";

  const modal = pickSearchParam(resolvedSearchParams.modal);

  return (
    <>
      <Main className="min-h-screen">
        <PageHeader title="LLM" />
        <PageContent className="flex flex-col gap-6 pb-8">

          <section className="flex flex-col gap-4">
            {/* Provider connection cards moved to /connectors — see /connectors/openai,
                /connectors/gemini, /connectors/anthropic. The ?modal= overlay hosts
                below are kept for bookmark continuity. */}
            <Card className="border-line bg-surface backdrop-blur-none">
              <CardContent className="p-6">
                <DefaultProvidersCard
                  defaultLlmProvider={currentDefaultProvider}
                  defaultImageProvider={currentImageProvider}
                  openaiConnected={openaiConnected}
                  anthropicConnected={anthropicConnected}
                  geminiConnected={geminiConnected}
                  classificationModel={readObjectsClassificationModelFromDatabase()}
                  availableModels={["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano"]}
                  anthropicModels={[...CLAUDE_MODELS]}
                  // MUST mirror AGENT_CREATION_OPENAI_MODELS in src/app/campaigns/actions.ts
                  // (gpt-5 family). The classification availableModels (gpt-4*) is a
                  // separate purpose the agent-creation action would reject.
                  agentCreationOpenaiModels={["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5", "gpt-5-mini"]}
                  agentCreationProvider={readAgentCreationLlmProviderFromDatabase()}
                  agentCreationModel={readAgentCreationModelFromDatabase()}
                  anthropicSkillSyncEnabled={readAnthropicSkillSyncEnabledFromDatabase()}
                />
              </CardContent>
            </Card>
          </section>

          {savedIntegration ? (
            <Alert variant="success" className="rounded-control">
              <AlertDescription>
                {savedIntegration === "openai"
                  ? "The OpenAI API connection was validated and saved."
                  : "The API connection was saved."}
              </AlertDescription>
            </Alert>
          ) : null}

        </PageContent>
      </Main>

      {modal === "linkedin" ? (
        <LinkedInSettingsPage searchParams={searchParams} />
      ) : null}

      {modal === "openai" ? (
        <OpenAIModalContent />
      ) : null}

      {modal === "anthropic" ? (
        <ConnectorSettingsDialog closeHref="/configuration/llm">
          <AnthropicSettingsContent searchParams={searchParams} />
        </ConnectorSettingsDialog>
      ) : null}

      {modal === "external-mcp" ? (
        <ExternalMcpSettingsPage searchParams={searchParams} />
      ) : null}
    </>
  );
}
