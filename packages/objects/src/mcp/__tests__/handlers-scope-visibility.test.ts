/**
 * Write-time scope-derived visibility at the objects_save seam (#1885 C1 / D10).
 *
 * Pins that an `agent_run`-delegated save (an actor carrying an OBO ceiling
 * chain — the sole delegation === "agent_run" marker) derives the written row's
 * ownership tuple from the run's anchor, while chat/session/human callers (no
 * chain) keep the human-user defaults. The create probe carries the resolved
 * ownership + the frame projectId.
 *
 * Strategy: capture the store upsert input + the enforce probe resource; allow
 * every probe (the derivation, not the kernel decision, is under test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const upsertCalls: Array<{ ownerLevel: string; ownerId: string; visibility: string }> = [];
const probeCalls: Array<{
  ownerLevel: string;
  ownerId: string;
  visibility: string;
  projectId: string | null | undefined;
}> = [];

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn((input: { upsertInput: Record<string, unknown> }) => {
    upsertCalls.push({
      ownerLevel: input.upsertInput.ownerLevel as string,
      ownerId: input.upsertInput.ownerId as string,
      visibility: input.upsertInput.visibility as string,
    });
    return { ...input.upsertInput, id: "new-id", version: 1, changeSetId: "cs-1" };
  }),
  getObjectById: vi.fn(() => null),
  listObjectsByFilter: vi.fn(() => []),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

// The AsyncLocalStorage frame drives the probe projectId + store project_id.
const frameStore: { projectContext?: { projectId: string | null } } = {};
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frameStore },
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

vi.mock("../../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

vi.mock("../../identity", () => ({
  resolveIdentity: vi.fn(() => null),
  hashIdentity: vi.fn(() => "h"),
}));

// Lazy-imported app-layer gates (no-op in this handler-focused test).
vi.mock("@/lib/objects/claim-activation-gate", () => ({
  assertActivatedTypePayloadValid: () => {},
  typeHasActiveDedicatedClaim: async () => false,
}));
vi.mock("@/lib/objects/draftable-lock-gate", () => ({
  assertDraftableWriteAllowed: async () => {},
}));

// Capture the create probe resource; always allow (derivation under test).
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn(async (resource: Record<string, unknown>) => {
    probeCalls.push({
      ownerLevel: resource.ownerLevel as string,
      ownerId: resource.ownerId as string,
      visibility: resource.visibility as string,
      projectId: resource.projectId as string | null | undefined,
    });
  }),
  kernelActorForRead: vi.fn(() => ({})),
}));

import { handlers } from "../handlers";
import { objectTypeRegistry } from "../../registry";

objectTypeRegistry.register(
  { type: "test", category: "record", description: "Test" } as never,
  "@cinatra-ai/test",
);

const ORG = "org-A";

async function save(actor: Record<string, unknown>) {
  return handlers["objects_save"]({
    primitiveName: "objects_save",
    input: { rawData: { name: "x" } },
    actor: actor as never,
    mode: "agentic",
  } as never);
}

beforeEach(() => {
  upsertCalls.length = 0;
  probeCalls.length = 0;
  delete frameStore.projectContext;
});

describe("objects_save — agent_run scope-derived ownership (#1885 C1)", () => {
  it("team-anchored agent run → row lands team-owned / team-visible (today it was org-wide)", async () => {
    await save({
      actorType: "model",
      source: "agent",
      orgId: ORG,
      oboCeiling: [
        { tier: "team", id: "team-9" },
        { tier: "organization", id: ORG },
      ],
    });
    expect(upsertCalls[0]).toEqual({
      ownerLevel: "team",
      ownerId: "team-9",
      visibility: "team",
    });
    // The create probe carried the SAME resolved ownership.
    expect(probeCalls[0]).toMatchObject({
      ownerLevel: "team",
      ownerId: "team-9",
      visibility: "team",
    });
  });

  it("user-anchored agent run → user-owned / private", async () => {
    await save({
      actorType: "model",
      source: "agent",
      orgId: ORG,
      oboCeiling: [
        { tier: "user", id: "u-7" },
        { tier: "organization", id: ORG },
      ],
    });
    expect(upsertCalls[0]).toEqual({
      ownerLevel: "user",
      ownerId: "u-7",
      visibility: "private",
    });
  });

  it("project-anchored agent run → organization-owned, PRIVATE, and the probe carries the frame projectId", async () => {
    frameStore.projectContext = { projectId: "proj-42" };
    await save({
      actorType: "model",
      source: "agent",
      orgId: ORG,
      oboCeiling: [
        { tier: "project", id: "proj-42" },
        { tier: "organization", id: ORG },
      ],
    });
    expect(upsertCalls[0]).toEqual({
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "private",
    });
    expect(probeCalls[0]?.projectId).toBe("proj-42");
  });

  it("CHAT delegation (no OBO chain) keeps human-user defaults — user/private, NOT anchor-derived", async () => {
    await save({
      actorType: "human",
      source: "agent",
      userId: "human-1",
      orgId: ORG,
    });
    expect(upsertCalls[0]).toEqual({
      ownerLevel: "user",
      ownerId: "human-1",
      visibility: "private",
    });
  });

  it("explicit tool-input override still wins over the scope default (within the ceiling)", async () => {
    await handlers["objects_save"]({
      primitiveName: "objects_save",
      input: { rawData: { name: "x" }, ownerLevel: "user", ownerId: "u-7", visibility: "private" },
      actor: {
        actorType: "model",
        source: "agent",
        orgId: ORG,
        oboCeiling: [
          { tier: "team", id: "team-9" },
          { tier: "organization", id: ORG },
        ],
      } as never,
      mode: "agentic",
    } as never);
    expect(upsertCalls[0]).toEqual({
      ownerLevel: "user",
      ownerId: "u-7",
      visibility: "private",
    });
  });
});
