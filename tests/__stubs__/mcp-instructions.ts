// Stub for `@/lib/mcp-instructions` (cinatra#3031, epic #3023 W7 tier).
//
// The real module runs an IIFE at module load that calls
// `readLocalPackageSkillContent` from the `@cinatra-ai/skills` barrel; under
// vitest's resolution that named export comes back undefined (the ESM/CJS
// interop quirk in the workspace barrel chain that
// `packages/agents/vitest.config.ts` already carries a mock for), and the IIFE
// crashes module load for anything that transitively imports it — which the
// artifact service does.
//
// Nothing in the W7 tier reads the instructions string; it only needs the named
// exports to exist. Same shape and same reasoning as the agents package's own
// mock, placed at the root so a ROOT tier config can use it without reaching
// into another package's test tree.

export const CINATRA_MCP_INSTRUCTIONS: string = "";
export const CINATRA_MCP_EXPERIMENTAL: Record<string, unknown> = {};
