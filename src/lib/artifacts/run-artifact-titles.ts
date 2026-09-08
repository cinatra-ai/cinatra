import "server-only";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// The agent name an artifact's title carries. One small read, shared by the
// default road (cinatra#3029) and the retiring unbound-output derivation.

function pool(): Pool {
  return getPooledDb({
    name: "run-artifact-titles",
    connectionString: () => getPostgresConnectionString(),
  });
}

export async function readAgentTemplateName(
  templateId: string,
): Promise<string | null> {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const res = await pool().query(
    `SELECT name FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as { name?: string | null } | undefined;
  return typeof row?.name === "string" && row.name.length > 0 ? row.name : null;
}
