// cinatra#1940 P3 (Decision 2) — resolveRunCreationAuthority. Pins the
// three-step resolution order: (1) a frame-carried authority for THIS org
// that can("run.execute") is used as-is; (2) otherwise the delegating
// principal's member session authority (fail-closed for a non-member — the
// cross-org owner ruling); (3) neither ⇒ undefined (the guardedRunWrite seam
// then refuses "missing"). Also pins the free structural win: a run-bound
// authority (VerifiedRunRef) never satisfies step 1, because RUN_CAPABILITIES
// never grants "run.execute" — so an OBO/run frame always falls through to
// the delegating principal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

const resolveOrgRoleForUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

import { resolveRunCreationAuthority } from "../run-creation-authority";

const ORG = "org_1";

beforeEach(() => {
  resolveOrgRoleForUser.mockReset();
});

describe("resolveRunCreationAuthority", () => {
  it("uses a frame-carried authority as-is when it's for this org and can('run.execute')", async () => {
    const authority: OrgWriteAuthority = { orgId: ORG, can: () => true };
    const result = await resolveRunCreationAuthority(ORG, {
      orgWriteAuthority: authority,
    });
    expect(result).toBe(authority);
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("falls through to the delegating principal when the frame authority is for a DIFFERENT org", async () => {
    const foreignAuthority: OrgWriteAuthority = { orgId: "org_other", can: () => true };
    resolveOrgRoleForUser.mockResolvedValue("member");
    const result = await resolveRunCreationAuthority(ORG, {
      orgWriteAuthority: foreignAuthority,
      userId: "u1",
    });
    expect(result).not.toBe(foreignAuthority);
    expect(result?.orgId).toBe(ORG);
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith(ORG, "u1");
  });

  it("falls through to the delegating principal when the frame authority is run-bound (cannot('run.execute') — the free structural win)", async () => {
    // A VerifiedRunRef in production: RUN_CAPABILITIES holds only
    // content.write/run.complete, never run.execute — modeled here directly
    // via can():false so this test doesn't depend on that other module.
    const runAuthority: OrgWriteAuthority = { orgId: ORG, runId: "run_x", can: () => false };
    resolveOrgRoleForUser.mockResolvedValue("member");
    const result = await resolveRunCreationAuthority(ORG, {
      orgWriteAuthority: runAuthority,
      userId: "u1",
    });
    expect(result).not.toBe(runAuthority);
    expect(result?.can("run.execute")).toBe(true);
  });

  it("resolves the delegating member's session authority when no usable frame authority is present", async () => {
    resolveOrgRoleForUser.mockResolvedValue("member");
    const result = await resolveRunCreationAuthority(ORG, { userId: "u1" });
    expect(result?.orgId).toBe(ORG);
    expect(result?.can("run.execute")).toBe(true);
  });

  it("fails closed (undefined) for a non-member delegating principal — the cross-org owner ruling", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    const result = await resolveRunCreationAuthority(ORG, { userId: "u_outsider" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when neither a usable frame authority nor a userId is present", async () => {
    const result = await resolveRunCreationAuthority(ORG, {});
    expect(result).toBeUndefined();
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });
});
