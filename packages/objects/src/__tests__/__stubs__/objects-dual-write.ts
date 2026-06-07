// Test stub for @/lib/objects-dual-write (used by mcp-primitives.test.ts).
// Real production module imports a chain of server-only Drizzle/pg modules
// that are unsafe to load in a node test runner. Tests that need to spy on
// shadowUpsertObject use `vi.mock("@/lib/objects-dual-write", ...)` directly.
export function shadowUpsertObject(_input: unknown): void {
  // no-op
}
