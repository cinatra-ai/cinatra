// cinatra#1381 AC5 — a PROMOTED memory row's scope survives subsequent syncs.
//
// Promotion (#1381) widens a row's ownership/visibility tuple through review.
// Sync (#1378) writes the same rows from a local bundle and defaults every
// write to `user/private`. If the second could undo the first, promotion would
// last exactly until the next `memory sync`.
//
// THE GUARD BEING REGRESSION-TESTED lives in the ingest handler
// (packages/objects/src/mcp/handlers.ts, the collision branch of
// `objects_save`): on a resolved collision the tuple actually written is
// `ownershipForWrite = existingRow`'s — the writer's ON CONFLICT arm does not
// list owner_level / owner_id / visibility — and a resync that ASKS for a
// different tuple is refused with `OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED`
// rather than accepted and silently dropped.
//
// This suite drives that guard with the exact tuples a #1381 approve writes, in
// the three shapes a resync can take, and pins that the promoted row's identity
// is untouched too — so the interaction is proven end to end, not assumed.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => {
    throw new Error("classifier LLM must not be called for an exact static typeHint");
  }),
  runResolvedDeterministicLlmTask: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue, getObjectById } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  computeMemoryConceptExternalId,
} from "../integration/register-types";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockGet = getObjectById as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({
    orgId: "org-1",
    userId: "user-1",
    agentId: "coding-agent",
    runId: "run-42",
    packageVersion: "0.1.0",
  } as unknown as Record<string, unknown>),
} as never;

const BUNDLE_ID = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
const CONCEPT_ID = "convention/never-commit-a-key";

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    conceptId: CONCEPT_ID,
    bundleId: BUNDLE_ID,
    externalId: computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID),
    okfType: "convention",
    frontmatter: { type: "convention", title: "Never commit a key" },
    bodyMarkdown: "Keys live in the environment.",
    links: [],
    okfVersion: "0.1",
    provenance: { tool: "@cinatra-ai/memory:sync", toolVersion: "0.1.0" },
    ...overrides,
  };
}

function makeMemoryRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "obj-mem-1",
    type: MEMORY_CONCEPT_TYPE_ID,
    parentId: null,
    parentType: null,
    data: makeEnvelope(),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: "user-1",
    orgId: "org-1",
    source: "agent",
    runId: "run-42",
    agentId: "coding-agent",
    packageVersion: "0.1.0",
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ownerLevel: "user",
    ownerId: "user-1",
    visibility: "private",
    projectId: null,
    changeSetId: "cs-1",
    ...overrides,
  };
}

/** The row as it stands AFTER a #1381 approve widened it to the org. */
function orgPromotedRow(overrides: Record<string, unknown> = {}) {
  return makeMemoryRecord({
    version: 4,
    ownerLevel: "organization",
    ownerId: "org-1",
    visibility: "organization",
    ...overrides,
  });
}

/** The row as it stands AFTER a #1381 approve widened it to a team. */
function teamPromotedRow(overrides: Record<string, unknown> = {}) {
  return makeMemoryRecord({
    version: 4,
    ownerLevel: "team",
    ownerId: "team-9",
    visibility: "team",
    ...overrides,
  });
}

function save(rawData: unknown, extra: Record<string, unknown> = {}) {
  return createObjectsPrimitiveHandlers().objects_save({
    primitiveName: "objects_save",
    input: { rawData, typeHint: MEMORY_CONCEPT_TYPE_ID, ...extra },
    actor: ACTOR,
    mode: "agentic",
  } as never);
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockGet.mockReset();
  mockUpsert.mockReturnValue(makeMemoryRecord());
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

describe("a resync never narrows a promoted row", () => {
  it("keeps an ORGANIZATION-promoted tuple when the resync omits scope (what the sync client actually sends)", async () => {
    mockGet.mockReturnValue(orgPromotedRow());
    mockUpsert.mockReturnValue(orgPromotedRow({ version: 5 }));

    await save(makeEnvelope({ bodyMarkdown: "Revised after review." }));

    const { upsertInput } = mockUpsert.mock.calls[0][0];
    expect(upsertInput.ownerLevel).toBe("organization");
    expect(upsertInput.ownerId).toBe("org-1");
    expect(upsertInput.visibility).toBe("organization");
    // The default this write would otherwise have taken.
    expect(upsertInput.visibility).not.toBe("private");
  });

  it("keeps a TEAM-promoted tuple, including the owning team id", async () => {
    mockGet.mockReturnValue(teamPromotedRow());
    mockUpsert.mockReturnValue(teamPromotedRow({ version: 5 }));

    await save(makeEnvelope({ bodyMarkdown: "Revised again." }));

    const { upsertInput } = mockUpsert.mock.calls[0][0];
    expect(upsertInput.ownerLevel).toBe("team");
    expect(upsertInput.ownerId).toBe("team-9");
    expect(upsertInput.visibility).toBe("team");
  });

  it("keeps the promoted tuple when the resync re-states the SAME values (a no-op passes through)", async () => {
    mockGet.mockReturnValue(orgPromotedRow());
    mockUpsert.mockReturnValue(orgPromotedRow({ version: 5 }));

    await save(makeEnvelope({ bodyMarkdown: "Same scope, new body." }), {
      ownerLevel: "organization",
      visibility: "organization",
    });

    const { upsertInput } = mockUpsert.mock.calls[0][0];
    expect(upsertInput.visibility).toBe("organization");
  });

  it("REFUSES a resync that asks to narrow a promoted row back to private", async () => {
    mockGet.mockReturnValue(orgPromotedRow());
    await expect(
      save(makeEnvelope(), { visibility: "private" }),
    ).rejects.toMatchObject({ code: "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a narrowing that ALSO names an owner is refused even earlier, by the #1378 ownership gate", async () => {
    // TWO guards stand between a bundle and a promoted row's tuple, and this is
    // the outer one: `authorizeMemoryOwnershipRequest` refuses an explicit
    // `ownerId` outright, before the collision branch is ever reached, because
    // a bundle file may not name the principal that owns a row.
    mockGet.mockReturnValue(orgPromotedRow());
    await expect(
      save(makeEnvelope(), { ownerLevel: "user", ownerId: "user-1", visibility: "private" }),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("REFUSES a resync that asks to re-own a team-promoted row to a DIFFERENT team", async () => {
    // The same outer guard: no TEAM ownership is derivable from a bundle at
    // this seam, so the request cannot even be evaluated — which is exactly why
    // a team-owned row can only be reached through promotion.
    mockGet.mockReturnValue(teamPromotedRow());
    await expect(
      save(makeEnvelope(), { ownerLevel: "team", ownerId: "team-other", visibility: "team" }),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a resync cannot use the SYNC path to widen either — promotion is the only widen", async () => {
    // The inverse direction, for completeness: a bundle asking for organization
    // on a still-private row is refused by the same guard, which is why
    // widening has to go through review at all.
    mockGet.mockReturnValue(makeMemoryRecord({ version: 3 }));
    await expect(
      save(makeEnvelope(), { ownerLevel: "organization", visibility: "organization" }),
    ).rejects.toMatchObject({ code: "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("leaves the promoted row's IDENTITY untouched across the resync", async () => {
    mockGet.mockReturnValue(orgPromotedRow());
    mockUpsert.mockReturnValue(orgPromotedRow({ version: 5 }));

    await save(makeEnvelope({ bodyMarkdown: "Third revision." }));

    const first = mockUpsert.mock.calls[0][0].upsertInput;
    expect(first.data.bundleId).toBe(BUNDLE_ID);
    expect(first.data.conceptId).toBe(CONCEPT_ID);
    expect(first.data.externalId).toBe(computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID));

    // The row id is DERIVED from the identity triple, so a second resync of the
    // same concept resolves to the same row rather than forking a new private
    // one beside the promoted one.
    mockUpsert.mockClear();
    await save(makeEnvelope({ bodyMarkdown: "Fourth revision." }));
    const second = mockUpsert.mock.calls[0][0].upsertInput;
    expect(second.id).toBe(first.id);
    expect(second.visibility).toBe("organization");
  });
});
