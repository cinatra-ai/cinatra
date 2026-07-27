import { describe, expect, it, vi } from "vitest";
import {
  readNativeInjectionPolicy,
  setNativeInjectionMode,
  NATIVE_INJECTION_POLICY_VERSION,
  type NativeInjectionStoreDeps,
  type NativeInjectionStoreQuery,
} from "@/lib/connector-instance-native-injection-store";
import { connectorInstanceNativeInjectionSchemaQueries } from "@/lib/connector-instance-native-injection-schema";

// cinatra#2019 S4 — the trusted-site native-injection OPT-IN store. Injected
// query + audit → no real DB. Pins: absent row reads OFF; malformed rows read
// OFF + audit loudly (fail-closed); consent is ORG-BOUND (a row consented by
// one org reads OFF for a different current owner); the writer refuses a
// partial consent acknowledgement; `off` clears stamps + enable attribution;
// every transition emits the `native_injection_mode_changed` authorization
// record — STRICTLY BEFORE the row flip on the privileged `trusted_site`
// direction (an audit failure aborts the enable with nothing written),
// best-effort AFTER the row flip on revocation (an audit outage never keeps
// injection enabled).

type Row = {
  connector_key: string;
  instance_id: string;
  mode: string;
  disclosure_version: string | null;
  descriptor_set_version: number | string | null;
  descriptor_set_hash: string | null;
  consented_org_id: string | null;
  enabled_by: string | null;
  enabled_at: string | null;
  updated_by: string;
  updated_at: string;
};

function makeStore(seed?: Row[]): {
  deps: NativeInjectionStoreDeps;
  audit: ReturnType<typeof vi.fn>;
  auditStrict: ReturnType<typeof vi.fn>;
  rows: Map<string, Row>;
  calls: string[];
} {
  const rows = new Map<string, Row>();
  for (const row of seed ?? []) rows.set(`${row.connector_key}::${row.instance_id}`, row);
  const key = (ck: string, iid: string) => `${ck}::${iid}`;
  const calls: string[] = [];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const v = (values ?? []) as unknown[];
    if (text.includes("SELECT")) {
      const row = rows.get(key(v[0] as string, v[1] as string));
      return row ? [row] : [];
    }
    if (text.includes("ON CONFLICT")) {
      calls.push("write");
      const trusted = v[2] === "trusted_site";
      rows.set(key(v[0] as string, v[1] as string), {
        connector_key: v[0] as string,
        instance_id: v[1] as string,
        mode: v[2] as string,
        disclosure_version: (v[3] as string | null) ?? null,
        descriptor_set_version: (v[4] as number | null) ?? null,
        descriptor_set_hash: (v[5] as string | null) ?? null,
        consented_org_id: (v[6] as string | null) ?? null,
        enabled_by: (v[7] as string | null) ?? null,
        enabled_at: trusted ? "2026-07-27T00:00:00Z" : null,
        updated_by: v[8] as string,
        updated_at: "2026-07-27T00:00:00Z",
      });
      return [];
    }
    return [];
  });
  const audit = vi.fn(async () => {
    calls.push("audit");
  });
  const auditStrict = vi.fn(async () => {
    calls.push("auditStrict");
    return { id: "audit-row-1" };
  });
  return {
    deps: { query: query as unknown as NativeInjectionStoreQuery, audit, auditStrict },
    audit,
    auditStrict,
    rows,
    calls,
  };
}

const STAMPS = {
  disclosureVersion: "v1",
  descriptorSetVersion: 1,
  descriptorSetHash: "a".repeat(64),
};

function trustedRow(overrides?: Partial<Row>): Row {
  return {
    connector_key: "wordpress",
    instance_id: "i1",
    mode: "trusted_site",
    disclosure_version: "v1",
    descriptor_set_version: 1,
    descriptor_set_hash: STAMPS.descriptorSetHash,
    consented_org_id: "org-1",
    enabled_by: "admin-1",
    enabled_at: "2026-07-27T00:00:00Z",
    updated_by: "admin-1",
    updated_at: "2026-07-27T00:00:00Z",
    ...overrides,
  };
}

describe("readNativeInjectionPolicy — total, fail-closed, org-bound", () => {
  it("reads OFF with all-null fields for an absent row (no audit)", async () => {
    const { deps, audit } = makeStore();
    const view = await readNativeInjectionPolicy("wordpress", "i1", "org-1", deps);
    expect(view).toEqual({
      mode: "off",
      disclosureVersion: null,
      descriptorSetVersion: null,
      descriptorSetHash: null,
      consentedOrgId: null,
      enabledBy: null,
      enabledAt: null,
      updatedBy: null,
      updatedAt: null,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("reads a persisted trusted_site row back verbatim for the consented org (integer version normalized from a string column read)", async () => {
    const { deps, audit } = makeStore([trustedRow({ descriptor_set_version: "1" })]);
    const view = await readNativeInjectionPolicy("wordpress", "i1", "org-1", deps);
    expect(view.mode).toBe("trusted_site");
    expect(view.descriptorSetVersion).toBe(1);
    expect(view.descriptorSetHash).toBe(STAMPS.descriptorSetHash);
    expect(view.disclosureVersion).toBe("v1");
    expect(view.consentedOrgId).toBe("org-1");
    expect(view.enabledBy).toBe("admin-1");
    expect(audit).not.toHaveBeenCalled();
  });

  it("reads OFF + audits denied when the current owner is NOT the consented org (consent never survives an ownership change)", async () => {
    const { deps, audit } = makeStore([trustedRow()]);
    const view = await readNativeInjectionPolicy("wordpress", "i1", "org-2", deps);
    expect(view.mode).toBe("off");
    expect(view.consentedOrgId).toBeNull();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      operation: "native_injection_policy_invalid",
      decision: "denied",
      policyVersion: NATIVE_INJECTION_POLICY_VERSION,
      metadata: { connectorKey: "wordpress", reason: "consented_org_mismatch_read_as_off" },
    });
  });

  it("reads OFF + audits denied for an unknown persisted mode", async () => {
    const { deps, audit } = makeStore([
      trustedRow({ mode: "trusted_site_v2", disclosure_version: null, descriptor_set_version: null, descriptor_set_hash: null, consented_org_id: null, enabled_by: null, enabled_at: null }),
    ]);
    const view = await readNativeInjectionPolicy("wordpress", "i1", "org-1", deps);
    expect(view.mode).toBe("off");
    expect(audit.mock.calls[0][0]).toMatchObject({
      operation: "native_injection_policy_invalid",
      decision: "denied",
      metadata: { connectorKey: "wordpress", reason: "unknown_mode_read_as_off" },
    });
  });

  it.each([
    ["a consent stamp", { descriptor_set_version: null }],
    ["the org stamp", { consented_org_id: null }],
    ["the enable attribution", { enabled_by: null, enabled_at: null }],
  ] as Array<[string, Partial<Row>]>)(
    "reads OFF + audits denied for a trusted_site row missing %s",
    async (_label, overrides) => {
      const { deps, audit } = makeStore([trustedRow(overrides)]);
      const view = await readNativeInjectionPolicy("wordpress", "i1", "org-1", deps);
      expect(view.mode).toBe("off");
      expect(view.descriptorSetHash).toBeNull();
      expect(audit.mock.calls[0][0]).toMatchObject({
        decision: "denied",
        metadata: { reason: "trusted_site_missing_consent_stamps_read_as_off" },
      });
    },
  );

  it("refuses a read without the owning org id outright (callers cannot skip the ownership check)", async () => {
    const { deps } = makeStore();
    await expect(
      readNativeInjectionPolicy("wordpress", "i1", "", deps),
    ).rejects.toThrow(/owning org id/);
  });
});

describe("setNativeInjectionMode — host-stamped upsert + authorization record", () => {
  it("writes a trusted_site row with all stamps + org binding + enable attribution; the STRICT audit records off→trusted_site BEFORE the row flip", async () => {
    const { deps, audit, auditStrict, rows, calls } = makeStore();
    await setNativeInjectionMode(
      {
        connectorKey: "wordpress",
        instanceId: "i1",
        mode: "trusted_site",
        actorUserId: "admin-1",
        actorOrgId: "org-1",
        ...STAMPS,
      },
      deps,
    );
    const row = rows.get("wordpress::i1");
    expect(row).toMatchObject({
      mode: "trusted_site",
      disclosure_version: "v1",
      descriptor_set_version: 1,
      descriptor_set_hash: STAMPS.descriptorSetHash,
      consented_org_id: "org-1",
      enabled_by: "admin-1",
      updated_by: "admin-1",
    });
    expect(row?.enabled_at).not.toBeNull();
    // Privileged direction rides the STRICT sink only, BEFORE the write.
    expect(calls).toEqual(["auditStrict", "write"]);
    expect(audit).not.toHaveBeenCalled();
    expect(auditStrict).toHaveBeenCalledTimes(1);
    expect(auditStrict.mock.calls[0][0]).toMatchObject({
      resourceType: "connector_instance",
      resourceId: "i1",
      organizationId: "org-1",
      actorPrincipalType: "human",
      actorPrincipalId: "admin-1",
      authSource: "ui",
      operation: "native_injection_mode_changed",
      decision: "allowed",
      policyVersion: NATIVE_INJECTION_POLICY_VERSION,
      metadata: {
        connectorKey: "wordpress",
        from: "off",
        to: "trusted_site",
        updatedBy: "admin-1",
        disclosureVersion: "v1",
        descriptorSetVersion: 1,
        descriptorSetHash: STAMPS.descriptorSetHash,
        consentedOrgId: "org-1",
      },
    });
  });

  it("aborts an enable when the strict audit insert fails — NOTHING written (no consent row without its record)", async () => {
    const { deps, auditStrict, rows } = makeStore();
    auditStrict.mockRejectedValueOnce(new Error("audit db down"));
    await expect(
      setNativeInjectionMode(
        {
          connectorKey: "wordpress",
          instanceId: "i1",
          mode: "trusted_site",
          actorUserId: "admin-1",
          actorOrgId: "org-1",
          ...STAMPS,
        },
        deps,
      ),
    ).rejects.toThrow(/audit db down/);
    expect(rows.size).toBe(0);
  });

  it("revocation writes the row FIRST and audits best-effort after (an audit outage never blocks disabling)", async () => {
    const { deps, calls, rows } = makeStore([trustedRow()]);
    await setNativeInjectionMode(
      { connectorKey: "wordpress", instanceId: "i1", mode: "off", actorUserId: "admin-1", actorOrgId: "org-1" },
      deps,
    );
    expect(calls).toEqual(["write", "audit"]);
    expect(rows.get("wordpress::i1")?.mode).toBe("off");
  });

  it("clears stamps + org binding + enable attribution on off, audits trusted_site→off without stamp metadata", async () => {
    const { deps, audit, rows } = makeStore([trustedRow()]);
    await setNativeInjectionMode(
      { connectorKey: "wordpress", instanceId: "i1", mode: "off", actorUserId: "admin-2", actorOrgId: "org-1" },
      deps,
    );
    expect(rows.get("wordpress::i1")).toMatchObject({
      mode: "off",
      disclosure_version: null,
      descriptor_set_version: null,
      descriptor_set_hash: null,
      consented_org_id: null,
      enabled_by: null,
      enabled_at: null,
      updated_by: "admin-2",
    });
    const event = audit.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(event).toMatchObject({
      operation: "native_injection_mode_changed",
      organizationId: "org-1",
      metadata: { from: "trusted_site", to: "off", updatedBy: "admin-2" },
    });
    expect(event.metadata).not.toHaveProperty("descriptorSetHash");
    expect(event.metadata).not.toHaveProperty("consentedOrgId");
  });

  it("nulls stamps + org binding on an off write even when a caller passes stamp values", async () => {
    const { deps, rows } = makeStore();
    await setNativeInjectionMode(
      {
        connectorKey: "wordpress",
        instanceId: "i1",
        mode: "off",
        actorUserId: "admin-1",
        actorOrgId: "org-1",
        ...STAMPS,
      },
      deps,
    );
    expect(rows.get("wordpress::i1")).toMatchObject({
      mode: "off",
      disclosure_version: null,
      descriptor_set_version: null,
      descriptor_set_hash: null,
      consented_org_id: null,
      enabled_by: null,
    });
  });

  it.each([
    ["missing disclosureVersion", { descriptorSetVersion: 1, descriptorSetHash: "h" }],
    ["missing descriptorSetVersion", { disclosureVersion: "v1", descriptorSetHash: "h" }],
    ["missing descriptorSetHash", { disclosureVersion: "v1", descriptorSetVersion: 1 }],
    ["non-integer descriptorSetVersion", { disclosureVersion: "v1", descriptorSetVersion: 1.5, descriptorSetHash: "h" }],
  ])("refuses a trusted_site write with %s (nothing written, nothing audited)", async (_label, stamps) => {
    const { deps, audit, auditStrict, rows } = makeStore();
    await expect(
      setNativeInjectionMode(
        {
          connectorKey: "wordpress",
          instanceId: "i1",
          mode: "trusted_site",
          actorUserId: "admin-1",
          actorOrgId: "org-1",
          ...(stamps as Partial<typeof STAMPS>),
        },
        deps,
      ),
    ).rejects.toThrow(/host-stamped consent/);
    expect(rows.size).toBe(0);
    expect(audit).not.toHaveBeenCalled();
    expect(auditStrict).not.toHaveBeenCalled();
  });

  it("refuses an unknown mode, a missing actor and a missing owning org outright", async () => {
    const { deps, rows } = makeStore();
    await expect(
      setNativeInjectionMode(
        {
          connectorKey: "wordpress",
          instanceId: "i1",
          mode: "on" as unknown as "off",
          actorUserId: "admin-1",
          actorOrgId: "org-1",
        },
        deps,
      ),
    ).rejects.toThrow(/unknown mode/);
    await expect(
      setNativeInjectionMode(
        { connectorKey: "wordpress", instanceId: "i1", mode: "off", actorUserId: "", actorOrgId: "org-1" },
        deps,
      ),
    ).rejects.toThrow(/acting user/);
    await expect(
      setNativeInjectionMode(
        { connectorKey: "wordpress", instanceId: "i1", mode: "off", actorUserId: "admin-1", actorOrgId: " " },
        deps,
      ),
    ).rejects.toThrow(/owning org/);
    expect(rows.size).toBe(0);
  });

  it("re-acknowledge (trusted_site→trusted_site) re-stamps and strict-audits with from=trusted_site", async () => {
    const { deps, auditStrict, rows } = makeStore([trustedRow()]);
    const fresh = { disclosureVersion: "v2", descriptorSetVersion: 2, descriptorSetHash: "b".repeat(64) };
    await setNativeInjectionMode(
      {
        connectorKey: "wordpress",
        instanceId: "i1",
        mode: "trusted_site",
        actorUserId: "admin-1",
        actorOrgId: "org-1",
        ...fresh,
      },
      deps,
    );
    expect(rows.get("wordpress::i1")).toMatchObject({
      descriptor_set_version: 2,
      descriptor_set_hash: fresh.descriptorSetHash,
      disclosure_version: "v2",
      consented_org_id: "org-1",
    });
    expect(auditStrict.mock.calls[0][0]).toMatchObject({
      metadata: { from: "trusted_site", to: "trusted_site", descriptorSetVersion: 2 },
    });
  });
});

describe("bootstrap DDL leaf", () => {
  it("emits one CREATE TABLE IF NOT EXISTS with the mode CHECK, the trusted_site_stamps CHECK (stamps + org + attribution) and the composite PK", () => {
    const queries = connectorInstanceNativeInjectionSchemaQueries('sch"ema');
    expect(queries).toHaveLength(1);
    const ddl = queries[0].text;
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "sch""ema"."connector_instance_native_injection_policy"');
    expect(ddl).toContain("CHECK (mode IN ('off','trusted_site'))");
    expect(ddl).toContain("CONSTRAINT trusted_site_stamps CHECK");
    expect(ddl).toContain("mode <> 'trusted_site'");
    expect(ddl).toContain(
      "disclosure_version IS NOT NULL AND descriptor_set_version IS NOT NULL AND descriptor_set_hash IS NOT NULL",
    );
    expect(ddl).toContain(
      "consented_org_id IS NOT NULL AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL",
    );
    expect(ddl).toContain("PRIMARY KEY (connector_key, instance_id)");
  });
});
