// D3 (eng#548 #1625) — the send-routing resolver read actor.
//
// Root cause: `resolveConnectorId`'s sender-identity reads ran through a
// ROLE-LESS System actor that the authz kernel denies `object.read` — so
// `filterByAuthz` silently dropped EVERY sender-identity row and the routing
// chain fell through to the first-registered connector (gmail) on every send.
// Fix: read as the run OWNER (`ownerReadActorForOrg`) so the owner's own
// (default-private) mailbox identity + the org-default identity are readable.
//
// Two test groups, split deliberately so neither can false-green (per the codex
// convergence, .planning/codex-verdict-d3.md):
//   A) the REAL authz gate (`enforceResourceAccess`) — proves the axis: a
//      role-less System envelope is DENIED (the silent-drop cause), while a
//      HumanUser owner envelope is ALLOWED, and the owner short-circuit reads a
//      user-PRIVATE row WITHOUT `member` masking the result. Cross-org denied.
//   B) the REAL `resolveConnectorId` (not mocked) driven through the capability
//      registry — proves the resolver's own logic (the objects_get unwrap +
//      sender-identity TYPE guard, the chain order, the fall-throughs) AND
//      asserts the store actor is EXACTLY the owner-scoped shape (so a mocked
//      store cannot false-green on a stale System/user-less envelope).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Group A — the REAL authz gate. No mocks beyond `server-only`; this exercises
// enforceResourceAccess → decideResourceAccess → kernel can() → policies.
// ---------------------------------------------------------------------------
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";

const ORG = "org-td1625";
const OTHER_ORG = "org-other";
const OWNER = "user-owner-td1625";

const SENDER_IDENTITY_TYPE = "@cinatra-ai/email:sender-identity";

// A sender-identity object row as the objects layer would surface it, at the
// two visibilities that matter: the run owner's OWN (default-private) mailbox,
// and an org-owned org-visible default.
function userPrivateIdentity(overrides: Partial<ResourceForAccessCheck> = {}): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: "si-user-1",
    organizationId: ORG,
    ownerLevel: "user",
    ownerId: OWNER,
    visibility: "private",
    ...overrides,
  };
}
function orgVisibleIdentity(overrides: Partial<ResourceForAccessCheck> = {}): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: "si-org-1",
    organizationId: ORG,
    ownerLevel: "organization",
    ownerId: ORG,
    visibility: "organization",
    ...overrides,
  };
}

// Envelopes EXACTLY as `actorContextToObjectsEnvelope` produces them for the
// three actor shapes (objects-actor-envelope.ts:39-74): the objects handler
// reads these off `request.actor`.
const roleLessSystemEnvelope = {
  actorType: "system" as const,
  source: "worker" as const,
  orgId: ORG,
  organizationId: ORG,
  // NO userId (System is user-less), NO roles — the exact old shape.
};
const roleLessHumanOwnerEnvelope = {
  actorType: "human" as const,
  source: "worker" as const,
  userId: OWNER,
  orgId: ORG,
  organizationId: ORG,
  // NO roles — isolates the OWNER short-circuit from any member masking.
};
const ownerMemberEnvelope = {
  actorType: "human" as const,
  source: "worker" as const,
  userId: OWNER,
  orgId: ORG,
  organizationId: ORG,
  roles: ["member"],
};
const systemMemberEnvelope = {
  actorType: "system" as const,
  source: "worker" as const,
  orgId: ORG,
  organizationId: ORG,
  roles: ["member"],
};

describe("D3 authz gate — object.read on a sender-identity row", () => {
  it("REGRESSION: a role-less System actor is DENIED object.read (the silent-drop cause)", async () => {
    // This is exactly what `filterByAuthz` caught-and-dropped for every row.
    await expect(
      enforceResourceAccess(orgVisibleIdentity(), roleLessSystemEnvelope, "object.read"),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(
      enforceResourceAccess(userPrivateIdentity(), roleLessSystemEnvelope, "object.read"),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("a HumanUser owner reads their OWN user-PRIVATE identity via the owner short-circuit — WITHOUT any role", async () => {
    // The decisive axis: no `member`, no `platform_admin`. Only the human
    // principalId === ownerId owner match. A System/platform_admin actor could
    // NEVER reach this (their principal is not the owner's userId).
    await expect(
      enforceResourceAccess(userPrivateIdentity(), roleLessHumanOwnerEnvelope, "object.read"),
    ).resolves.toBeUndefined();
  });

  it("member grants object.read on the ORG-owned org-visible identity (step 4 fallback)", async () => {
    await expect(
      enforceResourceAccess(orgVisibleIdentity(), ownerMemberEnvelope, "object.read"),
    ).resolves.toBeUndefined();
    await expect(
      enforceResourceAccess(orgVisibleIdentity(), systemMemberEnvelope, "object.read"),
    ).resolves.toBeUndefined();
  });

  it("does NOT widen cross-org: the owner+member actor is DENIED a row in another org", async () => {
    await expect(
      enforceResourceAccess(
        orgVisibleIdentity({ organizationId: OTHER_ORG, resourceId: "si-cross" }),
        ownerMemberEnvelope,
        "object.read",
      ),
    ).rejects.toBeInstanceOf(AuthzError);
  });
});

// ---------------------------------------------------------------------------
// Group B — the REAL resolveConnectorId through the capability registry.
//
// The objects store is mocked at `@cinatra-ai/objects` (the seam
// `register-email-providers` imports) so the resolver's own logic is exercised
// and the store ACTOR is captured. Authz correctness is proven by Group A; here
// we prove (a) actor shape and (b) unwrap/type-guard/chain logic.
// ---------------------------------------------------------------------------
const capturedActors: Array<Record<string, unknown>> = [];
let seededListItems: Array<{ data?: Record<string, unknown> }> = [];
let seededGet: (id: string) => Promise<{ object: unknown } | unknown | null> = async () => ({
  object: null,
});

vi.mock("@cinatra-ai/objects", () => ({
  createSessionObjectsClient: vi.fn((actor: Record<string, unknown>) => {
    capturedActors.push(actor);
    return {
      list: vi.fn(async () => ({ items: seededListItems, nextCursor: null })),
      get: vi.fn(async (id: string) => seededGet(id)),
    };
  }),
  objectsClient: { save: vi.fn(async () => undefined) },
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
}));

import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";
// Importing the module auto-registers the routing impl into the capability
// registry (side effect at module load).
import "@/lib/register-email-providers";

type ResolveConnectorId = (opts: {
  explicitConnectorId?: string;
  senderIdentityId?: string;
  userId?: string;
  orgId?: string;
}) => Promise<string | null>;

function getResolveConnectorId(): ResolveConnectorId {
  const providers = resolveCapabilityProviders(
    HOST_CONNECTOR_SERVICE_CAPABILITIES.emailRouting,
  );
  const impl = providers[0]?.impl as { resolveConnectorId?: ResolveConnectorId } | undefined;
  if (!impl?.resolveConnectorId) throw new Error("email-routing impl not registered");
  return impl.resolveConnectorId;
}

describe("D3 resolver — resolveConnectorId against the objects store", () => {
  beforeEach(() => {
    capturedActors.length = 0;
    seededListItems = [];
    seededGet = async () => ({ object: null });
  });

  it("explicit connectorId short-circuits — no objects read at all", async () => {
    const connectorId = await getResolveConnectorId()({
      explicitConnectorId: "resend",
      userId: OWNER,
      orgId: ORG,
    });
    expect(connectorId).toBe("resend");
    expect(capturedActors).toHaveLength(0);
  });

  it("resolves the run OWNER's user-level identity AND builds a HumanUser owner actor (principalId === userId, org, member)", async () => {
    seededListItems = [
      { data: { ownerLevel: "user", ownerId: OWNER, connectorId: "resend", fromEmail: "o@x.test" } },
    ];
    const connectorId = await getResolveConnectorId()({ userId: OWNER, orgId: ORG });
    expect(connectorId).toBe("resend");
    // codex anti-false-green remedy: assert the store actor is EXACTLY the
    // owner-scoped shape (a stale System/user-less envelope would fail here).
    const actor = capturedActors[0];
    expect(actor.principalType).toBe("HumanUser");
    expect(actor.principalId).toBe(OWNER);
    expect(actor.organizationId).toBe(ORG);
    expect(actor.orgRole).toBe("member");
  });

  it("resolves the ORG-owned identity via a System+member actor when there is no run-owner user", async () => {
    seededListItems = [
      { data: { ownerLevel: "organization", ownerId: ORG, connectorId: "resend" } },
    ];
    const connectorId = await getResolveConnectorId()({ orgId: ORG });
    expect(connectorId).toBe("resend");
    const actor = capturedActors[0];
    expect(actor.principalType).toBe("System");
    expect(actor.organizationId).toBe(ORG);
    expect(actor.orgRole).toBe("member");
  });

  it("explicit senderIdentityId resolves through the {object} envelope unwrap", async () => {
    seededGet = async () => ({
      object: {
        id: "si-explicit",
        type: SENDER_IDENTITY_TYPE,
        data: { connectorId: "resend", fromEmail: "o@x.test" },
      },
    });
    const connectorId = await getResolveConnectorId()({
      senderIdentityId: "si-explicit",
      userId: OWNER,
      orgId: ORG,
    });
    expect(connectorId).toBe("resend");
  });

  it("REJECTS a non-sender object that merely carries data.connectorId (type guard)", async () => {
    // A readable object of ANOTHER type with a `connectorId` field must NOT
    // masquerade as a sender-identity. It falls through; with no other identity
    // seeded, the resolver returns null (facade applies its own fallback).
    seededGet = async () => ({
      object: {
        id: "not-a-sender",
        type: "@cinatra-ai/email:sent-email",
        data: { connectorId: "smuggled" },
      },
    });
    const connectorId = await getResolveConnectorId()({
      senderIdentityId: "not-a-sender",
      userId: OWNER,
      orgId: ORG,
    });
    expect(connectorId).toBeNull();
  });

  it("returns null (chain fall-through) when no identity is readable", async () => {
    seededListItems = [];
    seededGet = async () => ({ object: null });
    const connectorId = await getResolveConnectorId()({ userId: OWNER, orgId: ORG });
    expect(connectorId).toBeNull();
  });
});
