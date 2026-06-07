import { mcpServerMount } from "@/lib/mcp-server";

const connectivityCheckHandlers = mcpServerMount.ConnectivityCheckHandlers;

export async function POST(
  ...args: Parameters<typeof connectivityCheckHandlers.POST>
): ReturnType<typeof connectivityCheckHandlers.POST> {
  return connectivityCheckHandlers.POST(...args);
}
