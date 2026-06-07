import { mcpServerMount } from "@/lib/mcp-server";

const { Layout } = mcpServerMount;

export default function McpLayoutRoute(props: Parameters<typeof Layout>[0]) {
  return <Layout {...props} />;
}
