// cinatra#1937 (archive S1) — the shared organization lifecycle-eligibility
// primitive extracted from the delete guards. The load-bearing new behavior is
// FAIL-CLOSED mode reading: a failing single-org config read yields
// `mode-unavailable` (lifecycle op refuses) instead of the pre-#1937 delete
// path's silent "assume multi-org and proceed".

import { describe, it, expect, vi, beforeEach } from "vitest";

const readSingleOrgModeStrict = vi.fn();
vi.mock("@/lib/authz/instance-mode", () => ({
  readSingleOrgModeStrict: (...a: unknown[]) => readSingleOrgModeStrict(...a),
}));

const orgRowsResult = vi.fn<() => Promise<Array<{ slug: string | null }>>>();
vi.mock("@/lib/better-auth-db", async () => {
  const { pgTable, text } = await import("drizzle-orm/pg-core");
  return {
    betterAuthOrganizations: pgTable("organization", {
      id: text("id").primaryKey(),
      slug: text("slug"),
    }),
    betterAuthDb: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => orgRowsResult() }),
        }),
      }),
    },
  };
});

import { resolveOrganizationLifecycleEligibility } from "@/lib/organization-lifecycle";

const ORG = "org_1";

beforeEach(() => {
  readSingleOrgModeStrict.mockReset();
  orgRowsResult.mockReset();
  readSingleOrgModeStrict.mockResolvedValue(false);
  orgRowsResult.mockResolvedValue([{ slug: "acme" }]);
});

describe("resolveOrganizationLifecycleEligibility", () => {
  it("eligible: multi-org mode, existing non-default org", async () => {
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: true,
    });
  });

  it("single-org mode refuses", async () => {
    readSingleOrgModeStrict.mockResolvedValue(true);
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: false,
      reason: "single-org-mode",
    });
  });

  it("the Default organization refuses (NULL-slug orgs stay eligible)", async () => {
    orgRowsResult.mockResolvedValue([{ slug: "default" }]);
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: false,
      reason: "default-org",
    });
    orgRowsResult.mockResolvedValue([{ slug: null }]);
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: true,
    });
  });

  it("missing org row refuses as not-found", async () => {
    orgRowsResult.mockResolvedValue([]);
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: false,
      reason: "not-found",
    });
  });

  it("FAIL-CLOSED HARDENING: a failing mode read refuses (mode-unavailable), never assumes multi-org", async () => {
    readSingleOrgModeStrict.mockRejectedValue(new Error("db down"));
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: false,
      reason: "mode-unavailable",
    });
    // The org lookup must not even be attempted — mode is checked first.
    expect(orgRowsResult).not.toHaveBeenCalled();
  });

  it("a failing org lookup refuses (lookup-failed)", async () => {
    orgRowsResult.mockRejectedValue(new Error("query failed"));
    await expect(resolveOrganizationLifecycleEligibility(ORG)).resolves.toEqual({
      eligible: false,
      reason: "lookup-failed",
    });
  });
});
