import { describe, expect, it, vi } from "vitest";
import {
  mintServerId,
  resolveServerId,
  assertServerIdNotReserved,
  normalizeRestPath,
  listInstanceServers,
  listEnrolledServers,
  readServer,
  upsertServer,
  retireServer,
  deletePresentUnenrolledServer,
  retireServersForInstance,
  recordServerStatus,
  recordServerExposureMode,
  ensureDefaultServerEnrollment,
  tryAdvanceSiteInventory,
  readSiteInventory,
  CATALOG_DEFAULT_SERVER_ID,
  DEFAULT_SERVER_REST_PATH,
  SYSTEM_SERVER_ENROLLMENT_ACTOR,
  type ServerStoreDeps,
  type ServerStoreQuery,
} from "@/lib/connector-instance-server-store";
import { CATALOG_DEFAULT_SERVER_ID as CACHE_DEFAULT_SERVER_ID } from "@/lib/connector-instance-catalog-cache";

// cinatra#2018 S3 PR-A — persisted multi-server enrollment store. Injected query
// + audit → no real DB (mirrors the connector-instance-tool-policy-store test).

const TS = "2026-07-27T00:00:00.000Z";

type ServerRow = {
  connector_key: string;
  instance_id: string;
  server_id: string;
  source: string;
  status: string;
  adapter_server_id: string | null;
  namespace: string | null;
  route: string | null;
  rest_path: string;
  label: string | null;
  server_version: string | null;
  transports: unknown;
  exposure_mode: string | null;
  unenrolled_reason: string | null;
  enrolled_at: string | null;
  retired_at: string | null;
  verified_at: string | null;
  last_status: string | null;
  last_status_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type InventoryRow = {
  connector_key: string;
  instance_id: string;
  contract_version: string;
  site_id: string;
  origin: string;
  credential_version: number;
  inventory_seq: number;
  site_meta: unknown;
  received_at: string;
};

/**
 * A semantically faithful in-memory Postgres double: it models the guarded
 * upsert WHERE clauses, the conditional-advance gate, and the RETURNING shapes
 * so the store's SQL contract (not just its call graph) is exercised.
 */
function makeStore(): {
  deps: ServerStoreDeps;
  audit: ReturnType<typeof vi.fn>;
  servers: Map<string, ServerRow>;
  inventory: Map<string, InventoryRow>;
} {
  const servers = new Map<string, ServerRow>();
  const inventory = new Map<string, InventoryRow>();
  const key = (ck: string, iid: string, sid: string) => `${ck}::${iid}::${sid}`;
  const ikey = (ck: string, iid: string) => `${ck}::${iid}`;

  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const v = (values ?? []) as unknown[];
    const trimmed = text.trimStart();

    // --- companion site-inventory table -----------------------------------
    if (text.includes("connector_instance_site_inventory")) {
      if (trimmed.startsWith("INSERT")) {
        const [ck, iid, cv, siteId, origin, credVer, seq, siteMetaJson] = v as [
          string, string, string, string, string, number, number, string,
        ];
        const existing = inventory.get(ikey(ck, iid));
        const newer =
          !existing ||
          credVer > existing.credential_version ||
          (credVer === existing.credential_version && seq > existing.inventory_seq);
        if (!newer) return [];
        const row: InventoryRow = {
          connector_key: ck,
          instance_id: iid,
          contract_version: cv,
          site_id: siteId,
          origin,
          credential_version: credVer,
          inventory_seq: seq,
          site_meta: JSON.parse(siteMetaJson),
          received_at: TS,
        };
        inventory.set(ikey(ck, iid), row);
        return [row];
      }
      const [ck, iid] = v as [string, string];
      const row = inventory.get(ikey(ck, iid));
      return row ? [row] : [];
    }

    // --- connector_instance_server: writes ---------------------------------
    if (trimmed.startsWith("INSERT")) {
      if (text.includes("DO NOTHING")) {
        // ensureDefaultServerEnrollment
        const [ck, iid, sid, restPath, createdBy] = v as [string, string, string, string, string];
        const k = key(ck, iid, sid);
        if (servers.has(k)) return []; // conflict → not created
        servers.set(k, {
          ...blankRow(ck, iid, sid),
          source: "default",
          status: "enrolled",
          rest_path: restPath,
          exposure_mode: "triad-only",
          enrolled_at: TS,
          verified_at: TS,
          created_by: createdBy,
        });
        return [{ server_id: sid }];
      }
      // upsertServer (guarded ON CONFLICT DO UPDATE)
      const [
        ck, iid, sid, source, status, adapter, ns, route, restPath, label, ver,
        transports, exposure, unenrolled, enrolledAt, retiredAt, verifiedAt,
        lastStatus, lastStatusAt, createdBy,
      ] = v as [
        string, string, string, string, string, string | null, string | null,
        string | null, string, string | null, string | null, string | null,
        string | null, string | null, string | null, string | null, string | null,
        string | null, string | null, string,
      ];
      const k = key(ck, iid, sid);
      const existing = servers.get(k);
      const nextTransports = transports === null ? null : JSON.parse(transports);
      if (!existing) {
        servers.set(k, {
          connector_key: ck, instance_id: iid, server_id: sid, source, status,
          adapter_server_id: adapter ?? null, namespace: ns ?? null, route: route ?? null,
          rest_path: restPath, label: label ?? null, server_version: ver ?? null,
          transports: nextTransports, exposure_mode: exposure ?? null,
          unenrolled_reason: unenrolled ?? null, enrolled_at: enrolledAt ?? null,
          retired_at: retiredAt ?? null, verified_at: verifiedAt ?? null,
          last_status: lastStatus ?? null, last_status_at: lastStatusAt ?? null,
          created_by: createdBy, created_at: TS, updated_at: TS,
        });
        return [{ server_id: sid }];
      }
      // conflict → guard: same source AND same natural identity
      const guardOk =
        existing.source === source &&
        ((source === "discovered" && (existing.adapter_server_id ?? null) === (adapter ?? null)) ||
          (source === "manual" && existing.rest_path === restPath) ||
          source === "default");
      if (!guardOk) return []; // collision with a DIFFERENT identity → no write
      Object.assign(existing, {
        status, adapter_server_id: adapter ?? null, namespace: ns ?? null,
        route: route ?? null, rest_path: restPath, label: label ?? null,
        server_version: ver ?? null, transports: nextTransports,
        exposure_mode: exposure ?? null, unenrolled_reason: unenrolled ?? null,
        enrolled_at: enrolledAt ?? null, retired_at: retiredAt ?? null,
        verified_at: verifiedAt ?? null, last_status: lastStatus ?? null,
        last_status_at: lastStatusAt ?? null, updated_at: TS,
      });
      return [{ server_id: sid }];
    }

    if (trimmed.startsWith("UPDATE")) {
      if (text.includes("last_status = $4")) {
        const [ck, iid, sid, status, at] = v as [string, string, string, string, string | null];
        const row = servers.get(key(ck, iid, sid));
        if (row) {
          row.last_status = status;
          row.last_status_at = at ?? TS;
          row.updated_at = TS;
        }
        return [];
      }
      if (text.includes("exposure_mode = $4")) {
        const [ck, iid, sid, exposure] = v as [string, string, string, string];
        const row = servers.get(key(ck, iid, sid));
        if (row) {
          row.exposure_mode = exposure;
          row.updated_at = TS;
        }
        return [];
      }
      if (text.includes("status = 'retired'")) {
        if (text.includes("server_id = $3")) {
          // retireServer — discovered-only
          const [ck, iid, sid] = v as [string, string, string];
          const row = servers.get(key(ck, iid, sid));
          if (row && row.source === "discovered" && row.status !== "retired") {
            row.status = "retired";
            row.retired_at = row.retired_at ?? TS;
            row.updated_at = TS;
            return [{ server_id: sid }];
          }
          return [];
        }
        // retireServersForInstance — every non-retired row
        const [ck, iid] = v as [string, string];
        const out: { server_id: string }[] = [];
        for (const row of servers.values()) {
          if (row.connector_key === ck && row.instance_id === iid && row.status !== "retired") {
            row.status = "retired";
            row.retired_at = row.retired_at ?? TS;
            row.updated_at = TS;
            out.push({ server_id: row.server_id });
          }
        }
        return out;
      }
      return [];
    }

    if (trimmed.startsWith("DELETE")) {
      const [ck, iid, sid] = v as [string, string, string];
      const k = key(ck, iid, sid);
      const row = servers.get(k);
      if (row && row.status === "present_unenrolled") {
        servers.delete(k);
        return [{ server_id: sid }];
      }
      return [];
    }

    // --- connector_instance_server: reads ----------------------------------
    if (text.includes("status = 'enrolled'")) {
      const [ck, iid] = v as [string, string];
      return [...servers.values()]
        .filter((r) => r.connector_key === ck && r.instance_id === iid && r.status === "enrolled")
        .sort((a, b) => a.server_id.localeCompare(b.server_id))
        .map((r) => ({ server_id: r.server_id, exposure_mode: r.exposure_mode, rest_path: r.rest_path }));
    }
    if (text.includes("LIMIT 1")) {
      const [ck, iid, sid] = v as [string, string, string];
      const row = servers.get(key(ck, iid, sid));
      return row ? [row] : [];
    }
    // listInstanceServers
    const [ck, iid] = v as [string, string];
    return [...servers.values()]
      .filter((r) => r.connector_key === ck && r.instance_id === iid)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.server_id.localeCompare(b.server_id));
  });

  const audit = vi.fn(async () => {});
  return { deps: { query: query as unknown as ServerStoreQuery, audit }, audit, servers, inventory };
}

function blankRow(ck: string, iid: string, sid: string): ServerRow {
  return {
    connector_key: ck, instance_id: iid, server_id: sid, source: "discovered",
    status: "enrolled", adapter_server_id: null, namespace: null, route: null,
    rest_path: "/", label: null, server_version: null, transports: null,
    exposure_mode: null, unenrolled_reason: null, enrolled_at: null, retired_at: null,
    verified_at: null, last_status: null, last_status_at: null,
    created_by: SYSTEM_SERVER_ENROLLMENT_ACTOR, created_at: TS, updated_at: TS,
  };
}

// A minimal discovered-server upsert input builder for the transition tests.
function discovered(over: Partial<Parameters<typeof upsertServer>[0]> = {}) {
  return {
    connectorKey: "wordpress",
    instanceId: "i1",
    serverId: mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: over.adapterServerId ?? "vendor-a" }),
    source: "discovered" as const,
    status: "enrolled" as const,
    restPath: "/mcp/vendor-a",
    adapterServerId: "vendor-a",
    namespace: "mcp",
    route: "vendor-a",
    createdBy: "system:test",
    enrolledAt: TS,
    verifiedAt: TS,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Identity: mint / digest / guard (pure)
// ---------------------------------------------------------------------------

describe("mintServerId — deterministic digest + v1 versioning (D1)", () => {
  it("is deterministic and prefixed wps- with a 16-hex body", () => {
    const a = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" });
    const b = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" });
    expect(a).toBe(b);
    expect(a).toMatch(/^wps-[0-9a-f]{16}$/);
  });

  it("differs by instanceId, adapterServerId, and discovered-vs-manual kind", () => {
    const base = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" });
    expect(mintServerId({ kind: "discovered", instanceId: "i2", adapterServerId: "vendor-a" })).not.toBe(base);
    expect(mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-b" })).not.toBe(base);
    expect(mintServerId({ kind: "manual", instanceId: "i1", restPath: "/mcp/vendor-a" })).not.toBe(base);
  });

  it("full-digest fallback shares the prefix but is a distinct 64-hex id", () => {
    const short = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" });
    const full = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a", full: true });
    expect(full).toMatch(/^wps-[0-9a-f]{64}$/);
    expect(full.startsWith(short)).toBe(true); // short is the 16-hex prefix of full
    expect(full).not.toBe(short);
  });

  it("a 'v1|' scheme change would mint a distinguishable id (versioning is in the material)", () => {
    // The digest material is `v1|<instanceId>|adapter-id|<adapterServerId>`; two
    // adapter ids that would only collide if the version tag were dropped must
    // still differ. (Guards against silently dropping the version prefix.)
    const withColon = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "adapter-id|x" });
    const plain = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "x" });
    expect(withColon).not.toBe(plain);
  });

  it("manual mint normalizes the rest path before digesting (identity is the canonical route)", () => {
    const a = mintServerId({ kind: "manual", instanceId: "i1", restPath: "/mcp/vendor-a" });
    const b = mintServerId({ kind: "manual", instanceId: "i1", restPath: "/mcp/vendor-a/" });
    const c = mintServerId({ kind: "manual", instanceId: "i1", restPath: "/mcp/vendor-a?x=1" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("never emits a reserved id across many inputs (wps- prefix is the firewall)", () => {
    for (const adapterServerId of ["mcp-adapter-default", "default", "mcp", "a", "z".repeat(120)]) {
      const id = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId });
      expect(id).not.toBe(CATALOG_DEFAULT_SERVER_ID);
      expect(id.startsWith("wps-")).toBe(true);
    }
  });
});

describe("assertServerIdNotReserved — hard-throw guard (D1)", () => {
  it("throws for a reserved id and passes any wps- id", () => {
    expect(() => assertServerIdNotReserved(CATALOG_DEFAULT_SERVER_ID)).toThrow(/reserved/);
    expect(() => assertServerIdNotReserved("wps-deadbeefdeadbeef")).not.toThrow();
  });
});

describe("normalizeRestPath", () => {
  it("forces a single leading slash, trims trailing slashes, drops query/fragment/dot-segments", () => {
    expect(normalizeRestPath("mcp/vendor-a")).toBe("/mcp/vendor-a");
    expect(normalizeRestPath("/mcp/vendor-a/")).toBe("/mcp/vendor-a");
    expect(normalizeRestPath("/mcp/vendor-a?rest_route=x#frag")).toBe("/mcp/vendor-a");
    expect(normalizeRestPath("/mcp/./vendor-a/../vendor-a")).toBe("/mcp/vendor-a");
    expect(normalizeRestPath("/")).toBe("/");
  });
});

describe("resolveServerId — PK-collision fallback (D1)", () => {
  it("returns the 16-hex id when free", () => {
    const id = resolveServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" }, () => false);
    expect(id).toMatch(/^wps-[0-9a-f]{16}$/);
  });

  it("falls back to the full 64-hex digest when the short id is TAKEN by a different identity", () => {
    const short = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" });
    const full = mintServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a", full: true });
    const id = resolveServerId(
      { kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" },
      (candidate) => candidate === short, // short collides, full is free
    );
    expect(id).toBe(full);
  });

  it("throws loudly if even the full digest is taken (no silent adoption)", () => {
    expect(() =>
      resolveServerId({ kind: "discovered", instanceId: "i1", adapterServerId: "vendor-a" }, () => true),
    ).toThrow(/collision/);
  });
});

// ---------------------------------------------------------------------------
// connector_instance_server: transitions (store)
// ---------------------------------------------------------------------------

describe("upsertServer — insert / metadata-update / revive transitions", () => {
  it("inserts a new discovered row (written: true) and reads it back", async () => {
    const { deps } = makeStore();
    const input = discovered();
    expect(await upsertServer(input, deps)).toEqual({ written: true });
    const row = await readServer("wordpress", "i1", input.serverId, deps);
    expect(row).toMatchObject({ source: "discovered", status: "enrolled", adapterServerId: "vendor-a", restPath: "/mcp/vendor-a" });
  });

  it("updates metadata on the SAME identity WITHOUT resetting enrolled_at (route move, D1)", async () => {
    const { deps } = makeStore();
    const input = discovered({ enrolledAt: "2020-01-01T00:00:00.000Z" });
    await upsertServer(input, deps);
    // Same adapterServerId, new restPath/label — a route move on the same row.
    await upsertServer({ ...input, restPath: "/mcp/vendor-a-moved", label: "Renamed", enrolledAt: "2020-01-01T00:00:00.000Z" }, deps);
    const row = await readServer("wordpress", "i1", input.serverId, deps);
    expect(row).toMatchObject({ restPath: "/mcp/vendor-a-moved", label: "Renamed", enrolledAt: "2020-01-01T00:00:00.000Z" });
  });

  it("revives a retired row of the same identity (status → enrolled, new enrolled_at)", async () => {
    const { deps } = makeStore();
    const input = discovered();
    await upsertServer(input, deps);
    await retireServer("wordpress", "i1", input.serverId, deps);
    expect((await readServer("wordpress", "i1", input.serverId, deps))?.status).toBe("retired");
    // Revive: reconciler recomputes desired state (enrolled + fresh enrolled_at).
    await upsertServer({ ...input, status: "enrolled", enrolledAt: TS, retiredAt: null }, deps);
    const row = await readServer("wordpress", "i1", input.serverId, deps);
    expect(row).toMatchObject({ status: "enrolled", retiredAt: null });
  });

  it("REFUSES to adopt a colliding row of a DIFFERENT identity (written: false — D1 no silent adoption)", async () => {
    const { deps, servers } = makeStore();
    const first = discovered({ adapterServerId: "vendor-a" });
    await upsertServer(first, deps);
    // A different adapterServerId that (hypothetically) hashed to the same
    // server_id must NOT overwrite the existing row.
    const collidingSameId = { ...discovered({ adapterServerId: "vendor-b" }), serverId: first.serverId };
    expect(await upsertServer(collidingSameId, deps)).toEqual({ written: false });
    // The stored row still belongs to vendor-a.
    expect([...servers.values()][0]!.adapter_server_id).toBe("vendor-a");
  });
});

describe("retireServer — manual-clobber protection at the store layer (§5)", () => {
  it("retires a discovered row", async () => {
    const { deps } = makeStore();
    const input = discovered();
    await upsertServer(input, deps);
    expect(await retireServer("wordpress", "i1", input.serverId, deps)).toEqual({ retired: true });
    expect((await readServer("wordpress", "i1", input.serverId, deps))?.status).toBe("retired");
  });

  it("NEVER retires a manual row (WHERE source='discovered' → no-op)", async () => {
    const { deps } = makeStore();
    const manual = {
      connectorKey: "wordpress", instanceId: "i1",
      serverId: mintServerId({ kind: "manual", instanceId: "i1", restPath: "/mcp/manual" }),
      source: "manual" as const, status: "enrolled" as const, restPath: "/mcp/manual",
      createdBy: "admin-user", enrolledAt: TS, verifiedAt: TS,
    };
    await upsertServer(manual, deps);
    expect(await retireServer("wordpress", "i1", manual.serverId, deps)).toEqual({ retired: false });
    expect((await readServer("wordpress", "i1", manual.serverId, deps))?.status).toBe("enrolled");
  });

  it("NEVER retires the default row via the single-server retire", async () => {
    const { deps } = makeStore();
    await ensureDefaultServerEnrollment({ connectorKey: "wordpress", instanceId: "i1" }, deps);
    expect(await retireServer("wordpress", "i1", CATALOG_DEFAULT_SERVER_ID, deps)).toEqual({ retired: false });
    expect((await readServer("wordpress", "i1", CATALOG_DEFAULT_SERVER_ID, deps))?.status).toBe("enrolled");
  });
});

describe("retireServersForInstance — instance delete (§6 event 5)", () => {
  it("retires every non-retired row regardless of source", async () => {
    const { deps } = makeStore();
    await ensureDefaultServerEnrollment({ connectorKey: "wordpress", instanceId: "i1" }, deps);
    await upsertServer(discovered({ adapterServerId: "vendor-a" }), deps);
    const res = await retireServersForInstance("wordpress", "i1", deps);
    expect(res.retired).toBe(2);
    const rows = await listInstanceServers("wordpress", "i1", deps);
    expect(rows.every((r) => r.status === "retired")).toBe(true);
  });
});

describe("deletePresentUnenrolledServer — informational replace-semantics (§5 step 4)", () => {
  it("deletes only a present_unenrolled row, never an enrolled/retired one", async () => {
    const { deps } = makeStore();
    const pu = discovered({ adapterServerId: "stdio-only", status: "present_unenrolled", unenrolledReason: "custom_transport", enrolledAt: null, verifiedAt: null });
    await upsertServer(pu, deps);
    expect(await deletePresentUnenrolledServer("wordpress", "i1", pu.serverId, deps)).toEqual({ deleted: true });
    expect(await readServer("wordpress", "i1", pu.serverId, deps)).toBeNull();

    const enrolled = discovered({ adapterServerId: "vendor-a" });
    await upsertServer(enrolled, deps);
    expect(await deletePresentUnenrolledServer("wordpress", "i1", enrolled.serverId, deps)).toEqual({ deleted: false });
    expect(await readServer("wordpress", "i1", enrolled.serverId, deps)).not.toBeNull();
  });
});

describe("recordServerStatus / recordServerExposureMode — health + classification write-back", () => {
  it("stamps the health verdict and the classified exposure mode", async () => {
    const { deps } = makeStore();
    const input = discovered();
    await upsertServer(input, deps);
    await recordServerStatus({ connectorKey: "wordpress", instanceId: "i1", serverId: input.serverId, status: "catalog_unavailable" }, deps);
    await recordServerExposureMode({ connectorKey: "wordpress", instanceId: "i1", serverId: input.serverId, exposureMode: "first-class" }, deps);
    const row = await readServer("wordpress", "i1", input.serverId, deps);
    expect(row).toMatchObject({ lastStatus: "catalog_unavailable", exposureMode: "first-class" });
  });
});

describe("ensureDefaultServerEnrollment — create-if-absent backstop + audit (mirrors ensureDefaultOpenPolicy)", () => {
  it("creates the pinned triad-only default row + audits once; no-op + no audit on conflict", async () => {
    const { deps, audit } = makeStore();
    const first = await ensureDefaultServerEnrollment({ connectorKey: "wordpress", instanceId: "i1" }, deps);
    expect(first).toEqual({ created: true });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      actorPrincipalType: "system",
      operation: "server_default_enrolled",
      metadata: { serverId: CATALOG_DEFAULT_SERVER_ID, source: "default", createdBy: SYSTEM_SERVER_ENROLLMENT_ACTOR },
    });
    const row = await readServer("wordpress", "i1", CATALOG_DEFAULT_SERVER_ID, deps);
    expect(row).toMatchObject({ source: "default", status: "enrolled", exposureMode: "triad-only", restPath: DEFAULT_SERVER_REST_PATH });

    const second = await ensureDefaultServerEnrollment({ connectorKey: "wordpress", instanceId: "i1" }, deps);
    expect(second).toEqual({ created: false });
    expect(audit).toHaveBeenCalledTimes(1); // no second audit
  });
});

describe("listEnrolledServers — minimal invoker projection (codex round-0 #6)", () => {
  it("returns only enrolled servers, projected to {serverId, exposureMode, restPath}", async () => {
    const { deps } = makeStore();
    await ensureDefaultServerEnrollment({ connectorKey: "wordpress", instanceId: "i1" }, deps);
    const a = discovered({ adapterServerId: "vendor-a" });
    await upsertServer(a, deps);
    const retiredOne = discovered({ adapterServerId: "vendor-b", restPath: "/mcp/vendor-b" });
    await upsertServer(retiredOne, deps);
    await retireServer("wordpress", "i1", retiredOne.serverId, deps);

    const enrolled = await listEnrolledServers("wordpress", "i1", deps);
    const ids = enrolled.map((s) => s.serverId);
    expect(ids).toContain(CATALOG_DEFAULT_SERVER_ID);
    expect(ids).toContain(a.serverId);
    expect(ids).not.toContain(retiredOne.serverId);
    // Projection shape only — no health/history fields leak.
    expect(Object.keys(enrolled[0]!).sort()).toEqual(["exposureMode", "restPath", "serverId"]);
  });
});

// ---------------------------------------------------------------------------
// connector_instance_site_inventory: atomic conditional-advance gate (§4.1)
// ---------------------------------------------------------------------------

describe("tryAdvanceSiteInventory — anti-replay/ordering gate (§4.1 step 5)", () => {
  const base = {
    connectorKey: "wordpress", instanceId: "i1", contractVersion: "v1",
    siteId: "site-1", origin: "https://example.com", siteMeta: { wpVersion: "6.9.1" },
  };

  it("bootstraps on the no-row case (INSERT) and returns the accepted row", async () => {
    const { deps } = makeStore();
    const row = await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 5 }, deps);
    expect(row).toMatchObject({ credentialVersion: 1, inventorySeq: 5, contractVersion: "v1", siteId: "site-1" });
    expect(await readSiteInventory("wordpress", "i1", deps)).toMatchObject({ inventorySeq: 5 });
  });

  it("accepts a strictly-higher seq within the same epoch", async () => {
    const { deps } = makeStore();
    await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 5 }, deps);
    const row = await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 6 }, deps);
    expect(row?.inventorySeq).toBe(6);
  });

  it("REJECTS a lower or equal seq within the same epoch (stale → null, nothing advanced)", async () => {
    const { deps } = makeStore();
    await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 5 }, deps);
    expect(await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 5 }, deps)).toBeNull();
    expect(await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 4 }, deps)).toBeNull();
    expect((await readSiteInventory("wordpress", "i1", deps))?.inventorySeq).toBe(5); // unchanged
  });

  it("accepts a higher epoch even with a RESET (lower) seq — rotation recovery", async () => {
    const { deps } = makeStore();
    await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 42 }, deps);
    const row = await tryAdvanceSiteInventory({ ...base, credentialVersion: 2, inventorySeq: 0 }, deps);
    expect(row).toMatchObject({ credentialVersion: 2, inventorySeq: 0 });
  });

  it("REJECTS a lower epoch even with a higher seq (a pre-rotation capture can't win)", async () => {
    const { deps } = makeStore();
    await tryAdvanceSiteInventory({ ...base, credentialVersion: 2, inventorySeq: 1 }, deps);
    expect(await tryAdvanceSiteInventory({ ...base, credentialVersion: 1, inventorySeq: 9999 }, deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

describe("default-server identity drift guard", () => {
  it("CATALOG_DEFAULT_SERVER_ID equals the catalog cache's grandfathered constant", () => {
    expect(CATALOG_DEFAULT_SERVER_ID).toBe(CACHE_DEFAULT_SERVER_ID);
    expect(CATALOG_DEFAULT_SERVER_ID).toBe("mcp-adapter-default");
  });
});
