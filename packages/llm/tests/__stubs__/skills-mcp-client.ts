// Test stub: vitest alias for @cinatra-ai/skills/mcp-client.
// Individual tests vi.mock("@cinatra-ai/skills/mcp-client", ...) with their
// own factory; this stub only needs to be loadable. The real client lives at
// packages/skills/src/mcp/client/deterministic-client.ts and pulls in the
// entire agents+objects module graph — too heavy for unit tests.
export function createDeterministicSkillsClient(_input?: unknown): {
  installed: { get: (id: string) => Promise<unknown> };
} {
  return {
    installed: {
      get: async () => null,
    },
  };
}
