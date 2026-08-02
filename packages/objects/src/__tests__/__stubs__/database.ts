// Test stub for @/lib/database. The real production module imports node:fs,
// postgres-sync, drizzle-store, and is server-only, so the package vitest
// config aliases the specifier here.
//
// It deliberately exports NOTHING. `mcp/handlers.ts` used to import
// `readObjectsClassificationModelFromDatabase` from `@/lib/database` to forward
// a per-purpose model override into `classifyObject`; that override was retired
// (cinatra#2335) and the import went with it, so no handler path DEREFERENCES a
// `@/lib/database` export any more.
//
// The alias itself stays, and the specifier is still IMPORTED transitively — the
// graphiti projector/rebuild/projection-policy modules (reachable from
// handlers.ts) import `getPostgresConnectionString` / `postgresSchema` from it.
// Every test that actually exercises one of those DB-backed paths supplies its
// own `vi.mock("@/lib/database", …)` with the exports it needs, exactly as it
// already had to: this stub never provided them.
export {};
