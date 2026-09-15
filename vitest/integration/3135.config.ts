import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3135 — DEDICATED config for the development instance-provisioning
// command, against a REAL Postgres.
//
// WHY A SEPARATE CONFIG. Every claim the command makes is a claim about rows:
// that a wrapper writes the SAME row the screen's own writer writes (sealed
// field and all), that a second run writes nothing more, that a refusal happens
// before a write, and that the setup step's own derivation reads ready
// afterwards. The root config stubs `@/lib/database` — necessarily, for a unit
// tier — and a stub would agree with whatever this code said about all four. So
// this tier runs the real writers, the real sealing codec, the real claim/commit
// machine and the real readiness saga, against a scratch database:
//
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:dev-instance-provisioning
//
// The suite self-skips without a DSN so any other config that picks the file up
// keeps the ordinary skip; in THIS lane a missing DSN is a hard throw. Mirrors
// the #3031 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      // The setup writer graph transitively reaches `@/lib/mcp-instructions`,
      // whose top-level IIFE crashes module load under vitest (the same interop
      // quirk the #3031 tier stubs around). Nothing here reads the string.
      {
        find: "@/lib/mcp-instructions",
        replacement: path.join(root, "tests/__stubs__/mcp-instructions.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Serial: the suites own ONE shared schema.
    fileParallelism: false,
    include: [
      "src/lib/dev-instance-provisioning/__tests__/dev-instance-provisioning.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // A skipped proof proves nothing; this flag turns a missing DSN into a
      // hard, self-describing throw in the lane that exists to run it.
      CINATRA_DEV_PROVISIONING_REALDB: "1",
      SUPABASE_SCHEMA: "cinatra_x3135",
      // Fixed placeholders. Not credentials, and never to be treated as any.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3135-placeholder-not-a-credential",
      // A FIXED 32-byte placeholder, base64. Not a credential, and never to be
      // treated as one — it exists so the at-rest codec has a key to run under.
      CINATRA_ENCRYPTION_KEY:
        process.env.CINATRA_ENCRYPTION_KEY ??
        "eDMxMzUtcGxhY2Vob2xkZXItbm90LWEtY3JlZC0zMmI=",
    },
  },
});
