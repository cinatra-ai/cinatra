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

const getAuthSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
}));

import {
  resolveOrSeedInstanceIdentity,
  buildInstanceActor,
  enforceInstanceConnectionUse,
  resolveOrSeedPerUserInstanceIdentity,
  enforcePerUserInstanceConnectionUse,
  authorizeWorkerConnectionUse,
  isConnectionUseDeniedError,
  resolveTrustedSessionBinding,
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

// ---------------------------------------------------------------------------
// #975 Wave 3 prerequisite (epic #978): the actor-less worker gate + the
// cross-boundary deny classifier the `@cinatra-ai/host:instance-connection-gate`
// capability service publishes to relocated vendor clients.
// ---------------------------------------------------------------------------

/** The host use-gate deny, shaped structurally (the marker field is what the
 * classifier keys on — the real `ConnectionUseDeniedError` carries it as a
 * class field; this test module mocks `@/lib/connection-use-gate`, so the
 * marker is reproduced here). */
class DeniedShape extends Error {
  readonly connectionUseDenied = true as const;
}

describe("isConnectionUseDeniedError (cross-boundary deny classifier)", () => {
  it("classifies an Error carrying the connectionUseDenied marker as a deny", () => {
    expect(isConnectionUseDeniedError(new DeniedShape("denied"))).toBe(true);
  });

  it("does NOT classify a generic Error, a non-Error, or a spoofed non-true marker", () => {
    expect(isConnectionUseDeniedError(new Error("boom"))).toBe(false);
    expect(isConnectionUseDeniedError({ connectionUseDenied: true })).toBe(false);
    const nonTrue = new Error("boom") as Error & { connectionUseDenied?: unknown };
    nonTrue.connectionUseDenied = "yes";
    expect(isConnectionUseDeniedError(nonTrue)).toBe(false);
    expect(isConnectionUseDeniedError(undefined)).toBe(false);
  });

  it("classifies the REAL ConnectionUseDeniedError class (marker stays in sync)", async () => {
    // Import the ACTUAL module (bypassing this file's mock) so a drift
    // between the class's marker field and the structural classifier fails
    // here, not in production.
    const actual = await vi.importActual<typeof import("@/lib/connection-use-gate")>(
      "@/lib/connection-use-gate",
    );
    const denied = new actual.ConnectionUseDeniedError({ statusCode: 403, reason: "forbidden" });
    expect(isConnectionUseDeniedError(denied)).toBe(true);
  });
});

describe("authorizeWorkerConnectionUse (actor-less worker gate — the youtube-api scraper-mint pattern)", () => {
  it("fails CLOSED (false) when NO identity row exists — never seeds one", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);

    const result = await authorizeWorkerConnectionUse({
      connectorKey: "youtube",
      connectionId: "yt-conn",
      source: "media-feeds-scraper",
    });

    expect(result).toBe(false);
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
    expect(resolveSingleTenantContentEditorIdentity).not.toHaveBeenCalled();
    expect(enforceConnectionUse).not.toHaveBeenCalled();
  });

  it("threads an ORG-BOUND InternalWorker actor (no runAsUserId, no subjectUserId) and authorizes on allow", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity({ organizationId: "org-7" }));

    const result = await authorizeWorkerConnectionUse({
      connectorKey: "youtube",
      connectionId: "yt-conn",
      source: "media-feeds-scraper",
      runId: "run-1",
    });

    expect(result).toBe(true);
    const call = (enforceConnectionUse.mock.calls[0] as unknown[])[0] as {
      actor: { principalType: string; principalId: string; organizationId?: string; runAsUserId?: string };
      subjectUserId?: string;
      runId?: string;
      source?: string;
    };
    expect(call.actor).toMatchObject({
      principalType: "InternalWorker",
      principalId: "worker:media-feeds-scraper",
      organizationId: "org-7",
    });
    expect(call.actor.runAsUserId).toBeUndefined();
    expect(call.subjectUserId).toBeUndefined();
    expect(call.runId).toBe("run-1");
    expect(call.source).toBe("media-feeds-scraper");
  });

  it("folds a use-gate DENY to a bare false (the gate audited before throwing) — falsy so `if (await …)` reads a deny correctly", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity());
    enforceConnectionUse.mockRejectedValueOnce(new DeniedShape("denied"));

    const result = await authorizeWorkerConnectionUse({
      connectorKey: "youtube",
      connectionId: "yt-conn",
      source: "media-feeds-scraper",
    });

    expect(result).toBe(false);
  });

  it("rethrows an UNEXPECTED error fail-loud (never folded to a boolean)", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(identity());
    enforceConnectionUse.mockRejectedValueOnce(new Error("db down"));

    await expect(
      authorizeWorkerConnectionUse({
        connectorKey: "youtube",
        connectionId: "yt-conn",
        source: "media-feeds-scraper",
      }),
    ).rejects.toThrow("db down");
  });
});

describe("resolveTrustedSessionBinding (the trusted FRESH-binding source — codex round-0 finding)", () => {
  it("resolves {orgId, runBy} from the validated session (both ids required)", async () => {
    getAuthSession.mockResolvedValue({
      session: { activeOrganizationId: "org-5" },
      user: { id: "admin-5" },
    });

    await expect(resolveTrustedSessionBinding()).resolves.toEqual({
      orgId: "org-5",
      runBy: "admin-5",
    });
  });

  it("returns null — never half a binding — when the org or user id is missing/blank", async () => {
    getAuthSession.mockResolvedValue({
      session: { activeOrganizationId: "  " },
      user: { id: "admin-5" },
    });
    await expect(resolveTrustedSessionBinding()).resolves.toBeNull();

    getAuthSession.mockResolvedValue({ session: {}, user: { id: "admin-5" } });
    await expect(resolveTrustedSessionBinding()).resolves.toBeNull();

    getAuthSession.mockResolvedValue(null);
    await expect(resolveTrustedSessionBinding()).resolves.toBeNull();
  });

  it("NEVER throws: a session-less / no-request-context path yields null (import-era drupal-api semantics)", async () => {
    getAuthSession.mockRejectedValue(new Error("headers() called outside a request scope"));

    await expect(resolveTrustedSessionBinding()).resolves.toBeNull();
  });
});
