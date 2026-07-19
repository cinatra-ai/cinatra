// Artifact-scope recall entitlement wiring (cinatra#1436 AC3; epic #1785
// type-driven cutover).
//
// objects_list with a query against an ARTIFACT-scoped type — the generic
// artifact type OR a DISPOSITION-GOVERNED type whose type-driven disposition is
// artifact-safe / faceted — must pass the actor's SERVER-DERIVED entitled lane
// set to Graphiti searchNodes (own user lane + a lane per real team membership +
// the ambient org lane), exactly like the memory branch. A governed 'raw'
// opt-in, a governed 'none' type, and an ungoverned data type keep the single
// ambient org lane and do NOT resolve teams. The entitled-vs-unentitled lane
// math is unit-tested in graphiti-projection-policy-memory-lanes.test.ts; this
// proves the handler wiring (type detection via the shared type-driven registry
// resolver → readTeamsForUser → lane derivation → searchNodes). The lane is
// relevance scoping only; Postgres ownership + object.read still gate every
// candidate (unchanged path).

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

import { z } from "zod";

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { searchNodes } from "../graphiti-client";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";
import { GENERIC_ARTIFACT_OBJECT_TYPE } from "../effective-identity";
import { objectTypeRegistry } from "../registry";
import type { TypeProjectionDisposition } from "../types";

const ORG = "org-1";
const BASE = deriveProjectionGroupId(ORG);
const CLAIMED_TYPE = "@acme/email:message";

const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockTeams = readTeamsForUser as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  userId: "user-1",
  ...({ orgId: ORG, agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

// Register CLAIMED_TYPE as a disposition-GOVERNED type with the given projection
// (the type-driven authority the retirement replaced the DB claim with). An
// omitted projection registers the type UNGOVERNED (no dispositions).
function registerType(projection?: TypeProjectionDisposition, type = CLAIMED_TYPE) {
  objectTypeRegistry.register({
    type,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    ...(projection ? { dispositions: { projection } } : {}),
  });
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
  objectTypeRegistry._clearForTests();
  mockSearch.mockReset();
  mockSearch.mockResolvedValue({ nodes: [] });
  mockTeams.mockReset();
  mockTeams.mockResolvedValue([]);
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
  });

  it("a GOVERNED artifact-safe type passes the entitled lane set (type-driven resolver)", async () => {
    registerType("artifact-safe");
    mockTeams.mockResolvedValue([{ id: "team-a", name: "A" }]);
    await listWith(CLAIMED_TYPE);

    expect(mockTeams).toHaveBeenCalledWith("user-1", ORG);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(BASE);
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-a`);
  });

  it("a governed artifact-safe type (the bridge's default when a manifest omits dispositions) is also entitled-lane-scoped", async () => {
    // A manifest that omits dispositions registers a GOVERNED type at the
    // artifact-safe default (the bridge writes an explicit payload) — entitled.
    registerType("artifact-safe");
    mockTeams.mockResolvedValue([{ id: "team-b", name: "B" }]);
    await listWith(CLAIMED_TYPE);
    const groupIds = mockSearch.mock.calls[0][0].group_ids as string[];
    expect(groupIds).toContain(`${BASE}-user-user-1`);
    expect(groupIds).toContain(`${BASE}-team-team-b`);
  });

  it("a governed 'raw' type keeps the SINGLE ambient org lane and does NOT resolve teams", async () => {
    registerType("raw");
    await listWith(CLAIMED_TYPE);
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("a governed 'none' type keeps the single ambient org lane (never entitled-scoped)", async () => {
    registerType("none");
    await listWith(CLAIMED_TYPE);
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("an UNGOVERNED data type (no declared disposition) keeps the single ambient org lane and does NOT resolve teams", async () => {
    registerType(undefined, "@acme/crm:account"); // registered, but ungoverned
    await listWith("@acme/crm:account");
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });

  it("an UNINSTALLED definer (unregistered type → resolver 'none') keeps the single ambient org lane", async () => {
    // No registration at all — the type-driven resolver fails closed to 'none',
    // so the type is never artifact-scoped.
    await listWith("@uninstalled/pkg:thing");
    expect(mockTeams).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0][0].group_ids).toEqual([BASE]);
  });
});
