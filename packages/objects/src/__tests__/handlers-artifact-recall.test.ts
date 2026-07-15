// Artifact-scope recall entitlement wiring (cinatra#1436 AC3).
//
// objects_list with a query against an ARTIFACT-scoped type — the generic
// artifact type OR a claimed type whose winning disposition is artifact-safe /
// faceted — must pass the actor's SERVER-DERIVED entitled lane set to Graphiti
// searchNodes (own user lane + a lane per real team membership + the ambient
// org lane), exactly like the memory branch. A claimed 'raw' opt-in and an
// unclaimed type keep the single ambient org lane and do NOT resolve teams. The
// entitled-vs-unentitled lane math is unit-tested in
// graphiti-projection-policy-memory-lanes.test.ts; this proves the handler
// wiring (type detection via the shared claim resolver → readTeamsForUser →
// lane derivation → searchNodes). The lane is relevance scoping only; Postgres
// ownership + object.read still gate every candidate (unchanged path).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(() => []),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../classifier", () => ({ classifyObject: vi.fn() }));

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: vi.fn(async () => []),
  readDynamicObjectTypeByType: vi.fn(async () => null),
}));

vi.mock("../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => [] as Array<{ id: string; name: string }>),
}));

// The claim store drives artifact-scoped detection for CLAIMED types. Default:
// no claims; each test overrides for its type.
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: vi.fn(() => []),
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { searchNodes } from "../graphiti-client";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";
import { GENERIC_ARTIFACT_OBJECT_TYPE } from "../effective-identity";

const ORG = "org-1";
const BASE = deriveProjectionGroupId(ORG);
const CLAIMED_TYPE = "@acme/email:message";

const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockTeams = readTeamsForUser as unknown as ReturnType<typeof vi.fn>;
const mockClaims = readArtifactTypeClaimsForOrg as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  userId: "user-1",
  ...({ orgId: ORG, agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

function claim(dispositions: unknown, objectTypeId = CLAIMED_TYPE) {
  return {
    id: "claim-1",
    scope: "platform",
    objectTypeId,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: "@acme/email-artifact",
    extensionVersion: "1.0.0",
    generation: 1,
    dispositions,
    installId: null,
    createdAt: null,
    updatedAt: null,
  };
}

async function listWith(type: string) {
  const handlers = createObjectsPrimitiveHandlers();
  await handlers.objects_list({
    primitiveName: "objects_list",
    input: { query: "how do we export", type },
    actor: ACTOR,
    mode: "deterministic",
  } as never);
}

beforeEach(() => {
  mockSearch.mockReset();
  mockSearch.mockResolvedValue({ nodes: [] });
  mockTeams.mockReset();
  mockTeams.mockResolvedValue([]);
  mockClaims.mockReset();
  mockClaims.mockReturnValue([]);
});

describe("objects_list — artifact recall entitlement (#1436 AC3)", () => {
  it("the GENERIC artifact type passes the entitled lane set (user + teams + org) to searchNodes", async () => {
    mockTeams.mockResolvedValue([{ id: "team-a", name: "A" }]);
    await listWith(GENERIC_ARTIFACT_OBJECT_TYPE);

    expect(mockTeams).toHaveBeenCalledWith("user-1", ORG);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(BASE);
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-a`);
    // NOT entitled: an arbitrary team lane, any project lane.
    expect(groupIds).not.toContain(`${BASE}-team-team-z`);
    expect(groupIds.some((l) => l.includes("-proj-"))).toBe(false);
    // The generic artifact type never consults the claim registry.
    expect(mockClaims).not.toHaveBeenCalled();
  });

  it("a CLAIMED artifact-safe type passes the entitled lane set (claim registry consulted)", async () => {
    mockClaims.mockReturnValue([claim({ projection: "artifact-safe" })]);
    mockTeams.mockResolvedValue([{ id: "team-a", name: "A" }]);
    await listWith(CLAIMED_TYPE);

    expect(mockClaims).toHaveBeenCalledWith(ORG);
    expect(mockTeams).toHaveBeenCalledWith("user-1", ORG);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(BASE);
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-a`);
  });

  it("a claimed type with NULL dispositions (⇒ artifact-safe default) is also entitled-lane-scoped", async () => {
    mockClaims.mockReturnValue([claim(null)]);
    mockTeams.mockResolvedValue([{ id: "team-b", name: "B" }]);
    await listWith(CLAIMED_TYPE);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-b`);
  });

  it("a claimed 'raw' type keeps the SINGLE ambient org lane and does NOT resolve teams", async () => {
    mockClaims.mockReturnValue([claim({ projection: "raw" })]);
    await listWith(CLAIMED_TYPE);
    expect(mockClaims).toHaveBeenCalledWith(ORG);
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("a claimed 'none' type keeps the single ambient org lane (never entitled-scoped)", async () => {
    mockClaims.mockReturnValue([claim({ projection: "none" })]);
    await listWith(CLAIMED_TYPE);
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("an UNCLAIMED non-artifact type keeps the single ambient org lane and does NOT resolve teams", async () => {
    mockClaims.mockReturnValue([]); // no winning claim for this type
    await listWith("@cinatra-ai/objects:object");
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });
});
