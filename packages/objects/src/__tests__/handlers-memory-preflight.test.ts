// The memory-sync remote preflight: `objects_list` batched by `externalId`
// (cinatra#1378).
//
// The preflight is what lets a resync write NOTHING for untouched concepts. It
// is a filter on the EXISTING primitive rather than a new one, so the
// authorization it gets is exactly `objects_list`'s — and both directions of
// that authorization are asserted here:
//
//   - the rightful caller sees its own rows;
//   - a caller who may not read a row sees the SAME answer it would get for a
//     row that does not exist, so the preflight is not an existence oracle.
//
// The refusals (no `type`, combined with a semantic `query`, an empty batch,
// an over-cap batch) are refusals rather than silent corrections: a preflight
// that quietly answered a different question is what a duplicate write is made
// of.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

// The read path never classifies, but the handler module pulls the classifier
// (and through it the LLM registry) at import time. The double keeps this suite
// off the app's generated extension manifest, and fails loudly if a read ever
// does reach an LLM.
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => {
    throw new Error("objects_list must not resolve an LLM runtime");
  }),
  runResolvedDeterministicLlmTask: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

// The kernel, denying by default. `enforceResourceAccess` short-circuits for a
// user-owned row's OWN owner before it ever consults the kernel, so this single
// stub gives both directions honestly: the owner reads its row, and any other
// caller falls through to a denial. (The package-wide alias stub is
// allow-by-default, which would make the drop assertion vacuous.)
vi.mock("@/lib/authz", () => ({
  can: vi.fn(() => false),
  canDo: vi.fn(() => false),
  buildActorContext: vi.fn(() => ({})),
  AuthzError: class AuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(opts: { statusCode: number; reason: string; message?: string }) {
      super(opts.message ?? opts.reason);
      this.name = "AuthzError";
      this.statusCode = opts.statusCode;
      this.reason = opts.reason;
    }
  },
  EFFECTIVE_GRANTS: {},
  POLICY_VERSION: "test",
  logAuditEvent: vi.fn(),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { listObjectsByFilter } from "@/lib/objects-store";
import { objectsListSchema } from "../mcp/schemas";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  computeMemoryConceptExternalId,
} from "../integration/register-types";

const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;

const BUNDLE_ID = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
const MINE = computeMemoryConceptExternalId(BUNDLE_ID, "convention/mine");
const THEIRS = computeMemoryConceptExternalId(BUNDLE_ID, "convention/theirs");

const OWNER = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", userId: "user-1" } as unknown as Record<string, unknown>),
} as never;

const STRANGER = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", userId: "user-2" } as unknown as Record<string, unknown>),
} as never;

function memoryRow(externalId: string, ownerId: string) {
  return {
    id: `obj-${externalId.slice(0, 8)}`,
    type: MEMORY_CONCEPT_TYPE_ID,
    parentId: null,
    parentType: null,
    data: { externalId, bundleId: BUNDLE_ID, okfType: "convention" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: ownerId,
    orgId: "org-1",
    source: "agent",
    runId: null,
    agentId: null,
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ownerLevel: "user",
    ownerId,
    visibility: "private",
    projectId: null,
  };
}

function list(input: Record<string, unknown>, actor: unknown = OWNER) {
  return createObjectsPrimitiveHandlers().objects_list({
    primitiveName: "objects_list",
    input,
    actor,
    mode: "agentic",
  } as never);
}

beforeEach(() => {
  mockList.mockReset();
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

describe("objects_list — the externalIds batch reaches the SQL filter", () => {
  it("pushes the batch down alongside the type filter", async () => {
    mockList.mockReturnValue([memoryRow(MINE, "user-1")]);
    const result = (await list({
      type: MEMORY_CONCEPT_TYPE_ID,
      externalIds: [MINE, THEIRS],
      limit: 500,
    })) as { items: Array<{ id: string }> };
    expect(mockList).toHaveBeenCalledOnce();
    expect(mockList.mock.calls[0][0]).toMatchObject({
      orgId: "org-1",
      type: MEMORY_CONCEPT_TYPE_ID,
      externalIds: [MINE, THEIRS],
    });
    expect(result.items.map((i) => i.id)).toEqual([`obj-${MINE.slice(0, 8)}`]);
  });

  it("carries an explicit project binding through with the batch", async () => {
    mockList.mockReturnValue([]);
    // A platform-admin-free caller with no grants would be 404-hidden by the
    // read gate before the filter ran; this asserts the plumbing on the path
    // that does reach the store.
    await list({
      type: MEMORY_CONCEPT_TYPE_ID,
      externalIds: [MINE],
    }).catch(() => undefined);
    expect(mockList.mock.calls[0][0].projectId).toBeNull();
  });
});

describe("objects_list — the batch is never an existence oracle", () => {
  it("shows the rightful caller its own row", async () => {
    mockList.mockReturnValue([memoryRow(MINE, "user-1")]);
    const result = (await list({
      type: MEMORY_CONCEPT_TYPE_ID,
      externalIds: [MINE],
    })) as { items: unknown[] };
    expect(result.items).toHaveLength(1);
  });

  it("gives a caller who may not read the row the SAME answer as a missing row", async () => {
    // The store returns the row (an ownership filter miss is not what is under
    // test here — the per-row object.read probe is). The handler drops it, so
    // the stranger's answer is an empty list: byte-identical to the answer for
    // an externalId nobody has ever synced. Nothing distinguishes "exists but
    // is not yours" from "does not exist", which is what keeps a preflight
    // from enumerating other people's memory.
    mockList.mockReturnValue([memoryRow(THEIRS, "user-1")]);
    const denied = (await list(
      { type: MEMORY_CONCEPT_TYPE_ID, externalIds: [THEIRS] },
      STRANGER,
    )) as { items: unknown[] };

    mockList.mockReturnValue([]);
    const absent = (await list(
      { type: MEMORY_CONCEPT_TYPE_ID, externalIds: ["0".repeat(64)] },
      STRANGER,
    )) as { items: unknown[] };

    expect(denied).toEqual(absent);
    expect(denied.items).toEqual([]);
  });
});

describe("objects_list — the batch refuses what it cannot answer honestly", () => {
  it("refuses a batch with no type: an external id is unique only within its type", async () => {
    await expect(list({ externalIds: [MINE] })).rejects.toThrow(
      /externalIds requires an explicit `type`/,
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses a batch combined with a semantic query", async () => {
    await expect(
      list({ type: MEMORY_CONCEPT_TYPE_ID, externalIds: [MINE], query: "pnpm" }),
    ).rejects.toThrow(/cannot be combined with a semantic `query`/);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("objectsListSchema — the batch bounds are part of the contract", () => {
  it("rejects an empty batch rather than reading it as no filter", () => {
    // A filter that silently disappeared would widen the read from "these
    // three concepts" to "every memory row in the org".
    expect(objectsListSchema.safeParse({ type: "t", externalIds: [] }).success).toBe(false);
  });

  it("rejects a batch larger than the limit ceiling", () => {
    const tooMany = Array.from({ length: 501 }, (_v, i) => `id-${i}`);
    expect(objectsListSchema.safeParse({ type: "t", externalIds: tooMany }).success).toBe(
      false,
    );
    const atCap = Array.from({ length: 500 }, (_v, i) => `id-${i}`);
    expect(objectsListSchema.safeParse({ type: "t", externalIds: atCap }).success).toBe(true);
  });

  it("caps the batch at exactly the `limit` maximum", () => {
    // Pinned equal rather than left to agree by coincidence: a batch that
    // could ask for more rows than one call can return would report present
    // rows as absent, and a sync run reads absent as "create".
    //
    // BOTH ceilings are DISCOVERED here (binary search over safeParse) rather
    // than restated as a literal, so raising one in isolation fails this test.
    // The third side of the same pin — that the STORE's own
    // `MAX_EXTERNAL_IDS_BATCH` equals these two — is asserted in
    // `objects-store-postgres-primary.test.ts`, which loads the real store
    // module this suite mocks away.
    const highestAccepted = (accepts: (n: number) => boolean): number => {
      let lo = 1;
      let hi = 4096;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (accepts(mid)) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const batchMax = highestAccepted(
      (n) =>
        objectsListSchema.safeParse({
          type: "t",
          externalIds: Array.from({ length: n }, (_v, i) => `id-${i}`),
        }).success,
    );
    const limitMax = highestAccepted(
      (n) => objectsListSchema.safeParse({ type: "t", limit: n }).success,
    );
    expect(batchMax).toBe(limitMax);
  });
});
