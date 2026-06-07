// Stub for `@/lib/mcp-instructions`.
//
// The real module runs an IIFE at top-level that calls
// `readLocalPackageSkillContent` from `@cinatra-ai/skills`. Under vitest's
// fork-pool resolution that import resolves but the named export shows
// up undefined (likely an ESM/CJS interop quirk in the workspace barrel
// chain). Tests don't need the real instructions string — they only
// need the named exports to be present.

export const CINATRA_MCP_INSTRUCTIONS: string = "";
export const CINATRA_MCP_EXPERIMENTAL: Record<string, unknown> = {};
