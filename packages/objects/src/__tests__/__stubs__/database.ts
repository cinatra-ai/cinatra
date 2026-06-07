// Test stub for @/lib/database (used by mcp-primitives.test.ts).
// Real production module imports node:fs, postgres-sync, drizzle-store, and
// is server-only. Only `readObjectsClassificationModelFromDatabase` is needed
// by handlers.ts; tests that need a different return value override it with
// `vi.mock("@/lib/database", ...)`.
export function readObjectsClassificationModelFromDatabase(): string {
  return "openai:gpt-4o-mini";
}
