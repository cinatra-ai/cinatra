/**
 * cinatra#3089 — a reviewed body that a send mails is found by the campaign
 * views.
 *
 * A body the drafting step filed for review carries no campaign correlation,
 * and the send that mails it writes no body of its own. The bind records the
 * run, the campaign and the contact on the body's object row
 * (`recordFanoutMessageCorrelation`), which the campaign view filters on
 * (`getCampaignEmailView`, `data.campaignId`).
 *
 * The pooled db is a stand-in for the objects table: it applies the merge the
 * ledger's UPDATE states (only where the row holds no other value, and only
 * when the row does not already hold all three) and answers its read-back.
 * The campaign view runs unchanged over a session client that lists that table
 * by data equality.
 *
 * Cases:
 *   G1 after the correlation of a reviewed body, the campaign view finds it;
 *      the revision pointer and every other field are unchanged
 *   G2 a second correlation (a second send attempt) writes nothing
 *   G3 a row that already names another campaign is never overwritten: false
 *   G4 the statement merges exactly the three keys, on the row of that type in
 *      the organization, and never on a row that holds another value
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; org_id: string; type: string; data: Record<string, unknown>; writes: number };
const { poolQueryMock, table } = vi.hoisted(() => ({ poolQueryMock: vi.fn(), table: { rows: [] as Row[] } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({
  createSessionObjectsClient: () => ({
    list: async (q: { type: string; dataEquals: Array<{ key: string; value: string }> }) => ({
      items: table.rows
        .filter((r) => r.type === q.type && q.dataEquals.every((f) => r.data[f.key] === f.value))
        .map((r) => ({ id: r.id, type: r.type, data: r.data, createdAt: "2026-11-25T00:00:00Z" })),
    }),
  }),
}));

import { recordFanoutMessageCorrelation } from "../materialization-ledger";
import { getCampaignEmailView } from "../../email-correlation-queries";

const BODY_TYPE = "@cinatra-ai/email:body";
const KEYS = ["runId", "campaignId", "contactId"] as const;

/** The objects table as the ledger's two statements see it. */
function applyQuery(text: string, params: unknown[]) {
  const [id, orgId, type, ...wanted] = params as string[];
  const row = table.rows.find((r) => r.id === id && r.org_id === orgId && r.type === type);
  const holdsAll = (r: Row) => KEYS.every((k, i) => r.data[k] === wanted[i]);
  if (/^\s*UPDATE "public"\."objects"/.test(text)) {
    const free = row && KEYS.every((k, i) => row.data[k] === undefined || row.data[k] === wanted[i]);
    if (row && free && !holdsAll(row)) {
      row.data = { ...row.data, runId: wanted[0], campaignId: wanted[1], contactId: wanted[2] };
      row.writes += 1;
    }
    return { rows: [] };
  }
  if (/^\s*SELECT \(data @>/.test(text)) return { rows: row ? [{ held: holdsAll(row) }] : [] };
  throw new Error(`unexpected query: ${text}`);
}

const input = {
  orgId: "org-a",
  artifactId: "art-1",
  objectTypeId: BODY_TYPE,
  runId: "run-1",
  campaignId: "camp-1",
  contactId: "c1",
};

beforeEach(() => {
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation(async (text: string, params: unknown[]) => applyQuery(text, params));
  // A body as the drafting step files it for review: its title and the
  // pointer to its revision, no campaign correlation.
  table.rows = [
    {
      id: "art-1",
      org_id: "org-a",
      type: BODY_TYPE,
      data: { title: "Subject one", latestRepresentationRevisionId: "rev-1", latestDigest: "d-1", mime: "text/markdown" },
      writes: 0,
    },
  ];
});

const actor = { principalId: "user-1", organizationId: "org-a" } as never;

describe("cinatra#3089 — a reviewed body is found by the campaign views", () => {
  it("G1 after the correlation the campaign view finds the body, its revision unchanged", async () => {
    const before = await getCampaignEmailView({ actor, campaignId: "camp-1" });
    expect(before.bodies.records).toEqual([]);
    // red-first-expect: recordFanoutMessageCorrelation is not a function
    expect(await recordFanoutMessageCorrelation(input)).toBe(true);
    const after = await getCampaignEmailView({ actor, campaignId: "camp-1" });
    expect(after.bodies.records.map((b) => b.id)).toEqual(["art-1"]);
    expect(after.bodies.records[0]!.data).toEqual({
      title: "Subject one",
      latestRepresentationRevisionId: "rev-1",
      latestDigest: "d-1",
      mime: "text/markdown",
      runId: "run-1",
      campaignId: "camp-1",
      contactId: "c1",
    });
  });

  it("G2 a second correlation writes nothing", async () => {
    // red-first-expect: recordFanoutMessageCorrelation is not a function
    expect(await recordFanoutMessageCorrelation(input)).toBe(true);
    const snapshot = structuredClone(table.rows[0]!.data);
    expect(await recordFanoutMessageCorrelation(input)).toBe(true);
    expect(table.rows[0]!.writes).toBe(1);
    expect(table.rows[0]!.data).toEqual(snapshot);
  });

  it("G3 a body that already names another campaign is never overwritten", async () => {
    table.rows[0]!.data.campaignId = "camp-other";
    // red-first-expect: recordFanoutMessageCorrelation is not a function
    expect(await recordFanoutMessageCorrelation(input)).toBe(false);
    expect(table.rows[0]!.writes).toBe(0);
    expect(table.rows[0]!.data.campaignId).toBe("camp-other");
    expect((await getCampaignEmailView({ actor, campaignId: "camp-1" })).bodies.records).toEqual([]);
  });

  it("G4 the statement merges exactly the three keys on the row of that type in the organization", async () => {
    // red-first-expect: recordFanoutMessageCorrelation is not a function
    await recordFanoutMessageCorrelation(input);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SET data = data \|\| jsonb_build_object\('runId', \$4::text, 'campaignId', \$5::text, 'contactId', \$6::text\), updated_at = now\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND org_id = \$2 AND type = \$3/);
    for (const [key, n] of [["runId", 4], ["campaignId", 5], ["contactId", 6]] as const) {
      expect(sql).toContain(`COALESCE(data->>'${key}', $${n}) = $${n}`);
    }
    expect(sql).toContain("AND NOT (data @> jsonb_build_object(");
    expect(sql).not.toMatch(/representation/);
    expect(params).toEqual(["art-1", "org-a", BODY_TYPE, "run-1", "camp-1", "c1"]);
  });
});
