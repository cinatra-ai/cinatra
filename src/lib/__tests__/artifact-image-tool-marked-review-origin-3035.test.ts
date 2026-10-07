/**
 * cinatra#3035 — THE PICTURE WRITTEN MID-RUN CARRIES THE INTERMEDIATE ORIGIN.
 *
 * A mid-run text write of a run whose own flow declares a marked review step
 * already takes the intermediate origin: that marked step IS its review, so the
 * core default must not open a second one afterwards. A first picture the image
 * tool files for such a run is the same kind of write and takes the same
 * origin; a run whose flow marks no review step keeps the durable origin.
 *
 * PURE TIER. Every seam is supplied: the creation seam is replaced so the input
 * the tool hands the one write path is read directly, and the ledger claim
 * answers a fresh claim, so neither a database nor a provider is reached.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const {
  resolveBoundArtifactTargetMock,
  isArtifactExtensionWriteAllowedMock,
  createSemanticArtifactMock,
  enqueueArtifactMatchRunMock,
  claimMaterializationMock,
} = vi.hoisted(() => ({
  resolveBoundArtifactTargetMock: vi.fn(),
  isArtifactExtensionWriteAllowedMock: vi.fn(async () => true),
  createSemanticArtifactMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async () => undefined),
  claimMaterializationMock: vi.fn(),
}));

vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isArtifactExtensionWriteAllowedMock,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
}));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>();
  return { ...actual, claimMaterialization: claimMaterializationMock };
});

import { generateArtifactImage, type ArtifactImageToolDeps } from "@/lib/artifact-image-tool";

const EXTENSION = "@cinatra-ai/blog-image-artifact";
const OBJECT_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";

function deps(over: Partial<ArtifactImageToolDeps> = {}): ArtifactImageToolDeps {
  return {
    resolveImageProvider: async () => ({
      provider: "test-provider",
      generateImage: async () => ({
        imageData: "iVBORw0KGgo=",
        mimeType: "image/png",
        model: "test-image-model",
      }),
    }),
    loadProducesRefs: async () => [{ extension: EXTENSION, objectTypeId: OBJECT_TYPE }],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    countRunImages: async () => 0,
    ...over,
  };
}

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "node-1",
  extension: EXTENSION,
  title: "A picture",
  prompt: "a lighthouse at dusk",
};

function arrange(): void {
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: { objectTypeId: OBJECT_TYPE, acceptedFileMimeTypes: ["image/png"] },
  });
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "artifact-1",
    representationRevisionId: "revision-1",
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("@/lib/artifacts/resolve-bound-artifact-type");
  vi.doUnmock("@/lib/artifacts/artifact-extension-access");
  vi.doUnmock("@/lib/artifacts/artifact-creation");
  vi.doUnmock("@/lib/artifacts/matcher-enqueue");
  vi.doUnmock("@/lib/artifacts/materialization-ledger");
  vi.resetModules();
});

describe("cinatra#3035 — the origin of a first picture filed mid-run", () => {
  it("files a first picture with the intermediate origin when the run's flow marks a review step", async () => {
    arrange();
    const outcome = await generateArtifactImage(
      call,
      deps({ loadMarksReviewStep: async () => true }),
    );

    expect(outcome.ok).toBe(true);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      originKind: "live_generator",
    });
  });

  it("keeps the durable origin when the run's flow marks no review step", async () => {
    arrange();
    const outcome = await generateArtifactImage(
      call,
      deps({ loadMarksReviewStep: async () => false }),
    );

    expect(outcome.ok).toBe(true);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      originKind: "agent_generated",
    });
  });
});
