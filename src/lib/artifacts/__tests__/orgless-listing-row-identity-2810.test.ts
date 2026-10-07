/**
 * AN ORGLESS LISTING RESOLVES EACH ROW'S IDENTITY AGAINST THE ROW'S OWN
 * ORGANIZATION (cinatra#2810, the workspace Artifacts tab).
 *
 * The workspace tab lists the union over the actor's organizations, so it reads
 * the library with no organization in scope (`orgId: null`). Identity used to be
 * resolved against `input.orgId` only, and an orgless read skipped it
 * altogether: every row came back as `no-primary`, although the same stored row
 * resolves to its defining extension when the organization it belongs to reads
 * it. The picture showed the result on the workspace tab: the generic label, the
 * generic glyph, and the row drawn as the file-form floor.
 *
 * These cases pin the read itself. The identity services are stood in by fakes
 * that keep the live contract: the effective identity is type-driven, the
 * presented identity layers the assertions of ONE organization on top of it.
 */
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { resolveEffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const IDEA_TYPE = "@fixture/idea-artifact:idea";
const IDEA_EXT = "@fixture/idea-artifact";
const TEXT_TYPE = "@fixture/text-artifact:text";
const TEXT_EXT = "@fixture/text-artifact";
const SUMMARY_EXT = "@fixture/summary-artifact";
const ORG_A = "org-a";
const ORG_B = "org-b";

/** The meaning assertions each organization holds, keyed by artifact id. An
 *  assertion lives in ONE organization, exactly as `semantic_assertion` does. */
const world = vi.hoisted(() => ({
  assertions: {} as Record<string, Record<string, string>>,
  rows: [] as Array<Record<string, unknown>>,
}));

const listObjectsByFilter = vi.fn();
vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: vi.fn(),
}));
vi.mock("../artifact-retention", () => ({ tombstoneArtifact: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("../semantic-assertion-store", () => ({
  listArtifactIdsForExtension: vi.fn(() => new Set<string>()),
}));

const effectiveCalls = vi.fn();
const presentationCalls = vi.fn();
vi.mock("@/lib/objects/effective-identity", async () => {
  const { resolveEffectiveIdentity: typeDriven } = await import(
    "@cinatra-ai/objects/effective-identity"
  );
  return {
    resolveArtifactEffectiveIdentities: (input: {
      orgId: string;
      rows: ReadonlyArray<{ id: string; type: string }>;
    }) => {
      effectiveCalls(input.orgId, input.rows.map((r) => r.id));
      return new Map(
        input.rows.map((r) => [
          r.id,
          {
            identity: typeDriven(r.type),
            eligibleExtensions: world.assertions[input.orgId]?.[r.id]
              ? [world.assertions[input.orgId]![r.id]!]
              : [],
          },
        ]),
      );
    },
    resolveArtifactEffectiveIdentity: vi.fn(),
  };
});
vi.mock("@/lib/objects/presentation-identity", async () => {
  const { resolveEffectiveIdentity: typeDriven } = await import(
    "@cinatra-ai/objects/effective-identity"
  );
  return {
    resolveArtifactPresentationIdentities: (input: {
      orgId: string;
      rows: ReadonlyArray<{ id: string; type: string }>;
    }) => {
      presentationCalls(input.orgId, input.rows.map((r) => r.id));
      return new Map(
        input.rows.map((r) => {
          const asserted = world.assertions[input.orgId]?.[r.id];
          return [
            r.id,
            {
              identity: asserted
                ? { kind: "extension" as const, extension: asserted }
                : typeDriven(r.type),
              tier: asserted ? "classic" : "claim-backed",
              suggestions: [],
            },
          ];
        }),
      );
    },
    resolveArtifactPresentationIdentity: vi.fn(),
  };
});

function registerArtifactType(type: string, pkg: string): void {
  objectTypeRegistry.register(
    {
      type,
      category: "content",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/plain"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    pkg,
  );
}

/** One stored row as the object store returns it: an agent-produced text file. */
function stored(id: string, type: string, orgId: string | null) {
  return {
    id,
    type,
    data: {
      artifactType: "file",
      title: id,
      mime: "text/plain",
      size: 12,
      originKind: "agent_generated",
      latestRepresentationRevisionId: `${id}-v1`,
    },
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    ownerLevel: orgId ? "organization" : "workspace",
    ownerId: orgId,
    visibility: "organization",
    orgId,
    projectId: null,
  };
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
  registerArtifactType(IDEA_TYPE, IDEA_EXT);
  registerArtifactType(TEXT_TYPE, TEXT_EXT);
  world.assertions = {
    // The binding road: a base-typed text file an agent asserted a MEANING for,
    // in the organization the run belonged to.
    [ORG_A]: { "a-meaning": IDEA_EXT },
    [ORG_B]: { "b-meaning": SUMMARY_EXT },
  };
  world.rows = [
    stored("a-typed", IDEA_TYPE, ORG_A),
    stored("a-meaning", TEXT_TYPE, ORG_A),
    stored("b-meaning", TEXT_TYPE, ORG_B),
    stored("tier-typed", IDEA_TYPE, null),
  ];
  // The store's own org clause: `(org_id = $1 OR $1 IS NULL)`.
  listObjectsByFilter.mockImplementation((f: { orgId: string | null; type: string }) =>
    world.rows.filter((r) => r.type === f.type && (f.orgId === null || r.orgId === f.orgId)),
  );
  effectiveCalls.mockReset();
  presentationCalls.mockReset();
});

afterEach(() => {
  objectTypeRegistry._clearForTests();
  listObjectsByFilter.mockReset();
});

describe("an orgless listing resolves each row against its own organization", () => {
  it("presents every row with the identity its own organization's read gives it", async () => {
    const { listArtifacts } = await import("../artifact-service");
    const byId = new Map(listArtifacts({ orgId: null }).map((r) => [r.artifactId, r]));

    expect(byId.get("a-typed")?.presentationIdentity).toEqual({ kind: "extension", extension: IDEA_EXT });
    expect(byId.get("a-typed")?.primaryExtension).toBe(IDEA_EXT);
    // Org A's meaning assertion, read in org A.
    expect(byId.get("a-meaning")?.presentationIdentity).toEqual({ kind: "extension", extension: IDEA_EXT });
    expect(byId.get("a-meaning")?.eligibleExtensions).toEqual([IDEA_EXT]);
    // Org B's meaning assertion, read in org B, never in org A.
    expect(byId.get("b-meaning")?.presentationIdentity).toEqual({ kind: "extension", extension: SUMMARY_EXT });
    expect(byId.get("b-meaning")?.effectiveIdentity).toEqual({ kind: "extension", extension: TEXT_EXT });
  });

  it("gives each orgless row exactly what the org-scoped read of its organization gives it", async () => {
    const { listArtifacts } = await import("../artifact-service");
    const orgless = new Map(listArtifacts({ orgId: null }).map((r) => [r.artifactId, r]));
    for (const org of [ORG_A, ORG_B]) {
      for (const row of listArtifacts({ orgId: org })) {
        expect(orgless.get(row.artifactId)).toEqual(row);
      }
    }
  });

  it("reads each organization's assertions once, for that organization's rows only", async () => {
    const { listArtifacts } = await import("../artifact-service");
    listArtifacts({ orgId: null });
    const calls = (fn: typeof effectiveCalls) =>
      fn.mock.calls
        .map(([org, ids]) => [org, [...(ids as string[])].sort()])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    const expected = [
      [ORG_A, ["a-meaning", "a-typed"]],
      [ORG_B, ["b-meaning"]],
    ];
    expect(calls(effectiveCalls)).toEqual(expected);
    expect(calls(presentationCalls)).toEqual(expected);
  });

  it("gives a row that belongs to no organization its type-driven identity", async () => {
    const { listArtifacts } = await import("../artifact-service");
    const row = listArtifacts({ orgId: null }).find((r) => r.artifactId === "tier-typed");
    expect(row?.effectiveIdentity).toEqual(resolveEffectiveIdentity(IDEA_TYPE));
    expect(row?.presentationIdentity).toEqual({ kind: "extension", extension: IDEA_EXT });
    expect(row?.eligibleExtensions).toEqual([]);
    expect(row?.presentationSuggestions).toEqual([]);
  });
});

describe("an org-scoped listing is resolved exactly as before", () => {
  it("resolves the whole page against the read's own organization, once", async () => {
    const { listArtifacts } = await import("../artifact-service");
    const rows = listArtifacts({ orgId: ORG_A });
    expect(rows.map((r) => r.artifactId).sort()).toEqual(["a-meaning", "a-typed"]);
    expect(effectiveCalls.mock.calls).toHaveLength(1);
    expect(effectiveCalls.mock.calls[0]?.[0]).toBe(ORG_A);
    expect(presentationCalls.mock.calls).toHaveLength(1);
    expect(presentationCalls.mock.calls[0]?.[0]).toBe(ORG_A);
  });
});
