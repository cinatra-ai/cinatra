import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// deleteOrganizationAction (cinatra#1510 remainder) — the fail-closed write
// gate: capability re-check (incl. the structural hazards folded into
// `canDelete`), SERVER-side name confirmation against the live row, blocked
// pass-through with per-kind counts, and the allowed-path audit + redirect.
// The transactional core is covered in src/lib/__tests__/organization-delete;
// here it is mocked at the module seam.
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));

const getAuthSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
}));

const resolveOrganizationManageCapabilities = vi.fn();
vi.mock("@/lib/authz/organization-manage-gate", () => ({
  resolveOrganizationManageCapabilities: (...a: unknown[]) =>
    resolveOrganizationManageCapabilities(...a),
  userCanManageOrganization: vi.fn(),
  userCanManageOrganizationMembers: vi.fn(),
}));

const logAuditEvent = vi.fn();
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));

const deleteOrganizationReferenceGuarded = vi.fn();
vi.mock("@/lib/organization-delete", () => ({
  deleteOrganizationReferenceGuarded: (...a: unknown[]) =>
    deleteOrganizationReferenceGuarded(...a),
}));

const orgNameRows = vi.fn<() => Promise<Array<{ name: string }>>>();
vi.mock("@/lib/better-auth-db", async () => {
  const { pgTable, text } = await import("drizzle-orm/pg-core");
  return {
    betterAuthOrganizations: pgTable("organization", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
    }),
    betterAuthDb: {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => orgNameRows() }) }),
      }),
    },
  };
});

import { deleteOrganizationAction } from "../organization-manage-actions";

const ORG = "org_target";
const SESSION = { user: { id: "user_1" }, session: { activeOrganizationId: ORG } };

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const CAN_DELETE = {
  role: "org_owner",
  canManageSettings: true,
  canManageMembers: true,
  canDelete: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(SESSION);
  resolveOrganizationManageCapabilities.mockResolvedValue(CAN_DELETE);
  orgNameRows.mockResolvedValue([{ name: "Acme" }]);
  deleteOrganizationReferenceGuarded.mockResolvedValue({ ok: true });
});

describe("deleteOrganizationAction — fail-closed write gate", () => {
  it("no session: denied, nothing touched", async () => {
    getAuthSession.mockResolvedValue(null);
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "You do not have permission to delete this organization.",
    });
    expect(deleteOrganizationReferenceGuarded).not.toHaveBeenCalled();
  });

  it("capabilities without canDelete (lower role OR structural hazard): denied", async () => {
    resolveOrganizationManageCapabilities.mockResolvedValue({
      ...CAN_DELETE,
      canDelete: false,
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result.ok).toBe(false);
    expect(deleteOrganizationReferenceGuarded).not.toHaveBeenCalled();
  });

  it("confirmation name mismatch (server-verified against the live row): refused", async () => {
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "acme " }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("does not match");
    expect(deleteOrganizationReferenceGuarded).not.toHaveBeenCalled();
  });

  it("blocked delete: per-kind counts pass through for the danger card (incl. #1939 kinds)", async () => {
    const blockers = {
      teams: 1,
      activeProjects: 0,
      installedExtensions: 2,
      dashboards: 0,
      agents: 0,
      liveAgentRuns: 3,
    };
    deleteOrganizationReferenceGuarded.mockResolvedValue({
      ok: false,
      reason: "blocked",
      blockers,
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toMatchObject({ ok: false, blockers });
    if (!result.ok) {
      expect(result.error).toContain("1 team(s)");
      expect(result.error).toContain("2 installed extension(s)");
      expect(result.error).toContain("3 running agent(s)");
    }
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("not-archived refusal (archived-only gate on) surfaces the archive-first guidance", async () => {
    deleteOrganizationReferenceGuarded.mockResolvedValue({
      ok: false,
      reason: "not-archived",
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Archive this organization first");
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("allowed path: transactional delete → audit record → revalidate → /organizations redirect", async () => {
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toEqual({ ok: true, redirectTo: "/organizations" });
    expect(deleteOrganizationReferenceGuarded).toHaveBeenCalledWith(ORG, "user_1");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actorPrincipalId: "user_1",
        operation: "organization.delete",
        decision: "allowed",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/organizations");
  });

  it("in-tx default-org refusal surfaces as a clear error", async () => {
    deleteOrganizationReferenceGuarded.mockResolvedValue({
      ok: false,
      reason: "default-org",
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "The default organization cannot be deleted.",
    });
  });

  it("single-org-mode re-check refusal surfaces as a clear error", async () => {
    deleteOrganizationReferenceGuarded.mockResolvedValue({
      ok: false,
      reason: "single-org-mode",
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "Organizations cannot be deleted in single-organization mode.",
    });
  });

  it("in-tx ownership denial (actor demoted mid-flight) surfaces as permission error", async () => {
    deleteOrganizationReferenceGuarded.mockResolvedValue({
      ok: false,
      reason: "denied",
    });
    const result = await deleteOrganizationAction(
      form({ organizationId: ORG, confirmName: "Acme" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "You do not have permission to delete this organization.",
    });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
