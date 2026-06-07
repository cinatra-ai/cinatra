import { mcpServerMount } from "@/lib/mcp-server";

const { LlmAccessHandlers } = mcpServerMount;

export async function POST(...args: Parameters<typeof LlmAccessHandlers.POST>) {
  return LlmAccessHandlers.POST(...args);
}

export async function DELETE(...args: Parameters<typeof LlmAccessHandlers.DELETE>) {
  return LlmAccessHandlers.DELETE(...args);
}
