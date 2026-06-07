import type { Metadata } from "next";
import { getOpenAILoggingSettings } from "@cinatra-ai/openai-connector";
import { getAnthropicLoggingSettings } from "@/lib/logging";
import { getApolloLoggingSettings } from "@cinatra-ai/apollo-connector";
import { getGeminiLoggingSettings } from "@cinatra-ai/gemini-connector";
import { getWordPressLoggingSettings } from "@/lib/wordpress-api";
import { getLinkedInLoggingSettings } from "@/lib/linkedin-api";
import { getMcpLoggingSettings } from "@/lib/mcp-logging";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { SettingsTabNav } from "@/components/settings-tab-nav";
import { DevelopmentLoggingForm } from "@/app/configuration/development/development-logging-form";

export const metadata: Metadata = { title: "Telemetry" };

const TABS = [
  { value: "logs", label: "Logs" },
];

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettingsTelemetryPage({ searchParams }: Props) {
  const resolved = (await (searchParams ?? Promise.resolve({}))) as Record<string, string | string[] | undefined>;
  const tab = (Array.isArray(resolved.tab) ? resolved.tab[0] : resolved.tab) ?? "logs";
  const logsCleared = pickSearchParam(resolved.logsCleared) === "1";

  const openAI = getOpenAILoggingSettings();
  const anthropic = getAnthropicLoggingSettings();
  const apollo = getApolloLoggingSettings();
  const gemini = getGeminiLoggingSettings();
  const wordpress = getWordPressLoggingSettings();
  const linkedin = getLinkedInLoggingSettings();
  const mcp = getMcpLoggingSettings();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Telemetry"
        description="Configure API request logging for debugging and observability."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SettingsTabNav tabs={TABS} activeTab={tab} />

        {tab === "logs" && (
          <>
            <DevelopmentLoggingForm
              providers={[
                {
                  id: "apollo",
                  label: "Apollo",
                  description: "Persist Apollo request and response payloads for connection checks and Apollo-backed workflows.",
                  enabled: apollo.enabled,
                  directory: apollo.directory,
                },
                {
                  id: "gemini",
                  label: "Gemini API",
                  description: "Persist Gemini request and response payloads for transcript generation and other Gemini workflows.",
                  enabled: gemini.enabled,
                  directory: gemini.directory,
                },
                {
                  id: "linkedin",
                  label: "LinkedIn API",
                  description: "Persist LinkedIn OAuth and API request and response payloads for account connection, profile lookup, and organization authorization checks.",
                  enabled: linkedin.enabled,
                  directory: linkedin.directory,
                },
                {
                  id: "mcpServer",
                  label: "MCP server",
                  description: "Persist shared MCP server transport requests and responses handled by the app-hosted MCP runtime.",
                  enabled: mcp.serverEnabled,
                  directory: mcp.serverDirectory,
                },
                {
                  id: "mcpClient",
                  label: "MCP client",
                  description: "Persist MCP client invocation events from deterministic package-side MCP client execution.",
                  enabled: mcp.clientEnabled,
                  directory: mcp.clientDirectory,
                },
                {
                  id: "openai",
                  label: "OpenAI API",
                  description: "Persist OpenAI request and response payloads for model calls and related API operations.",
                  enabled: openAI.enabled,
                  directory: openAI.directory,
                },
                {
                  id: "anthropic",
                  label: "Anthropic API",
                  description: "Persist Anthropic request and response payloads for Claude model calls.",
                  enabled: anthropic.enabled,
                  directory: anthropic.directory,
                },
                {
                  id: "wordpress",
                  label: "WordPress API",
                  description: "Persist WordPress API request and response payloads for connection checks, latest-post retrieval, media uploads, and draft creation.",
                  enabled: wordpress.enabled,
                  directory: wordpress.directory,
                },
              ]}
            />
            {logsCleared && (
              <div className="soft-panel rounded-card px-6 py-4 text-sm text-success">
                All provider log entries were deleted.
              </div>
            )}
          </>
        )}
      </PageContent>
    </Main>
  );
}
