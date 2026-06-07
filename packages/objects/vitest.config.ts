import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: {
      // Workspace package aliases for tests
      // Leaf-subpath alias must be listed BEFORE the barrel alias so vite's
      // alias resolver picks the more-specific match first.
      "@cinatra-ai/objects/classifier-signals": path.join(__dirname, "src/classifier-signals.ts"),
      "@cinatra-ai/objects": path.join(__dirname, "src/index.ts"),
      "@cinatra-ai/objects/renderer-types": path.join(__dirname, "src/renderer-types.ts"),
      // Alias host-app paths used by mcp/handlers.ts to local test stubs so
      // tests that import handlers.ts can be loaded by vitest without pulling
      // in server-only Drizzle/pg modules. Tests still override these with
      // `vi.mock("@/lib/...")` for behaviour assertions.
      "@/lib/objects-dual-write": path.join(__dirname, "src/__tests__/__stubs__/objects-dual-write.ts"),
      "@/lib/database": path.join(__dirname, "src/__tests__/__stubs__/database.ts"),
      // Alias the host-app objects-store + postgres-sync modules to their real
      // source paths so tests for the Postgres-primary CRUD functions can
      // import them. Tests use `vi.mock("@/lib/postgres-sync")` and
      // `vi.mock("@/lib/database")` factories to control behaviour without
      // touching a real PG instance.
      "@/lib/objects-store": path.join(root, "src/lib/objects-store.ts"),
      "@/lib/postgres-sync": path.join(root, "src/lib/postgres-sync.ts"),
      // Archive gate support: the objects_update handler calls
      // assertProjectWritable on a project-move; the upsertObject* writer paths
      // in src/lib/objects-store.ts call assertProjectWritableSync inside the
      // host-app objects-store alias. The real module imports postgres-sync +
      // database; route to a stub that no-ops so the handler / writer tests pass
      // through the gate. Tests that need to exercise the archive-reject path
      // stub locally via vi.mock.
      "@/lib/project-writable": path.join(__dirname, "src/__tests__/__stubs__/project-writable.ts"),
      "@/lib/resource-project-move": path.join(__dirname, "src/__tests__/__stubs__/resource-project-move.ts"),
      // Alias the authz sub-files used by the objects handlers so vitest can
      // resolve them. The barrel (`@/lib/authz`) is also aliased for tests that
      // vi.mock it.
      "@/lib/authz/enforce-resource-access": path.join(root, "src/lib/authz/enforce-resource-access.ts"),
      "@/lib/authz/errors": path.join(root, "src/lib/authz/errors.ts"),
      "@/lib/authz/build-actor-context": path.join(root, "src/lib/authz/build-actor-context.ts"),
      "@/lib/authz/permissions": path.join(root, "src/lib/authz/permissions.ts"),
      "@/lib/authz/resource-ref": path.join(root, "src/lib/authz/resource-ref.ts"),
      // Barrel itself goes to a stub: the real barrel pulls authz/audit.ts
      // which creates a pg Pool at module-load and crashes in unit tests.
      // The stub provides the same surface with allow-by-default `can()`
      // because handler tests assume authz is open, plus a no-op audit logger.
      // Tests that need different kernel behaviour can `vi.mock("@/lib/authz")`
      // locally; the deny-path tests do exactly this.
      "@/lib/authz": path.join(__dirname, "src/__tests__/__stubs__/authz.ts"),
      // Object-history substrate. The real module imports
      // postgres-sync + ensurePostgresSchema, which are not initialised in
      // vitest. The stub provides the same public surface for type-level
      // imports; behaviour tests should vi.mock locally.
      "@/lib/object-history": path.join(__dirname, "src/__tests__/__stubs__/object-history.ts"),
      // Alias @cinatra-ai/mcp-server to a tiny stub so registry-orgid.test.ts
      // can import `mcpRequestContextStorage` without pulling in the real
      // next/navigation + better-auth entry point.
      "@cinatra-ai/mcp-server": path.join(__dirname, "src/__tests__/__stubs__/mcp-server.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
