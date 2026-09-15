import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3031 (epic #3023 W7) — DEDICATED config for the declared-tables,
// extension-data and dependency-scoped artifact-read proofs against a REAL
// Postgres.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. Every claim W7 makes
// is a claim about what the DATABASE does: that a declared table exists under
// the extension's prefix, that a migration touching another table is refused —
// by the server, with `permission denied`, not by a check in our own code —
// that the extension-data tool can reach the caller's own rows and nothing
// else, and that a listing pages with a cursor without dropping or repeating a
// row. A stubbed store would agree with whatever this code said about all four.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly the W7 files. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:extension-tables
// The suites self-skip without one, so any OTHER config that picks them up
// keeps the ordinary skip; in THIS lane a missing DSN is a hard throw. Mirrors
// the #2935 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      // The artifact service transitively imports `@/lib/mcp-instructions`,
      // whose top-level IIFE crashes module load under vitest (the
      // `@cinatra-ai/skills` barrel's named export resolves undefined — the
      // same interop quirk `packages/agents/vitest.config.ts` mocks around).
      // Nothing in this tier reads the instructions string.
      {
        find: "@/lib/mcp-instructions",
        replacement: path.join(root, "tests/__stubs__/mcp-instructions.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Serial: the suites own ONE shared schema and one database role.
    fileParallelism: false,
    include: [
      "src/lib/__tests__/extension-declared-tables.integration.test.ts",
      "src/lib/__tests__/extension-data-tool.integration.test.ts",
      "src/lib/artifacts/__tests__/extension-artifact-reads.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suites SELF-SKIP without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_EXTENSION_TABLES_REALDB: "1",
      SUPABASE_SCHEMA: "cinatra_x3031",
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as
      // one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3031-placeholder-not-a-credential",
    },
  },
});
