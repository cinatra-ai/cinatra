import { mcpServerMount } from "@/lib/mcp-server";

const { Layout } = mcpServerMount;

export default function ApiMcpHandshakeLayout(props: Parameters<typeof Layout>[0]) {
  return <Layout {...props} />;
}
