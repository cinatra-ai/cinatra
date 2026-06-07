// Deeplink: Better Auth MCP OAuth handshake route (sign-in/sign-up/sign-out); URL is advertised to external MCP clients as loginPage/signupPage.
import type { Metadata } from "next";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { mcpServerMount } from "@/lib/mcp-server";

export const metadata: Metadata = { title: "Sign In" };

export const dynamicParams = false;

export async function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

const { AuthPage } = mcpServerMount;

export default function McpAuthRoutePage(props: Parameters<typeof AuthPage>[0]) {
  return <AuthPage {...props} />;
}
