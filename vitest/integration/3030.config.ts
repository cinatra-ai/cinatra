import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3030 (epic #3023 W6) — DEDICATED config for THE RUN FOLDER, THE FILE
// PICKUP, THE FAN-OUT and THE MID-RUN REVISION against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit tier proves
// the folder's own rules (confinement, the symlink refusal, the two caps, the
// retention tier's clock) and the grammar's rules, against pure inputs. What it
// cannot prove is that Postgres agrees about what those rules PRODUCE: that a
// file an agent wrote really becomes an artifact of the right base with one
// ledger row under its reserved id, that a bound file really lands under its
// declared extension, that a list output really fans out to one artifact per
// member over one content-addressed blob, and that a second append against a
// base another save already built on really fails on the unique index. A stubbed
// store would agree with whatever the code said about all four.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly the two files of this slice. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:run-folder
// The suites self-skip without one, so any OTHER config that picks them up keeps
// the ordinary skip. Mirrors the #3029 tier's shape.
//
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below climbs back out of it.
const root = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      {
        // The SAME anchored alias the root config carries, for the same
        // pre-existing reason: the bare `@cinatra-ai/skills` barrel pulls
        // `@cinatra-ai/llm` and the app-layer database module, which are not
        // resolvable in a vitest sandbox. Anchored to the bare specifier so real
        // subpaths fall through to tsconfigPaths.
        find: /^@cinatra-ai\/skills$/,
        replacement: path.join(root, "tests/__stubs__/cinatra-skills.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Serial AND in a process of its own per file. Each suite owns ONE schema
    // and one temporary data root, and it names them by setting `process.env`
    // in its first hook — which a thread-pooled sibling would SHARE, so the two
    // suites would race for one `SUPABASE_SCHEMA` and each would read a store
    // the other had just re-pointed. A fork per file makes each suite's
    // environment its own, which is what "owns" has to mean here.
    pool: "forks",
    fileParallelism: false,
    include: [
      "src/lib/artifacts/__tests__/run-folder-pickup.integration.test.ts",
      "src/lib/artifacts/__tests__/fan-out-and-revision.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // Each suite sets its OWN schema in its first hook; this is the default a
      // module read before that hook would otherwise see.
      SUPABASE_SCHEMA: "cinatra_test_run_folder_3030",
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as
      // one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3030-placeholder-not-a-credential",
    },
  },
});
