import { NextResponse } from "next/server";
import { getApolloAPIStatus } from "@cinatra-ai/apollo-connector";
import { getGoogleOAuthStatus } from "@cinatra-ai/google-oauth-connection";
import { isOpenAIConnectionReady } from "@cinatra-ai/openai-connector";
import { getLinkedInAPIStatus } from "@/lib/linkedin-api";
import { readOpenAIConnection } from "@/lib/openai-connection-store";
import { getWordPressAPIStatus } from "@/lib/wordpress-api";
import { getYouTubeAPIStatus } from "@/lib/youtube-api";
import { isSetupWizardComplete } from "@/lib/setup-wizard";

export async function GET() {
  const [
    googleStatus,
    apolloStatus,
    youtubeStatus,
    wordpressStatus,
    linkedinStatus,
    wizardComplete,
  ] = await Promise.all([
    getGoogleOAuthStatus(),
    Promise.resolve(getApolloAPIStatus()),
    Promise.resolve(getYouTubeAPIStatus()),
    Promise.resolve(getWordPressAPIStatus()),
    getLinkedInAPIStatus(),
    isSetupWizardComplete(),
  ]);

  const openAIConnection = readOpenAIConnection();
  const openAIReady = isOpenAIConnectionReady(openAIConnection ?? undefined);
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
