/**
 * Tests for cross-org guard activation in enforceRunAccess.
 *
 * enforceRunAccess must keep the actor organization and resource organization
 * distinct. The run org belongs on the resource (`organizationId`), while the
 * actor org must come from the session (`activeOrganizationId`) so a member of
 * org-B trying to read a run from org-A is denied even when the run record
 * lives in agent_runs.
 *
 * The bridge routes session.activeOrganizationId into the actor context. These
 * tests wire up the guard via an explicit `actorOrganizationId` hint on
 * ActorRoleHints so the same orgId cannot accidentally flow into both sides of
 * the guard.
 */
import { describe, it, expect } from "vitest";

import { enforceRunAccess } from "../auth-policy";
import type { ActorRoleHints, AgentAuthPolicy } from "../auth-policy";
import { AuthzError } from "@/lib/authz";

const baseRun = {
  id: "run-1",
  runBy: "user-1", // owner
};

// Org-tier policy: any same-org member can read. We use this so the cross-org
// guard is the ONLY thing that can deny a non-owner — without this, the
// default owner-only policy denies independently and masks whether the
// cross-org guard fired.
const ORG_TIER_POLICY: AgentAuthPolicy = {
  runListVisibility: "org",
  runDataVisibility: "org",
  runExecuteVisibility: "org",
  allowRunSharing: false,
};

type ActorOrgRoleHints = ActorRoleHints & {
  // Threads session activeOrganizationId through the actor bridge.
  actorOrganizationId?: string | null;
};

describe("enforceRunAccess cross-org guard", () => {
  // -------------------------------------------------------------------------
  // Same-org member with org-tier policy + orgRole "member" must be allowed.
  // The kernel must receive session-derived org role hints so it grants
  // run.read for org_member when resource.organizationId === actor.organizationId.
  // -------------------------------------------------------------------------
  it("allows a same-org member (orgRole: member) when policy is org-tier", async () => {
    await expect(
      enforceRunAccess(
        {
          ...baseRun,
          orgId: "org-A",
          effectivePolicy: ORG_TIER_POLICY,
        },
        { actorType: "human", userId: "user-2", source: "ui" },
        "read",
        {
          platformRole: "member",
          orgRole: "member",
          actorOrganizationId: "org-A",
        } as ActorOrgRoleHints,
      ),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The cross-org member must be denied even if granted org_member role. The
  // kernel cross-org guard inside `can()` must use actor.organizationId sourced
  // from session (org-B), not from run.orgId (org-A).
  // -------------------------------------------------------------------------
  it("denies a non-admin member in org-B from reading an org-A run (cross-org guard)", async () => {
    await expect(
      enforceRunAccess(
        {
          ...baseRun,
          orgId: "org-A",
          effectivePolicy: ORG_TIER_POLICY,
        },
        { actorType: "human", userId: "user-2", source: "ui" },
        "read",
        {
          platformRole: "member",
          orgRole: "member",
          actorOrganizationId: "org-B",
        } as ActorOrgRoleHints,
      ),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  // -------------------------------------------------------------------------
  // Owner short-circuit must continue to fire regardless of actor org. Pinned
  // so the owner check stays independent from the actor-org pipeline.
  // -------------------------------------------------------------------------
  it("allows the run owner regardless of actor org (owner short-circuit preserved)", async () => {
    await expect(
      enforceRunAccess(
        {
          ...baseRun,
          orgId: "org-A",
          effectivePolicy: ORG_TIER_POLICY,
        },
        { actorType: "human", userId: "user-1", source: "ui" },
        "read",
        {
          platformRole: "member",
          actorOrganizationId: "org-B",
        } as ActorOrgRoleHints,
      ),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // platform_admin bypasses cross-org via the kernel's platform_admin grant.
  // Pinned so admin bypass remains intact.
  // -------------------------------------------------------------------------
  it("allows platform_admin across orgs", async () => {
    await expect(
      enforceRunAccess(
        {
          ...baseRun,
          orgId: "org-A",
          effectivePolicy: ORG_TIER_POLICY,
        },
        { actorType: "human", userId: "user-2", source: "ui" },
        "read",
        {
          platformRole: "platform_admin",
          actorOrganizationId: "org-B",
        } as ActorOrgRoleHints,
      ),
    ).resolves.toBeUndefined();
  });
});
