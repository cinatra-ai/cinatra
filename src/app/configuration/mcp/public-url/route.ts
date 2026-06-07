import { mcpServerMount } from "@/lib/mcp-server";

const publicBaseUrlHandlers = mcpServerMount.PublicBaseUrlHandlers;

export async function POST(
  ...args: Parameters<typeof publicBaseUrlHandlers.POST>
): ReturnType<typeof publicBaseUrlHandlers.POST> {
  return publicBaseUrlHandlers.POST(...args);
}
