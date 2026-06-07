import type { Metadata } from "next";
import { mcpServerMount } from "@/lib/mcp-server";

export const metadata: Metadata = { title: "MCP server" };

const { OverviewPage } = mcpServerMount;

export default async function McpOverviewRoutePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  return <OverviewPage searchParams={await searchParams} />;
}
