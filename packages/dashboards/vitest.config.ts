import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");
const mcpServerStub = path.join(__dirname, "tests/__stubs__/mcp-server.ts");
const betterAuthDbStub = path.join(__dirname, "tests/__stubs__/better-auth-db.ts");
const root = path.resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      { find: /^@cinatra\/mcp-server$/, replacement: mcpServerStub },
      // Stub `@/lib/better-auth-db` before the generic `@/` pattern below;
      // otherwise the real module eagerly opens a Postgres pool and chains
      // through projects-store.ts which throws under missing SUPABASE_DB_URL.
      // The stub returns an empty membership list, which is sufficient for
      // MCP-side cube registration tests.
      { find: "@/lib/better-auth-db", replacement: betterAuthDbStub },
      { find: /^@\/(.+)$/, replacement: path.join(root, "src") + "/$1" },
      // Vitest can't resolve workspace package subpath imports without explicit
      // aliases, so mirror the tsconfig paths used by the host app for the
      // dashboards-cube wiring.
      {
        find: "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube",
        replacement: path.join(root, "packages/sdk-dashboard/src/adapters/drizzle-cube/index.ts"),
      },
      {
        find: /^@cinatra\/sdk-dashboard$/,
        replacement: path.join(root, "packages/sdk-dashboard/src/index.ts"),
      },
      {
        find: "@cinatra-ai/agents/schema",
        replacement: path.join(root, "packages/agents/src/schema.ts"),
      },
      // The MCP cube singleton resolves the platform via
      // @cinatra-ai/dashboards/cubes-platform.
      {
        find: "@cinatra-ai/dashboards/cubes-platform",
        replacement: path.join(root, "packages/dashboards/src/cubes/platform-singleton.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
