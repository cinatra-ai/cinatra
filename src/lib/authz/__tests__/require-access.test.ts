/**
 * `requireAccess` primitive + registry + CarveOut tests.
 *
 * Covers: registry lookup, deny-by-missing-classification, role gate,
 * project-grant gate, CarveOut allow path. Audit emission is verified via
 * a mock on the audit module.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLICY_VERSION, type ActorContext } from "../actor-context";
import { AuthzError } from "../errors";
import * as auditModule from "../audit";
import { requireAccess, canRequireAccess } from "../require-access";
import { CARVE_OUTS } from "../carve-out";

function makeActor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: "org-1",
    orgRole: "member",
    ...over,
  } as ActorContext;
}

const orgRes = (over: Partial<{ resourceId: string }> = {}) => ({
  resourceType: "agent" as const,
  resourceId: over.resourceId ?? "agent-1",
  organizationId: "org-1",
  ownerType: "organization" as const,
  ownerId: "org-1",
});

describe("requireAccess", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  });
  afterEach(() => {
    auditSpy.mockRestore();
  });

  it("allows when actor holds the required permission", async () => {
    const actor = makeActor();
    await expect(requireAccess(actor, orgRes(), "read")).resolves.toBeUndefined();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", resourceType: "agent" }),
    );
  });

  it("denies when actor lacks the required permission", async () => {
    const stranger = makeActor({
      organizationId: "other-org",
      orgRole: undefined,
    });
    await expect(requireAccess(stranger, orgRes(), "delete")).rejects.toBeInstanceOf(AuthzError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
  });

  it("denies on unknown (resourceType, action) (missing_classification)", async () => {
    const actor = makeActor({ platformRole: "platform_admin" });
    await expect(
      // 'share' is not registered for object — treat as drift.
      requireAccess(actor, { resourceType: "object", resourceId: "o1", organizationId: "org-1" }, "share"),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ reason: "missing_classification" }) }),
    );
  });

  it("denies on missing role gate (marketplace publish needs release_manager)", async () => {
    const actor = makeActor({ orgRole: "org_admin" });
    await expect(
      requireAccess(actor, { resourceType: "marketplace_template", resourceId: "mt-1", organizationId: "org-1" }, "publish"),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ reason: "missing_role" }) }),
    );
  });

  it("allows when actor holds the required role + permission", async () => {
    const actor = makeActor({
      orgRole: "org_admin",
      // `roles[]` is the extension axis used by `requireAccess.actorHoldsRole`.
      ...({ roles: ["release_manager"] } as Partial<ActorContext>),
    });
    await expect(
      requireAccess(actor, { resourceType: "marketplace_template", resourceId: "mt-1", organizationId: "org-1" }, "publish"),
    ).resolves.toBeUndefined();
  });

  it("denies when requireProjectGrant is requested but actor lacks the grant", async () => {
    const actor = makeActor();
    await expect(
      requireAccess(actor, orgRes(), "read", { requireProjectGrant: "proj-99" }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ reason: "missing_project_grant", projectId: "proj-99" }) }),
    );
  });

  it("allows when requireProjectGrant matches an existing grant", async () => {
    const actor = makeActor({
      projectGrants: [{ projectId: "proj-99", effectiveRole: "read", accessSource: "user" }],
    });
    await expect(
      requireAccess(actor, orgRes(), "read", { requireProjectGrant: "proj-99" }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits to allowed when a valid carve-out is supplied", async () => {
    const sample = CARVE_OUTS.find((c) => c.primitiveName === "workflow_draft_create")!;
    const actor = makeActor();
    await expect(
      requireAccess(
        actor,
        { resourceType: sample.resourceType, resourceId: "draft-1", organizationId: "org-1" },
        sample.action,
        { carveOut: { primitiveName: sample.primitiveName, boundary: sample.boundary } },
      ),
    ).resolves.toBeUndefined();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", metadata: expect.objectContaining({ carveOut: true }) }),
    );
  });

  it("denies and audits when a carve-out reference does not exist", async () => {
    const actor = makeActor();
    await expect(
      requireAccess(actor, orgRes(), "read", {
        carveOut: { primitiveName: "ghost_primitive_does_not_exist", boundary: "mcp_handler_dispatch" },
      }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ reason: "unknown_carve_out" }) }),
    );
  });

  it("canRequireAccess returns the structured decision without throwing", () => {
    const actor = makeActor();
    expect(canRequireAccess(actor, orgRes(), "read")).toEqual({ allowed: true });
    expect(canRequireAccess(actor, orgRes(), "delete")).toEqual({ allowed: false, reason: "denied_by_permission" });
    expect(canRequireAccess(actor, orgRes(), "share")).toEqual({ allowed: false, reason: "denied_by_permission" });
    expect(canRequireAccess(actor, orgRes(), "read", { requireProjectGrant: "proj-99" })).toEqual({
      allowed: false,
      reason: "missing_project_grant",
    });
  });
});
