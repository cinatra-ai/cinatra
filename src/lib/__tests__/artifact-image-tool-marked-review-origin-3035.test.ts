/**
 * cinatra#3035 — THE ORIGIN OF A FIRST PICTURE FOLLOWS THE ONE WRITE-FACTS READ.
 *
 * The image tool reads the run package's write facts ONCE — the produces refs it
 * authorizes against and whether an executed marked gate reviews the write of
 * this node — and files a first picture with the intermediate origin only when
 * that same reading says the write is reviewed; otherwise the durable origin.
 * Which flows read as reviewed is pinned by the materializer suite
 * (materialize-tool-artifact.test.ts, through `loadRunImageWriteFacts`).
 *
 * PURE TIER. Every seam is supplied: the write-facts seam answers a stated
 * value, the creation seam is replaced so the input the tool hands the one write
 * path is read directly, and the ledger claim answers a fresh claim, so neither
 * a database, a registry nor a provider is reached.
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
    loadWriteFacts: async () => ({
      producesRefs: [{ extension: EXTENSION, objectTypeId: OBJECT_TYPE }],
      reviewed: false,
    }),
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

function facts(reviewed: boolean) {
  return vi.fn(async () => ({
    producesRefs: [{ extension: EXTENSION, objectTypeId: OBJECT_TYPE }],
    reviewed,
  }));
}

describe("cinatra#3035 — the origin of a first picture filed mid-run", () => {
  it("files a first picture with the intermediate origin when the one reading says the write is reviewed", async () => {
    arrange();
    const loadWriteFacts = facts(true);
    const outcome = await generateArtifactImage(call, deps({ loadWriteFacts }));

    expect(outcome.ok).toBe(true);
    // One reading, asked for THIS node's write, supplies both answers.
    expect(loadWriteFacts).toHaveBeenCalledTimes(1);
    expect(loadWriteFacts).toHaveBeenCalledWith({
      templateId: "tpl-1",
      packageVersion: "1.0.0",
      nodeId: "node-1",
    });
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      objectType: OBJECT_TYPE,
      originKind: "live_generator",
    });
  });

  it("keeps the durable origin when the same reading says the write is not reviewed", async () => {
    arrange();
    const loadWriteFacts = facts(false);
    const outcome = await generateArtifactImage(call, deps({ loadWriteFacts }));

    expect(outcome.ok).toBe(true);
    expect(loadWriteFacts).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      originKind: "agent_generated",
    });
  });
});
