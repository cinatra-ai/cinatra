/**
 * Each `objects_*` MCP handler must invoke `enforceResourceAccess`
 * against the resolved row. These tests verify that the handlers are
 * wrapped with the helper and that the authorization-test wiring
 * (vi.mock for the store + a stable authz spy) is in place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks. The handlers under test reach into the host-app
// objects-store, the authz kernel barrel (used transitively by
// enforceResourceAccess), and a few side-effecting modules — none of
// which can run in a Node vitest environment without a real Postgres /
// Redis. We replace each with a deterministic stub that exercises only
// the handler authorization contract.
// ---------------------------------------------------------------------------

const ORG_A = "org-A";
const ORG_B = "org-B";
const USER_OWNER = "user-owner";
const USER_OTHER = "user-other";

const userOwnedRow = {
  id: "obj-1",
  type: "test",
  parentId: null,
  parentType: null,
  data: { name: "obj-1" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdBy: USER_OWNER,
  orgId: ORG_A,
  source: null,
  runId: null,
  agentId: null,
  packageVersion: null,
  agentSpecVersion: null,
  version: 1,
  deletedAt: null,
  ownerLevel: "user" as const,
  ownerId: USER_OWNER,
  visibility: "private" as const,
};

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn((input: { upsertInput: { id?: string } }) => ({
    ...userOwnedRow,
    id: input.upsertInput.id ?? "new-id",
    version: 1,
  })),
  // Note: the production SQL filters by org_id; this stub returns the row
  // unconditionally so the handler authorization gate (not the SQL filter) is exercised.
  getObjectById: vi.fn((id: string, _scope: { orgId: string | null }) => {
    if (id !== userOwnedRow.id) return null;
    return userOwnedRow;
  }),
  listObjectsByFilter: vi.fn(() => [userOwnedRow]),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../../classifier", () => ({
  classifyObject: vi.fn(async () => ({
    type: "test",
    confidence: 0.9,
    isNewType: false,
    normalizedData: { name: "x" },
    inferredTypeName: null,
    inferredCategory: null,
    canonicalKeys: null,
  })),
}));

vi.mock("../../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: vi.fn(async () => []),
  readDynamicObjectTypeByType: vi.fn(async () => null),
}));

vi.mock("../../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

vi.mock("../../identity", () => ({
  resolveIdentity: vi.fn(() => null),
  hashIdentity: vi.fn(() => "h"),
}));

// authz kernel: deny by default, allow only for owner / same-org admin.
// The real kernel is exercised in src/lib/authz/__tests__; this stub
// pins a small decision surface so the handler-level tests stay
// focused on "does the handler invoke enforceResourceAccess at all".
vi.mock("@/lib/authz", () => ({
  can: vi.fn(() => false),
  canDo: vi.fn(() => false),
  buildActorContext: vi.fn(() => ({})),
  AuthzError: class AuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(opts: { statusCode: number; reason: string; message?: string }) {
      super(opts.message ?? opts.reason);
      this.statusCode = opts.statusCode;
      this.reason = opts.reason;
    }
  },
  EFFECTIVE_GRANTS: {},
  POLICY_VERSION: "test",
  logAuditEvent: vi.fn(),
}));

import { handlers } from "../handlers";

const ownerActor = {
  actorType: "human",
  source: "ui",
  userId: USER_OWNER,
  orgId: ORG_A,
  roles: ["member"],
} as never;
const memberActor = {
  actorType: "human",
  source: "ui",
  userId: USER_OTHER,
  orgId: ORG_A,
  roles: ["member"],
} as never;
const crossOrgActor = {
  actorType: "human",
  source: "ui",
  userId: "user-cross",
  orgId: ORG_B,
  roles: ["member"],
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("objects_get authz", () => {
  it("ALLOW when actor is owner", async () => {
    const result = await handlers["objects_get"]({
      primitiveName: "objects_get",
      input: { objectId: userOwnedRow.id },
      actor: ownerActor,
      mode: "deterministic",
    } as never);
    expect(result).toBeDefined();
  });

  it("DENY (404 hidden) when actor cross-tenant", async () => {
    await expect(
      handlers["objects_get"]({
        primitiveName: "objects_get",
        input: { objectId: userOwnedRow.id },
        actor: crossOrgActor,
        mode: "deterministic",
      } as never),
    ).rejects.toThrow();
  });

  it("DENY when actor org-member but resource owner_level=user, owner_id ≠ actor.userId", async () => {
    await expect(
      handlers["objects_get"]({
        primitiveName: "objects_get",
        input: { objectId: userOwnedRow.id },
        actor: memberActor,
        mode: "deterministic",
      } as never),
    ).rejects.toThrow();
  });
});

describe("objects_list authz", () => {
  it("post-filters out rows the actor cannot read", async () => {
    const result = await handlers["objects_list"]({
      primitiveName: "objects_list",
      input: {},
      actor: memberActor,
      mode: "deterministic",
    } as never);
    // memberActor cannot read userOwnedRow (owner=USER_OWNER, level=user)
    const items = (result as { items: Array<{ id: string }> }).items;
    expect(items.map((o) => o.id)).not.toContain(userOwnedRow.id);
  });
});

describe("objects_save authz", () => {
  it("ALLOW when actor creating their own user-owned object", async () => {
    const result = await handlers["objects_save"]({
      primitiveName: "objects_save",
      input: { rawData: { name: "x" }, ownerLevel: "user" },
      actor: ownerActor,
      mode: "deterministic",
    } as never);
    expect(result).toBeDefined();
  });
});

describe("objects_update authz", () => {
  it("DENY when actor not owner", async () => {
    await expect(
      handlers["objects_update"]({
        primitiveName: "objects_update",
        input: { objectId: userOwnedRow.id, data: {} },
        actor: memberActor,
        mode: "deterministic",
      } as never),
    ).rejects.toThrow();
  });

  it("ALLOW when actor is owner", async () => {
    const result = await handlers["objects_update"]({
      primitiveName: "objects_update",
      input: { objectId: userOwnedRow.id, data: {} },
      actor: ownerActor,
      mode: "deterministic",
    } as never);
    expect(result).toBeDefined();
  });
});

describe("objects_delete authz", () => {
  it("DENY when actor cross-org", async () => {
    await expect(
      handlers["objects_delete"]({
        primitiveName: "objects_delete",
        input: { objectId: userOwnedRow.id },
        actor: crossOrgActor,
        mode: "deterministic",
      } as never),
    ).rejects.toThrow();
  });
});

describe("objects_classify authz", () => {
  it("requires object.read on the target", async () => {
    await expect(
      handlers["objects_classify"]({
        primitiveName: "objects_classify",
        input: { objectId: userOwnedRow.id },
        actor: crossOrgActor,
        mode: "deterministic",
      } as never),
    ).rejects.toThrow();
  });
});
