import { describe, expect, it, vi } from "vitest";
import {
  __resetServerHealthRefreshDebounceForTests,
  addManualServerRoute,
  applySiteInventory,
  isSiteInventoryStrictlyNewer,
  listInstanceServersWithHealthRefresh,
  removeManualServerRoute,
  MANUAL_SERVER_REST_PATH_PATTERN,
  type WordPressServerEnrollmentDeps,
  type WordPressServerEnrollmentStore,
} from "@/lib/connector-instance-server-enrollment";
import {
  CATALOG_DEFAULT_SERVER_ID,
  DEFAULT_SERVER_REST_PATH,
  SYSTEM_SERVER_ENROLLMENT_ACTOR,
  mintServerId,
  type ConnectorInstanceServerRecord,
  type UpsertServerInput,
} from "@/lib/connector-instance-server-store";
import { wpSiteInventoryV1Schema, type WpSiteInventoryV1 } from "@/lib/connector-instance-site-inventory-contract";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import goldenFixture from "./__fixtures__/wp-site-inventory-v1.json";

// cinatra#2018 S3 — the enrollment reconciler: diff-apply add/update/retire/
// revive with manual-preserve + default-always, the manual-route verify-then-
// enroll machinery, the pure ordering-acceptance rule, and the S7 read's
// debounced health refresh. All against an injected in-memory store.

const CK = "wordpress";
const IID = "inst-1";
const TS = 1_753_600_000_000; // fixed clock
const TS_ISO = new Date(TS).toISOString();

function parseFixture(): WpSiteInventoryV1 {
  return wpSiteInventoryV1Schema.parse(structuredClone(goldenFixture));
}

function baseRow(over: Partial<ConnectorInstanceServerRecord>): ConnectorInstanceServerRecord {
  return {
    connectorKey: CK,
    instanceId: IID,
    serverId: "wps-x",
    source: "discovered",
    status: "enrolled",
    adapterServerId: null,
    namespace: null,
    route: null,
    restPath: "/",
    label: null,
    serverVersion: null,
    transports: null,
    exposureMode: null,
    unenrolledReason: null,
    enrolledAt: null,
    retiredAt: null,
    verifiedAt: null,
    lastStatus: null,
    lastStatusAt: null,
    createdBy: SYSTEM_SERVER_ENROLLMENT_ACTOR,
    createdAt: TS_ISO,
    updatedAt: TS_ISO,
    ...over,
  };
}

/** In-memory store double replicating the real store's guards (identity-
 * preserving upsert, discovered-only retire, pinned deletes). */
function makeStore(seed: ConnectorInstanceServerRecord[] = []) {
  const rows = new Map<string, ConnectorInstanceServerRecord>(seed.map((r) => [r.serverId, r]));
  const calls = {
    retire: [] as string[],
    deletePresent: [] as string[],
    deleteManual: [] as string[],
    recordStatus: [] as Array<{ serverId: string; status: string }>,
  };
  const store: WordPressServerEnrollmentStore = {
    listInstanceServers: async () => [...rows.values()].map((r) => ({ ...r })),
    ensureDefaultServerEnrollment: async () => {
      if (rows.has(CATALOG_DEFAULT_SERVER_ID)) return { created: false };
      rows.set(
        CATALOG_DEFAULT_SERVER_ID,
        baseRow({
          serverId: CATALOG_DEFAULT_SERVER_ID,
          source: "default",
          status: "enrolled",
          restPath: DEFAULT_SERVER_REST_PATH,
          exposureMode: "triad-only",
          enrolledAt: TS_ISO,
          verifiedAt: TS_ISO,
        }),
      );
      return { created: true };
    },
    upsertServer: async (input: UpsertServerInput) => {
      const existing = rows.get(input.serverId);
      if (existing) {
        const sameIdentity =
          existing.source === input.source &&
          ((input.source === "discovered" &&
            (existing.adapterServerId ?? null) === (input.adapterServerId ?? null)) ||
            (input.source === "manual" && existing.restPath === input.restPath) ||
            input.source === "default");
        if (!sameIdentity) return { written: false };
      }
      rows.set(input.serverId, {
        ...baseRow({}),
        ...(existing ? { createdBy: existing.createdBy, createdAt: existing.createdAt } : {}),
        connectorKey: input.connectorKey,
        instanceId: input.instanceId,
        serverId: input.serverId,
        source: input.source,
        status: input.status,
        adapterServerId: input.adapterServerId ?? null,
        namespace: input.namespace ?? null,
        route: input.route ?? null,
        restPath: input.restPath,
        label: input.label ?? null,
        serverVersion: input.serverVersion ?? null,
        transports: input.transports ?? null,
        exposureMode: input.exposureMode ?? null,
        unenrolledReason: input.unenrolledReason ?? null,
        enrolledAt: input.enrolledAt ?? null,
        retiredAt: input.retiredAt ?? null,
        verifiedAt: input.verifiedAt ?? null,
        lastStatus: input.lastStatus ?? null,
        lastStatusAt: input.lastStatusAt ?? null,
        ...(existing ? {} : { createdBy: input.createdBy }),
      });
      return { written: true };
    },
    retireServer: async (_ck, _iid, serverId) => {
      const row = rows.get(serverId);
      if (!row || row.source !== "discovered" || row.status === "retired") {
        return { retired: false };
      }
      row.status = "retired";
      row.retiredAt = TS_ISO;
      calls.retire.push(serverId);
      return { retired: true };
    },
    deletePresentUnenrolledServer: async (_ck, _iid, serverId) => {
      const row = rows.get(serverId);
      if (!row || row.status !== "present_unenrolled") return { deleted: false };
      rows.delete(serverId);
      calls.deletePresent.push(serverId);
      return { deleted: true };
    },
    deleteManualServer: async (_ck, _iid, serverId) => {
      const row = rows.get(serverId);
      if (!row || row.source !== "manual") return { deleted: false };
      rows.delete(serverId);
      calls.deleteManual.push(serverId);
      return { deleted: true };
    },
    recordServerStatus: async (input) => {
      calls.recordStatus.push({ serverId: input.serverId, status: input.status });
      const row = rows.get(input.serverId);
      if (row) row.lastStatus = input.status as ConnectorInstanceServerRecord["lastStatus"];
    },
  };
  return { store, rows, calls };
}

/** The audit-event shape the deps slot carries — spelled on the spy so
 * `mock.calls` rows are indexable tuples (the audit assertions read c[0]). */
type EnrollmentAuditEvent = Parameters<NonNullable<WordPressServerEnrollmentDeps["audit"]>>[0];

function makeDeps(
  seed: ConnectorInstanceServerRecord[] = [],
  over: Partial<WordPressServerEnrollmentDeps> = {},
) {
  const { store, rows, calls } = makeStore(seed);
  const onServerInvalidated = vi.fn();
  const audit = vi.fn<(event: EnrollmentAuditEvent) => Promise<void>>(async () => {});
  const deps: WordPressServerEnrollmentDeps = {
    store,
    onServerInvalidated,
    audit,
    now: () => TS,
    ...over,
  };
  return { deps, rows, calls, onServerInvalidated, audit };
}

const VENDOR_ID = mintServerId({ kind: "discovered", instanceId: IID, adapterServerId: "fixture-vendor-server" });

describe("isSiteInventoryStrictlyNewer — the ordering acceptance rule (pure)", () => {
  const stored = { credentialVersion: 3, inventorySeq: 10 };
  it("no stored pair always accepts", () => {
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 1, inventorySeq: 0 }, null)).toBe(true);
  });
  it("same epoch: strictly higher sequence accepts; equal and lower reject", () => {
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 3, inventorySeq: 11 }, stored)).toBe(true);
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 3, inventorySeq: 10 }, stored)).toBe(false);
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 3, inventorySeq: 9 }, stored)).toBe(false);
  });
  it("credential rotation resets the epoch: a higher generation accepts even a restarted sequence", () => {
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 4, inventorySeq: 0 }, stored)).toBe(true);
    expect(isSiteInventoryStrictlyNewer({ credentialVersion: 2, inventorySeq: 999 }, stored)).toBe(false);
  });
});

describe("applySiteInventory — first intake of the golden fixture", () => {
  it("ensures the default, enrolls the eligible vendor server, surfaces the two ineligible entries", async () => {
    const { deps, rows } = makeDeps();
    const result = await applySiteInventory(
      { connectorKey: CK, instanceId: IID, payload: parseFixture(), siteId: "site-1" },
      deps,
    );
    // default entry + vendor entry enrolled; stdio + dedicated-auth surfaced.
    expect(result).toEqual({ enrolled: 2, presentUnenrolled: 2, retired: 0 });

    const defaultRow = rows.get(CATALOG_DEFAULT_SERVER_ID)!;
    expect(defaultRow).toMatchObject({
      source: "default",
      status: "enrolled",
      restPath: DEFAULT_SERVER_REST_PATH,
      exposureMode: "triad-only",
      label: "MCP Adapter Default Server",
    });

    const vendor = rows.get(VENDOR_ID)!;
    expect(vendor).toMatchObject({
      source: "discovered",
      status: "enrolled",
      adapterServerId: "fixture-vendor-server",
      restPath: "/mcp/fixture-vendor-server",
      exposureMode: null, // classified on first catalog load, not from the payload
      verifiedAt: TS_ISO,
      createdBy: SYSTEM_SERVER_ENROLLMENT_ACTOR,
    });

    const unenrolled = [...rows.values()].filter((r) => r.status === "present_unenrolled");
    expect(unenrolled.map((r) => [r.adapterServerId, r.unenrolledReason]).sort()).toEqual([
      ["fixture-dedicated-auth-server", "custom_auth"],
      ["fixture-stdio-only-server", "custom_transport"],
    ]);
    // Surfaced rows are NEVER enrolled.
    expect(unenrolled.every((r) => r.enrolledAt === null)).toBe(true);
  });

  it("is idempotent: re-applying the same payload converges (no retires, no metadata audits)", async () => {
    const { deps, audit, calls } = makeDeps();
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload: parseFixture() }, deps);
    audit.mockClear();
    const second = await applySiteInventory(
      { connectorKey: CK, instanceId: IID, payload: parseFixture() },
      deps,
    );
    expect(second).toEqual({ enrolled: 2, presentUnenrolled: 2, retired: 0 });
    expect(calls.retire).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("applySiteInventory — lifecycle transitions", () => {
  async function seededDeps() {
    const made = makeDeps();
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload: parseFixture() }, made.deps);
    made.audit.mockClear();
    made.onServerInvalidated.mockClear();
    return made;
  }

  it("a route move under the SAME adapterServerId keeps the SAME serverId, invalidates, audits", async () => {
    const { deps, rows, audit, onServerInvalidated } = await seededDeps();
    const payload = parseFixture();
    const vendor = payload.servers.find((s) => s.adapterServerId === "fixture-vendor-server")!;
    vendor.route = "fixture-vendor-server-v2";
    vendor.restPath = "/mcp/fixture-vendor-server-v2";
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);

    const row = rows.get(VENDOR_ID)!; // SAME identity — no orphaned caches/health
    expect(row.restPath).toBe("/mcp/fixture-vendor-server-v2");
    expect(row.status).toBe("enrolled");
    expect(onServerInvalidated).toHaveBeenCalledWith(IID, VENDOR_ID);
    const metadataAudit = audit.mock.calls.find(
      (c) => (c[0] as { operation: string }).operation === "server_identity_metadata_changed",
    );
    expect(metadataAudit?.[0]).toMatchObject({
      metadata: { serverId: VENDOR_ID, changed: ["route"] },
    });
  });

  it("name/version changes audit with the changed field list", async () => {
    const { deps, audit } = await seededDeps();
    const payload = parseFixture();
    const vendor = payload.servers.find((s) => s.adapterServerId === "fixture-vendor-server")!;
    vendor.name = "Renamed Vendor Server";
    vendor.version = "2.0.0";
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    const metadataAudit = audit.mock.calls.find(
      (c) => (c[0] as { operation: string }).operation === "server_identity_metadata_changed",
    );
    expect(metadataAudit?.[0]).toMatchObject({ metadata: { changed: ["name", "version"] } });
  });

  it("absence retires a discovered enrolled server (fail closed) and deletes informational rows", async () => {
    const { deps, rows, calls, onServerInvalidated } = await seededDeps();
    const payload = parseFixture();
    payload.servers = payload.servers.filter((s) => s.isDefault); // only the default remains
    const result = await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(result.retired).toBe(1);
    expect(rows.get(VENDOR_ID)!.status).toBe("retired");
    expect(onServerInvalidated).toHaveBeenCalledWith(IID, VENDOR_ID);
    // present_unenrolled rows have replace semantics — deleted, not tombstoned.
    expect(calls.deletePresent).toHaveLength(2);
    expect([...rows.values()].some((r) => r.status === "present_unenrolled")).toBe(false);
  });

  it("re-appearance REVIVES the retired identity (same row, fresh enrolledAt, audited)", async () => {
    const { deps, rows, audit } = await seededDeps();
    const withoutVendor = parseFixture();
    withoutVendor.servers = withoutVendor.servers.filter(
      (s) => s.adapterServerId !== "fixture-vendor-server",
    );
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload: withoutVendor }, deps);
    expect(rows.get(VENDOR_ID)!.status).toBe("retired");

    audit.mockClear();
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload: parseFixture() }, deps);
    const row = rows.get(VENDOR_ID)!;
    expect(row.status).toBe("enrolled");
    expect(row.retiredAt).toBeNull();
    expect(row.enrolledAt).toBe(TS_ISO);
    expect(
      audit.mock.calls.some((c) => (c[0] as { operation: string }).operation === "server_reenrolled"),
    ).toBe(true);
  });

  it("manual rows are NEVER touched by reconciliation", async () => {
    const manualId = mintServerId({ kind: "manual", instanceId: IID, restPath: "/mcp/hand-added" });
    const { deps, rows, calls } = makeDeps([
      baseRow({
        serverId: manualId,
        source: "manual",
        restPath: "/mcp/hand-added",
        enrolledAt: TS_ISO,
        createdBy: "admin-1",
      }),
    ]);
    const payload = parseFixture(); // does not mention the manual route
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(rows.get(manualId)).toMatchObject({ status: "enrolled", source: "manual" });
    expect(calls.retire).not.toContain(manualId);
    expect(calls.deleteManual).toEqual([]);
  });

  it("default always enrolled: an empty enumeration never touches the default row", async () => {
    const { deps, rows } = await seededDeps();
    const payload = parseFixture();
    payload.site.adapterVersion = null;
    payload.servers = [];
    const result = await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(rows.get(CATALOG_DEFAULT_SERVER_ID)!.status).toBe("enrolled");
    expect(rows.get(VENDOR_ID)!.status).toBe("retired"); // adapter absent ⇒ discovered retire
    expect(result.enrolled).toBe(0);
  });

  it("an enrolled server that turns ineligible transitions to present_unenrolled and loses its snapshot", async () => {
    const { deps, rows, onServerInvalidated } = await seededDeps();
    const payload = parseFixture();
    const vendor = payload.servers.find((s) => s.adapterServerId === "fixture-vendor-server")!;
    vendor.requiresDedicatedAuth = true;
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(rows.get(VENDOR_ID)).toMatchObject({
      status: "present_unenrolled",
      unenrolledReason: "custom_auth",
    });
    expect(onServerInvalidated).toHaveBeenCalledWith(IID, VENDOR_ID);
  });

  it("a route move while PARKED present_unenrolled still audits the identity-metadata change", async () => {
    const { deps, rows, audit, onServerInvalidated } = await seededDeps();
    const stdioId = mintServerId({
      kind: "discovered",
      instanceId: IID,
      adapterServerId: "fixture-stdio-only-server",
    });
    const payload = parseFixture();
    const stdio = payload.servers.find((s) => s.adapterServerId === "fixture-stdio-only-server")!;
    stdio.route = "fixture-stdio-only-server-v2";
    stdio.restPath = "/mcp/fixture-stdio-only-server-v2";
    stdio.name = "Renamed Stdio Server";
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    // Still parked (ineligible), but the drift is on the row AND on the trail.
    expect(rows.get(stdioId)).toMatchObject({
      status: "present_unenrolled",
      restPath: "/mcp/fixture-stdio-only-server-v2",
    });
    const metadataAudit = audit.mock.calls.find(
      (c) => (c[0] as { operation: string }).operation === "server_identity_metadata_changed",
    );
    expect(metadataAudit?.[0]).toMatchObject({
      metadata: { serverId: stdioId, changed: ["route", "name"], status: "present_unenrolled" },
    });
    expect(onServerInvalidated).toHaveBeenCalledWith(IID, stdioId);
  });

  it("a default entry cannot suppress a discovered identity's retire (registry ids never map onto the default row)", async () => {
    const { deps, rows } = await seededDeps();
    // Craft a payload whose ONLY entry is the default server; the vendor
    // server is absent and must retire even though a default entry exists.
    const payload = parseFixture();
    payload.servers = payload.servers.filter((s) => s.isDefault);
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(rows.get(VENDOR_ID)!.status).toBe("retired");
    expect(rows.get(CATALOG_DEFAULT_SERVER_ID)!.status).toBe("enrolled");
  });

  it("a present_unenrolled server that turns eligible enrolls on the SAME identity row", async () => {
    const { deps, rows } = await seededDeps();
    const stdioId = mintServerId({
      kind: "discovered",
      instanceId: IID,
      adapterServerId: "fixture-stdio-only-server",
    });
    const payload = parseFixture();
    const stdio = payload.servers.find((s) => s.adapterServerId === "fixture-stdio-only-server")!;
    stdio.transports = ["streamable-http", "stdio"];
    await applySiteInventory({ connectorKey: CK, instanceId: IID, payload }, deps);
    expect(rows.get(stdioId)).toMatchObject({
      status: "enrolled",
      unenrolledReason: null,
      enrolledAt: TS_ISO,
    });
  });
});

// ---------------------------------------------------------------------------
// Manual routes
// ---------------------------------------------------------------------------

const INSTANCE = {
  siteUrl: "https://site.test",
  username: "svc",
  applicationPassword: "pw",
};

function manualDeps(over: Partial<WordPressServerEnrollmentDeps> = {}) {
  const probeServer = vi.fn(async () => "registered" as const);
  const listTools = vi.fn(async () => [{ name: "vendor_tool", inputSchema: {} }]);
  const made = makeDeps([], {
    resolveInstance: () => INSTANCE,
    verifier: { probeServer, listTools },
    resolveEndpoint: (siteUrl, restPath) => `${siteUrl}/index.php?rest_route=${restPath}`,
    ...over,
  });
  return { ...made, probeServer, listTools };
}

describe("addManualServerRoute — verify-then-enroll (strict preconditions)", () => {
  it("happy path: probe + MCP handshake verified → manual row with classified exposure + audit", async () => {
    const { deps, rows, probeServer, listTools, audit } = manualDeps();
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/hand-added", actor: "admin-1" },
      deps,
    );
    expect(result).toMatchObject({ ok: true, restPath: "/mcp/hand-added", exposureMode: "first-class" });
    expect(probeServer).toHaveBeenCalledWith(INSTANCE, "/mcp/hand-added");
    expect(listTools).toHaveBeenCalledWith({
      endpoint: "https://site.test/index.php?rest_route=/mcp/hand-added",
      authHeader: `Basic ${Buffer.from("svc:pw", "utf8").toString("base64")}`,
    });
    const serverId = (result as { serverId: string }).serverId;
    expect(rows.get(serverId)).toMatchObject({
      source: "manual",
      status: "enrolled",
      createdBy: "admin-1",
      verifiedAt: TS_ISO,
      lastStatus: "registered",
    });
    expect(
      audit.mock.calls.some(
        (c) => (c[0] as { operation: string }).operation === "server_manual_enrolled",
      ),
    ).toBe(true);
  });

  it("rejects malformed paths (charset, dot-segments, query/fragment) with NOTHING persisted", async () => {
    const { deps, rows } = manualDeps();
    for (const bad of ["mcp/no-leading-slash", "/mcp/../admin", "/mcp/x?y=1", "/mcp/x#f", "/mcp/space here", "/index.php"]) {
      const result = await addManualServerRoute(
        { connectorKey: CK, instanceId: IID, restPath: bad, actor: "admin-1" },
        deps,
      );
      expect(result.ok).toBe(false);
    }
    expect(rows.size).toBe(0);
  });

  it("accepts a pasted SAME-ORIGIN URL (reduced to its path; /wp-json prefix stripped)", async () => {
    const { deps } = manualDeps();
    const result = await addManualServerRoute(
      {
        connectorKey: CK,
        instanceId: IID,
        restPath: "https://site.test/wp-json/mcp/hand-added",
        actor: "admin-1",
      },
      deps,
    );
    expect(result).toMatchObject({ ok: true, restPath: "/mcp/hand-added" });
  });

  it("rejects a foreign-origin URL", async () => {
    const { deps, rows } = manualDeps();
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "https://evil.test/mcp/x", actor: "admin-1" },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "foreign_origin" });
    expect(rows.size).toBe(0);
  });

  it("rejects the default server's route as reserved", async () => {
    const { deps } = manualDeps();
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: DEFAULT_SERVER_REST_PATH, actor: "admin-1" },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "reserved_route" });
  });

  it("probe failure persists NOTHING (typed status returned)", async () => {
    const { deps, rows, listTools } = manualDeps({
      verifier: {
        probeServer: vi.fn(async () => "not_installed" as const),
        listTools: vi.fn(async () => []),
      },
    });
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/missing", actor: "admin-1" },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "probe_failed", probeStatus: "not_installed" });
    expect(rows.size).toBe(0);
    expect(listTools).not.toHaveBeenCalled();
  });

  it("MCP verification failure persists NOTHING (typed transport code surfaced)", async () => {
    const { deps, rows } = manualDeps({
      verifier: {
        probeServer: vi.fn(async () => "registered" as const),
        listTools: vi.fn(async () => {
          throw new InvokerError("session_required");
        }),
      },
    });
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/handshake-fails", actor: "admin-1" },
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: "verification_failed",
      errorCode: "session_required",
    });
    expect(rows.size).toBe(0);
  });

  it("re-adding the same path re-verifies onto the SAME row and preserves created_by", async () => {
    const { deps, rows } = manualDeps();
    const first = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/hand-added", actor: "admin-1" },
      deps,
    );
    const second = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/hand-added", actor: "admin-2" },
      deps,
    );
    const firstId = (first as { serverId: string }).serverId;
    expect((second as { serverId: string }).serverId).toBe(firstId);
    expect(rows.get(firstId)!.createdBy).toBe("admin-1");
    expect(rows.size).toBe(1);
  });

  it("unresolvable instance/credential → typed rejection", async () => {
    const { deps } = manualDeps({ resolveInstance: () => null });
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/x", actor: "admin-1" },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "instance_unresolvable" });
  });

  it("a store identity-guard refusal (race) → conflict; no audit, no invalidation, nothing claimed persisted", async () => {
    const made = manualDeps();
    made.deps.store.upsertServer = async () => ({ written: false });
    const result = await addManualServerRoute(
      { connectorKey: CK, instanceId: IID, restPath: "/mcp/raced", actor: "admin-1" },
      made.deps,
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(made.onServerInvalidated).not.toHaveBeenCalled();
    expect(
      made.audit.mock.calls.some(
        (c) => (c[0] as { operation: string }).operation === "server_manual_enrolled",
      ),
    ).toBe(false);
  });
});

describe("removeManualServerRoute — manual rows only", () => {
  it("removes a manual row (invalidation + audit); refuses discovered rows; not_found on unknown", async () => {
    const manualId = mintServerId({ kind: "manual", instanceId: IID, restPath: "/mcp/hand-added" });
    const discoveredId = mintServerId({
      kind: "discovered",
      instanceId: IID,
      adapterServerId: "vendor-x",
    });
    const { deps, rows, onServerInvalidated, audit } = makeDeps([
      baseRow({ serverId: manualId, source: "manual", restPath: "/mcp/hand-added", createdBy: "admin-1" }),
      baseRow({ serverId: discoveredId, adapterServerId: "vendor-x", restPath: "/mcp/vendor-x" }),
    ]);

    expect(
      await removeManualServerRoute(
        { connectorKey: CK, instanceId: IID, serverId: discoveredId, actor: "admin-1" },
        deps,
      ),
    ).toEqual({ ok: false, reason: "not_manual" });
    expect(rows.has(discoveredId)).toBe(true);

    expect(
      await removeManualServerRoute(
        { connectorKey: CK, instanceId: IID, serverId: manualId, actor: "admin-1" },
        deps,
      ),
    ).toEqual({ ok: true });
    expect(rows.has(manualId)).toBe(false);
    expect(onServerInvalidated).toHaveBeenCalledWith(IID, manualId);
    expect(
      audit.mock.calls.some(
        (c) => (c[0] as { operation: string }).operation === "server_manual_removed",
      ),
    ).toBe(true);

    expect(
      await removeManualServerRoute(
        { connectorKey: CK, instanceId: IID, serverId: "wps-unknown", actor: "admin-1" },
        deps,
      ),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listInstanceServersWithHealthRefresh — S7 read + debounced probe refresh", () => {
  it("returns the full row set and refreshes enrolled rows' health in the background (once per debounce window)", async () => {
    __resetServerHealthRefreshDebounceForTests();
    const manualId = mintServerId({ kind: "manual", instanceId: IID, restPath: "/mcp/hand-added" });
    const probeServer = vi.fn(async () => "unreachable" as const);
    const { deps, calls, rows } = makeDeps(
      [
        baseRow({ serverId: manualId, source: "manual", restPath: "/mcp/hand-added" }),
        baseRow({
          serverId: "wps-retired",
          adapterServerId: "gone",
          status: "retired",
          restPath: "/mcp/gone",
        }),
      ],
      {
        resolveInstance: () => INSTANCE,
        verifier: { probeServer, listTools: vi.fn(async () => []) },
      },
    );

    const listed = await listInstanceServersWithHealthRefresh(
      { connectorKey: CK, instanceId: IID },
      deps,
    );
    expect(listed).toHaveLength(2); // full set: enrolled + retired
    await vi.waitFor(() => {
      expect(calls.recordStatus).toEqual([{ serverId: manualId, status: "unreachable" }]);
    });
    expect(rows.get(manualId)!.lastStatus).toBe("unreachable");
    // Retired rows are NOT probed.
    expect(probeServer).toHaveBeenCalledTimes(1);

    // Within the debounce window a second read does not re-probe.
    await listInstanceServersWithHealthRefresh({ connectorKey: CK, instanceId: IID }, deps);
    expect(probeServer).toHaveBeenCalledTimes(1);
  });
});

describe("MANUAL_SERVER_REST_PATH_PATTERN", () => {
  it("accepts canonical namespace/route paths and rejects dots outright", () => {
    expect(MANUAL_SERVER_REST_PATH_PATTERN.test("/mcp/vendor-server")).toBe(true);
    expect(MANUAL_SERVER_REST_PATH_PATTERN.test("/mcp/nested/route_1")).toBe(true);
    expect(MANUAL_SERVER_REST_PATH_PATTERN.test("/mcp/../admin")).toBe(false);
    expect(MANUAL_SERVER_REST_PATH_PATTERN.test("/index.php")).toBe(false);
  });
});
