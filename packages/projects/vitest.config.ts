import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

// Vitest config for @cinatra-ai/projects.
//
// Mirrors packages/objects/vitest.config.ts: alias host-app `@/lib/*`
// paths used by handlers.ts to stub modules + real source paths so the
// node test runner can resolve them without spinning up server-only
// Drizzle/pg modules at import time. Tests that need behaviour control
// override these with `vi.mock("@/lib/...")` factories.
export default defineConfig({
  resolve: {
    alias: {
      // Workspace package aliases for tests.
      "@cinatra-ai/projects": path.join(__dirname, "src/index.ts"),
      // Authz sub-files used by the projects handlers — resolve to the
      // real sources so type/shape compatibility is preserved. The barrel
      // (`@/lib/authz`) goes to a tiny stub so we don't pull `audit.ts`
      // (which creates a pg Pool at module-load).
      "@/lib/authz/enforce-resource-access": path.join(root, "src/lib/authz/enforce-resource-access.ts"),
      "@/lib/authz/errors": path.join(root, "src/lib/authz/errors.ts"),
      "@/lib/authz/build-actor-context": path.join(root, "src/lib/authz/build-actor-context.ts"),
      "@/lib/authz/permissions": path.join(root, "src/lib/authz/permissions.ts"),
      "@/lib/authz/resource-ref": path.join(root, "src/lib/authz/resource-ref.ts"),
      "@/lib/authz/actor-context": path.join(root, "src/lib/authz/actor-context.ts"),
      "@/lib/authz": path.join(__dirname, "src/__tests__/__stubs__/authz.ts"),
      // Host-app paths used by handlers.ts — projects-store / DAO /
      // co-owners. Tests mock these with `vi.mock(...)` so the real
      // pg.Pool init in projects-store never fires.
      "@/lib/projects-store": path.join(__dirname, "src/__tests__/__stubs__/projects-store.ts"),
      "@/lib/projects-store-dao": path.join(__dirname, "src/__tests__/__stubs__/projects-store-dao.ts"),
      "@/lib/project-co-owners-store": path.join(__dirname, "src/__tests__/__stubs__/project-co-owners-store.ts"),
      // Write-block helper consumed by the bindings handlers. The real
      // module imports postgres-sync + database modules with pg.Pool init at
      // module-load; route it to a stub that resolves to a no-op. The binding
      // tests don't exercise the archive gate's I/O; they assert the SQL
      // emission shape.
      "@/lib/project-writable": path.join(__dirname, "src/__tests__/__stubs__/project-writable.ts"),
      // mcp-server stub — only need `mcpRequestContextStorage`, mirror
      // objects/__stubs__/mcp-server.ts.
      "@cinatra-ai/mcp-server": path.join(__dirname, "src/__tests__/__stubs__/mcp-server.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
