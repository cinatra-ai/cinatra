// #180 PR-2: the install-BATCH ledger store — SQL shapes + row mapping over
// the injected query (no DB), mirroring extension-install-ops.test coverage.
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  beginInstallBatch,
  setInstallBatchPhase,
  updateInstallBatchMember,
  readInstallBatch,
  listActiveInstallBatches,
  listStaleInstallBatches,
  listRecentInstallBatches,
  type InstallBatchMember,
  type InstallBatchOpsDeps,
} from "@/lib/extension-install-batch-ops";

const query = vi.fn();
const deps: InstallBatchOpsDeps = { query: query as never, schema: "cinatra" };

function row(over: Record<string, unknown> = {}) {
  return {
    batch_id: "b-1",
    root_package: "@cinatra-ai/root",
    org_id: null,
    phase: "planning",
    members: [member("@cinatra-ai/dep-a")],
    created_at: "t0",
    updated_at: "t0",
    ...over,
  };
}

function member(packageName: string, over: Partial<InstallBatchMember> = {}): InstallBatchMember {
  return {
    packageName,
    version: "1.0.0",
    typeId: "connector",
    status: "planned",
    preState: { present: false },
    ...over,
  };
}

beforeEach(() => {
  query.mockReset();
});

describe("extension-install-batch-ops", () => {
  it("beginInstallBatch INSERTs at phase 'planning' with the jsonb member set", async () => {
    query.mockResolvedValueOnce([row()]);
    const b = await beginInstallBatch(
      {
        batchId: "b-1",
        rootPackage: "@cinatra-ai/root",
        orgId: null,
        members: [member("@cinatra-ai/dep-a")],
      },
      deps,
    );
    expect(b.phase).toBe("planning");
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO "cinatra"."extension_install_batches"');
    expect(sql).toContain("'planning'");
    expect(values?.[3]).toContain("@cinatra-ai/dep-a"); // serialized members
  });

  it("setInstallBatchPhase UPDATEs phase + updated_at; missing batch throws", async () => {
    query.mockResolvedValueOnce([row({ phase: "installing" })]);
    const b = await setInstallBatchPhase("b-1", "installing", deps);
    expect(b.phase).toBe("installing");
    expect(query.mock.calls[0]![0]).toContain("updated_at = now()");

    query.mockResolvedValueOnce([]);
    await expect(setInstallBatchPhase("missing", "failed", deps)).rejects.toThrow(/no row for batch/);
  });

  it("updateInstallBatchMember patches exactly ONE member by packageName (read-modify-write)", async () => {
    query.mockResolvedValueOnce([
      row({ members: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b")] }),
    ]);
    query.mockImplementationOnce(async (_sql: string, values: unknown[]) => {
      const members = JSON.parse(values[0] as string) as InstallBatchMember[];
      return [row({ members })];
    });
    const b = await updateInstallBatchMember(
      "b-1",
      "@cinatra-ai/dep-b",
      { status: "installed", installOpId: "op-9" },
      deps,
    );
    expect(b.members.find((m) => m.packageName === "@cinatra-ai/dep-b")).toMatchObject({
      status: "installed",
      installOpId: "op-9",
    });
    expect(b.members.find((m) => m.packageName === "@cinatra-ai/dep-a")!.status).toBe("planned");
  });

  it("readInstallBatch maps the row (jsonb already-parsed AND stringified forms)", async () => {
    query.mockResolvedValueOnce([row({ members: JSON.stringify([member("@cinatra-ai/dep-a")]) })]);
    const b = await readInstallBatch("b-1", deps);
    expect(b!.members[0]!.packageName).toBe("@cinatra-ai/dep-a");
    query.mockResolvedValueOnce([]);
    expect(await readInstallBatch("nope", deps)).toBeNull();
  });

  it("listActiveInstallBatches selects the ACTIVE phases; listStaleInstallBatches adds the idle threshold", async () => {
    query.mockResolvedValueOnce([row()]);
    await listActiveInstallBatches(deps);
    expect(query.mock.calls[0]![0]).toContain("phase = ANY($1::text[])");
    expect(query.mock.calls[0]![1]?.[0]).toEqual(["planning", "installing"]);

    query.mockResolvedValueOnce([]);
    await listStaleInstallBatches(60_000, deps);
    expect(query.mock.calls[1]![0]).toContain("milliseconds");
    expect(query.mock.calls[1]![1]?.[1]).toBe("60000");
  });

  it("listRecentInstallBatches orders by updated_at DESC, clamps the limit, and is unscoped by default", async () => {
    query.mockResolvedValueOnce([row({ phase: "finalized" })]);
    const batches = await listRecentInstallBatches({ limit: 10 }, deps);
    expect(batches[0]!.phase).toBe("finalized");
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(sql).toContain("LIMIT $1");
    expect(sql).not.toContain("phase = ANY"); // any phase, including terminal
    expect(values?.[0]).toBe(10);
  });

  it("listRecentInstallBatches scopes by org_id (NULL-safe) when orgId is provided", async () => {
    query.mockResolvedValueOnce([row({ org_id: "org-1" })]);
    await listRecentInstallBatches({ limit: 5, orgId: "org-1" }, deps);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("org_id IS NOT DISTINCT FROM $1");
    expect(values?.[0]).toBe("org-1");
    expect(values?.[1]).toBe(5);

    // Explicit null scope → platform-scoped batches.
    query.mockResolvedValueOnce([row({ org_id: null })]);
    await listRecentInstallBatches({ orgId: null }, deps);
    expect(query.mock.calls[1]![1]?.[0]).toBeNull();
  });

  it("listRecentInstallBatches with orgId exposes NO cross-org rows (cinatra #209 item 2 leak fix)", async () => {
    // Regression guard for the registry-catalog screen's batch read: the screen
    // is gated by requireAuthSession() alone, so the read MUST be org-scoped or
    // a member of org A sees org B's batches. Model a ledger that spans two orgs
    // plus a platform-scoped (org_id null) batch; the SQL the screen drives must
    // filter to the actor's org with the NULL-safe predicate so the DB never
    // returns another org's rows. We assert the predicate + bound org value
    // (the actual isolation lives in `org_id IS NOT DISTINCT FROM $1`), then
    // confirm that a query honoring that predicate yields only the actor's org.
    const ledger = [
      row({ batch_id: "b-A1", org_id: "org-A", root_package: "@acme/root" }),
      row({ batch_id: "b-B1", org_id: "org-B", root_package: "@beta/secret-root" }),
      row({ batch_id: "b-plat", org_id: null, root_package: "@cinatra-ai/platform" }),
    ];
    query.mockImplementationOnce(async (sql: string, values: unknown[]) => {
      // The store must scope by org; emulate the DB applying that predicate.
      expect(sql).toContain("org_id IS NOT DISTINCT FROM $1");
      const wantOrg = values[0] as string | null;
      return ledger.filter((r) => (r.org_id ?? null) === (wantOrg ?? null));
    });

    const visible = await listRecentInstallBatches({ limit: 10, orgId: "org-A" }, deps);

    // Only org-A's batch is returned — org-B's and the platform batch are not.
    expect(visible.map((b) => b.batchId)).toEqual(["b-A1"]);
    expect(visible.some((b) => b.orgId === "org-B")).toBe(false);
    expect(visible.some((b) => b.rootPackage.includes("secret"))).toBe(false);
  });

  it("listRecentInstallBatches with a null active org sees only platform-scoped batches, not other orgs", async () => {
    // A member with no active org must NOT fall through to a cross-org read;
    // null scopes to platform-scoped (org_id IS NULL) batches only — mirroring
    // the saga's `(b.orgId ?? null) !== orgId` scoping.
    const ledger = [
      row({ batch_id: "b-A1", org_id: "org-A" }),
      row({ batch_id: "b-plat", org_id: null }),
    ];
    query.mockImplementationOnce(async (sql: string, values: unknown[]) => {
      expect(sql).toContain("org_id IS NOT DISTINCT FROM $1");
      const wantOrg = values[0] as string | null;
      return ledger.filter((r) => (r.org_id ?? null) === (wantOrg ?? null));
    });
    const visible = await listRecentInstallBatches({ limit: 10, orgId: null }, deps);
    expect(visible.map((b) => b.batchId)).toEqual(["b-plat"]);
  });

  it("listRecentInstallBatches clamps the limit into [1, 200]", async () => {
    query.mockResolvedValueOnce([]);
    await listRecentInstallBatches({ limit: 9999 }, deps);
    expect(query.mock.calls[0]![1]?.[0]).toBe(200);
    query.mockResolvedValueOnce([]);
    await listRecentInstallBatches({ limit: 0 }, deps);
    expect(query.mock.calls[1]![1]?.[0]).toBe(1);
  });
});
