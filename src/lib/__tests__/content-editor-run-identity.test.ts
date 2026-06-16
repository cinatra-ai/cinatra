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

import { resolveSingleTenantContentEditorIdentity } from "@/lib/content-editor-run-identity";

beforeEach(() => {
  resolveDefaultOrgId.mockReset();
  whereSpy.mockReset();
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
