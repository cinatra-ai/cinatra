import { describe, expect, it, vi } from "vitest";
import {
  readInstanceToolPolicy,
  ensureDefaultOpenPolicy,
  writeCreationDefaultPolicy,
  reconcileConnectorInstanceToolPolicies,
  writeInstanceToolPolicy,
  SYSTEM_POLICY_BACKFILL_ACTOR,
  type PolicyStoreDeps,
} from "@/lib/connector-instance-tool-policy-store";

// cinatra#2017 S2 slice K4 — persisted policy store (R2-B2 / R3-B2). Injected
// query + audit → no real DB (design §6.1 store test).

type Row = {
  connector_key: string;
  instance_id: string;
  mode: string;
  allow_refs: unknown;
  deny_refs: unknown;
  updated_by: string;
  updated_at: string;
};

function makeStore(): { deps: PolicyStoreDeps; audit: ReturnType<typeof vi.fn>; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const key = (ck: string, iid: string) => `${ck}::${iid}`;
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const v = (values ?? []) as unknown[];
    if (text.includes("SELECT")) {
      const row = rows.get(key(v[0] as string, v[1] as string));
      return row ? [row] : [];
    }
    if (text.includes("DO NOTHING")) {
      const k = key(v[0] as string, v[1] as string);
      if (rows.has(k)) return []; // conflict → not created
      rows.set(k, {
        connector_key: v[0] as string,
        instance_id: v[1] as string,
        mode: "open",
        allow_refs: null,
        deny_refs: null,
        updated_by: v[2] as string,
        updated_at: "2026-07-26T00:00:00Z",
      });
      return [{ connector_key: v[0] }];
    }
    if (text.includes("DO UPDATE")) {
      rows.set(key(v[0] as string, v[1] as string), {
        connector_key: v[0] as string,
        instance_id: v[1] as string,
        mode: v[2] as string,
        allow_refs: v[3] ? JSON.parse(v[3] as string) : null,
        deny_refs: v[4] ? JSON.parse(v[4] as string) : null,
        updated_by: v[5] as string,
        updated_at: "2026-07-26T00:00:00Z",
      });
      return [];
    }
    return [];
  });
  const audit = vi.fn(async () => {});
  return { deps: { query, audit }, audit, rows };
}

describe("ensureDefaultOpenPolicy — create-if-absent, never clobber", () => {
  it("creates an explicit open row + audits on first call; no-op + no audit on conflict", async () => {
    const { deps, audit } = makeStore();
    const first = await ensureDefaultOpenPolicy(
      { connectorKey: "wordpress", instanceId: "i1", updatedBy: "sys", reason: "test" },
      deps,
    );
    expect(first).toEqual({ created: true });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      actorPrincipalType: "system",
      operation: "policy_default_open",
      metadata: { mode: "open" },
    });
    const second = await ensureDefaultOpenPolicy(
      { connectorKey: "wordpress", instanceId: "i1", updatedBy: "sys", reason: "test" },
      deps,
    );
    expect(second).toEqual({ created: false });
    expect(audit).toHaveBeenCalledTimes(1); // no second audit
  });
});

describe("readInstanceToolPolicy", () => {
  it("returns null when absent (compatibility fallback window)", async () => {
    const { deps } = makeStore();
    expect(await readInstanceToolPolicy("wordpress", "missing", deps)).toBeNull();
  });
  it("maps a written row into a record", async () => {
    const { deps } = makeStore();
    await writeCreationDefaultPolicy({ connectorKey: "wordpress", instanceId: "i2" }, deps);
    const rec = await readInstanceToolPolicy("wordpress", "i2", deps);
    expect(rec).toMatchObject({ connectorKey: "wordpress", instanceId: "i2", mode: "open" });
  });
});

describe("reconcileConnectorInstanceToolPolicies (R2-B2)", () => {
  it("writes one open row per DISTINCT enrolled instance under the system backfill actor", async () => {
    const { deps, audit } = makeStore();
    const res = await reconcileConnectorInstanceToolPolicies(
      { connectorKey: "wordpress", instanceIds: ["a", "b", "a", ""] },
      deps,
    );
    expect(res).toEqual({ written: 2, total: 4 }); // "a" once, "b" once, "" skipped
    for (const call of audit.mock.calls) {
      expect(call[0].metadata.updatedBy).toBe(SYSTEM_POLICY_BACKFILL_ACTOR);
    }
    expect(await readInstanceToolPolicy("wordpress", "a", deps)).not.toBeNull();
    expect(await readInstanceToolPolicy("wordpress", "b", deps)).not.toBeNull();
  });
});

describe("writeInstanceToolPolicy — operator mutation (audited)", () => {
  it("upserts restricted allow/deny and audits policy_update", async () => {
    const { deps, audit } = makeStore();
    await writeInstanceToolPolicy(
      {
        connectorKey: "wordpress",
        instanceId: "i3",
        mode: "restricted",
        allow: [{ serverId: "s1", name: "core/get-site-info" }],
        deny: [{ serverId: "s1", name: "ewpa/create-post" }],
        updatedBy: "admin-user",
      },
      deps,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "policy_update", metadata: expect.objectContaining({ mode: "restricted", allowCount: 1, denyCount: 1 }) }),
    );
    const rec = await readInstanceToolPolicy("wordpress", "i3", deps);
    expect(rec?.mode).toBe("restricted");
    expect(rec?.allow).toEqual([{ serverId: "s1", name: "core/get-site-info" }]);
    expect(rec?.deny).toEqual([{ serverId: "s1", name: "ewpa/create-post" }]);
  });
});
