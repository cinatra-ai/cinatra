import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");
const mcpServerStub = path.join(__dirname, "tests/__stubs__/mcp-server.ts");
const betterAuthDbStub = path.join(__dirname, "tests/__stubs__/better-auth-db.ts");
const runtimeCubeServeHostStub = path.join(__dirname, "tests/__stubs__/runtime-cube-serve-host.ts");
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
      // cinatra#660 — stub the host serve-gate bridge before the generic `@/`
      // pattern; the real module chains through the read-model → canonical
      // store → Postgres which throws under a missing SUPABASE_DB_URL. Bundled
      // cubes always pass the gate, which is what the MCP-path tests exercise;
      // cross-org runtime denial is covered host-side with a mocked read-model.
      { find: "@/lib/dashboards/runtime-cube-serve-host", replacement: runtimeCubeServeHostStub },
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
      // cinatra#660 — the host serve-gate bridge (imported by mcp-cubes/handlers
      // via @/lib/dashboards/runtime-cube-serve-host) resolves these subpaths.
      {
        find: "@cinatra-ai/dashboards/runtime-cube-registry",
        replacement: path.join(root, "packages/dashboards/src/cubes/runtime-cube-registry.ts"),
      },
      {
        find: "@cinatra-ai/dashboards/runtime-cube-serve-gate",
        replacement: path.join(root, "packages/dashboards/src/cubes/runtime-cube-serve-gate.ts"),
      },
      {
        find: /^@cinatra-ai\/sdk-dashboard$/,
        replacement: path.join(root, "packages/sdk-dashboard/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // `.tsx` covers the React component tests (per-file `@vitest-environment
    // jsdom` pragmas opt those into the DOM environment).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // DB-backed integration tests (cinatra#326) are gated on DASH_DB_IT + a real
    // SUPABASE_DB_URL and run explicitly; keep them out of the default unit run
    // (which has no Postgres) so the green unit gate never imports them.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
