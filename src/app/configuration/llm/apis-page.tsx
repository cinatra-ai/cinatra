import type { Metadata } from "next";
import type { ComponentType } from "react";
import { NangoManagedApiCard } from "@cinatra-ai/sdk-ui/nango";
import { getNangoFrontendConfig, getNangoStatus, getPrimarySavedNangoConnection } from "@/lib/nango";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { saveOpenAIConnectionAction } from "@/app/campaigns/actions";
import { DEFAULT_OPENAI_MODEL_ID } from "@cinatra-ai/agents/llm-provider-policy";
import { Label } from "@/components/ui/label";
import { readDefaultLlmProviderFromDatabase, readDefaultImageProviderFromDatabase, readObjectsClassificationModelFromDatabase, readAgentCreationLlmProviderFromDatabase, readAgentCreationModelFromDatabase, readAnthropicSkillSyncEnabledFromDatabase } from "@/lib/database";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DefaultProvidersCard } from "@/app/configuration/llm/_default-llm-select";
import { Input } from "@/components/ui/input";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { ExternalMcpSettingsPage } from "@/lib/external-mcp-settings-page";
import { ConnectorSettingsDialog } from "@/components/connector-settings-dialog";
import { readOpenAIConnection, type OpenAIConnection } from "@/lib/openai-connection-store";
// Connector status reads, model lists, and settings components resolve through
// the generated extension manifest (entry modules + settings-page loaders) —
// this page names no connector package. The structural types below are the
// export shapes this surface consumes (its host↔connector data contract).
import { loadConnectorModule } from "@/lib/connector-modules.server";
import { getConnectorSettingsPageLoader } from "@/lib/connector-setup-pages";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

type ProviderStatus = { status: string };

type AnthropicConnectorModule = {
  getAnthropicAPIStatus: () => ProviderStatus;
  CLAUDE_MODELS: readonly string[];
};

type GeminiConnectorModule = {
  getGeminiAPIStatus: () => ProviderStatus;
};

type OpenAIConnectionSnapshot = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  promptCachingEnabled?: boolean;
  availableModels?: string[];
};

type OpenAIConnectorModule = {
  getConfiguredOpenAIConnection: (
    connection?: OpenAIConnection,
  ) => Promise<OpenAIConnectionSnapshot | null>;
  isOpenAIConnectionReady: (connection?: OpenAIConnection | OpenAIConnectionSnapshot) => boolean;
  listAvailableOpenAIModels: (input: {
    projectId?: string;
    organizationId?: string;
  }) => Promise<string[]>;
  filterVisibleOpenAIModels: (models: string[]) => string[];
  filterSelectableOpenAIModels: (models: string[]) => string[];
  getDefaultOpenAIServiceTier: () => string;
  OPENAI_SERVICE_TIER_OPTIONS: Array<{ value: string; label: string }>;
};

type SettingsContentProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function loadSettingsComponent(
  slug: string,
  exportName: string,
): Promise<ComponentType<SettingsContentProps> | null> {
  const loader = getConnectorSettingsPageLoader(slug);
  if (!loader) return null;
  const ns = await loader();
  if (isDegradedExtensionLoad(ns)) {
    // cinatra#7: absent optional settings module — degrade to "no page".
    console.warn(
      `[llm-apis] settings module for "${slug}" is absent post-build — skipping (${ns.reason})`,
    );
    return null;
  }
  const mod = ns as Record<string, unknown>;
  const component = mod[exportName];
  return typeof component === "function"
    ? (component as ComponentType<SettingsContentProps>)
    : null;
}
// ---------------------------------------------------------------------------
// OpenAI modal content — async server component (backs ?modal=openai overlay)
// ---------------------------------------------------------------------------

async function OpenAIModalContent() {
  const openai = await loadConnectorModule<OpenAIConnectorModule>("openai-connector");
  if (!openai) return null;
  const connection = readOpenAIConnection();
  const nangoStatus = getNangoStatus();
  const nangoFrontendConfig = getNangoFrontendConfig();
  const defaultServiceTier = openai.getDefaultOpenAIServiceTier();
  const configuredConnection = await openai.getConfiguredOpenAIConnection(connection ?? undefined);
  const isConnected = openai.isOpenAIConnectionReady(configuredConnection ?? connection ?? undefined);
  const connectionServiceReady = nangoStatus.status === "connected";
  const hasNangoConnection = Boolean(getPrimarySavedNangoConnection("openai"));

  let availableModels = connection?.availableModels ?? configuredConnection?.availableModels ?? [];
  if (configuredConnection?.apiKey) {
    try {
      const fetchedModels = await openai.listAvailableOpenAIModels({
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
  availableModels = openai.filterVisibleOpenAIModels(availableModels);
  const selectableModels = new Set(openai.filterSelectableOpenAIModels(availableModels));
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
              {openai.OPENAI_SERVICE_TIER_OPTIONS.map((option) => (
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
                  defaultValue={connection?.defaultModel && selectableModels.has(connection.defaultModel) ? connection.defaultModel : DEFAULT_OPENAI_MODEL_ID}
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
                <Input name="defaultModel" defaultValue={connection?.defaultModel ?? DEFAULT_OPENAI_MODEL_ID} />
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
  const [anthropic, gemini, openai, resolvedSearchParams] = await Promise.all([
    loadConnectorModule<AnthropicConnectorModule>("anthropic-connector"),
    loadConnectorModule<GeminiConnectorModule>("gemini-connector"),
    loadConnectorModule<OpenAIConnectorModule>("openai-connector"),
    (searchParams ?? Promise.resolve({})) as Promise<Record<string, string | string[] | undefined>>,
  ]);
  const claudeStatus: ProviderStatus = anthropic?.getAnthropicAPIStatus() ?? {
    status: "not_connected",
  };
  const geminiStatus: ProviderStatus = gemini?.getGeminiAPIStatus() ?? {
    status: "not_connected",
  };
  const configuredOpenAIConnection = (await openai?.getConfiguredOpenAIConnection()) ?? null;
  const anthropicModels = [...(anthropic?.CLAUDE_MODELS ?? [])];
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

  // Settings components resolve through the generated settings-page loader map
  // only when their modal is requested.
  const LinkedInSettings =
    modal === "linkedin"
      ? await loadSettingsComponent("linkedin-connector", "LinkedInSettingsPage")
      : null;
  const AnthropicSettings =
    modal === "anthropic"
      ? await loadSettingsComponent("anthropic-connector", "AnthropicSettingsContent")
      : null;

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
                  anthropicModels={anthropicModels}
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

      {LinkedInSettings ? (
        <LinkedInSettings searchParams={searchParams} />
      ) : null}

      {modal === "openai" ? (
        <OpenAIModalContent />
      ) : null}

      {AnthropicSettings ? (
        <ConnectorSettingsDialog closeHref="/configuration/llm">
          <AnthropicSettings searchParams={searchParams} />
        </ConnectorSettingsDialog>
      ) : null}

      {modal === "external-mcp" ? (
        <ExternalMcpSettingsPage searchParams={searchParams} />
      ) : null}
    </>
  );
}
