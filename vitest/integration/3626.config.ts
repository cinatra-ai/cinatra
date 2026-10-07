import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3626 — DEDICATED config for the git-native agent ingest, against a
// REAL Postgres.
//
// WHY A SEPARATE CONFIG. The claim the awaited `dev-agent-ingest` boot phase
// exists to make is a claim about ROWS: that one pass over the extension source
// tree leaves the agent definitions on file before the boot marks itself ready,
// and that a second pass writes nothing more. The root config stubs
// `@/lib/database` — necessarily, for a unit tier — and a stub would agree with
// whatever this code said about both. So this tier runs the real per-definition
// loader against a scratch database. Mirrors the #3135 tier's shape.
//
// THE RECIPE the suite's header states, because a bare `createdb` is not enough:
//
//   createdb <scratch>
//   SUPABASE_DB_URL='<dsn>' node scripts/apply-public-schema.mjs
//   SUPABASE_DB_URL='<dsn>' pnpm test:agent-ingest
//
// NO SUPABASE_SCHEMA PIN, and that is the one place this tier departs from
// #3135. That tier writes metadata rows and reads them straight back, so a
// throwaway schema costs it nothing. This one writes through the application's
// own agent-template store and then reads `agent_templates` by name, and an
// already-migrated development database is a database whose rows live in the
// default schema — a pin here would point the suite at a second, empty schema
// beside them. The scratch DATABASE is the isolation, as the recipe above says.
//
// The suite self-skips without a DSN so any other config that picks the file up
// keeps the ordinary skip.
const root = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      // The loader's graph transitively reaches `@/lib/mcp-instructions`, whose
      // top-level IIFE crashes module load under vitest (the same interop quirk
      // the #3031 and #3135 tiers stub around). Nothing here reads the string.
      {
        find: "@/lib/mcp-instructions",
        replacement: path.join(root, "tests/__stubs__/mcp-instructions.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 900_000,
    hookTimeout: 300_000,
    // Serial: the suite owns ONE scratch database.
    fileParallelism: false,
    include: ["src/lib/__tests__/git-native-agent-ingest.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    env: {
      // The phase under test is development-only, and so is the ingest it runs.
      CINATRA_RUNTIME_MODE: "development",
      // Fixed placeholders. Not credentials, and never to be treated as any —
      // they exist so the at-rest codec and the auth store have a key to run
      // under while the suite reads agent-template rows.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3626-placeholder-not-a-credential",
      // A FIXED 32-byte placeholder, base64.
      CINATRA_ENCRYPTION_KEY:
        process.env.CINATRA_ENCRYPTION_KEY ??
        "eDM2MjYtcGxhY2Vob2xkZXItbm90LWEtY3JlZC0zMmI=",
    },
  },
});
