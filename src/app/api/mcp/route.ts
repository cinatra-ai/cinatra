import { mcpServerMount } from "@/lib/mcp-server";

const transportHandlers = mcpServerMount.TransportHandlers;

export async function GET(
  ...args: Parameters<typeof transportHandlers.GET>
): ReturnType<typeof transportHandlers.GET> {
  return transportHandlers.GET(...args);
}

export async function POST(
  ...args: Parameters<typeof transportHandlers.POST>
): ReturnType<typeof transportHandlers.POST> {
  return transportHandlers.POST(...args);
}

export async function DELETE(
  ...args: Parameters<typeof transportHandlers.DELETE>
): ReturnType<typeof transportHandlers.DELETE> {
  return transportHandlers.DELETE(...args);
}

export async function OPTIONS(
  ...args: Parameters<typeof transportHandlers.OPTIONS>
): ReturnType<typeof transportHandlers.OPTIONS> {
  return transportHandlers.OPTIONS(...args);
}
