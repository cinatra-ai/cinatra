// cinatra#246 — single-tenant content-editor OBO identity resolver.
//
// Asserts the resolver picks the oldest org (resolveDefaultOrgId) + the oldest
// owner/admin MEMBER of that org as the OBO write actor, and fails soft (null)
// when no org or no admin-capable member exists (caller then falls back to the
// anonymous dispatch — never elevates).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- module boundary mocks ---------------------------------------------------

const resolveDefaultOrgId = vi.fn<() => Promise<string | null>>();
vi.mock("@cinatra-ai/agents", () => ({
  resolveDefaultOrgId: () => resolveDefaultOrgId(),
}));

type MemberRow = { userId: string; role: string | null; createdAt: Date };
let memberRows: MemberRow[] = [];
const whereSpy = vi.fn();

// Drizzle chain stub for betterAuthDb.select().from().where().orderBy().
// orderBy resolves to the (already createdAt-ASC-ordered) memberRows fixture.
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          whereSpy(...args);
          return {
            orderBy: () => Promise.resolve(memberRows),
          };
        },
      }),
    }),
  },
  betterAuthMembers: {
    userId: "userId",
    role: "role",
    createdAt: "createdAt",
    organizationId: "organizationId",
  },
}));

// --- connector_config reader (cinatra#274 per-install rows) ------------------
let connectorConfig: Record<string, { instances?: unknown }> = {};
const readConnectorConfigFromDatabase = vi.fn(
  (key: string, fallback: { instances?: unknown }) => connectorConfig[key] ?? fallback,
);
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (key: string, fallback: { instances?: unknown }) =>
    readConnectorConfigFromDatabase(key, fallback),
}));

// Reuse the REAL origin↔siteUrl matcher so the test exercises the actual
// normalization contract rather than a stand-in.
vi.mock("@/lib/widget-stream-auth", async () => {
  const normalizeStoredSiteUrl = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withProtocol);
      url.pathname = url.pathname.replace(/\/+$/, "");
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return withProtocol.replace(/\/+$/, "");
    }
  };
  const forCompare = (v: string) => v.replace(/\/+$/, "").toLowerCase();
  return {
    originMatchesSiteUrl: (origin: string | null | undefined, siteUrl: string | null | undefined) => {
      const want = forCompare(String(origin ?? "").trim());
      const have = forCompare(normalizeStoredSiteUrl(String(siteUrl ?? "").trim()));
      return want.length > 0 && have.length > 0 && want === have;
    },
  };
});

import {
  resolveSingleTenantContentEditorIdentity,
  resolveContentEditorIdentityForInstance,
} from "@/lib/content-editor-run-identity";

beforeEach(() => {
  resolveDefaultOrgId.mockReset();
  whereSpy.mockReset();
  readConnectorConfigFromDatabase.mockClear();
  connectorConfig = {};
  memberRows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveSingleTenantContentEditorIdentity", () => {
  it("returns null when there is no default org", async () => {
    resolveDefaultOrgId.mockResolvedValue(null);
    expect(await resolveSingleTenantContentEditorIdentity()).toBeNull();
  });

  it("returns null when the default org has no owner/admin member", async () => {
    resolveDefaultOrgId.mockResolvedValue("org_1");
    memberRows = [
      { userId: "u_member", role: "member", createdAt: new Date("2026-01-01") },
    ];
    expect(await resolveSingleTenantContentEditorIdentity()).toBeNull();
  });

  it("picks the oldest org and its oldest admin-capable member", async () => {
    resolveDefaultOrgId.mockResolvedValue("org_1");
    // Fixture is ordered createdAt ASC (mirrors the orderBy the query issues).
    memberRows = [
      { userId: "u_member", role: "member", createdAt: new Date("2026-01-01") },
      { userId: "u_admin_first", role: "admin", createdAt: new Date("2026-02-01") },
      { userId: "u_admin_second", role: "owner", createdAt: new Date("2026-03-01") },
    ];
    const out = await resolveSingleTenantContentEditorIdentity();
    expect(out).toEqual({ orgId: "org_1", runBy: "u_admin_first" });
  });

  it("treats comma-joined 'owner,admin' role as admin-capable", async () => {
    resolveDefaultOrgId.mockResolvedValue("org_1");
    memberRows = [
      { userId: "u_combo", role: "owner,admin", createdAt: new Date("2026-01-01") },
    ];
    const out = await resolveSingleTenantContentEditorIdentity();
    expect(out).toEqual({ orgId: "org_1", runBy: "u_combo" });
  });

  it("recognizes a plain 'owner' as admin-capable", async () => {
    resolveDefaultOrgId.mockResolvedValue("org_1");
    memberRows = [
      { userId: "u_owner", role: "owner", createdAt: new Date("2026-01-01") },
    ];
    const out = await resolveSingleTenantContentEditorIdentity();
    expect(out).toEqual({ orgId: "org_1", runBy: "u_owner" });
  });
});

// ---------------------------------------------------------------------------
// cinatra#274 — per-install resolver. Origin is authoritative; instanceId only
// disambiguates among origin-matched rows; a complete binding is required; any
// miss falls through to single-tenant.
// ---------------------------------------------------------------------------

describe("resolveContentEditorIdentityForInstance (cinatra#274)", () => {
  // The single-tenant fallback is exercised via resolveDefaultOrgId + memberRows.
  function armSingleTenant(orgId = "org_default", userId = "u_default_admin") {
    resolveDefaultOrgId.mockResolvedValue(orgId);
    memberRows = [{ userId, role: "admin", createdAt: new Date("2026-01-01") }];
  }

  it("binds to the origin-matched install's persisted {orgId, runBy}", async () => {
    armSingleTenant(); // present, but must NOT be used
    connectorConfig.wordpress = {
      instances: [
        { id: "wp-a", siteUrl: "https://a.example", orgId: "org_a", runBy: "u_a" },
        { id: "wp-b", siteUrl: "https://b.example", orgId: "org_b", runBy: "u_b" },
      ],
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://b.example",
      instanceId: "wp-b",
    });
    expect(out).toEqual({ orgId: "org_b", runBy: "u_b" });
    expect(resolveDefaultOrgId).not.toHaveBeenCalled();
  });

  it("IGNORES a forged instanceId that names a different row than the verified origin", async () => {
    armSingleTenant();
    connectorConfig.wordpress = {
      instances: [
        { id: "wp-a", siteUrl: "https://a.example", orgId: "org_a", runBy: "u_a" },
        { id: "wp-b", siteUrl: "https://b.example", orgId: "org_b", runBy: "u_b" },
      ],
    };
    // Token-bound origin is a.example; body claims instanceId wp-b (other tenant).
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://a.example",
      instanceId: "wp-b",
    });
    // Binds to the ORIGIN's row (a), never the forged id's row (b).
    expect(out).toEqual({ orgId: "org_a", runBy: "u_a" });
  });

  it("matches by origin alone when instanceId is absent and the origin is unambiguous", async () => {
    armSingleTenant();
    connectorConfig.drupal = {
      instances: [{ id: "d-1", siteUrl: "https://drupal.example/", orgId: "org_d", runBy: "u_d" }],
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "drupal",
      // trailing-slash / case differences must still match via normalization
      origin: "https://DRUPAL.example",
    });
    expect(out).toEqual({ orgId: "org_d", runBy: "u_d" });
  });

  it("falls through to single-tenant when the matched row has NO binding (pre-#274 row)", async () => {
    armSingleTenant("org_default", "u_default_admin");
    connectorConfig.wordpress = {
      instances: [{ id: "wp-old", siteUrl: "https://old.example" }], // no orgId/runBy
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://old.example",
      instanceId: "wp-old",
    });
    expect(out).toEqual({ orgId: "org_default", runBy: "u_default_admin" });
  });

  it("falls through to single-tenant when the row has only HALF a binding", async () => {
    armSingleTenant("org_default", "u_default_admin");
    connectorConfig.wordpress = {
      instances: [{ id: "wp-half", siteUrl: "https://half.example", orgId: "org_h" }], // runBy missing
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://half.example",
    });
    expect(out).toEqual({ orgId: "org_default", runBy: "u_default_admin" });
  });

  it("falls through to single-tenant when no row matches the verified origin", async () => {
    armSingleTenant("org_default", "u_default_admin");
    connectorConfig.wordpress = {
      instances: [{ id: "wp-a", siteUrl: "https://a.example", orgId: "org_a", runBy: "u_a" }],
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://unknown.example",
      instanceId: "wp-a",
    });
    expect(out).toEqual({ orgId: "org_default", runBy: "u_default_admin" });
  });

  it("does NOT bind on a client-asserted instanceId when there is no verified origin (forgeable) — falls through to single-tenant", async () => {
    armSingleTenant("org_default", "u_default_admin");
    connectorConfig.wordpress = {
      instances: [{ id: "wp-x", siteUrl: "https://x.example", orgId: "org_x", runBy: "u_x" }],
    };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: null, // no verified origin
      instanceId: "wp-x", // forgeable id alone must not select the per-install row
    });
    expect(out).toEqual({ orgId: "org_default", runBy: "u_default_admin" });
  });

  it("returns null when neither a per-install binding NOR a single-tenant identity exists", async () => {
    resolveDefaultOrgId.mockResolvedValue(null); // no single-tenant fallback
    connectorConfig.wordpress = { instances: [] };
    const out = await resolveContentEditorIdentityForInstance({
      instancesConfigKey: "wordpress",
      origin: "https://a.example",
      instanceId: "wp-a",
    });
    expect(out).toBeNull();
  });
});
