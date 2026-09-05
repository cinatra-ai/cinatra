/**
 * A RUN THAT CANNOT PROVE IT OWED NOTHING IS NOT A CLEAN SUCCESS
 * (cinatra#3051, the eighth proof round).
 *
 * WHAT THE ROUND MEASURED. Two real runs of an installed agent completed
 * cleanly and the host materialized nothing: `artifact_review_gates` held 0 rows
 * for the whole window, `artifact_audit` 0 rows, no review card existed on any
 * surface, and no line anywhere named a reason. The agent's own service
 * description DOES declare a binding — its EndNode `content` output carries
 * `cinatra.artifact` for `@cinatra-ai/blog-post-artifact`, and compiling that
 * document records `hasArtifactBindings: true` — so "the package declares no
 * artifact" was never true of this run.
 *
 * WHERE THE SILENCE LIVED. `materializeRunArtifacts` consults the locally
 * persisted authority first (`agent_templates.has_artifact_bindings`) and then
 * reads the package for this run's pin. When that read comes back with ZERO
 * bindings and zero errors — an unreadable payload in the resolved copy, a
 * document the collector finds nothing in — the pass returned an EMPTY outcome
 * list, which the run-completion gate reads as "this run owed no artifact" and
 * transitions to `completed`. Two readings of the same package disagreed, and
 * the disagreement was resolved in favour of silence.
 *
 * WHAT THE #2486 MATERIALIZATION-HONESTY CONTRACT SAYS ABOUT THAT. "We cannot
 * prove the run owed no artifact, so we do not claim success." A registry that
 * does not answer already fails the run for exactly this reason; a registry that
 * answers with a copy declaring nothing, while the template says it declares
 * something, is the same ignorance wearing a 200.
 *
 * THE NARROW RULE PINNED HERE. The outcome is loud ONLY when the local authority
 * PROVABLY disagrees — `has_artifact_bindings = true` at this run's own pin. The
 * `false` short-circuit (the run owes nothing, provably) and the `null` unknown
 * (a legacy row with no backfill) keep their existing behavior exactly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  getPublishedExtensionSummaryMock,
  listArtifactsMock,
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
  listArtifactsMock: vi.fn(),
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
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
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
  artifactMatchJobId: () => "job",
  ARTIFACT_MATCH_RETRY_POLICY: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain"]),
}));

import {
  materializeRunArtifacts,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";

const EXT = "@cinatra-ai/blog-post-artifact";

/** The registry's copy of the package, with or without the declared binding. */
function packageFixture(opts: { bound: boolean }) {
  const draftOutput: Record<string, unknown> = { title: "draft", type: "string" };
  if (opts.bound) {
    draftOutput.cinatra = {
      artifact: {
        extension: EXT,
        contentFrom: "draft",
        declaredMime: "text/markdown",
        titleFrom: "title",
      },
    };
  }
  return {
    manifest: { name: "@test/agent", cinatra: { produces: [{ extension: EXT }] } },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [draftOutput, { title: "title", type: "string" }],
        },
      },
    },
  };
}

const BASE_INPUT = {
  runId: "run-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  createdBy: "user-1",
  endNodeOutputs: { draft: "# Hello", title: "My Draft" } as Record<string, unknown>,
};

/** The template row, with the flag this run's pin really carries. */
function templateRow(hasArtifactBindings: boolean | null, packageVersion = "1.2.3") {
  return {
    rows: [
      {
        package_name: "@test/agent",
        package_version: packageVersion,
        ...(hasArtifactBindings === null ? {} : { has_artifact_bindings: hasArtifactBindings }),
      },
    ],
  };
}

/**
 * The pool answers BY QUERY: the template read gets the row above, and the
 * rewrite probe (template `updated_at` beside the run's immutable `created_at`)
 * gets the pair this case is about. A case that says nothing about timestamps
 * gets a probe that answers with no row at all — unreadable, which proves no
 * rewrite and keeps the caller loud.
 */
function poolAnswering(opts: {
  template: { rows: Array<Record<string, unknown>> };
  templateUpdatedAt?: Date;
  runCreatedAt?: Date;
}) {
  return async (text: string) => {
    if (text.includes("template_updated_at")) {
      if (!opts.templateUpdatedAt || !opts.runCreatedAt) return { rows: [] };
      return {
        rows: [
          {
            template_updated_at: opts.templateUpdatedAt,
            run_created_at: opts.runCreatedAt,
          },
        ],
      };
    }
    return opts.template;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  listArtifactsMock.mockReturnValue([]);
});

describe("the template says a binding was declared and the package read finds none", () => {
  it("FAILS THE RUN with a named reason instead of completing it empty", async () => {
    poolQueryMock.mockResolvedValue(templateRow(true));
    // The copy resolved for this run declares nothing — the eighth round's
    // silence, reproduced at the seam it lived at.
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes.length).toBe(1);
    const only = outcomes[0]!;
    expect(only.ok).toBe(false);
    if (only.ok) return;
    expect(only.outputId).toBe("(binding-disagreement)");
    expect(only.error).toContain("has_artifact_bindings");
    expect(only.error).toContain("@test/agent");
    expect(only.error).toContain("1.2.3");
  });

  it("says nothing when the package read AGREES — the bound output materializes as before", async () => {
    poolQueryMock.mockResolvedValue(templateRow(true));
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: true }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    // One outcome per declared binding — this suite does not drive the write
    // path, so the outcome may be a per-output failure, but it is never the
    // disagreement outcome and it is never an empty pass.
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok === true || outcomes[0]!.outputId !== "(binding-disagreement)").toBe(true);
  });

  it("leaves the PROVABLY-binding-free run untouched — no read, no outcome", async () => {
    poolQueryMock.mockResolvedValue(templateRow(false));
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes).toEqual([]);
    // The whole point of the `false` short-circuit: the registry is never asked.
    expect(getAgentPackageMock).not.toHaveBeenCalled();
  });

  it("leaves the UNKNOWN legacy row untouched — an unbackfilled flag proves no disagreement", async () => {
    poolQueryMock.mockResolvedValue(templateRow(null));
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes).toEqual([]);
  });

  it("says NOTHING when the template row was rewritten after this run started", async () => {
    // The recompile road writes has_artifact_bindings together with the SAME
    // version string when local source is edited without a bump, so a dev who
    // adds a binding to an already-running agent flips the row to `true` at this
    // run's pin while the immutable copy this run resolved still declares none.
    // The run did not cause that and is not evidence of anything: prior posture.
    const runStarted = new Date("2026-09-02T10:00:00Z");
    poolQueryMock.mockImplementation(
      poolAnswering({
        template: templateRow(true),
        runCreatedAt: runStarted,
        templateUpdatedAt: new Date(runStarted.getTime() + 60_000),
      }),
    );
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes).toEqual([]);
  });

  it("stays LOUD when the row has stood untouched since before the run started", async () => {
    const runStarted = new Date("2026-09-02T10:00:00Z");
    poolQueryMock.mockImplementation(
      poolAnswering({
        template: templateRow(true),
        runCreatedAt: runStarted,
        templateUpdatedAt: new Date(runStarted.getTime() - 3_600_000),
      }),
    );
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.outputId).toBe("(binding-disagreement)");
  });

  it("leaves a flag that no longer describes THIS run's pin untouched", async () => {
    // A concurrent reinstall moved the template to another version: the flag is
    // about that version, not this run's, so it proves nothing either way.
    poolQueryMock.mockResolvedValue(templateRow(true, "2.0.0"));
    getAgentPackageMock.mockResolvedValue(packageFixture({ bound: false }));

    const outcomes = await materializeRunArtifacts(BASE_INPUT);

    expect(outcomes).toEqual([]);
  });
});
