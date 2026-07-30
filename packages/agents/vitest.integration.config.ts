// Dedicated integration-test config.
// The default `vitest.config.ts` excludes `**/*.integration.test.ts` so the
// fast unit-test run stays Postgres-free. This config inverts that: only the
// `*.integration.test.ts` files run, against the schema pointed at by
// `CINATRA_TEST_DB_URL` (set by `pnpm test:integration`).
//
// We import the base config and overwrite `test.include` / `test.exclude`
// directly (vitest's `mergeConfig` concatenates arrays, which would re-add
// the unit-test glob and re-apply the integration exclude — both wrong here).
//
// Handle CINATRA_TEST_DB_URL → SUPABASE_DB_URL forwarding here in Node-land
// instead of in the package.json script. The previous
// shell-based `SUPABASE_DB_URL=$CINATRA_TEST_DB_URL` form broke under URLs
// containing shell metacharacters (`?`, `&` in connection strings) and was
// not portable to non-POSIX shells. Doing the assignment in this config file
// also collapses the existence check + forwarding to a single place.
//
// cinatra#2226 — the forwarding below is NECESSARY BUT NOT SUFFICIENT, and for
// a non-obvious reason: `vitest.config.ts` sets
//   test.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL ?? "<unused placeholder>"
// and ESM HOISTS the `import baseConfig` statement below this comment, so that
// module is fully evaluated BEFORE the `process.env.SUPABASE_DB_URL = …` line
// further down ever runs. So the base config captured the "unused:unused@localhost:5432"
// placeholder, vitest then injected THAT placeholder into every test worker's
// env, and the assignment below was overwritten in the workers it was meant to
// serve. Effect: `pnpm test:integration` with only CINATRA_TEST_DB_URL set ran
// 21/277 tests (22 of 31 files self-skipped on the placeholder URL, and the
// rest hit ECONNREFUSED :5432) — the tier looked "run" while proving nothing.
// The `test.env` override at the bottom of this file is the actual fix; keep
// BOTH (the process.env assignment still serves config-time consumers such as
// vitest.config.ts's own .env.local loader).
import baseConfig from "./vitest.config";
import { defineConfig } from "vitest/config";

if (!process.env.CINATRA_TEST_DB_URL) {
  throw new Error(
    "CINATRA_TEST_DB_URL is required for test:integration (set it in your shell or .env)",
  );
}
process.env.SUPABASE_DB_URL = process.env.CINATRA_TEST_DB_URL;

// Preserve vitest's default excludes (node_modules, dist, .git, etc.) by
// filtering only the integration-test entry from the base
// config's exclude list rather than wiping it entirely with `[]`.
const baseExclude = (baseConfig.test?.exclude ?? []) as string[];
const filteredExclude = baseExclude.filter(
  (entry) => entry !== "**/*.integration.test.ts",
);

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["src/**/*.integration.test.ts"],
    exclude: filteredExclude,
    env: {
      // Spread first, then OVERWRITE SUPABASE_DB_URL — see the import-hoisting
      // note at the top of this file. Without this line the workers receive the
      // base config's placeholder and the whole tier self-skips (cinatra#2226).
      // `CINATRA_TEST_DB_URL` is guaranteed non-empty by the guard above.
      ...(baseConfig.test?.env ?? {}),
      SUPABASE_DB_URL: process.env.CINATRA_TEST_DB_URL,
    },
  },
});
