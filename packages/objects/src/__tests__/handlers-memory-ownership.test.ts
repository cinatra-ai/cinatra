// The ownership tuple a memory-typed save may REQUEST (cinatra#1378 review
// item 4), driven against a REAL authorization kernel.
//
// Why this file exists at all. The package-wide vitest alias points
// `@/lib/authz` at an allow-by-default stub (`can: () => true`), and neither
// `handlers-memory-sync-ingest.test.ts` nor `memory-sync-e2e.test.ts` overrides
// it — so no test in the original change could have caught a create that named
// somebody else as owner. The reviewer's finding was that the `object.create`
// probe does not decide what the comments said it decides:
// `enforceResourceAccess` short-circuits only when the resource is user-owned
// by the ACTOR, everything else falls through to `can()`, and `can()` evaluates
// the cross-org guard and role->permission and never reads `ownerType`,
// `ownerId` or `visibility` at all. `object.create` is in the plain member set,
// so a same-org member's create with someone else's `ownerId` passed on the
// strength of the member grant alone.
//
// The kernel double below reproduces those two facts honestly:
//   - `can()` returns TRUE, because a same-org member really does hold
//     `object.create` — a deny-by-default double would make every assertion
//     here pass for the wrong reason;
//   - so the ONLY thing that can refuse a forged tuple is the memory
//     ownership-authority gate, which is what this file pins.
//
// Both directions are asserted: the rightful tuple is written, the forged one
// is refused, and the refusal names the field rather than echoing the value.
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

// The kernel as the source says it behaves for a same-org member holding
// `object.create`: it grants, and it never reads the ownership tuple. Recorded
// so a test can assert the tuple really did reach it unexamined.
const canCalls: unknown[][] = [];
vi.mock("@/lib/authz", () => ({
  can: vi.fn((...args: unknown[]) => {
    canCalls.push(args);
    return true;
  }),
  canDo: vi.fn(() => true),
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

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  computeMemoryConceptExternalId,
} from "../integration/register-types";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;

const BUNDLE_ID = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
const CONCEPT_ID = "convention/never-commit-a-key";

/** An ordinary same-org member. Not an administrator, not a machine. */
const MEMBER = {
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

function envelope() {
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
  };
}

function save(extra: Record<string, unknown> = {}, actor: unknown = MEMBER) {
  return createObjectsPrimitiveHandlers().objects_save({
    primitiveName: "objects_save",
    input: { rawData: envelope(), typeHint: MEMORY_CONCEPT_TYPE_ID, ...extra },
    actor,
    mode: "agentic",
  } as never);
}

beforeEach(() => {
  canCalls.length = 0;
  mockUpsert.mockReset();
  mockUpsert.mockReturnValue({
    id: "obj-mem-1",
    type: MEMORY_CONCEPT_TYPE_ID,
    data: envelope(),
    orgId: "org-1",
    version: 1,
    ownerLevel: "user",
    ownerId: "user-1",
    visibility: "private",
    projectId: null,
  });
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

describe("a memory create under a real kernel — the rightful direction", () => {
  it("writes the actor's own tuple when the bundle asks for nothing", async () => {
    await save();
    expect(mockUpsert).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][0].upsertInput).toMatchObject({
      ownerLevel: "user",
      ownerId: "user-1",
      visibility: "private",
    });
  });

  it("honours a level the actor can satisfy, with the principal actor-derived", async () => {
    await save({ ownerLevel: "organization" });
    expect(mockUpsert.mock.calls[0][0].upsertInput).toMatchObject({
      ownerLevel: "organization",
      ownerId: "org-1",
    });
  });
});

describe("a memory create under a real kernel — the rightless direction", () => {
  it("refuses a create that names ANOTHER user as owner", async () => {
    // This is the reviewer's measured case. The kernel below grants
    // `object.create` — as it really does for a member — so nothing except the
    // memory ownership gate stands between an untrusted bundle file and a row
    // owned by a colleague.
    await expect(
      save({ ownerLevel: "user", ownerId: "user-VICTIM" }),
    ).rejects.toMatchObject({
      code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED",
      details: { field: "ownerId" },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a team the actor's membership cannot be checked for", async () => {
    await expect(
      save({ ownerLevel: "team", ownerId: "team-the-actor-is-not-in" }),
    ).rejects.toMatchObject({ code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a workspace-level create", async () => {
    await expect(save({ ownerLevel: "workspace" })).rejects.toMatchObject({
      code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED",
      details: { field: "ownerLevel" },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a create that asks to publish", async () => {
    await expect(save({ visibility: "public" })).rejects.toMatchObject({
      code: "OBJECTS_MEMORY_OWNERSHIP_REFUSED",
      details: { field: "visibility" },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("names the field and never echoes the value it refused", async () => {
    const error = await save({ ownerLevel: "user", ownerId: "user-VICTIM" }).catch(
      (e: unknown) => e,
    );
    const rendered = JSON.stringify({
      message: (error as { message?: string }).message,
      details: (error as { details?: unknown }).details,
    });
    expect(rendered).toContain("ownerId");
    expect(rendered).not.toContain("user-VICTIM");
  });
});

describe("why the gate is required rather than the probe", () => {
  it("shows the kernel granting object.create without reading the tuple", async () => {
    // A create the gate allows still reaches the probe, and the probe consults
    // `can()`. Pinning that `can()` is consulted — and grants — is what makes
    // the refusals above attributable to the gate and not to an authz accident.
    await save({ ownerLevel: "organization" });
    expect(canCalls.length).toBeGreaterThan(0);
    expect(mockUpsert).toHaveBeenCalledOnce();
  });
});
