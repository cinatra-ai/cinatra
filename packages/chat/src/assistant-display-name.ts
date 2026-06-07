// Display-name resolver for chat assistant rows. Maps ONLY the canonical
// Cinatra handle ("cinatra") to its branded casing ("Cinatra"); every other
// assistant handle (user-authored agents, Claude/OpenAI/Gemini, third-party
// assistants) renders verbatim. Null/undefined falls back to "Assistant"
// (matching the prior inline `handle ?? "Assistant"`).
//
// This changes ONLY the displayed string — handle values, participant ids,
// @cinatra mentions, MCP labels, package names, and route slugs are never
// touched by this helper.

export function resolveAssistantDisplayName(
  handle: string | null | undefined,
): string {
  if (!handle) return "Assistant";
  if (handle === "cinatra") return "Cinatra";
  return handle;
}
