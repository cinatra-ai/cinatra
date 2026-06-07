import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Connector access scope guard
//
// guardConnectorAccess(connectorId, actor) looks up the connector's
// ownership tuple and routes the visibility check through enforceRunAccess.
// Throws CONNECTOR_ACCESS_DENIED on deny; throws ACTOR_CONTEXT_MISSING when
// called outside an ALS frame.
// ---------------------------------------------------------------------------

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    teamIds: ["team-a"],
    projectIds: [],
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v1",
    ...overrides,
  } as ActorContext;
}

// Mock the connector lookup module so the guard is testable without a DB.
vi.mock("@/lib/connectors-store", () => ({
  readConnectorOwnershipById: vi.fn(),
}));

// Mock enforceRunAccess to drive allow/deny outcomes.
// SUT imports from the agents auth-policy package.
vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  enforceRunAccess: vi.fn(),
}));

class AuthzErrorStub extends Error {
  statusCode: number;
  reason: string;
  constructor(args: { statusCode: number; reason: string; message: string }) {
    super(args.message);
    this.statusCode = args.statusCode;
    this.reason = args.reason;
  }
}

import { guardConnectorAccess } from "@/lib/connectors-scope-guard";
import { readConnectorOwnershipById } from "@/lib/connectors-store";
import { enforceRunAccess } from "@cinatra-ai/agents/auth-policy";
import { withActorContext } from "@cinatra-ai/llm";

describe("guardConnectorAccess", () => {
  beforeEach(() => {
    vi.mocked(readConnectorOwnershipById).mockReset();
    vi.mocked(enforceRunAccess).mockReset();
  });

  it("allows when enforceRunAccess resolves (org visibility, same org)", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "c1",
      organizationId: "org-1",
      ownerType: "user",
      ownerId: "user-1",
      visibility: "org",
    });
    vi.mocked(enforceRunAccess).mockResolvedValue(undefined);

    await withActorContext(actor(), async () => {
      await expect(guardConnectorAccess("c1", actor())).resolves.toBeUndefined();
    });
    expect(enforceRunAccess).toHaveBeenCalledTimes(1);
  });

  it("allows when team:T1 visibility and actor in T1", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "c2",
      organizationId: "org-1",
      ownerType: "team",
      ownerId: "team-a",
      visibility: "team:team-a",
    });
    vi.mocked(enforceRunAccess).mockResolvedValue(undefined);

    await withActorContext(actor({ teamIds: ["team-a"] }), async () => {
      await expect(guardConnectorAccess("c2", actor({ teamIds: ["team-a"] }))).resolves.toBeUndefined();
    });
  });

  it("denies with CONNECTOR_ACCESS_DENIED when actor not in team", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "c3",
      organizationId: "org-1",
      ownerType: "team",
      ownerId: "team-x",
      visibility: "team:team-x",
    });
    vi.mocked(enforceRunAccess).mockRejectedValue(
      new AuthzErrorStub({ statusCode: 403, reason: "forbidden", message: "denied" }),
    );

    const a = actor({ teamIds: ["team-y"] });
    await withActorContext(a, async () => {
      await expect(guardConnectorAccess("c3", a)).rejects.toMatchObject({
        code: "CONNECTOR_ACCESS_DENIED",
      });
    });
  });

  it("throws ACTOR_CONTEXT_MISSING when called outside an ALS frame with no actor arg", async () => {
    // Calling without an active frame and forcing internal getActorContextOrThrow
    await expect(
      guardConnectorAccess("c4", undefined),
    ).rejects.toMatchObject({ code: "ACTOR_CONTEXT_MISSING" });
  });

  it("allows workspace-scoped connector for any authenticated principal (member role, different org)", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "twenty-workspace",
      organizationId: null,
      ownerType: "workspace",
      ownerId: "twenty-workspace",
      visibility: "workspace",
    });

    const a = actor({ organizationId: "org-2", teamIds: [], platformRole: "member" });
    await withActorContext(a, async () => {
      await expect(guardConnectorAccess("twenty-workspace", a)).resolves.toBeUndefined();
    });
    // enforceRunAccess must NOT be consulted for workspace-scope reads.
    expect(enforceRunAccess).not.toHaveBeenCalled();
  });

  it("allows workspace-scoped connector for a roleless service-account actor", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "twenty-workspace",
      organizationId: null,
      ownerType: "workspace",
      ownerId: "twenty-workspace",
      visibility: "workspace",
    });

    const a = actor({
      principalType: "ServiceAccount",
      principalId: "model-actor",
      organizationId: "org-3",
      teamIds: [],
      platformRole: "member",
    });
    await withActorContext(a, async () => {
      await expect(guardConnectorAccess("twenty-workspace", a)).resolves.toBeUndefined();
    });
    expect(enforceRunAccess).not.toHaveBeenCalled();
  });

  it("user-owned connector still routes through enforceRunAccess (no workspace bypass leak)", async () => {
    vi.mocked(readConnectorOwnershipById).mockResolvedValue({
      connectorId: "user-c1",
      organizationId: "org-1",
      ownerType: "user",
      ownerId: "user-1",
      visibility: "owner",
    });
    vi.mocked(enforceRunAccess).mockResolvedValue(undefined);

    await withActorContext(actor(), async () => {
      await expect(guardConnectorAccess("user-c1", actor())).resolves.toBeUndefined();
    });
    expect(enforceRunAccess).toHaveBeenCalledTimes(1);
  });
});
