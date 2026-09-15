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

/**
 * cinatra#3208 acceptance item 5 — the live chat-mcp project must assert the
 * artifact ROWS a run owed, not only that the run reached a terminal status.
 *
 * The defect this closes was invisible to a status-only assertion in one
 * direction and lethal in the other: run completion re-derived a run's artifact
 * bindings from the package registry instead of the declaration the run
 * executed, so a drifted registry copy failed the run on an output it never
 * declared, and no fixture read back what the run actually filed.
 *
 * The shape asserted here is acceptance item 1's: the run's structured
 * fan-out output carries N members, exactly N artifact rows of the declared
 * type are linked to that run, and each row's title is its member's own first
 * line with the declared marker stripped.
 */
export type ExpectedArtifactRows = {
  /** The declared object type each materialized row must carry. */
  objectType: string;
  /**
   * The run's structured EndNode output whose members the fan-out binding
   * materializes one artifact per. The expected row COUNT is that array's
   * length, read from the run itself — never a hard-coded number, because the
   * model chooses how many members to produce.
   */
  countFromOutput: string;
  /** The fan-out title marker; the stored title must not still carry it. */
  titlePrefix: string;
};

type RunOutputRow = { outputData: Record<string, unknown> | null };

async function fetchRunDeclaredOutputs(runId: string): Promise<RunOutputRow> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT step_results FROM ${SCHEMA}.agent_runs WHERE id = $1 LIMIT 1`,
      [runId],
    );
    const raw = res.rows[0]?.step_results as string | null | undefined;
    if (typeof raw !== "string" || raw.length === 0) return { outputData: null };
    const parsed = JSON.parse(raw) as Array<{ output_data?: Record<string, unknown> }>;
    return { outputData: parsed[0]?.output_data ?? null };
  } finally {
    await client.end();
  }
}

/**
 * Assert the artifact rows a fan-out binding owed for `runId`: one row of the
 * declared type per member of the run's own structured output, each titled from
 * its member's first line behind the marker.
 */
export async function assertExpectedArtifactRows(
  runId: string,
  packageName: string,
  expected: ExpectedArtifactRows,
): Promise<void> {
  const { outputData } = await fetchRunDeclaredOutputs(runId);
  const members = outputData?.[expected.countFromOutput];
  expect(
    Array.isArray(members),
    `${packageName}: run ${runId} surfaced no array output "${expected.countFromOutput}" — ` +
      `the fan-out binding had nothing to materialize per member. output_data keys: ` +
      `${outputData ? Object.keys(outputData).join(", ") || "<none>" : "<absent>"}`,
  ).toBeTruthy();
  const memberCount = (members as unknown[]).length;
  expect(
    memberCount,
    `${packageName}: run ${runId} surfaced an EMPTY "${expected.countFromOutput}" list`,
  ).toBeGreaterThanOrEqual(1);

  const rows = await fetchObjectsByRunId(runId);
  const artifactRows = rows.filter((r) => r.type === expected.objectType);
  expect(
    artifactRows.length,
    `${packageName}: run ${runId} surfaced ${memberCount} member(s) of ` +
      `"${expected.countFromOutput}" but filed ${artifactRows.length} row(s) of ` +
      `"${expected.objectType}". Types persisted: ` +
      `${[...new Set(rows.map((r) => r.type))].join(", ") || "<none>"}`,
  ).toBe(memberCount);

  for (const row of artifactRows) {
    const title = (row.data as { title?: unknown } | null)?.title;
    expect(
      typeof title === "string" && title.trim().length > 0,
      `${packageName}: artifact row ${row.id} carries no title — a fanned-out member ` +
        `titles itself from its own first line, never from a sibling output`,
    ).toBeTruthy();
    expect(
      String(title).startsWith(expected.titlePrefix),
      `${packageName}: artifact row ${row.id} still carries the "${expected.titlePrefix}" ` +
        `marker in its stored title (${String(title)}) — the marker is stripped, not kept`,
    ).toBeFalsy();
  }

  // Codex convergence round, finding 3: a non-empty title with the marker
  // stripped is NOT the contract — every row must be titled from ITS OWN
  // member. Derive the owed title from each member exactly as the materializer
  // does (first line, the declared prefix removed, trimmed) and compare the two
  // multisets, so a row titled from a sibling member or from a run-level output
  // fails even when the count and the shape are right.
  const owedTitles = (members as unknown[])
    .map((member) => {
      if (typeof member !== "string") return null;
      const firstLine = member.split("\n", 1)[0] ?? "";
      if (!firstLine.startsWith(expected.titlePrefix)) return null;
      const derived = firstLine.slice(expected.titlePrefix.length).trim();
      return derived.length > 0 ? derived : null;
    })
    .filter((t): t is string => t !== null)
    .sort();
  const storedTitles = artifactRows
    .map((row) => String((row.data as { title?: unknown } | null)?.title ?? ""))
    .sort();
  expect(
    owedTitles.length,
    `${packageName}: run ${runId} surfaced ${memberCount} member(s) of ` +
      `"${expected.countFromOutput}" but only ${owedTitles.length} of them open with the ` +
      `declared "${expected.titlePrefix}" marker — the run did not produce what the ` +
      `binding declared, so the stored titles cannot be correlated`,
  ).toBe(memberCount);
  expect(
    storedTitles,
    `${packageName}: run ${runId} filed artifact titles that do not come from their own ` +
      `members. Owed (from "${expected.countFromOutput}"): ${JSON.stringify(owedTitles)}; ` +
      `stored: ${JSON.stringify(storedTitles)}`,
  ).toEqual(owedTitles);
}
