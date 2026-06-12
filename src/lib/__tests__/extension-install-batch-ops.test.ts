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
});
