import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#2021 (S6) / cinatra#2018 (S3 PR-D, absorbed) — POST
// /api/connect/site-inventory. This route is the FIRST production caller of
// the S3 reconciler (`applySiteInventory`) and anti-replay store
// (`tryAdvanceSiteInventory`), which stay REAL/unmocked here so this suite is
// the genuine "zero cinatra code changes, enrichment lands in the S3 store"
// composed proof the S3 design deferred to this slice. Only the DB-touching
// leaves of `connector-instance-server-store` are faked (an in-memory row
// set, mirroring the S3 reconciler's own test double) — the reconciler's pure
// helpers (mintServerId / CATALOG_DEFAULT_SERVER_ID / etc.) run for real via
// `importOriginal`. The auth/transport/rate-limit collaborators are mocked at
// the boundary; the route's own auth-before-body-read ordering, the pre-auth
// generic-400 "no oracle" surface, the transaction control flow, and the
// contract-version/schema/replay response mapping all run REAL.
//
// This suite deliberately attacks the auth path per the design's security
// posture: credential bypass, origin-binding confusion, instance/org
// cross-check evasion, replay/out-of-order delivery, and payload-bomb sizing —
// each must terminate BEFORE any store write, matching the contract's
// pre-auth "no oracle" + anti-replay guarantees.

const {
  resolveSiteMock,
  resolveInstanceMock,
  readConnectorConfigMock,
  logAuditEventMock,
  poolConnectMock,
  clientQueryMock,
  clientReleaseMock,
  tryAdvanceSiteInventoryMock,
  fakeStoreState,
} = vi.hoisted(() => {
  const fakeStoreState: {
    rows: Array<Record<string, unknown>>;
  } = { rows: [] };
  return {
    resolveSiteMock: vi.fn(),
    resolveInstanceMock: vi.fn(),
    readConnectorConfigMock: vi.fn(),
    // Typed spy: the implementation's parameter type flows into `mock.calls`
    // (Parameters<T>[]), so call-record assertions below need no casts. The
    // shape is the structural subset of the real AuditEventInput this suite
    // actually asserts on.
    logAuditEventMock: vi.fn(
      async (_input: { metadata?: { reason?: string } & Record<string, unknown> }) => {},
    ),
    poolConnectMock: vi.fn(),
    clientQueryMock: vi.fn(async (text: string) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected direct SQL in route under test: ${text}`);
    }),
    clientReleaseMock: vi.fn(),
    tryAdvanceSiteInventoryMock: vi.fn(),
    fakeStoreState,
  };
});

vi.mock("@/lib/widget-user-auth", () => ({
  resolveVerifiedSiteFromCredential: resolveSiteMock,
  resolveCanonicalInstanceForOrigin: resolveInstanceMock,
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
}));

vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: logAuditEventMock,
}));

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ connect: poolConnectMock }),
}));

// Partial mock: keep the REAL pure helpers (mintServerId, CATALOG_DEFAULT_
// SERVER_ID, resolveServerId, normalizeRestPath, ...) but replace the
// DB-touching leaves with an in-memory fake so no real Postgres connection is
// ever attempted. Mirrors the S3 reconciler's own in-memory store double
// (wordpress-server-enrollment.test.ts `makeStore`).
vi.mock("@/lib/connector-instance-server-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/connector-instance-server-store")>();

  function key(connectorKey: string, instanceId: string, serverId: string): string {
    return `${connectorKey}::${instanceId}::${serverId}`;
  }

  return {
    ...actual,
    tryAdvanceSiteInventory: tryAdvanceSiteInventoryMock,
    listInstanceServers: vi.fn(async (connectorKey: string, instanceId: string) =>
      fakeStoreState.rows.filter(
        (r) => r.connectorKey === connectorKey && r.instanceId === instanceId,
      ),
    ),
    ensureDefaultServerEnrollment: vi.fn(
      async (input: { connectorKey: string; instanceId: string }) => {
        const k = key(input.connectorKey, input.instanceId, actual.CATALOG_DEFAULT_SERVER_ID);
        const exists = fakeStoreState.rows.some(
          (r) =>
            r.connectorKey === input.connectorKey &&
            r.instanceId === input.instanceId &&
            r.serverId === actual.CATALOG_DEFAULT_SERVER_ID,
        );
        if (!exists) {
          fakeStoreState.rows.push({
            connectorKey: input.connectorKey,
            instanceId: input.instanceId,
            serverId: actual.CATALOG_DEFAULT_SERVER_ID,
            source: "default",
            status: "enrolled",
            restPath: actual.DEFAULT_SERVER_REST_PATH,
            exposureMode: "triad-only",
            createdBy: actual.SYSTEM_SERVER_ENROLLMENT_ACTOR,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
        void k;
        return { created: !exists };
      },
    ),
    upsertServer: vi.fn(async (input: Record<string, unknown>) => {
      const idx = fakeStoreState.rows.findIndex(
        (r) =>
          r.connectorKey === input.connectorKey &&
          r.instanceId === input.instanceId &&
          r.serverId === input.serverId,
      );
      const merged = {
        ...(idx === -1 ? {} : fakeStoreState.rows[idx]),
        ...input,
        createdAt: idx === -1 ? "2026-01-01T00:00:00.000Z" : fakeStoreState.rows[idx]!.createdAt,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      if (idx === -1) fakeStoreState.rows.push(merged);
      else fakeStoreState.rows[idx] = merged;
      return { written: true };
    }),
    retireServer: vi.fn(async (connectorKey: string, instanceId: string, serverId: string) => {
      const row = fakeStoreState.rows.find(
        (r) =>
          r.connectorKey === connectorKey &&
          r.instanceId === instanceId &&
          r.serverId === serverId &&
          r.source === "discovered" &&
          r.status !== "retired",
      );
      if (!row) return { retired: false };
      row.status = "retired";
      row.retiredAt = "2026-01-01T00:00:00.000Z";
      return { retired: true };
    }),
    deletePresentUnenrolledServer: vi.fn(
      async (connectorKey: string, instanceId: string, serverId: string) => {
        const idx = fakeStoreState.rows.findIndex(
          (r) =>
            r.connectorKey === connectorKey &&
            r.instanceId === instanceId &&
            r.serverId === serverId &&
            r.status === "present_unenrolled",
        );
        if (idx === -1) return { deleted: false };
        fakeStoreState.rows.splice(idx, 1);
        return { deleted: true };
      },
    ),
    deleteManualServer: vi.fn(async () => ({ deleted: false })),
    recordServerStatus: vi.fn(async () => {}),
  };
});

import { POST } from "../route";
import goldenFixture from "@/lib/__tests__/__fixtures__/wp-site-inventory-v1.json";
import { __resetSiteInventoryRateLimitForTests } from "@/lib/site-inventory-rate-limit";

const WP_ORIGIN = "https://wp.test";
const SITE = {
  siteId: "11111111-1111-1111-1111-111111111111",
  client: "wordpress",
  orgId: "org-A",
  siteOrigin: WP_ORIGIN,
  credentialVersion: 1,
};
const INSTANCE_ID = "inst-1";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://cinatra.test/api/connect/site-inventory", {
    method: "POST",
    headers: {
      Authorization: "Bearer cnx_site_secret",
      "Content-Type": "application/json",
      Origin: WP_ORIGIN,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(goldenFixture), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSiteInventoryRateLimitForTests();
  fakeStoreState.rows = [];

  resolveSiteMock.mockReturnValue(SITE);
  resolveInstanceMock.mockReturnValue(INSTANCE_ID);
  readConnectorConfigMock.mockReturnValue({
    instances: [{ id: INSTANCE_ID, siteUrl: WP_ORIGIN, orgId: "org-A" }],
  });
  poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
  // Default: a fresh, strictly-newer inventory (advance succeeds).
  tryAdvanceSiteInventoryMock.mockImplementation(
    async (input: { credentialVersion: number; inventorySeq: number }) => ({
      connectorKey: "wordpress",
      instanceId: INSTANCE_ID,
      contractVersion: "v1",
      siteId: SITE.siteId,
      origin: WP_ORIGIN,
      credentialVersion: input.credentialVersion,
      inventorySeq: input.inventorySeq,
      siteMeta: {},
      receivedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

describe("POST /api/connect/site-inventory — pre-auth surface (generic 400, no oracle)", () => {
  it("429s BEFORE authentication once the per-IP bucket is exhausted — attributable to the IP bucket alone", async () => {
    // Warm-ups fail authentication (mock returns null) so the per-site
    // debounce is never touched, and each carries a UNIQUE credential so the
    // per-credential bucket never masks the IP bucket: the only limit the
    // final request can trip is the IP bucket.
    resolveSiteMock.mockReturnValue(null);
    for (let i = 0; i < 30; i++) {
      await POST(
        req(validBody(), {
          "x-forwarded-for": "9.9.9.9",
          Authorization: `Bearer cnx_warmup_${i}`,
        }),
      );
    }
    resolveSiteMock.mockClear();
    const res = await POST(
      req(validBody(), { "x-forwarded-for": "9.9.9.9", Authorization: "Bearer cnx_final" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    // Denied PRE-AUTH: the credential validator never ran for the final call.
    expect(resolveSiteMock).not.toHaveBeenCalled();
  });

  it("429s BEFORE authentication when one credential rotates x-forwarded-for (the secondary bucket defeats IP spoofing)", async () => {
    resolveSiteMock.mockReturnValue(null);
    for (let i = 0; i < 10; i++) {
      await POST(
        req(validBody(), {
          "x-forwarded-for": `10.0.0.${i}`,
          Authorization: "Bearer cnx_rotating_spoofer",
        }),
      );
    }
    resolveSiteMock.mockClear();
    const res = await POST(
      req(validBody(), {
        "x-forwarded-for": "10.0.99.99",
        Authorization: "Bearer cnx_rotating_spoofer",
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(resolveSiteMock).not.toHaveBeenCalled();
  });

  it("400s an invalid/missing credential BEFORE the body is ever read", async () => {
    resolveSiteMock.mockReturnValue(null);
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
    // The body-dependent instance-resolution step must never run.
    expect(resolveInstanceMock).not.toHaveBeenCalled();
  });

  it("passes the Origin header through verbatim to the credential validator", async () => {
    await POST(req(validBody(), { Origin: "https://other.test" }));
    expect(resolveSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestOrigin: "https://other.test" }),
    );
  });

  it("400s an oversized body (256 KB cap) and never reaches the DB", async () => {
    const res = await POST(req("x".repeat(300 * 1024)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(tryAdvanceSiteInventoryMock).not.toHaveBeenCalled();
    const rejectCall = logAuditEventMock.mock.calls.find(
      (c) => c[0].metadata?.reason === "payload_too_large",
    );
    expect(rejectCall).toBeDefined();
  });

  it("400s malformed JSON", async () => {
    const res = await POST(req("{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s a JSON body that isn't a plain object (array payload)", async () => {
    const res = await POST(req([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s when the origin resolves to zero/ambiguous instances", async () => {
    resolveInstanceMock.mockReturnValue(null);
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(tryAdvanceSiteInventoryMock).not.toHaveBeenCalled();
  });

  it("forwards claimedInstanceId from the body to the instance resolver (disambiguation only)", async () => {
    await POST(req(validBody({ claimedInstanceId: "claimed-1" })));
    expect(resolveInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ claimedInstanceId: "claimed-1" }),
    );
  });

  it("400s an org cross-check mismatch (instance bound to a different org than the credential)", async () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: INSTANCE_ID, siteUrl: WP_ORIGIN, orgId: "org-FOREIGN" }],
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(tryAdvanceSiteInventoryMock).not.toHaveBeenCalled();
  });

  it("does not reject when the instance carries no org binding at all (unbound is not a mismatch)", async () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: INSTANCE_ID, siteUrl: WP_ORIGIN }],
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
  });

  it("400s a payload `client` that doesn't match the authenticating credential's client", async () => {
    const res = await POST(req(validBody({ client: "drupal" })));
    expect(res.status).toBe(400);
    // Still the generic pre-auth shape, not the structured schema error — the
    // client cross-check runs BEFORE schema validation.
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("POST /api/connect/site-inventory — post-auth debounce", () => {
  it("429s + Retry-After on a second call within 60s of an ACCEPTED send", async () => {
    const first = await POST(req(validBody()));
    expect(first.status).toBe(200);
    const second = await POST(req(validBody({ inventorySeq: 43 })));
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    // The debounced call must never reach the transactional apply path.
    expect(tryAdvanceSiteInventoryMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT burn the debounce window on a rejected send — a corrected retry goes straight through", async () => {
    // An unsupported-version send fails post-auth validation…
    const bad = await POST(req(validBody({ contractVersion: "v2" })));
    expect(bad.status).toBe(400);
    // …and the immediate corrected retry is accepted: only COMMITTED sends
    // start the per-site window.
    const good = await POST(req(validBody()));
    expect(good.status).toBe(200);
  });
});

describe("POST /api/connect/site-inventory — structured post-auth errors", () => {
  it("returns unsupported_contract_version with the supported list for an unknown version", async () => {
    const res = await POST(req(validBody({ contractVersion: "v2" })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("unsupported_contract_version");
    expect(json.supported).toEqual(["v1"]);
  });

  it("returns invalid_payload for a schema violation (e.g. missing required site block)", async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).site;
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payload" });
  });

  it("returns invalid_payload for a restPath/namespace+route mismatch", async () => {
    const body = validBody();
    (body.servers as Array<Record<string, unknown>>)[1]!.restPath = "/mcp/wrong-path";
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payload" });
  });

  it("returns stale_payload and ROLLS BACK when the anti-replay gate rejects (replay/out-of-order defense)", async () => {
    tryAdvanceSiteInventoryMock.mockResolvedValueOnce(null);
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "stale_payload" });
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQueryMock).not.toHaveBeenCalledWith("COMMIT");
    expect(fakeStoreState.rows).toHaveLength(0);
  });
});

describe("POST /api/connect/site-inventory — happy path (composed, zero-cinatra-code-changes proof)", () => {
  it("200s and applies the golden fixture through the REAL reconciler: default + eligible server enrolled, custom-transport/auth servers present-not-enrolled", async () => {
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ accepted: true, enrolled: 2, presentUnenrolled: 2, retired: 0 });
    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);

    const vendorRow = fakeStoreState.rows.find((r) => r.adapterServerId === "fixture-vendor-server");
    expect(vendorRow?.status).toBe("enrolled");
    const stdioRow = fakeStoreState.rows.find((r) => r.adapterServerId === "fixture-stdio-only-server");
    expect(stdioRow?.status).toBe("present_unenrolled");
    expect(stdioRow?.unenrolledReason).toBe("custom_transport");
    const authRow = fakeStoreState.rows.find(
      (r) => r.adapterServerId === "fixture-dedicated-auth-server",
    );
    expect(authRow?.status).toBe("present_unenrolled");
    expect(authRow?.unenrolledReason).toBe("custom_auth");
  });

  it("retires a previously-enrolled discovered server absent from a fresh accepted payload", async () => {
    fakeStoreState.rows.push({
      connectorKey: "wordpress",
      instanceId: INSTANCE_ID,
      serverId: "wps-oldserver",
      source: "discovered",
      status: "enrolled",
      adapterServerId: "old-server",
      restPath: "/mcp/old-server",
      createdBy: "system:wp-server-enrollment",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const emptyServersPayload = {
      contractVersion: "v1",
      client: "wordpress",
      inventorySeq: 1,
      collectedAt: "2026-07-27T12:00:00Z",
      site: {
        wpVersion: "6.9.1",
        phpVersion: "8.3.2",
        adapterVersion: "0.5.0",
        connectedUserRole: "editor",
        permalinkStructure: "pretty",
      },
      servers: [],
    };
    const res = await POST(req(emptyServersPayload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, enrolled: 0, presentUnenrolled: 0, retired: 1 });
    const oldRow = fakeStoreState.rows.find((r) => r.serverId === "wps-oldserver");
    expect(oldRow?.status).toBe("retired");
  });
});

describe("POST /api/connect/site-inventory — transaction failure handling", () => {
  it("ROLLS BACK and 500s when the reconciler apply throws mid-transaction", async () => {
    clientQueryMock.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
    tryAdvanceSiteInventoryMock.mockImplementationOnce(async () => {
      throw new Error("boom: simulated apply failure");
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(500);
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQueryMock).not.toHaveBeenCalledWith("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });
});
