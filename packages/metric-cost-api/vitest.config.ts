import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");
// cinatra#2582: the breakdown's pure row formatters are exported from the table
// COMPONENT (they cannot live in the server-only store, and a new leaf module
// would grow every locked dev-perf route's reachable graph). Importing them
// therefore pulls the host UI barrel, which this sandbox cannot resolve — map it
// to a render-free stand-in so the formatters stay directly testable.
const uiTableStub = path.join(__dirname, "tests/__stubs__/ui-table.tsx");
// cinatra#2669: the budget alert is RENDERED in its honesty test — what an
// operator reads off a partial total is the claim under test, and no source
// assertion can check a sentence. Rendering pulls the host card wrappers.
const uiCardStub = path.join(__dirname, "tests/__stubs__/ui-card.tsx");

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
      "@/components/ui/table": uiTableStub,
      "@/components/ui/paginated-table": uiTableStub,
      "@/components/ui/card": uiCardStub,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      SUPABASE_DB_URL: "postgres://unused:unused@localhost:5432/unused",
    },
  },
});
