// Postgres connection configuration — SYNC LEAF module.
//
// ## Why this module exists (cinatra#104)
//
// Under Turbopack dev, `src/lib/database.ts` is an ASYNC MODULE: its static
// import graph reaches externals that Turbopack loads via dynamic `import()`
// (`pg` through drizzle-store -> drizzle-orm/node-postgres, and
// `@modelcontextprotocol/sdk` through objects-dual-write -> objects-store ->
// @/lib/mcp-server). Async-ness propagates to every static importer, and
// Turbopack's `asyncModule()` runtime permanently replaces such a module's
// `module.exports` with a getter that returns the module's Promise. Any
// CommonJS `require()` of an async module therefore receives a pending
// Promise — every named export reads as `undefined`.
//
// `artifact-refs-store.ts` (and friends) must stay synchronous (their query
// helpers compose into `runPostgresQueriesSync` transactions), so they cannot
// `await import()` and they MUST NOT `require()` database.ts. They import the
// connection primitives from here instead.
//
// ## Sync-leaf contract
//
// This module may import Node builtins ONLY. Anything else risks dragging an
// async external into the graph and re-creating the bug class. The contract
// is enforced by src/lib/__tests__/postgres-sync-leaf-imports.test.ts.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envLocalPath = path.join(process.cwd(), ".env.local");

export const postgresSchema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

function parseEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return {} as Record<string, string>;
  }

  const raw = readFileSync(filePath, "utf8");
  const result: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getSupabaseDbUrl() {
  return process.env.SUPABASE_DB_URL?.trim() || parseEnvFile(envLocalPath).SUPABASE_DB_URL?.trim() || "";
}

export function getPostgresConnectionString() {
  const connectionString = getSupabaseDbUrl();
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required. Configure Supabase in .env.local.");
  }
  return connectionString;
}
