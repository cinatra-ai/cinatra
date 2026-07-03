// Contract test for the nango_connection identity backfill migration
// (migrations/core/core__0014_nango-connection-identity-backfill.mjs,
// cinatra#951 W1). Pure unit test over a scripted pgm.db mock (no DB): pins
// the fail-closed owner-resolution ladder, the exactly-one-row contract, the
// same-transaction review report, the unknown-key abort, and down()'s
// report-scoped delete. Real-Postgres execution of the chain is covered by
// the repo's upgrade-proof (scripts/ci/upgrade-proof.sh).

import { describe, it, expect, vi } from "vitest";

import {
  up,
  down,
  BLOB_METADATA_KEY,
  REPORT_METADATA_KEY,
  CONNECTOR_KEY_TO_PACKAGE,
} from "../../../migrations/core/core__0014_nango-connection-identity-backfill.mjs";

type Row = Record<string, unknown>;

/**
 * Scripted pgm.db mock: routes queries by SQL text. Records every call so
 * assertions can pin ordering (BEGIN … report … COMMIT).
 */
function mockPgm(opts: {
  blob?: unknown;
  users?: string[];
  orgs?: string[];
  members?: Array<{ userId: string; organizationId: string; role: string }>;
  installedRows?: Array<{ id: string; organization_id: string | null }>;
  installerUserId?: string | null;
  existingLiveIdentities?: Array<{ connectorKey: string; connectionId: string }>;
  reportValue?: string;
}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let inserted = 0;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK" || norm.startsWith("LOCK TABLE")) {
      return { rows: [] as Row[] };
    }
    if (norm.startsWith("SELECT value FROM metadata WHERE key = $1")) {
      const key = values?.[0];
      if (key === BLOB_METADATA_KEY) {
        return opts.blob === undefined
          ? { rows: [] }
          : { rows: [{ value: typeof opts.blob === "string" ? opts.blob : JSON.stringify(opts.blob) }] };
      }
      if (key === REPORT_METADATA_KEY) {
        return opts.reportValue === undefined ? { rows: [] } : { rows: [{ value: opts.reportValue }] };
      }
      return { rows: [] };
    }
    if (norm.startsWith('SELECT id FROM public."organization"')) {
      return { rows: (opts.orgs ?? []).map((id) => ({ id })) };
    }
    if (norm.startsWith("SELECT id, organization_id FROM installed_extension")) {
      return { rows: opts.installedRows ?? [] };
    }
    if (norm.includes("FROM extension_access_policy")) {
      return opts.installerUserId
        ? { rows: [{ installed_by_user_id: opts.installerUserId }] }
        : { rows: [] };
    }
    if (norm.startsWith('SELECT id FROM public."user" WHERE id = $1')) {
      return (opts.users ?? []).includes(values?.[0] as string)
        ? { rows: [{ id: values?.[0] }] }
        : { rows: [] };
    }
    if (norm.includes("FROM public.member")) {
      const orgId = values?.[0];
      const hit = (opts.members ?? []).find(
        (m) => m.organizationId === orgId && (m.role === "owner" || m.role === "admin"),
      );
      return hit ? { rows: [{ user_id: hit.userId }] } : { rows: [] };
    }
    if (norm.startsWith("INSERT INTO nango_connection")) {
      const [, , connectorKey, connectionId] = values as [string, string, string, string, string];
      const exists = (opts.existingLiveIdentities ?? []).some(
        (e) => e.connectorKey === connectorKey && e.connectionId === connectionId,
      );
      if (exists) return { rows: [] };
      inserted += 1;
      return { rows: [{ id: `00000000-0000-0000-0000-00000000000${inserted}` }] };
    }
    if (norm.startsWith("INSERT INTO metadata")) {
      return { rows: [] };
    }
    if (norm.startsWith("DELETE FROM nango_connection") || norm.startsWith("DELETE FROM metadata")) {
      return { rows: [] };
    }
    throw new Error(`mockPgm: unscripted query: ${norm}`);
  });
  const pgm = { noTransaction: vi.fn(), db: { query } };
  return { pgm, calls, query };
}

const insertedReport = (calls: Array<{ sql: string; values?: unknown[] }>) => {
  const call = calls.find(
    (c) => c.sql.replace(/\s+/g, " ").startsWith("INSERT INTO metadata") && c.values?.[0] === REPORT_METADATA_KEY,
  );
  return call ? JSON.parse(call.values?.[1] as string) : null;
};

describe("core__0014 nango_connection identity backfill", () => {
  it("creates one identity row per blob connection with the recorded connecting user as owner", async () => {
    const { pgm, calls } = mockPgm({
      blob: {
        connections: {
          gmail: [
            { connectionId: "c-1", providerConfigKey: "cinatra-gmail", scope: "user", userId: "u-1" },
          ],
        },
      },
      users: ["u-1"],
      orgs: ["org-1"],
      installedRows: [{ id: "iext_a", organization_id: "org-1" }],
    });
    await up(pgm as never);
    const report = insertedReport(calls);
    expect(report.counts).toMatchObject({ blobConnections: 1, inserted: 1, skippedExisting: 0 });
    expect(report.rows[0]).toMatchObject({
      connectorKey: "gmail",
      connectionId: "c-1",
      connectorPackageId: "@cinatra-ai/gmail-connector",
      organizationId: "org-1",
      ownerUserId: "u-1",
      ownerRule: "recorded-connecting-user",
      legacyScope: "user",
    });
    // Report is written INSIDE the transaction: BEGIN … report-INSERT … COMMIT.
    const seq = calls.map((c) => c.sql.replace(/\s+/g, " ").slice(0, 20));
    expect(seq.indexOf("BEGIN")).toBeLessThan(seq.findIndex((s) => s.startsWith("INSERT INTO metadata")));
    expect(seq.findIndex((s) => s.startsWith("INSERT INTO metadata"))).toBeLessThan(seq.indexOf("COMMIT"));
  });

  it("legacy scope:app without a recorded user falls back to the installing admin (access-policy)", async () => {
    const { pgm, calls } = mockPgm({
      blob: { connections: { github: [{ connectionId: "c-2", scope: "app" }] } },
      orgs: ["org-1"],
      installedRows: [{ id: "iext_b", organization_id: "org-1" }],
      installerUserId: "admin-1",
    });
    await up(pgm as never);
    expect(insertedReport(calls).rows[0]).toMatchObject({
      ownerUserId: "admin-1",
      ownerRule: "installing-admin(access-policy)",
      legacyScope: "app",
    });
  });

  it("falls back to the earliest org owner/admin when no user and no installer exist", async () => {
    const { pgm, calls } = mockPgm({
      blob: { connections: { github: [{ connectionId: "c-3", scope: "app" }] } },
      orgs: ["org-1"],
      installedRows: [],
      members: [{ userId: "owner-1", organizationId: "org-1", role: "owner" }],
    });
    await up(pgm as never);
    expect(insertedReport(calls).rows[0]).toMatchObject({
      ownerUserId: "owner-1",
      ownerRule: "earliest-org-admin",
      organizationId: "org-1", // sole-org fallback (package rows carried none)
    });
  });

  it("ABORTS (fail-closed) when no owner can be resolved — never a NULL/placeholder owner", async () => {
    const { pgm, calls } = mockPgm({
      blob: { connections: { github: [{ connectionId: "c-4", scope: "app" }] } },
      orgs: [],
    });
    await expect(up(pgm as never)).rejects.toThrow(/cannot resolve a NON-NULL owner/);
    expect(calls.map((c) => c.sql).some((s) => s === "ROLLBACK")).toBe(true);
    expect(calls.map((c) => c.sql).some((s) => s === "COMMIT")).toBe(false);
  });

  it("ABORTS on an unknown connector key (fail-closed, never guesses a package)", async () => {
    const { pgm } = mockPgm({
      blob: { connections: { mystery: [{ connectionId: "c-5", userId: "u-1" }] } },
      users: ["u-1"],
    });
    await expect(up(pgm as never)).rejects.toThrow(/unknown connector key "mystery"/);
  });

  it("ABORTS on a corrupt blob (never backfills from unparseable data)", async () => {
    const { pgm } = mockPgm({ blob: "{ not json" });
    await expect(up(pgm as never)).rejects.toThrow(/not valid JSON/);
  });

  it("ABORTS on a parseable-but-wrong blob shape (never ledgers a zero-row migration over it)", async () => {
    for (const blob of [[], "str-json", { connexions: {} }, { connections: [] }, { connections: null }]) {
      const { pgm } = mockPgm({ blob: JSON.stringify(blob) });
      await expect(up(pgm as never)).rejects.toThrow(/not the expected/);
    }
  });

  it("an already-present live identity is skipped (exactly-one-row contract) and reported", async () => {
    const { pgm, calls } = mockPgm({
      blob: { connections: { gmail: [{ connectionId: "c-1", userId: "u-1" }] } },
      users: ["u-1"],
      orgs: ["org-1"],
      existingLiveIdentities: [{ connectorKey: "gmail", connectionId: "c-1" }],
    });
    await up(pgm as never);
    const report = insertedReport(calls);
    expect(report.counts).toMatchObject({ inserted: 0, skippedExisting: 1 });
    expect(report.skippedExisting).toEqual([{ connectorKey: "gmail", connectionId: "c-1" }]);
  });

  it("no blob → still commits an empty report (blobPresent:false, 0 rows)", async () => {
    const { pgm, calls } = mockPgm({});
    await up(pgm as never);
    const report = insertedReport(calls);
    expect(report).toMatchObject({ blobPresent: false, counts: { blobConnections: 0, inserted: 0 } });
    expect(calls.map((c) => c.sql).includes("COMMIT")).toBe(true);
  });

  it("down() deletes exactly the report-named rows + the report key", async () => {
    const { pgm, calls } = mockPgm({
      reportValue: JSON.stringify({
        rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
      }),
    });
    await down(pgm as never);
    const del = calls.find((c) => c.sql.replace(/\s+/g, " ").startsWith("DELETE FROM nango_connection"));
    expect(del?.values).toEqual([["11111111-1111-1111-1111-111111111111"]]);
    const delReport = calls.find((c) => c.sql.replace(/\s+/g, " ").startsWith("DELETE FROM metadata"));
    expect(delReport?.values).toEqual([REPORT_METADATA_KEY]);
  });

  it("down() without a report is a no-op (fresh/ledger-faked schema)", async () => {
    const { pgm, calls } = mockPgm({});
    await down(pgm as never);
    expect(calls.some((c) => c.sql.startsWith("DELETE FROM nango_connection"))).toBe(false);
  });

  it("the key→package map covers every NangoConnectorKey the gateway vocabulary ships", () => {
    expect(Object.keys(CONNECTOR_KEY_TO_PACKAGE).sort()).toEqual(
      [
        "a2aServer",
        "apify",
        "apollo",
        "claude",
        "drupal",
        "gemini",
        "github",
        "gmail",
        "googleCalendar",
        "googleOAuth",
        "linkedin",
        "openai",
        "tailscale",
        "tailscaleOauth",
        "wordpress",
        "youtube",
      ].sort(),
    );
  });
});
