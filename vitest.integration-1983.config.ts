import { defineConfig } from "vitest/config";
import * as path from "node:path";
import rootConfig from "./vitest.config";

// cinatra#1983 — DEDICATED config for the REAL-STORE integration test that drives
// the real saveSentEmailObject → real objects_save handler → real
// enforceResourceAccess → real objects-store against a real Postgres (the shared
// verify pg :5634, a lane-unique cloned schema, dropped after).
//
// It reuses the ROOT config's alias set verbatim (the root `@/` catch-all already
// resolves objects-store / postgres-sync / authz / the whole objects graph to
// REAL source) and overrides EXACTLY two entries:
//   1. `@/lib/database` — the root stub returns "postgres://stub"; swap it for the
//      env-driven real-connection shim so the store connects to the lane schema.
//   2. the `@cinatra-ai/llm` BARREL — the root config points it at the
//      actor-context leaf (missing the classifier's three symbols); swap it for a
//      shim that supplies them (never called — the fast-path handles the
//      registered sent-email type).
const rootResolve = (rootConfig as { resolve?: { alias?: unknown; tsconfigPaths?: boolean } })
  .resolve ?? {};
const rootAlias =
  (rootResolve.alias as Array<{ find: string | RegExp; replacement: string }>) ?? [];

// Drop the root `@/lib/database` stub (replaced below). Everything else is kept.
const inheritedAlias = rootAlias.filter(
  (a) => !(typeof a.find === "string" && a.find === "@/lib/database"),
);

export default defineConfig({
  resolve: {
    tsconfigPaths: rootResolve.tsconfigPaths ?? true,
    alias: [
      // First-match-wins: the two overrides precede the inherited root aliases.
      {
        find: "@/lib/database",
        replacement: path.join(__dirname, "tests/__stubs__/database-realconn-1983.ts"),
      },
      {
        // The lane schema is pre-cloned; suppress the from-scratch bootstrap that
        // several objects_save-path modules trigger via a direct import here.
        find: "@/lib/postgres-schema-init",
        replacement: path.join(__dirname, "tests/__stubs__/postgres-schema-init-noop-1983.ts"),
      },
      {
        // Exact-match the bare barrel (a subpath like `@cinatra-ai/llm/actor-context`
        // still falls through to the inherited leaf alias below).
        find: /^@cinatra-ai\/llm$/,
        replacement: path.join(__dirname, "tests/__stubs__/llm-classifier-min-1983.ts"),
      },
      ...inheritedAlias,
    ],
  },
  test: {
    environment: "node",
    // A real cloned schema + real pg round-trips per assertion.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: [
      "src/lib/__tests__/integration/sent-email-object-write-authz.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // SUPABASE_DB_URL / SUPABASE_SCHEMA flow through from the runner's process env
    // (see the inherited defaults) so the real-connection shim targets the lane
    // schema.
    env: {
      ...(rootConfig as { test?: { env?: Record<string, string> } }).test?.env,
    },
  },
});
