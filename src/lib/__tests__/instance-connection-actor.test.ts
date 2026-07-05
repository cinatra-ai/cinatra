// cinatra#967 (W3 residue of #952/#953): the shared instance-flow gating
// seam for the wordpress/drupal/linkedin(-mcp) connector consumers. Proves:
//   1. identity is SEEDED (self-heal) when absent — using the supplied
//      {orgId, runBy} binding, else falling back to the single-tenant
//      default owner/org;
//   2. the actor is THREADED through `enforceConnectionUse` (HumanUser when
//      the binding names the identity's own owner, else an InternalWorker
//      bound to the identity's owner/org — never a fabricated human);
//   3. a deny propagates (fail-closed) and an allow/deny is always audited
//      via the underlying `enforceConnectionUse` seam;
//   4. an instance with NO resolvable owner (no binding, no single-tenant
//      default) skips gating entirely — never a regression on top of the
//      pre-#967 ungated behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const readNangoConnectionByNaturalKey = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  readNangoConnectionByNaturalKey: (...a: unknown[]) => readNangoConnectionByNaturalKey(...a),
}));

const registerSavedConnectionIdentity = vi.fn();
class ConnectionIdentityConflictError extends Error {}
vi.mock("@/lib/connection-identity-seam", () => ({
  registerSavedConnectionIdentity: (...a: unknown[]) => registerSavedConnectionIdentity(...a),
  ConnectionIdentityConflictError,
}));

const enforceConnectionUse = vi.fn(async (..._args: unknown[]) => ({ allowed: true }));
vi.mock("@/lib/connection-use-gate", () => ({
  enforceConnectionUse: (...a: unknown[]) => enforceConnectionUse(...a),
  connectionSubjectUserId: (actor: { principalType: string; principalId: string; runAsUserId?: string }) =>
    actor.principalType === "HumanUser" ? actor.principalId : actor.runAsUserId,
}));

const resolveSingleTenantContentEditorIdentity = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveSingleTenantContentEditorIdentity: (...a: unknown[]) =>
    resolveSingleTenantContentEditorIdentity(...a),
}));

import {
  resolveOrSeedInstanceIdentity,
  buildInstanceActor,
  enforceInstanceConnectionUse,
  resolveOrSeedPerUserInstanceIdentity,
  enforcePerUserInstanceConnectionUse,
} from "@/lib/instance-connection-actor";

function identity(over: Partial<NangoConnectionIdentity> = {}): NangoConnectionIdentity {
  return {
    id: "identity-1",
    organizationId: "org-1",
    connectorPackageId: "@cinatra-ai/wordpress-mcp-connector",
    connectorKey: "wordpress",
    connectionId: "conn-1",
    ownerUserId: "user-1",
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enforceConnectionUse.mockResolvedValue({ allowed: true });
});

describe("resolveOrSeedInstanceIdentity", () => {
  it("returns the existing identity row without seeding when one already exists", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity());

    const result = await resolveOrSeedInstanceIdentity({
      connectorKey: "wordpress",
      connectionId: "conn-1",
    });

    expect(result?.id).toBe("identity-1");
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
  });

  it("seeds a new identity row using the supplied {orgId, runBy} binding when absent", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    registerSavedConnectionIdentity.mockResolvedValue(identity({ ownerUserId: "user-2", organizationId: "org-2" }));

    const result = await resolveOrSeedInstanceIdentity({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      binding: { orgId: "org-2", runBy: "user-2" },
    });

    expect(registerSavedConnectionIdentity).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      ownerUserId: "user-2",
      organizationId: "org-2",
      seed: "workspace",
    });
    expect(result?.ownerUserId).toBe("user-2");
    expect(resolveSingleTenantContentEditorIdentity).not.toHaveBeenCalled();
  });

  it("falls back to the single-tenant default owner/org when no binding is supplied", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    resolveSingleTenantContentEditorIdentity.mockResolvedValue({ orgId: "default-org", runBy: "default-admin" });
    registerSavedConnectionIdentity.mockResolvedValue(identity({ ownerUserId: "default-admin", organizationId: "default-org" }));

    await resolveOrSeedInstanceIdentity({ connectorKey: "wordpress", connectionId: "conn-1" });

    expect(registerSavedConnectionIdentity).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      ownerUserId: "default-admin",
      organizationId: "default-org",
      seed: "workspace",
    });
  });

  it("a partial {orgId, runBy} pair is treated as no binding (atomic unit) — falls back to single-tenant", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    resolveSingleTenantContentEditorIdentity.mockResolvedValue({ orgId: "default-org", runBy: "default-admin" });
    registerSavedConnectionIdentity.mockResolvedValue(identity());

    await resolveOrSeedInstanceIdentity({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      binding: { orgId: "org-2" /* runBy missing */ },
    });

    expect(resolveSingleTenantContentEditorIdentity).toHaveBeenCalled();
  });

  it("returns null (never blocks) when no owner can be resolved at all — the pre-#967 ungated fallback", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    resolveSingleTenantContentEditorIdentity.mockResolvedValue(null);

    const result = await resolveOrSeedInstanceIdentity({ connectorKey: "wordpress", connectionId: "conn-1" });

    expect(result).toBeNull();
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
  });

  it("a foreign-row conflict during seeding FAILS CLOSED (propagates) — never silently falls back to the ungated read", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    resolveSingleTenantContentEditorIdentity.mockResolvedValue({ orgId: "org-2", runBy: "user-2" });
    registerSavedConnectionIdentity.mockRejectedValue(new ConnectionIdentityConflictError("foreign row"));

    await expect(
      resolveOrSeedInstanceIdentity({ connectorKey: "wordpress", connectionId: "conn-1" }),
    ).rejects.toThrow(ConnectionIdentityConflictError);
  });
});

describe("buildInstanceActor", () => {
  it("builds a HumanUser actor when the binding's runBy IS the identity's recorded owner", () => {
    const actor = buildInstanceActor({
      identity: identity({ ownerUserId: "user-1" }),
      binding: { orgId: "org-1", runBy: "user-1" },
      source: "wordpress-api",
    });

    expect(actor).toMatchObject({ principalType: "HumanUser", principalId: "user-1", organizationId: "org-1" });
  });

  it("builds an org-bound InternalWorker with NO runAsUserId (never a fabricated ownership claim) when the binding does not name the identity's owner", () => {
    const actor = buildInstanceActor({
      identity: identity({ ownerUserId: "other-owner", organizationId: "org-9" }),
      binding: undefined,
      source: "wordpress-api",
    });

    expect(actor.principalType).toBe("InternalWorker");
    expect(actor.organizationId).toBe("org-9");
    // Load-bearing (codex round-0 finding): asserting `runAsUserId:
    // identity.ownerUserId` would trip the gate's OWN short-circuit and
    // self-authorize against ANY existing row — a tautology, not
    // authorization. The worker must be authorized by the REAL workspace
    // grant, not a fabricated ownership claim.
    expect((actor as { runAsUserId?: string }).runAsUserId).toBeUndefined();
  });
});

describe("enforceInstanceConnectionUse", () => {
  it("threads the actor through enforceConnectionUse and returns the identity on allow", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity({ ownerUserId: "user-1" }));

    const result = await enforceInstanceConnectionUse({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      binding: { orgId: "org-1", runBy: "user-1" },
      source: "wordpress-api",
    });

    expect(result?.id).toBe("identity-1");
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
    const call = (enforceConnectionUse.mock.calls[0] as unknown[])[0] as {
      actor: { principalType: string; principalId: string };
      subjectUserId?: string;
      source?: string;
    };
    expect(call.actor).toMatchObject({ principalType: "HumanUser", principalId: "user-1" });
    expect(call.subjectUserId).toBe("user-1");
    expect(call.source).toBe("wordpress-api");
  });

  it("propagates a deny (fails closed) — the underlying gate audits before throwing", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity());
    class Denied extends Error {}
    enforceConnectionUse.mockRejectedValueOnce(new Denied("denied"));

    await expect(
      enforceInstanceConnectionUse({ connectorKey: "wordpress", connectionId: "conn-1", source: "wordpress-api" }),
    ).rejects.toThrow(Denied);
  });

  it("skips gating (returns null, never calls enforceConnectionUse) when no identity could be resolved/seeded", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    resolveSingleTenantContentEditorIdentity.mockResolvedValue(null);

    const result = await enforceInstanceConnectionUse({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      source: "wordpress-api",
    });

    expect(result).toBeNull();
    expect(enforceConnectionUse).not.toHaveBeenCalled();
  });
});

describe("per-user (org-less) instance identity — cinatra#967 LinkedIn scope:user path", () => {
  it("seeds a NULL-org identity owned by the exact live userId when absent", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    registerSavedConnectionIdentity.mockResolvedValue(identity({ ownerUserId: "user-42", organizationId: null }));

    const result = await resolveOrSeedPerUserInstanceIdentity({
      connectorKey: "linkedin",
      connectionId: "li-conn",
      userId: "user-42",
    });

    expect(registerSavedConnectionIdentity).toHaveBeenCalledWith({
      connectorKey: "linkedin",
      connectionId: "li-conn",
      ownerUserId: "user-42",
      organizationId: null,
    });
    expect(result?.organizationId).toBeNull();
  });

  it("enforcePerUserInstanceConnectionUse threads a HumanUser actor (never a worker) matching the live userId", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity({ ownerUserId: "user-42", organizationId: null }));

    await enforcePerUserInstanceConnectionUse({
      connectorKey: "linkedin",
      connectionId: "li-conn",
      userId: "user-42",
      source: "linkedin-api",
    });

    const call = (enforceConnectionUse.mock.calls[0] as unknown[])[0] as {
      actor: { principalType: string; principalId: string };
      subjectUserId?: string;
      source?: string;
    };
    expect(call.actor).toMatchObject({ principalType: "HumanUser", principalId: "user-42" });
    expect(call.subjectUserId).toBe("user-42");
  });

  it("a foreign-row conflict during per-user seeding FAILS CLOSED (propagates)", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    registerSavedConnectionIdentity.mockRejectedValue(new ConnectionIdentityConflictError("foreign row"));

    await expect(
      resolveOrSeedPerUserInstanceIdentity({ connectorKey: "linkedin", connectionId: "li-conn", userId: "user-42" }),
    ).rejects.toThrow(ConnectionIdentityConflictError);
  });
});
