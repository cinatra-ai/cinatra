// Contract test for the per-connection grant seed migration
// (migrations/core/core__0015_connection-grant-seed.mjs, cinatra#952 W2).
// Scripted pgm.db mock (no DB), mirroring the core__0014 test: pins the
// behavior-preserving Phase A rules (app-scope + non-null org ONLY; ON
// CONFLICT DO NOTHING never resets an existing policy), the null-org
// narrowing, the external-MCP identity seed's fail-closed owner ladder, and
// down()'s report-scoped delete.

import { describe, it, expect, vi } from "vitest";

import {
  up,
  down,
  BLOB_METADATA_KEY,
  REPORT_METADATA_KEY,
  EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
} from "../../../migrations/core/core__0015_connection-grant-seed.mjs";

type Row = Record<string, unknown>;

function mockPgm(opts: {
  blob?: unknown;
  identityRows?: Row[];
  mcpRows?: Row[];
  users?: string[];
  orgs?: string[];
  members?: Array<{ user_id: string; org: string }>;
  policyConflicts?: Set<string>;
  reportValue?: string;
}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const policyInserts: Array<{ resourceId: string; policy: string; installedBy: unknown }> = [];
  const identityInserts: Array<unknown[]> = [];
  const deletes: Array<{ sql: string; values?: unknown[] }> = [];
  let reportWritten: string | null = null;

  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(norm) || norm.startsWith("LOCK TABLE")) {
      return { rows: [] as Row[] };
    }
    if (norm.startsWith("SELECT value FROM metadata WHERE key = $1")) {
      const key = values?.[0];
      if (key === BLOB_METADATA_KEY) {
        return opts.blob === undefined
          ? { rows: [] }
          : { rows: [{ value: JSON.stringify(opts.blob) }] };
      }
      if (key === REPORT_METADATA_KEY) {
        return opts.reportValue === undefined ? { rows: [] } : { rows: [{ value: opts.reportValue }] };
      }
      return { rows: [] };
    }
    if (norm.startsWith('SELECT id FROM public."organization"')) {
      return { rows: (opts.orgs ?? []).map((id) => ({ id })) };
    }
    if (norm.startsWith('SELECT id FROM public."user" WHERE id = $1')) {
      return { rows: (opts.users ?? []).includes(values?.[0] as string) ? [{ id: values?.[0] }] : [] };
    }
    if (norm.includes("FROM public.member")) {
      const org = values?.[0];
      const m = (opts.members ?? []).find((x) => x.org === org);
      return { rows: m ? [{ user_id: m.user_id }] : [] };
    }
    if (norm.startsWith("SELECT id, connector_key, connection_id, owner_user_id, organization_id FROM nango_connection")) {
      return { rows: opts.identityRows ?? [] };
    }
    if (norm.includes("FROM external_mcp_servers")) {
      return { rows: opts.mcpRows ?? [] };
    }
    if (norm.startsWith("INSERT INTO extension_access_policy")) {
      const resourceId = values?.[0] as string;
      if (opts.policyConflicts?.has(resourceId)) return { rows: [] };
      policyInserts.push({
        resourceId,
        policy: values?.[1] as string,
        installedBy: values?.[2],
      });
      return { rows: [{ resource_id: resourceId }] };
    }
    if (norm.startsWith("INSERT INTO nango_connection")) {
      identityInserts.push(values ?? []);
      return { rows: [{ id: `ext-${identityInserts.length}` }] };
    }
    if (norm.startsWith("SELECT id FROM nango_connection")) {
      return { rows: [{ id: "existing-ext" }] };
    }
    if (norm.startsWith("INSERT INTO metadata")) {
      reportWritten = values?.[1] as string;
      return { rows: [] };
    }
    if (norm.startsWith("DELETE FROM")) {
      deletes.push({ sql: norm, values });
      return { rows: [] };
    }
    throw new Error(`unscripted SQL: ${norm}`);
  });

  return {
    pgm: { noTransaction: vi.fn(), db: { query } },
    calls,
    policyInserts,
    identityInserts,
    deletes,
    report: () => (reportWritten ? JSON.parse(reportWritten) : null),
  };
}

describe("core__0015 up()", () => {
  it("seeds workspace policy for app-scope non-null-org rows ONLY (null-org + user-scope get nothing)", async () => {
    const m = mockPgm({
      blob: {
        connections: {
          github: [
            { connectionId: "app-1", scope: "app" },
            { connectionId: "user-1", scope: "user" },
            { connectionId: "app-nullorg" },
          ],
        },
      },
      identityRows: [
        { id: "id-app", connector_key: "github", connection_id: "app-1", owner_user_id: "u1", organization_id: "org-1" },
        { id: "id-user", connector_key: "github", connection_id: "user-1", owner_user_id: "u2", organization_id: "org-1" },
        { id: "id-null", connector_key: "github", connection_id: "app-nullorg", owner_user_id: "u1", organization_id: null },
      ],
      orgs: ["org-1"],
    });
    await up(m.pgm as never);
    expect(m.policyInserts.map((p) => p.resourceId)).toEqual(["id-app"]);
    const policy = JSON.parse(m.policyInserts[0].policy);
    expect(policy.runDataVisibility).toBe("workspace");
    const report = m.report();
    expect(report.counts.policiesSeeded).toBe(1);
  });

  it("never resets an existing policy row (ON CONFLICT skip is reported, not overwritten)", async () => {
    const m = mockPgm({
      blob: { connections: { github: [{ connectionId: "app-1", scope: "app" }] } },
      identityRows: [
        { id: "id-app", connector_key: "github", connection_id: "app-1", owner_user_id: "u1", organization_id: "org-1" },
      ],
      policyConflicts: new Set(["id-app"]),
      orgs: ["org-1"],
    });
    await up(m.pgm as never);
    expect(m.policyInserts).toEqual([]);
    expect(m.report().counts.skipped).toBe(1);
  });

  it("seeds external-MCP identity rows with the sentinel package + fail-closed owner ladder", async () => {
    const m = mockPgm({
      mcpRows: [
        { id: "srv-1", label: "Twenty", nango_connection_id: "twenty-abc", scope: "workspace", org_id: null, user_id: null },
      ],
      orgs: ["org-1"],
      members: [{ user_id: "admin-1", org: "org-1" }],
    });
    await up(m.pgm as never);
    expect(m.identityInserts).toHaveLength(1);
    const [org, pkg, connectionId, owner] = m.identityInserts[0];
    expect(pkg).toBe(EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL);
    expect(org).toBe("org-1"); // sole-org fallback
    expect(connectionId).toBe("twenty-abc");
    expect(owner).toBe("admin-1"); // earliest sole-org admin
    // Instance-global row with a resolved org → workspace grant seed.
    expect(m.policyInserts.map((p) => p.resourceId)).toEqual(["ext-1"]);
  });

  it("ABORTS (fail-closed) when no owner can be resolved for an external-MCP row", async () => {
    const m = mockPgm({
      mcpRows: [
        { id: "srv-1", label: "Twenty", nango_connection_id: "t", scope: "workspace", org_id: null, user_id: null },
      ],
      orgs: ["org-1", "org-2"], // multi-org → no sole-org fallback
    });
    await expect(up(m.pgm as never)).rejects.toThrow(/cannot resolve a NON-NULL owner/);
    const norms = m.calls.map((c) => c.sql.replace(/\s+/g, " ").trim());
    expect(norms[norms.length - 1]).toBe("ROLLBACK");
  });
});

describe("core__0015 down()", () => {
  it("deletes exactly the report-named rows + the report key", async () => {
    const m = mockPgm({
      reportValue: JSON.stringify({
        policyRows: [{ resourceId: "id-app" }],
        externalMcpIdentities: [{ id: "ext-1" }],
      }),
    });
    await down(m.pgm as never);
    expect(m.deletes.map((d) => d.sql.split(" ")[2])).toEqual([
      "extension_access_policy",
      "nango_connection",
      "metadata",
    ]);
  });
});
