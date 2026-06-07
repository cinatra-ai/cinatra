// Deeplink: Better Auth MCP OAuth consent page; URL is advertised to external MCP clients as consentPage.
import type { Metadata } from "next";
import { mcpServerMount } from "@/lib/mcp-server";

export const metadata: Metadata = { title: "MCP Consent" };

const { ConsentPage } = mcpServerMount;

export default function McpConsentRoutePage(
  props: Parameters<typeof ConsentPage>[0],
) {
  return <ConsentPage {...props} />;
}
