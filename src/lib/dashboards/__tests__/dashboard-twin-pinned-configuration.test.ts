// cinatra#3092 — every dashboard revision carries its configuration.
//
// The plan's "Frozen content" sentence: every dashboard twin upsert "writes an
// immutable configuration record alongside the representation it appends, in
// the same transaction"; and "a non-file revision reader returns exactly the
// pinned configuration". DB-FREE: the REAL `buildDashboardTwinQueries` builds
// the query list, and the REAL `resolveNonFileArtifactRevision` reads the
// written record back; only the synchronous query runner and the admissible
// type-id reader are replaced (the database-backed twin of the reader is the
// CI-tier `lifecycle-c-w3-non-file-reader.integration.test.ts`).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { runPgMock } = vi.hoisted(() => ({ runPgMock: vi.fn() }));

// Keep the imports hermetic (no Postgres) — the same substitutions the twin
// writer's own unit test and the context-resolver unit test make.
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: runPgMock }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  readAdmissibleArtifactTypeIdsForOrg: () => [],
}));

import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import { buildDashboardTwinQueries } from "@/lib/dashboards/dashboard-artifact-twin-writer";
import {
  PINNED_CONFIGURATION_SIGNAL_KEY,
  pinnedConfigurationDigest,
  resolveNonFileArtifactRevision,
} from "@/lib/artifacts/artifact-read";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { DashboardTwinContext } from "@cinatra-ai/dashboards/twin-writer-seam";

type SubstrateQuery = { text: string; values: readonly unknown[] };

/** A dashboard configuration shaped like the apiVersion 1.2 envelope the
 *  dashboards tests already build (one analytics portlet on a grid). */
const CONFIGURATION = {
  apiVersion: "1.2",
  scopeLevel: "team",
  portlets: [
    {
      id: "p1",
      title: "Runs by agent",
      w: 6,
      h: 8,
      x: 0,
      y: 0,
      analysisConfig: {
        query: { measures: ["agent_runs.count"], dimensions: ["agent_runs.agent_name"] },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

const upsertCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-1",
  orgId: "org-1",
  ownerLevel: "team",
  ownerId: "team-9",
  projectId: null,
  actorId: "user-7",
};
const configuredCtx: DashboardTwinContext = { ...upsertCtx, configuration: CONFIGURATION };

const dialect = new PgDialect();

/** The twin's query list with the review-orchestration switch opted OUT, so
 *  the list is the fixed substrate list (the switch reads the env synchronously). */
function buildWithoutLifecycle(ctx: DashboardTwinContext): SubstrateQuery[] {
  const saved = process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
  try {
    return buildDashboardTwinQueries(ctx);
  } finally {
    if (saved === undefined) delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    else process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = saved;
  }
}

function representationQuery(queries: readonly SubstrateQuery[]): SubstrateQuery | undefined {
  return queries.find((q) => /INSERT INTO "[^"]+"\."representation"/.test(q.text));
}

/** Split a SELECT list on its top-level commas (a comma inside `COALESCE(...)`
 *  is not a separator). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The representation INSERT's column list and its SELECT expressions, paired. */
function representationColumns(q: SubstrateQuery): Map<string, string> {
  const cols = q.text
    .slice(q.text.indexOf("(") + 1, q.text.indexOf(")"))
    .split(",")
    .map((c) => c.trim());
  const selectList = q.text.slice(q.text.indexOf("SELECT ") + "SELECT ".length, q.text.indexOf("\nFROM "));
  const exprs = splitTopLevel(selectList);
  expect(exprs).toHaveLength(cols.length);
  return new Map(cols.map((c, i) => [c, exprs[i]]));
}

/** The value the representation writes into one column: the literal NULL, or
 *  the positional parameter the expression names. */
function writtenValue(q: SubstrateQuery, column: string): unknown {
  const expr = representationColumns(q).get(column);
  if (expr === undefined) throw new Error(`representation writes no ${column}`);
  if (/^NULL$/i.test(expr)) return null;
  const m = /^\$(\d+)(?:::\w+)?$/.exec(expr);
  if (!m) throw new Error(`unexpected ${column} expression: ${expr}`);
  return q.values[Number(m[1]) - 1];
}

function asObject(written: unknown): unknown {
  return typeof written === "string" ? JSON.parse(written) : written;
}

beforeEach(() => {
  runPgMock.mockReset();
});

afterEach(() => {
  runPgMock.mockReset();
});

afterAll(() => {
  vi.doUnmock("@/lib/postgres-sync");
  vi.doUnmock("@/lib/postgres-schema-init");
  vi.doUnmock("@/lib/postgres-config");
  vi.doUnmock("@/lib/database");
  vi.doUnmock("@/lib/artifacts/resolve-bound-artifact-type");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("a dashboard twin upsert pins the configuration on the revision it appends (cinatra#3092)", () => {
  it("(a1) the representation carries exactly one key, the reader's, holding the configuration unchanged", () => {
    const queries = buildWithoutLifecycle(configuredCtx);
    const rep = representationQuery(queries);
    expect(rep, "an upsert appends a representation").toBeDefined();
    const record = asObject(writtenValue(rep!, "classifier_signals"));
    expect(record).toEqual({ [PINNED_CONFIGURATION_SIGNAL_KEY]: CONFIGURATION });
    expect(Object.keys(record as object)).toEqual(["pinnedConfiguration"]);
    // A jsonb parameter, never an interpolated literal.
    expect(representationColumns(rep!).get("classifier_signals")).toMatch(/^\$\d+::jsonb$/);
    // The bridge splices it with positional parity (no mis-numbered param).
    const { params } = dialect.sqlToQuery(rawWithParams(rep!.text, rep!.values));
    expect(params).toHaveLength(rep!.values.length);
  });

  it("(a2) a non-file revision reader returns exactly the pinned configuration, from JSON text and from a parsed object", () => {
    const rep = representationQuery(buildWithoutLifecycle(configuredCtx))!;
    const written = writtenValue(rep, "classifier_signals");
    const asText = typeof written === "string" ? written : JSON.stringify(written);
    const representationRevisionId = rep.values[0] as string;
    for (const stored of [asText, JSON.parse(asText) as unknown]) {
      runPgMock.mockReset();
      runPgMock.mockReturnValue([
        {
          rows: [
            {
              form: "dashboard",
              mime: "application/vnd.cinatra.dashboard+json",
              classifier_signals: stored,
            },
          ],
        },
      ]);
      const resolved = resolveNonFileArtifactRevision({
        orgId: upsertCtx.orgId,
        artifactId: upsertCtx.dashboardId,
        representationRevisionId,
      });
      expect(resolved?.configuration).toEqual(CONFIGURATION);
      expect(resolved?.configurationDigest).toBe(pinnedConfigurationDigest(CONFIGURATION));
      // The reader asked for the exact revision the twin appended.
      const call = runPgMock.mock.calls.at(-1)?.[0] as { queries: SubstrateQuery[] };
      expect(call.queries[0].values.slice(0, 3)).toEqual([
        representationRevisionId,
        upsertCtx.dashboardId,
        upsertCtx.orgId,
      ]);
    }
  });

  it("(a3) an upsert with no configuration still writes classifier_signals NULL, and created_by_run_id stays NULL", () => {
    const rep = representationQuery(buildWithoutLifecycle(upsertCtx))!;
    expect(writtenValue(rep, "classifier_signals")).toBeNull();
    expect(writtenValue(rep, "created_by_run_id")).toBeNull();
    const configured = representationQuery(buildWithoutLifecycle(configuredCtx))!;
    expect(writtenValue(configured, "created_by_run_id")).toBeNull();
    expect([...representationColumns(configured).keys()]).toEqual([
      ...representationColumns(rep).keys(),
    ]);
  });

  it("(a3) a delete still appends no representation, with or without a configuration on the context", () => {
    for (const ctx of [
      { ...upsertCtx, operation: "delete" as const },
      { ...configuredCtx, operation: "delete" as const },
    ]) {
      const queries = buildWithoutLifecycle(ctx);
      expect(queries).toHaveLength(3);
      expect(representationQuery(queries)).toBeUndefined();
    }
    const plain = buildWithoutLifecycle({ ...upsertCtx, operation: "delete" });
    const configured = buildWithoutLifecycle({ ...configuredCtx, operation: "delete" });
    expect(configured.map((q) => q.text)).toEqual(plain.map((q) => q.text));
  });

  it("(a3) the objects row, the resource, the audit and the binding operations are unchanged by the record", () => {
    const plain = buildWithoutLifecycle(upsertCtx);
    const configured = buildWithoutLifecycle(configuredCtx);
    expect(configured).toHaveLength(plain.length);
    const repIndex = plain.indexOf(representationQuery(plain)!);
    configured.forEach((q, i) => {
      if (i === repIndex) return;
      expect(q.text).toBe(plain[i].text);
    });
    // The lock, the resource and the audit carry identical values too.
    for (const i of [0, 1, repIndex + 1]) {
      expect(configured[i].values).toEqual(plain[i].values);
    }
  });
});
