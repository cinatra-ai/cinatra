// Server-side ingest gates for the memory sync path (cinatra#1378, epic #1373).
//
// The client scans, caps and provenance-stamps before it uploads — and none of
// that decides anything. A memory bundle is untrusted input end-to-end, so the
// tests here drive the SERVER and assert the server's own answer:
//
//   - AC3: a seeded credential-shaped literal is REJECTED and never stored, on
//     both write paths; a scan that cannot COMPLETE is also a rejection
//     (fail-closed — "could not look" is never reported as "found nothing").
//   - AC4: provenance lands on the row (actor-derived columns + the bundle /
//     concept identity in the envelope), and an `externalId` mismatch is
//     rejected.
//   - Ingest size caps: frontmatter, links and conceptId are bounded, because
//     an uncapped surface makes the 64 KiB body cap decorative.
//   - Untrusted end-to-end: a forged envelope field cannot widen a row's
//     scope, move it, or steer its identity.
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
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue, getObjectById } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  MEMORY_CONCEPT_FRONTMATTER_MAX_BYTES,
  MEMORY_CONCEPT_ID_MAX_BYTES,
  MEMORY_CONCEPT_LINK_TARGET_MAX_BYTES,
  MEMORY_CONCEPT_MAX_LINKS,
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

beforeEach(() => {
  mockUpsert.mockReset();
  mockGet.mockReset();
  mockUpsert.mockReturnValue(makeMemoryRecord());
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

function save(rawData: unknown, extra: Record<string, unknown> = {}) {
  return createObjectsPrimitiveHandlers().objects_save({
    primitiveName: "objects_save",
    input: { rawData, typeHint: MEMORY_CONCEPT_TYPE_ID, ...extra },
    actor: ACTOR,
    mode: "agentic",
  } as never);
}

function update(objectId: string, data: unknown) {
  return createObjectsPrimitiveHandlers().objects_update({
    primitiveName: "objects_update",
    input: { objectId, data },
    actor: ACTOR,
    mode: "agentic",
  } as never);
}

// ---------------------------------------------------------------------------
// AC3 — fail-closed secret scanning.
// ---------------------------------------------------------------------------

describe("AC3 — the ingest secret scan rejects, and the payload is never stored", () => {
  const SEEDED_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

  it("rejects a seeded credential in the body before any commit", async () => {
    await expect(
      save(makeEnvelope({ bodyMarkdown: `The deploy token is ${SEEDED_TOKEN}` })),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_DETECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a seeded credential hidden in frontmatter", async () => {
    await expect(
      save(
        makeEnvelope({
          frontmatter: { type: "convention", deployToken: SEEDED_TOKEN },
        }),
      ),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_DETECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a seeded credential smuggled through a link target", async () => {
    await expect(
      save(
        makeEnvelope({
          links: [{ target: `https://example.test/?token=${SEEDED_TOKEN}` }],
        }),
      ),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_DETECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("never echoes the matched secret back in the refusal", async () => {
    const error = await save(
      makeEnvelope({ bodyMarkdown: `token ${SEEDED_TOKEN}` }),
    ).then(
      () => null,
      (err: unknown) => err as Error & { details?: Record<string, unknown> },
    );
    expect(error).not.toBeNull();
    const rendered = `${error?.message} ${JSON.stringify(error?.details ?? {})}`;
    expect(rendered).toContain("github-pat");
    expect(rendered).not.toContain(SEEDED_TOKEN);
  });

  it("rejects on the UPDATE path too — the gate is not save-only", async () => {
    mockGet.mockReturnValue(makeMemoryRecord());
    await expect(
      update("obj-mem-1", { bodyMarkdown: `token ${SEEDED_TOKEN}` }),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_DETECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // A frontmatter KEY is author-controlled text exactly like a value, so a
  // walk that only read values would clear a payload it never looked at.
  it("rejects a seeded credential hidden in a frontmatter KEY, not just a value", async () => {
    await expect(
      save(
        makeEnvelope({
          frontmatter: { type: "convention", [SEEDED_TOKEN]: "a note" },
        }),
      ),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_DETECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // The refusal names the location, and the location is built from keys — so
  // a credential-shaped key would otherwise be echoed by the very message that
  // promises to name only the shape.
  it("never echoes a secret that lives in a KEY, in the hit or the scan-failure path", async () => {
    const rendered = async (envelope: Record<string, unknown>) => {
      const error = await save(envelope).then(
        () => null,
        (err: unknown) => err as Error & { details?: Record<string, unknown> },
      );
      expect(error).not.toBeNull();
      return `${error?.message} ${JSON.stringify(error?.details ?? {})}`;
    };

    const hit = await rendered(
      makeEnvelope({ frontmatter: { type: "convention", [SEEDED_TOKEN]: "a note" } }),
    );
    expect(hit).toContain("github-pat");
    expect(hit).not.toContain(SEEDED_TOKEN);
    expect(hit).toContain("[key#");

    // Same key, but the scan aborts on the depth bound before it can report a
    // hit: the FAILURE message carries a location too.
    let nested: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 40; i++) nested = { deeper: nested };
    const failure = await rendered(
      makeEnvelope({ frontmatter: { type: "convention", [SEEDED_TOKEN]: nested } }),
    );
    expect(failure).not.toContain(SEEDED_TOKEN);
  });

  it("SCANNER FAILURE ⇒ REJECT: an unwalkable payload is refused, not cleared", async () => {
    // 40 levels of nesting exceeds the walk's depth bound. The scan has not
    // seen the whole payload, so clearing it would be a false negative — the
    // exact failure mode a fail-closed gate exists to prevent.
    let nested: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 40; i++) nested = { deeper: nested };
    await expect(
      save(makeEnvelope({ frontmatter: { type: "convention", nested } })),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_SECRET_SCAN_FAILED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("stores an ordinary concept, and the documentation shapes authors write", async () => {
    await save(
      makeEnvelope({
        bodyMarkdown: "Set `export OPENAI_API_KEY=${OPENAI_API_KEY}` and pass <API_TOKEN>.",
      }),
    );
    // A gate that flagged the how-to-set-a-key concept would be routed around
    // rather than fixed, so tolerating placeholders is part of the contract.
    expect(mockUpsert).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AC4 — provenance + externalId recomputation.
// ---------------------------------------------------------------------------

describe("AC4 — provenance is recorded, and identity is the server's own", () => {
  it("stamps actor-derived provenance onto the row's columns", async () => {
    await save(makeEnvelope());
    const upsertInput = mockUpsert.mock.calls[0][0].upsertInput;
    // Tool identity and run id come from the AUTHENTICATED actor, not from the
    // bundle: no objects primitive accepts them as input.
    expect(upsertInput).toMatchObject({
      orgId: "org-1",
      createdBy: "user-1",
      source: "agent",
      runId: "run-42",
      agentId: "coding-agent",
      packageVersion: "0.1.0",
    });
  });

  it("keeps the bundle id and concept path on the stored envelope", async () => {
    await save(makeEnvelope());
    const stored = mockUpsert.mock.calls[0][0].upsertInput.data as Record<string, unknown>;
    expect(stored.bundleId).toBe(BUNDLE_ID);
    expect(stored.conceptId).toBe(CONCEPT_ID);
    expect(stored.provenance).toEqual({
      tool: "@cinatra-ai/memory:sync",
      toolVersion: "0.1.0",
    });
    // The run id the ROW carries is the server's, not the bundle's.
    expect(stored.cinatraAgentRunId).toBe("run-42");
  });

  it("rejects a forged externalId — the server recomputes it from bundleId + conceptId", async () => {
    await expect(
      save(makeEnvelope({ externalId: "f".repeat(64) })),
    ).rejects.toThrow(/invalid memory concept envelope.*externalId/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a provenance block that is not the declared shape", async () => {
    await expect(
      save(makeEnvelope({ provenance: { tool: "x", toolVersion: "1", orgId: "org-victim" } })),
    ).rejects.toThrow(/invalid memory concept envelope/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ingest size caps.
// ---------------------------------------------------------------------------

describe("ingest size caps — every author-controlled surface is bounded", () => {
  it("rejects frontmatter over the 32 KiB serialized cap", async () => {
    await expect(
      save(
        makeEnvelope({
          frontmatter: {
            type: "convention",
            note: "y".repeat(MEMORY_CONCEPT_FRONTMATTER_MAX_BYTES),
          },
        }),
      ),
    ).rejects.toThrow(/invalid memory concept envelope.*frontmatter/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects more links than the cap allows", async () => {
    await expect(
      save(
        makeEnvelope({
          links: Array.from({ length: MEMORY_CONCEPT_MAX_LINKS + 1 }, (_v, i) => ({
            target: `./c${i}.md`,
          })),
        }),
      ),
    ).rejects.toThrow(/invalid memory concept envelope.*links/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an oversize link target", async () => {
    await expect(
      save(
        makeEnvelope({
          links: [{ target: `./${"a".repeat(MEMORY_CONCEPT_LINK_TARGET_MAX_BYTES)}.md` }],
        }),
      ),
    ).rejects.toThrow(/invalid memory concept envelope.*links/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an oversize conceptId", async () => {
    const longId = "a".repeat(MEMORY_CONCEPT_ID_MAX_BYTES + 1);
    await expect(
      save(
        makeEnvelope({
          conceptId: longId,
          externalId: computeMemoryConceptExternalId(BUNDLE_ID, longId),
        }),
      ),
    ).rejects.toThrow(/invalid memory concept envelope.*conceptId/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Untrusted end-to-end — a forged field decides nothing.
// ---------------------------------------------------------------------------

describe("a forged bundle field cannot widen, move, or re-identify a row", () => {
  it("refuses a resync that asks to change an existing row's scope", async () => {
    // The bundle "asks" for organization visibility on a row that is private.
    // objects_save never changes an existing row's tuple, and it refuses rather
    // than accepting-and-silently-dropping — a caller that believes it widened
    // a row is the false accept this surface must not produce.
    mockGet.mockReturnValue(makeMemoryRecord({ version: 3 }));
    await expect(
      save(makeEnvelope(), { visibility: "organization", ownerLevel: "organization" }),
    ).rejects.toMatchObject({ code: "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("preserves a wider existing row when the resync omits scope", async () => {
    // This is what the sync client actually sends on an update: no ownership,
    // no visibility. The row keeps the scope promotion widened it to.
    mockGet.mockReturnValue(
      makeMemoryRecord({ version: 3, visibility: "organization", ownerLevel: "organization" }),
    );
    mockUpsert.mockReturnValue(makeMemoryRecord({ version: 4, visibility: "organization" }));
    await save(makeEnvelope({ bodyMarkdown: "Revised." }));
    const upsertInput = mockUpsert.mock.calls[0][0].upsertInput;
    expect(upsertInput.visibility).toBe("organization");
    expect(upsertInput.ownerLevel).toBe("organization");
  });

  it("refuses a project binding this caller holds no grant on, leaking nothing", async () => {
    // The rightless direction. This actor carries no `projectGrants` axis at
    // all, which both project gates read as NO grants — so the binding is
    // refused with the 404-hidden envelope every other project-scoped surface
    // produces. The refusal says "not found", NOT "exists but you may not
    // write it": the gate must not be an existence oracle for projects.
    //
    // The rightful direction (a caller WITH a write grant binds successfully,
    // and a collision onto a row in another project is routed to the audited
    // move path with OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED) is exercised
    // against the real gates in
    // `packages/objects/src/mcp/__tests__/handlers-project-binding.test.ts`
    // (cinatra#1377), which injects the project row reader; duplicating it
    // here would test that file's harness rather than this path.
    mockGet.mockReturnValue(makeMemoryRecord({ version: 2, projectId: "proj-other" }));
    const error = await save(makeEnvelope(), { projectId: "proj-mine" }).then(
      () => null,
      (err: unknown) => err as Error & { statusCode?: number },
    );
    expect(error?.statusCode).toBe(404);
    expect(error?.message).not.toContain("proj-other");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("ignores a frontmatter orgId entirely — the org is never caller-supplied", async () => {
    await save(
      makeEnvelope({
        frontmatter: { type: "convention", orgId: "org-victim", visibility: "public" },
      }),
    );
    const upsertInput = mockUpsert.mock.calls[0][0].upsertInput;
    // The forged keys survive as frontmatter content (tolerant OKF
    // consumption) and decide nothing: the row's org is the actor's.
    expect(upsertInput.orgId).toBe("org-1");
    expect(upsertInput.visibility).toBe("private");
  });
});
