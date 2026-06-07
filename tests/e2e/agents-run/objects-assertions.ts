/**
 * Object-persistence assertion helper.
 *
 * The runs API does not surface persisted objects directly. We query
 * `cinatra.objects` via direct pg (same pattern as
 * `tests/e2e/dashboards/seed-data.ts`) for rows where
 * `run_id = $1 AND type = $2` and assert at least one match
 * per declared `ExpectedOutput` on the fixture.
 *
 * Why direct pg, not MCP `objects_list`: the MCP path requires admin-
 * gated MCP-server access from the test runner, which adds tunnel +
 * OAuth complexity. The DB layer already enforces ownership at the
 * row level (run_id is the test user's own run), so a direct read is
 * equivalent for verification purposes.
 */
import { expect } from "@playwright/test";
import { Client } from "pg";

import type { AgentFixture } from "./fixtures";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

type ObjectRow = {
  id: string;
  type: string;
  data: unknown;
};

async function fetchObjectsByRunId(runId: string): Promise<ObjectRow[]> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT id, type, data FROM ${SCHEMA}.objects WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      data: r.data,
    }));
  } finally {
    await client.end();
  }
}

/** Assert each declared expected output is satisfied by a row in
 *  `cinatra.objects` keyed by `run_id`. */
export async function assertExpectedOutputs(
  runId: string,
  fixture: AgentFixture,
): Promise<void> {
  const expected = fixture.expectedOutputs ?? [];
  if (expected.length === 0) return;

  const rows = await fetchObjectsByRunId(runId);

  for (const spec of expected) {
    const candidates = rows.filter((r) => r.type === spec.objectType);
    expect(
      candidates.length,
      `${fixture.packageName}: expected at least one persisted object of type ` +
        `"${spec.objectType}" for run ${runId}; found 0. ` +
        `Other types persisted: ${[...new Set(rows.map((r) => r.type))].join(", ") || "<none>"}`,
    ).toBeGreaterThanOrEqual(1);

    if (spec.matcher) {
      const matched = candidates.find((r) =>
        spec.matcher!({ id: r.id, objectType: r.type, data: r.data }),
      );
      expect(
        matched,
        `${fixture.packageName}: no persisted object of type "${spec.objectType}" ` +
          `matched the fixture's matcher predicate (${candidates.length} candidate(s) examined).`,
      ).toBeTruthy();
    }
  }
}
