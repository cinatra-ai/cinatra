import base from "./vitest.config";

// Integration-run config (cinatra#1894 B1b): reuses the base config's workspace
// aliases + the suite-wide twin-writer setup file, but flips include/exclude so
// the DASH_DB_IT / TWIN_DB_IT `*.integration.test.ts` suites (kept OUT of the
// default green unit run) can be run explicitly against a live Postgres.
//
//   SUPABASE_DB_URL=… SUPABASE_SCHEMA=twin_it_1894 TWIN_DB_IT=1 \
//     npx vitest run --no-coverage --config vitest.integration.config.ts \
//       src/__tests__/twin-writer-substrate.integration.test.ts
const baseTest = (base as { test?: Record<string, unknown> }).test ?? {};

export default {
  ...base,
  test: {
    ...baseTest,
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
  },
};
