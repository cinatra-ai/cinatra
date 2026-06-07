import { mcpServerMount } from "@/lib/mcp-server";

const selfClientHandlers = mcpServerMount.SelfClientHandlers;

export async function POST(
  ...args: Parameters<typeof selfClientHandlers.POST>
): ReturnType<typeof selfClientHandlers.POST> {
  return selfClientHandlers.POST(...args);
}
