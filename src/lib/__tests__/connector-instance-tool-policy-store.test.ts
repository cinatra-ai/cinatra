import { describe, expect, it, vi } from "vitest";
import {
  readInstanceToolPolicy,
  ensureDefaultOpenPolicy,
  writeCreationDefaultPolicy,
  reconcileConnectorInstanceToolPolicies,
  writeInstanceToolPolicy,
  SYSTEM_POLICY_BACKFILL_ACTOR,
  type PolicyStoreDeps,
  type PolicyStoreQuery,
} from "@/lib/connector-instance-tool-policy-store";
import { evaluateInstanceToolPolicy } from "@cinatra-ai/mcp-server/instance-tool-policy";

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
      // cinatra#2022 S7 PR-δ: the default-writer's INSERT literal flipped from
      // 'open' to 'restricted' — mirror that here so the mock simulates the
      // real SQL text in ensureDefaultOpenPolicy.
      rows.set(k, {
        connector_key: v[0] as string,
        instance_id: v[1] as string,
        mode: "restricted",
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
  return { deps: { query: query as unknown as PolicyStoreQuery, audit }, audit, rows };
}

describe("ensureDefaultOpenPolicy — create-if-absent, never clobber (cinatra#2022 S7 PR-δ: now writes restricted+empty)", () => {
  it("creates an explicit restricted+empty row + audits on first call; no-op + no audit on conflict", async () => {
    const { deps, audit } = makeStore();
    const first = await ensureDefaultOpenPolicy(
      { connectorKey: "wordpress", instanceId: "i1", updatedBy: "sys", reason: "test" },
      deps,
    );
    expect(first).toEqual({ created: true });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      actorPrincipalType: "system",
      operation: "policy_default_restricted",
      decision: "denied",
      metadata: { mode: "restricted" },
    });
    const second = await ensureDefaultOpenPolicy(
      { connectorKey: "wordpress", instanceId: "i1", updatedBy: "sys", reason: "test" },
      deps,
    );
    expect(second).toEqual({ created: false });
    expect(audit).toHaveBeenCalledTimes(1); // no second audit
  });

  // A newly-created post-δ instance gets the IDENTICAL restricted-empty
  // verdict via the ordinary fallback path as an instance with no row at
  // all — proving there is no special-case creation-time branch, and no
  // window where a brand-new instance is briefly more permissive.
  it("the row this backstop writes evaluates IDENTICALLY to an absent record — no special-case creation branch", async () => {
    const { deps } = makeStore();
    const ref = { serverId: "mcp-adapter-default", name: "ewpa/create-post" };
    const absentVerdict = evaluateInstanceToolPolicy(
      await readInstanceToolPolicy("wordpress", "never-touched", deps),
      ref,
    );
    await ensureDefaultOpenPolicy(
      { connectorKey: "wordpress", instanceId: "freshly-created", updatedBy: "sys", reason: "instance_creation_hook" },
      deps,
    );
    const firstTouchVerdict = evaluateInstanceToolPolicy(
      await readInstanceToolPolicy("wordpress", "freshly-created", deps),
      ref,
    );
    expect(absentVerdict.status).toBe("denied");
    expect(firstTouchVerdict.status).toBe("denied");
    // Same net verdict; the warn code legitimately differs (absent vs. an
    // explicit-but-empty restricted record) — the STATUS is what a caller acts
    // on, and it must be identical either way.
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
    expect(rec).toMatchObject({ connectorKey: "wordpress", instanceId: "i2", mode: "restricted" });
  });
});

describe("reconcileConnectorInstanceToolPolicies (R2-B2)", () => {
  it("writes one restricted+empty row per DISTINCT enrolled instance under the system backfill actor", async () => {
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

describe("malformed persisted policy → fail-closed deny-all, NEVER hidden", () => {
  it("a row with a non-array deny_refs is passed through raw so the evaluator rejects the whole record", async () => {
    // An `open` row whose deny_refs is a stray object (not an array) must NOT be
    // read as `deny: undefined` (which would fail OPEN). It is passed through so
    // evaluateInstanceToolPolicy → invalid → deny-all.
    const query = vi.fn(async (text: string) => {
      if (text.includes("SELECT")) {
        return [
          {
            connector_key: "wordpress",
            instance_id: "corrupt",
            mode: "open",
            allow_refs: null,
            deny_refs: {}, // MALFORMED (jsonb object, not an array)
            updated_by: "u",
            updated_at: "2026-07-26T00:00:00Z",
          },
        ];
      }
      return [];
    });
    const rec = await readInstanceToolPolicy("wordpress", "corrupt", { query: query as unknown as PolicyStoreQuery });
    expect(rec).not.toBeNull();
    expect(rec!.deny).toEqual({}); // passed through raw (a non-array), NOT undefined
    const decision = evaluateInstanceToolPolicy(rec, { serverId: "mcp-adapter-default", name: "any" });
    expect(decision).toEqual({ status: "denied", warn: "invalid_policy_deny_all" });
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
