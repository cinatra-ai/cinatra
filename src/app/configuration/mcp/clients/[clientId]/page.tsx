import type { Metadata } from "next";
import { mcpServerMount } from "@/lib/mcp-server";

export const metadata: Metadata = { title: "MCP Client" };

const { ClientPage } = mcpServerMount;

export default function McpClientRoutePage(props: Parameters<typeof ClientPage>[0]) {
  return <ClientPage {...props} />;
}
