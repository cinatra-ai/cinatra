// Apply the candidate bootstrap DDL — the exact `ensureStoreSchema` boot pass
// (buildCreateStoreSchemaQueries) — to the database named by SUPABASE_DB_URL.
// Step 4a of scripts/ci/upgrade-proof.sh (the previous-release upgrade proof).
//
// WHY a real on-disk module instead of a `node --import tsx -e '<inline>'`
// string: the inline-eval form fails to resolve a NAMED export from the
// tsx-transformed `.ts` source on Node 22 — the importer is a virtual
// `[eval1]` module and tsx cannot surface the named binding to its linker, so
// `import { buildCreateStoreSchemaQueries } from "…drizzle-store.ts"` throws
// `SyntaxError: … does not provide an export named 'buildCreateStoreSchemaQueries'`
// (and the dynamic-namespace variant returns `undefined`). A REAL entry file
// on disk resolves the export cleanly on BOTH Node 22 and Node 24, so the proof
// runs locally on the common LTS, not only on CI's Node 24. See the runner note
// in scripts/ci/upgrade-proof.sh.
//
// Env:
//   SUPABASE_DB_URL  (required) connection string for the upgraded database.
//   SUPABASE_SCHEMA  app schema (default cinatra).
//
// Run from the repo root via tsx (the upgrade-proof script does this):
//   node --import tsx scripts/ci/lib/apply-candidate-bootstrap-ddl.mjs

import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "../../../src/lib/drizzle-store.ts";

const schema = process.env.SUPABASE_SCHEMA || "cinatra";
const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error(
    "apply-candidate-bootstrap-ddl: SUPABASE_DB_URL is required.",
  );
  process.exit(2);
}

const client = new Client({ connectionString });
await client.connect();
const queries = buildCreateStoreSchemaQueries(schema);
let applied = 0;
try {
  for (const q of queries) {
    await client.query(q.text, q.values);
    applied++;
  }
} finally {
  await client.end();
}
console.log(`    bootstrap DDL applied: ${applied}/${queries.length} statements`);
