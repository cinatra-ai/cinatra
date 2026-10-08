/**
 * Fan-out run-completion materialization (cinatra#3034, plan item 0.27).
 *
 * A binding annotated with `fanOut` names an ARRAY output of plain strings and
 * materializes ONE artifact per member, its title read from the member's own
 * first line behind the declared prefix. The failing shape the fourth proof
 * round measured — a real answer that carries the members but no batch title —
 * is a fixture here.
 *
 *   npx vitest run src/lib/artifacts/__tests__/run-artifact-materializer-fanout.test.ts
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  getPublishedExtensionSummaryMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  isWriteAllowedMock,
  resolveBoundArtifactTargetMock,
  enqueueArtifactMatchRunMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  getPublishedExtensionSummaryMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  resolveBoundArtifactTargetMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({ text: "UPDATE finalize", values: [] })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  isWriteAllowedMock: vi.fn(async () => true),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => ({ query: poolQueryMock }) }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
  getPublishedExtensionSummary: getPublishedExtensionSummaryMock,
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://registry.test",
    token: "test-token",
  })),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: createSemanticArtifactMock }));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isWriteAllowedMock,
}));
vi.mock("../matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
  artifactMatchJobId: (p: { orgId: string; artifactId: string; representationRevisionId: string }) =>
    `artifact-match__${p.orgId}__${p.artifactId}__${p.representationRevisionId}`,
  ARTIFACT_MATCH_RETRY_POLICY: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set([
    "text/markdown",
    "text/plain",
    "text/html",
    "application/json",
    "application/xml",
  ]),
}));

import {
  materializeRunArtifacts,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";

const EXT = "@cinatra-ai/blog-idea-artifact";

const sha256 = (v: string): string =>
  createHash("sha256").update(v, "utf8").digest("hex");

const FAN_OUT_BINDING = {
  extension: EXT,
  contentFrom: "ideas",
  declaredMime: "text/plain",
  fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
};

function ideaPackageFixture() {
  return {
    manifest: { name: "@test/idea-agent", cinatra: { produces: [{ extension: EXT }] } },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [
            {
              title: "ideas",
              type: "array",
              json_schema: { items: { type: "string" } },
              default: [],
              cinatra: { artifact: FAN_OUT_BINDING },
            },
            { title: "notes", type: "string" },
          ],
        },
      },
    },
  };
}

const IDEA_ONE = "Title: Five onboarding patterns\n\nWhy the first session decides.\n\n- Hook\n- Pattern one\n- Takeaway";
const IDEA_TWO = "Title: The hidden cost of a free tier\n\nThree questions before the green light.\n\n- Hook\n- Question one\n- Takeaway";

const BASE_INPUT = {
  runId: "run-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  createdBy: "user-1",
  endNodeOutputs: { ideas: [IDEA_ONE, IDEA_TWO], notes: "two clusters" } as Record<
    string,
    unknown
  >,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/idea-agent" }] });
  getAgentPackageMock.mockResolvedValue(ideaPackageFixture());
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: {
      objectTypeId: "@cinatra-ai/blog-idea:idea",
      acceptedFileMimeTypes: ["text/plain", "text/markdown"],
    },
  });
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  let n = 0;
  createSemanticArtifactMock.mockImplementation(async () => {
    n += 1;
    return { artifactId: `art-${n}`, representationRevisionId: `rep-${n}` };
  });
});

describe("materializeRunArtifacts — fan-out over plain-text members", () => {
  it("writes ONE artifact per member, titled from each member's first line", async () => {
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(2);
    expect(createSemanticArtifactMock.mock.calls[0][0]).toMatchObject({
      title: "Five onboarding patterns",
      declaredMime: "text/plain",
    });
    expect(createSemanticArtifactMock.mock.calls[1][0]).toMatchObject({
      title: "The hidden cost of a free tier",
      declaredMime: "text/plain",
    });
    // The member's OWN bytes are written verbatim — the marker line included,
    // no batch document, no re-rendering. Proven through the ledger's content
    // hash, which the write core takes over exactly the bytes it streams.
    const hashes = claimMaterializationMock.mock.calls.map(
      (c: unknown[]) => (c[0] as { contentHash: string }).contentHash,
    );
    expect(hashes).toEqual([sha256(IDEA_ONE), sha256(IDEA_TWO)]);
  });

  it("gives each member its OWN ledger identity so a re-drive dedupes per member", async () => {
    await materializeRunArtifacts(BASE_INPUT);
    const outputIds = claimMaterializationMock.mock.calls.map(
      (c: unknown[]) => (c[0] as { outputId: string }).outputId,
    );
    expect(outputIds).toEqual(["ideas[0]", "ideas[1]"]);
    expect(new Set(outputIds).size).toBe(2);
  });

  it("reports one outcome per member, each carrying its member output id", async () => {
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes.map((o) => o.outputId)).toEqual(["ideas[0]", "ideas[1]"]);
  });

  it("fails the member whose first line does not carry the declared prefix, and keeps the others", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { ideas: ["No marker here\n\nbody", IDEA_TWO] },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("Title:");
    expect(outcomes[1]!.ok).toBe(true);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("fails the member whose title behind the prefix is empty — a title is never invented", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { ideas: ["Title:   \n\nbody"] },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("non-empty");
  });

  it("fails closed when the bound list is EMPTY — the run owed artifacts and produced none", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { ideas: [] },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("empty");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("fails closed when the list carries MORE members than the cap — nothing is written", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: {
        ideas: Array.from({ length: 51 }, (_v, i) => `Title: idea ${i}\n\nbody`),
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("50-member cap");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("fails closed when the members TOGETHER exceed the list byte cap", async () => {
    const big = `Title: big\n\n${"a".repeat(6 * 1024 * 1024)}`;
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { ideas: [big, big] },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("byte list cap");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("fails closed when a member is not a plain string", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { ideas: [{ title: "x", summary: "y", outline: [] }] },
    });
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("plain string");
  });

  it("fails closed when the bound output is missing from the run's declared outputs — the fourth-round shape", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      // The measured answer carried NEITHER retired key — the bridge warned
      // that both were "missing or unusable" — and no `ideas` either.
      endNodeOutputs: { notes: "n" },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("ideas");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The MEMBER-FIELD fan-out (cinatra#3732): "the fan-out accepts a list of
// objects as members, files each member as one artifact of the declared type
// with the member as its body, and takes the title from a declared field of the
// member (the binding names the field); an empty list is a normal result for a
// feed and must not fail the materialization". A feed lister's episodes are the
// fixture: one JSON object per episode, each filed unchanged.
// ---------------------------------------------------------------------------

const PODCAST_EXT = "@cinatra-ai/podcast-artifacts";

const EPISODES_BINDING = {
  extension: PODCAST_EXT,
  contentFrom: "episodes",
  declaredMime: "application/json",
  fanOut: { mode: "member", titleFrom: "member-field", titleField: "title" },
};

function episodesPackageFixture() {
  return {
    manifest: {
      name: "@test/idea-agent",
      cinatra: { produces: [{ extension: PODCAST_EXT }] },
    },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [
            {
              title: "episodes",
              type: "array",
              json_schema: {
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    audioUrl: { type: "string" },
                    publishedAt: { type: "string" },
                  },
                },
              },
              default: [],
              cinatra: { artifact: EPISODES_BINDING },
            },
          ],
        },
      },
    },
  };
}

const EPISODE_ONE = {
  title: "Episode 12: Shipping on a Friday",
  audioUrl: "https://example.test/feed/12.mp3",
  publishedAt: "2026-09-01T08:00:00Z",
};
const EPISODE_TWO = {
  title: "Episode 13: The quiet release",
  audioUrl: "https://example.test/feed/13.mp3",
  publishedAt: "2026-09-08T08:00:00Z",
};

describe("materializeRunArtifacts — member-field fan-out over object members", () => {
  beforeEach(() => {
    getAgentPackageMock.mockResolvedValue(episodesPackageFixture());
    resolveBoundArtifactTargetMock.mockResolvedValue({
      ok: true,
      target: {
        objectTypeId: "@cinatra-ai/podcast-artifacts:artifact",
        acceptedFileMimeTypes: ["application/json"],
      },
    });
  });

  it("files each object member as ONE artifact whose body is the member itself and whose title is the named field", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { episodes: [EPISODE_ONE, EPISODE_TWO] },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.outputId)).toEqual(["episodes[0]", "episodes[1]"]);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(2);
    expect(createSemanticArtifactMock.mock.calls[0][0]).toMatchObject({
      objectType: "@cinatra-ai/podcast-artifacts:artifact",
      title: "Episode 12: Shipping on a Friday",
      declaredMime: "application/json",
    });
    expect(createSemanticArtifactMock.mock.calls[1][0]).toMatchObject({
      objectType: "@cinatra-ai/podcast-artifacts:artifact",
      title: "Episode 13: The quiet release",
      declaredMime: "application/json",
    });
    // The member's OWN JSON is the body — proven through the ledger's content
    // hash over exactly the bytes the write core streams — and each member
    // keeps its own ledger identity.
    const claims = claimMaterializationMock.mock.calls.map(
      (c: unknown[]) => c[0] as { contentHash: string; outputId: string },
    );
    expect(claims.map((c) => c.contentHash)).toEqual([
      sha256(JSON.stringify(EPISODE_ONE)),
      sha256(JSON.stringify(EPISODE_TWO)),
    ]);
    expect(claims.map((c) => c.outputId)).toEqual(["episodes[0]", "episodes[1]"]);
  });

  it("fails a member that is not a plain object ALONE, and files its siblings", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: {
        episodes: [EPISODE_ONE, "Episode 99 as plain text", null, [EPISODE_TWO], EPISODE_TWO],
      },
    });
    expect(outcomes.map((o) => o.outputId)).toEqual([
      "episodes[0]",
      "episodes[1]",
      "episodes[2]",
      "episodes[3]",
      "episodes[4]",
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, false, false, true]);
    for (const failed of [outcomes[1]!, outcomes[2]!, outcomes[3]!]) {
      expect(failed.ok === false && failed.error).toContain("not a plain object");
    }
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(2);
  });

  it("fails a member that cannot be serialized as JSON ALONE, and files its sibling", async () => {
    // "files each member as one artifact of the declared type with the member
    // as its body": a member whose body cannot be written fails under its own
    // identity and never takes a healthy sibling down with it.
    const circular: Record<string, unknown> = { title: "Episode 14: The loop" };
    circular.self = circular;
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { episodes: [circular, EPISODE_TWO] },
    });
    expect(outcomes.map((o) => o.outputId)).toEqual(["episodes[0]", "episodes[1]"]);
    expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("could not be serialized as JSON");
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0][0]).toMatchObject({
      title: "Episode 13: The quiet release",
    });
  });

  it("fails a member whose named title field is missing, empty or not a string ALONE — a title is never invented", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: {
        episodes: [
          { audioUrl: "https://example.test/feed/1.mp3" },
          { ...EPISODE_ONE, title: "   " },
          { ...EPISODE_ONE, title: 12 },
          EPISODE_TWO,
        ],
      },
    });
    expect(outcomes.map((o) => o.ok)).toEqual([false, false, false, true]);
    for (const failed of outcomes.slice(0, 3)) {
      expect(failed.ok === false && failed.error).toContain('title field "title"');
    }
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0][0]).toMatchObject({
      title: "Episode 13: The quiet release",
    });
  });

  it("an EMPTY list is a normal result for a feed: nothing is written and no outcome fails", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { episodes: [] },
    });
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
  });

  it("the member cap refuses the whole object list — nothing is written", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: {
        episodes: Array.from({ length: 51 }, (_v, i) => ({ ...EPISODE_ONE, title: `Episode ${i}` })),
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("50-member cap");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("the list byte cap counts the serialized object members and refuses the whole list — nothing is written", async () => {
    const big = { ...EPISODE_ONE, notes: "a".repeat(6 * 1024 * 1024) };
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { episodes: [big, big] },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.ok === false && outcomes[0]!.error).toContain("byte list cap");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});
