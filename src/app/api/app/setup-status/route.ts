import { NextResponse } from "next/server";
import { getGoogleOAuthStatus } from "@cinatra-ai/google-oauth-connection";
// The wordpress/linkedin/youtube status reads resolve the CONNECTOR-owned
// relocated clients lazily (cinatra#975 Wave 3 — the vendor clients are gone
// from core). Tested degradation: an absent connector reports not_connected
// (all-APIs-ready stays false) instead of breaking the route — the same
// posture as the manifest-resolved module reads below.
import {
  resolveLinkedInConnectionClient,
  resolveWordPressInstanceAdmin,
  resolveYouTubeConnectionClient,
} from "@/lib/connector-client-providers";
import { readOpenAIConnection, type OpenAIConnection } from "@/lib/openai-connection-store";
import { isSetupWizardComplete } from "@/lib/setup-wizard";
// Connector status reads resolve through the generated extension manifest —
// this route names no connector package. The structural types below are the
// export shapes it consumes; a connector absent from the image reports
// not_connected/not ready instead of breaking the route.
import { loadConnectorModule } from "@/lib/connector-modules.server";

type ApolloConnectorModule = {
  getApolloAPIStatus: () => { status: string };
};

type OpenAIConnectorModule = {
  isOpenAIConnectionReady: (connection?: OpenAIConnection) => boolean;
};

export async function GET() {
  const [
    googleStatus,
    apolloModule,
    openAIModule,
    youtubeStatus,
    wordpressStatus,
    linkedinStatus,
    wizardComplete,
  ] = await Promise.all([
    getGoogleOAuthStatus(),
    loadConnectorModule<ApolloConnectorModule>("apollo-connector"),
    loadConnectorModule<OpenAIConnectorModule>("openai-connector"),
    Promise.resolve(
      resolveYouTubeConnectionClient()?.getStatus() ?? { status: "not_connected" as const },
    ),
    Promise.resolve(
      resolveWordPressInstanceAdmin()?.getAPIStatus() ?? { status: "not_connected" as const },
    ),
    resolveLinkedInConnectionClient()?.getStatus() ??
      Promise.resolve({ status: "not_connected" as const }),
    isSetupWizardComplete(),
  ]);
  const apolloStatus = apolloModule?.getApolloAPIStatus() ?? { status: "not_connected" };

  const openAIConnection = readOpenAIConnection();
  const openAIReady =
    openAIModule?.isOpenAIConnectionReady(openAIConnection ?? undefined) ?? false;
  // allApisReady does not include gemini; statuses payload omits the gemini key.
  const allApisReady =
    openAIReady &&
    googleStatus.status === "connected" &&
    apolloStatus.status === "connected" &&
    youtubeStatus.status === "connected" &&
    wordpressStatus.status === "connected" &&
    linkedinStatus.status === "connected";

  return NextResponse.json({
    ready: allApisReady,
    wizardComplete,
    statuses: {
      openai: openAIReady ? "connected" : "incomplete",
      googleOAuth: googleStatus.status,
      apollo: apolloStatus.status,
      youtube: youtubeStatus.status,
      wordpress: wordpressStatus.status,
      linkedin: linkedinStatus.status,
    },
  });
}
