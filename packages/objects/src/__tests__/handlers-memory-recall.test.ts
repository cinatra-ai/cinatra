// Memory recall entitlement wiring (cinatra#1379 AC4).
//
// objects_list with a memory-type query must pass the actor's SERVER-DERIVED
// entitled lane set to Graphiti searchNodes — own user lane + a lane for every
// team the actor belongs to + the org lane — instead of the single ambient org
// lane. A non-memory query is unchanged (single ambient lane; no team lookup).
// The entitled-vs-unentitled math itself is unit-tested in
// graphiti-projection-policy-memory-lanes.test.ts; this proves the handler
// wiring (type detection + readTeamsForUser -> lane derivation -> searchNodes).

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

vi.mock("../classifier", () => ({
  classifyObject: vi.fn(),
}));

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

// The handler resolves the actor's team lanes via readTeamsForUser; mock it so
// no live DB is touched (the vitest alias already routes this to a no-op stub).
vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  readTeamsForUser: vi.fn(async () => [] as Array<{ id: string; name: string }>),
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { searchNodes } from "../graphiti-client";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";

const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";
const ORG = "org-1";
const BASE = deriveProjectionGroupId(ORG);

const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockTeams = readTeamsForUser as unknown as ReturnType<typeof vi.fn>;

// A HUMAN actor (userId present) so the entitlement derives a user lane + team
// lanes; source 'agent' matches the existing handler fixtures.
const ACTOR = {
  actorType: "model",
  source: "agent",
  userId: "user-1",
  ...({ orgId: ORG, agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

beforeEach(() => {
  mockSearch.mockReset();
  mockSearch.mockResolvedValue({ nodes: [] });
  mockTeams.mockReset();
  mockTeams.mockResolvedValue([]);
});

describe("objects_list — memory recall entitlement (AC4)", () => {
  it("passes the entitled lane set (user + teams + org) to searchNodes for a memory-type query", async () => {
    mockTeams.mockResolvedValue([{ id: "team-a", name: "A" }]);
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "how do we export", type: MEMORY_CONCEPT_TYPE_ID },
      actor: ACTOR,
      mode: "deterministic",
    } as never);

    expect(mockTeams).toHaveBeenCalledWith("user-1", ORG);
    expect(mockSearch).toHaveBeenCalledOnce();
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    // Entitled: org (ambient) + own user lane + the actor's team lane.
    expect(groupIds).toContain(BASE);
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-a`);
    // NOT entitled: a team the actor is not in, or any project lane.
    expect(groupIds).not.toContain(`${BASE}-team-team-z`);
    expect(groupIds.some((l) => l.includes("-proj-"))).toBe(false);
  });

  it("a NON-memory query keeps the single ambient org lane and does NOT resolve teams", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "quarterly report", type: "@cinatra-ai/objects:object" },
      actor: ACTOR,
      mode: "deterministic",
    } as never);

    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledOnce();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("a memory query with no team memberships still recalls the user + org lanes", async () => {
    mockTeams.mockResolvedValue([]);
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "x", type: MEMORY_CONCEPT_TYPE_ID },
      actor: ACTOR,
      mode: "deterministic",
    } as never);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(BASE);
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds.some((l) => l.startsWith(`${BASE}-team-`))).toBe(false);
  });
});
