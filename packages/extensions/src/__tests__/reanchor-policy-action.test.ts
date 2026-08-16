/**
 * §V RE-ANCHOR — the SERVER ACTION boundary (cinatra#2694 / S5 #2802).
 *
 * Owner ruling 2026-08-16 (entry 350): saving the §V access picker re-anchors
 * the install row. This suite drives the real `saveExtensionAccessPolicy` and
 * pins the routing decisions it owns:
 *
 *   - the install-row-anchored kinds (connector / artifact / workflow) go
 *     through the ONE sanctioned re-anchor primitive — never the plain policy
 *     write;
 *   - every other kind is byte-identical to before (plain policy write);
 *   - an ANCHOR MOVE is platform-admin-only; a non-platform admin may still make
 *     an ordinary same-anchor policy edit;
 *   - the connector ceiling veto is measured against the DESTINATION
 *     organization and runs BEFORE the mutation;
 *   - an unresolvable / multi-organization destination is `invalid_locus`, and a
 *     typed refusal from the primitive reaches the caller — writing nothing in
 *     both cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ROW_ID = "iext_reanchor_2802";
const PKG = "@cinatra-ai/reanchor-action-2802";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actorState: {
  platformRole: "platform_admin" | "member";
  organizationId: string | null;
} = { platformRole: "platform_admin", organizationId: ORG_A };

vi.mock("@/lib/auth-session", () => ({
  getActorContext: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-2802",
    platformRole: actorState.platformRole,
    organizationId: actorState.organizationId,
  })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-2802" } })),
}));

// The actor holds BOTH organizations, so a foreign-locus refusal in these tests
// is never an accident of the membership set.
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: vi.fn() },
  betterAuthUsers: {},
  readOrgsWithTeamsForUser: vi.fn(async () => [
    { id: ORG_A, name: "A", teams: [] },
    { id: ORG_B, name: "B", teams: [] },
  ]),
}));

vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(async () => null),
}));

// The edit gate opens: the saving actor manages this resource.
vi.mock("../enforce-extension-access", () => ({
  canExtensionAccess: vi.fn(async () => ({ allowed: true })),
  hasAdminStandingOverExtension: vi.fn(() => true),
}));

const writeMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../permissions-store", () => ({
  writeExtensionAccessPolicy: (...a: unknown[]) => writeMock(...a),
  readExtensionAccessPolicy: vi.fn(async () => null),
  readExtensionCoOwners: vi.fn(async () => []),
  readExtensionInstalledBy: vi.fn(async () => "user-2802"),
  addExtensionCoOwner: vi.fn(),
  removeExtensionCoOwner: vi.fn(),
}));

// The canonical row the save re-anchors — organization-anchored in ORG_A.
const rowState: {
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
} = { ownerLevel: "organization", ownerId: ORG_A, organizationId: ORG_A };

vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: vi.fn(async () => ({
    id: ROW_ID,
    packageName: PKG,
    kind: "artifact",
    status: "active",
    version: "1.0.0",
    isDefault: true,
    ...rowState,
  })),
}));

const reanchorMock = vi.fn(async (_args: unknown) => ({
  row: { id: ROW_ID },
  supersededRowIds: [] as string[],
  anchorMoved: true,
}));

vi.mock("../lifecycle-primitive", async () => {
  class ReanchorRefusedError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ReanchorRefusedError";
    }
  }
  return {
    ReanchorRefusedError,
    reanchorInstallRow: (args: unknown) => reanchorMock(args),
  };
});

const validatePolicyWrite = vi.fn(
  async (
    _id: string,
    _policy: AgentAuthPolicy,
    _ctx: { destinationOrganizationId?: string | null },
  ): Promise<string | null> => null,
);

vi.mock("../permissions-kind-hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../permissions-kind-hooks")>();
  return {
    ...actual,
    getExtensionKindHooks: vi.fn(async (kind: string) => ({
      resourceExists: vi.fn(async () => true),
      resolveOwnerContext: vi.fn(async () => ({
        ownerLevel: rowState.ownerLevel,
        ownerId: rowState.ownerId,
        organizationId: rowState.organizationId,
      })),
      ...(kind === "connector" || kind === "artifact" || kind === "workflow"
        ? { validatePolicyWrite }
        : {}),
      selfRemoveRedirect: "/",
    })),
  };
});

function policy(...tokens: string[]): AgentAuthPolicy {
  const selection = tokens as AgentAuthPolicy["runListVisibility"];
  return {
    runListVisibility: selection,
    runDataVisibility: selection,
    runExecuteVisibility: selection,
    allowRunSharing: false,
  };
}

async function save(kind: string, p: AgentAuthPolicy) {
  const { saveExtensionAccessPolicy } = await import("../permissions-actions");
  return saveExtensionAccessPolicy(kind, ROW_ID, p);
}

beforeEach(() => {
  vi.clearAllMocks();
  actorState.platformRole = "platform_admin";
  actorState.organizationId = ORG_A;
  rowState.ownerLevel = "organization";
  rowState.ownerId = ORG_A;
  rowState.organizationId = ORG_A;
  validatePolicyWrite.mockResolvedValue(null);
  reanchorMock.mockResolvedValue({ row: { id: ROW_ID }, supersededRowIds: [], anchorMoved: true });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — §V widening routes through the re-anchor primitive", () => {
  it('moves the row to the workspace anchor for "Workspace: All"', async () => {
    await expect(save("artifact", policy("workspace"))).resolves.toEqual({ ok: true });
    expect(writeMock).not.toHaveBeenCalled();
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock.mock.calls[0]![0]).toMatchObject({
      rowId: ROW_ID,
      resourceKind: "artifact",
      destination: { ownerLevel: "workspace", ownerId: "__platform__", organizationId: null },
    });
  });

  it('moves the row to the workspace anchor for "Workspace: Admins only"', async () => {
    await expect(save("connector", policy("admin"))).resolves.toEqual({ ok: true });
    expect(reanchorMock.mock.calls[0]![0]).toMatchObject({
      destination: { ownerLevel: "workspace", organizationId: null },
    });
  });

  it("narrows a workspace row back to a conflict-free organization", async () => {
    rowState.ownerLevel = "workspace";
    rowState.ownerId = "__platform__";
    rowState.organizationId = null;

    await expect(save("artifact", policy(`org:${ORG_B}`))).resolves.toEqual({ ok: true });
    expect(reanchorMock.mock.calls[0]![0]).toMatchObject({
      destination: { ownerLevel: "organization", ownerId: ORG_B, organizationId: ORG_B },
    });
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — who may move an anchor", () => {
  it("refuses an anchor move by a non-platform admin, writing nothing", async () => {
    actorState.platformRole = "member";
    await expect(save("artifact", policy("workspace"))).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("still lets a non-platform admin edit the policy AT THE SAME anchor", async () => {
    actorState.platformRole = "member";
    // org:A is the row's own organization — the anchor does not move.
    await expect(save("artifact", policy(`org:${ORG_A}`))).resolves.toEqual({ ok: true });
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock.mock.calls[0]![0]).toMatchObject({
      destination: { ownerLevel: "organization", ownerId: ORG_A, organizationId: ORG_A },
    });
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — typed refusals write nothing", () => {
  it("refuses a selection spanning two organizations as invalid_locus", async () => {
    await expect(save("artifact", policy(`org:${ORG_A}`, `org:${ORG_B}`))).resolves.toEqual({
      ok: false,
      error: "invalid_locus",
    });
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("surfaces anchor_conflict from the primitive", async () => {
    const { ReanchorRefusedError } = await import("../lifecycle-primitive");
    reanchorMock.mockRejectedValueOnce(
      new (ReanchorRefusedError as unknown as new (c: string, m: string) => Error)(
        "anchor_conflict",
        "occupied",
      ),
    );
    await expect(save("artifact", policy("workspace"))).resolves.toEqual({
      ok: false,
      error: "anchor_conflict",
    });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("surfaces the connector ceiling veto BEFORE any mutation", async () => {
    validatePolicyWrite.mockResolvedValueOnce("scope_locked_by_connector");
    await expect(save("connector", policy("workspace"))).resolves.toEqual({
      ok: false,
      error: "scope_locked_by_connector",
    });
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("hands the veto the DESTINATION organization, not the row's current one", async () => {
    await save("connector", policy(`org:${ORG_B}`));
    expect(validatePolicyWrite).toHaveBeenCalledTimes(1);
    expect(validatePolicyWrite.mock.calls[0]![2]).toMatchObject({
      destinationOrganizationId: ORG_B,
    });

    validatePolicyWrite.mockClear();
    await save("connector", policy("workspace"));
    expect(validatePolicyWrite.mock.calls[0]![2]).toMatchObject({
      destinationOrganizationId: null,
    });
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — non-install-row kinds are untouched", () => {
  it("keeps the plain policy write for skill_package", async () => {
    await expect(save("skill_package", policy("workspace"))).resolves.toEqual({ ok: true });
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});
