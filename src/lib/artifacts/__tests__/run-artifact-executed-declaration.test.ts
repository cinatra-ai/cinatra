/**
 * cinatra#3208 — materialization must resolve the declaration the run
 * EXECUTED, not whatever the package registry currently serves for the same
 * (packageName, packageVersion) pair.
 *
 * The measured failure: a real blog-idea-generator run reached its end node,
 * surfaced the fan-out `ideas` list its own flow declares, and was then landed
 * `failed` with
 *
 *   ideaBatchDocument [@cinatra-ai/blog-idea-artifact]: titleFrom output
 *   "ideaBatchTitle" did not resolve to a non-empty string
 *
 * — two identifiers belonging to the RETIRED scalar declaration (cinatra#3034
 * replaced it with the fan-out one), on a repository whose extension lock pins
 * the fan-out copy. Execution was bound to the immutable template-version
 * snapshot; materialization independently re-read the registry; the two
 * disagreed and the run paid for it after all of the model work was done.
 *
 * These cases drive the REAL materializer with exactly that disagreement
 * manufactured: the template row carries the persisted FAN-OUT declaration for
 * the run's pinned version, and the package-registry double returns the retired
 * SCALAR binding for the same package name and version.
 *
 *   npx vitest run src/lib/artifacts/__tests__/run-artifact-executed-declaration.test.ts
 */
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

import { serializeArtifactBindingDeclaration } from "@cinatra-ai/agents/artifact-binding";
import type { PersistedArtifactBindingDeclaration } from "@cinatra-ai/agents/artifact-binding";
import {
  materializeRunArtifacts,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";

const PKG = "@cinatra-ai/blog-idea-generator-agent";
const PKG_VERSION = "1.4.0";
const EXT = "@cinatra-ai/blog-idea-artifact";
const OBJECT_TYPE_ID = "@cinatra-ai/blog-idea-artifact:blog-idea";

/**
 * The declaration the pinned package (and therefore the run) actually executes,
 * verbatim from the extension's own `cinatra/oas.json`: ONE fan-out binding
 * over `ideas`, each member titled from its own first line, no run-level title.
 */
const EXECUTED_FAN_OUT_DECLARATION: PersistedArtifactBindingDeclaration = {
  bindings: [
    {
      nodeId: "endNode",
      outputId: "ideas",
      binding: {
        extension: EXT,
        objectTypeId: OBJECT_TYPE_ID,
        contentFrom: "ideas",
        declaredMime: "text/plain",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
      },
    },
  ],
  producesRefs: [{ extension: EXT, objectTypeId: OBJECT_TYPE_ID }],
};

/**
 * The SAME declaration in its persisted, JSON-as-text form, built here WITHOUT
 * the serializer under test. The behavioural cases below feed this literal to
 * the template row on purpose: the red-first proof must be the materializer
 * resolving the WRONG declaration at the previous head, not a missing export.
 *  below pins the serializer to it,
 * so the two can never drift apart.
 */
const EXECUTED_FAN_OUT_JSON = JSON.stringify({
  v: 1,
  bindings: EXECUTED_FAN_OUT_DECLARATION.bindings,
  producesRefs: EXECUTED_FAN_OUT_DECLARATION.producesRefs,
});

/**
 * The RETIRED scalar declaration the measured failure names — four outputs,
 * `ideaBatchDocument` bound as markdown and titled from `ideaBatchTitle`. This
 * is what the registry double serves for the SAME name and version.
 */
function retiredScalarPackageFixture() {
  return {
    manifest: { name: PKG, cinatra: { produces: [{ extension: EXT }] } },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [
            { title: "ideas", type: "array", json_schema: { items: { type: "string" } } },
            { title: "ideaBatchTitle", type: "string" },
            {
              title: "ideaBatchDocument",
              type: "string",
              cinatra: {
                artifact: {
                  extension: EXT,
                  contentFrom: "ideaBatchDocument",
                  declaredMime: "text/markdown",
                  titleFrom: "ideaBatchTitle",
                },
              },
            },
            { title: "notes", type: "string" },
          ],
        },
      },
    },
  };
}

/** The end-node outputs the fan-out flow really surfaces — no batch title anywhere. */
const END_NODE_OUTPUTS: Record<string, unknown> = {
  ideas: [
    "Title: Ship logs beat status meetings\n\nWhy a written trail outruns a standup.",
    "Title: The cost of an unread dashboard\n\nWhat nobody opens, nobody owns.",
  ],
  notes: "Two ideas, drawn from the brief.",
};

const BASE_INPUT = {
  runId: "run-3208",
  orgId: "org-a",
  templateId: "tpl-blog-idea",
  packageVersion: PKG_VERSION,
  createdBy: "user-1",
  endNodeOutputs: END_NODE_OUTPUTS,
};

/**
 * Route the template read by SQL. `persistedDeclaration: null` reproduces a row
 * that predates the column (or a compile with no readable sibling manifest).
 */
function templateRow(opts: { persistedDeclaration: string | null; rowVersion?: string }) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes("artifact_bindings")) {
      return Promise.resolve({
        rows: [
          {
            package_name: PKG,
            package_version: opts.rowVersion ?? PKG_VERSION,
            has_artifact_bindings: true,
            artifact_bindings: opts.persistedDeclaration,
          },
        ],
      });
    }
    if (sql.includes("package_name")) return Promise.resolve({ rows: [{ package_name: PKG }] });
    if (sql.includes("owner_level")) {
      return Promise.resolve({ rows: [{ owner_level: "organization", owner_id: "org-a" }] });
    }
    if (sql.includes("project_id")) return Promise.resolve({ rows: [{ project_id: null }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  getAgentPackageMock.mockResolvedValue(retiredScalarPackageFixture());
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: { objectTypeId: OBJECT_TYPE_ID, acceptedFileMimeTypes: ["text/plain", "text/markdown"] },
  });
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  let artifactSeq = 0;
  createSemanticArtifactMock.mockImplementation(async () => {
    artifactSeq += 1;
    return { artifactId: `art-${artifactSeq}`, representationRevisionId: `rep-${artifactSeq}` };
  });
});

describe("cinatra#3208 — the executed declaration is the materialization authority", () => {
  it("resolves the run's OWN fan-out declaration while the registry still serves the retired scalar one", async () => {
    templateRow({
      persistedDeclaration: EXECUTED_FAN_OUT_JSON,
    });

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    // One artifact per idea, each titled from its own first line — the shape
    // the executed declaration owes. Before the fix this was a single ok:false
    // outcome naming `ideaBatchDocument`.
    expect(outcomes).toEqual([
      {
        ok: true,
        outputId: "ideas[0]",
        nodeId: "endNode",
        extension: EXT,
        artifactId: "art-1",
        representationRevisionId: "rep-1",
        deduped: false,
      },
      {
        ok: true,
        outputId: "ideas[1]",
        nodeId: "endNode",
        extension: EXT,
        artifactId: "art-2",
        representationRevisionId: "rep-2",
        deduped: false,
      },
    ]);
    expect(createSemanticArtifactMock.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual([
      "Ship logs beat status meetings",
      "The cost of an unread dashboard",
    ]);
  });

  it("does not read the package registry at all when the executed declaration resolves", async () => {
    templateRow({
      persistedDeclaration: EXECUTED_FAN_OUT_JSON,
    });

    await materializeRunArtifacts(BASE_INPUT);

    // The whole defect was a SECOND authority. There is now one, so the read
    // that could disagree with it is not performed.
    expect(getAgentPackageMock).not.toHaveBeenCalled();
  });

  it("keeps the fail-closed posture: an executed declaration whose bound output is absent still fails the run", async () => {
    templateRow({
      persistedDeclaration: EXECUTED_FAN_OUT_JSON,
    });

    const outcomes = await materializeRunArtifacts({ ...BASE_INPUT, endNodeOutputs: { notes: "n" } });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, outputId: "ideas", extension: EXT });
    expect((outcomes[0] as { error: string }).error).toContain(
      'fan-out output "ideas" did not resolve to an array',
    );
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("a row with NO persisted declaration keeps the pre-#3208 registry read (unknown, not assumed)", async () => {
    templateRow({ persistedDeclaration: null });

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(getAgentPackageMock).toHaveBeenCalledTimes(1);
    // And the registry's retired scalar binding produces exactly the sentence
    // the proof rounds recorded — the legacy path is preserved, not silenced.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, outputId: "ideaBatchDocument", extension: EXT });
    expect((outcomes[0] as { error: string }).error).toBe(
      'titleFrom output "ideaBatchTitle" did not resolve to a non-empty string',
    );
  });

  it("a persisted declaration for a DIFFERENT version than the run's pin is not trusted (version-pin guard)", async () => {
    templateRow({
      persistedDeclaration: EXECUTED_FAN_OUT_JSON,
      rowVersion: "2.0.0",
    });

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    // The template moved on since this run started, so its declaration
    // describes a different version: unknown, fall through, never a wrong
    // "executed" answer.
    expect(getAgentPackageMock).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ ok: false, outputId: "ideaBatchDocument" });
  });

  it("serializes to exactly the persisted form the cases above feed the row", () => {
    // Pins the serializer to the literal, so a grammar change cannot quietly
    // make the behavioural cases above stop describing what is really written.
    expect(serializeArtifactBindingDeclaration(EXECUTED_FAN_OUT_DECLARATION)).toBe(
      EXECUTED_FAN_OUT_JSON,
    );
  });

  it("a malformed persisted declaration reads as unknown, never as an empty declaration", async () => {
    templateRow({ persistedDeclaration: '{"v":1,"bindings":"not-an-array"}' });

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(getAgentPackageMock).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ ok: false, outputId: "ideaBatchDocument" });
  });
});
