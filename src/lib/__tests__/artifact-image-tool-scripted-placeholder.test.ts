/**
 * The image tool on a credential-free development stack.
 *
 * With no keyed image provider, the tool's production seam
 * (`artifactImageToolDeps().resolveImageProvider`) falls back to the scripted
 * image provider, and only under the scripted test flag in an explicit
 * development runtime. The picture it files there is the constant placeholder,
 * marked as a development placeholder in the provenance the tool records and
 * in the answer it returns. A production build or the flag off keeps the
 * stated `no_provider` refusal, and a keyed provider that can make a picture
 * is used whether the flag is set or not.
 *
 * PURE TIER. The `@cinatra-ai/llm` barrel is unresolvable in the root vitest
 * sandbox, so it is stood in for here: the keyed walk
 * (`resolveDefaultImageProvider`) is a mock each case sets, and the scripted
 * resolver is the REAL one from `@cinatra-ai/llm/scripted-test-provider`
 * (aliased to source), the function the barrel re-exports. The ledger claim,
 * the artifact write and the matcher enqueue are stood in for; the provenance
 * query is the real builder's, read from the write's transaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveDefaultImageProvider: vi.fn(),
  resolveBoundArtifactTarget: vi.fn(),
  claimMaterialization: vi.fn(),
  createSemanticArtifact: vi.fn(),
  enqueueArtifactMatchRun: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/llm", async () => {
  const scripted = await import("@cinatra-ai/llm/scripted-test-provider");
  return {
    resolveDefaultImageProvider: h.resolveDefaultImageProvider,
    resolveScriptedImageProvider: scripted.resolveScriptedImageProvider,
  };
});
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: h.resolveBoundArtifactTarget,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => true,
}));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
  claimMaterialization: h.claimMaterialization,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: h.createSemanticArtifact,
}));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: h.enqueueArtifactMatchRun,
}));

import {
  artifactImageToolDeps,
  generateArtifactImage,
  type ArtifactImageToolDeps,
} from "@/lib/artifact-image-tool";
import {
  SCRIPTED_PLACEHOLDER_IMAGE_MODEL,
  SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64,
} from "@cinatra-ai/llm/scripted-test-provider";

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "node-1",
  extension: "@cinatra-ai/picture-artifact",
  title: "A picture",
  prompt: "a lighthouse at dusk",
};

/** The tool's production provider seam, with the run package's reads supplied. */
function deps(): ArtifactImageToolDeps {
  return {
    resolveImageProvider: artifactImageToolDeps().resolveImageProvider,
    loadProducesRefs: async () => [{ extension: "@cinatra-ai/picture-artifact" }],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    countRunImages: async () => 0,
  };
}

type Written = {
  input: Record<string, unknown>;
  bytes: Buffer;
  tx2: Array<{ text: string; values: unknown[] }>;
};
let written: Written[] = [];

function runtime(env: { flag: string; mode: string; nodeEnv: string }) {
  vi.stubEnv("CINATRA_TEST_LLM_PROVIDER", env.flag);
  vi.stubEnv("CINATRA_RUNTIME_MODE", env.mode);
  vi.stubEnv("NODE_ENV", env.nodeEnv);
}

function provenanceOf(w: Written): unknown[] | undefined {
  return w.tx2.find((q) => q.text.includes("image_provider"))?.values;
}

beforeEach(() => {
  written = [];
  h.resolveDefaultImageProvider.mockResolvedValue(null);
  h.resolveBoundArtifactTarget.mockResolvedValue({
    ok: true,
    target: {
      objectTypeId: "@cinatra-ai/picture-artifact:picture",
      acceptedFileMimeTypes: ["image/*"],
    },
  });
  h.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  h.createSemanticArtifact.mockImplementation(
    async (input: {
      stream: AsyncIterable<Uint8Array>;
      additionalTx2Queries: (ids: {
        artifactId: string;
        representationRevisionId: string;
      }) => Array<{ text: string; values: unknown[] }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      written.push({
        input: input as unknown as Record<string, unknown>,
        bytes: Buffer.concat(chunks),
        tx2: input.additionalTx2Queries({ artifactId: "art-1", representationRevisionId: "rev-1" }),
      });
      return { artifactId: "art-1", representationRevisionId: "rev-1" };
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("the image tool with no keyed image provider (a credential-free development stack)", () => {
  it("files the scripted placeholder under the flag in an explicit development runtime, marked as a development placeholder", async () => {
    runtime({ flag: "scripted", mode: "development", nodeEnv: "development" });

    const outcome = await generateArtifactImage(call, deps());

    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}: ${outcome.error}`);
    expect(outcome.provider).toBe("scripted");
    expect(outcome.model).toBe(SCRIPTED_PLACEHOLDER_IMAGE_MODEL);
    expect(outcome.mime).toBe("image/png");
    expect(outcome.deduped).toBe(false);
    expect(written).toHaveLength(1);
    const [w] = written;
    expect(w.input).toMatchObject({ declaredMime: "image/png", title: "A picture" });
    expect(w.bytes.equals(Buffer.from(SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64, "base64"))).toBe(true);
    expect(w.bytes.toString("latin1")).toContain("development placeholder");
    // The provenance the ledger row records: the prompt, the provider, the model.
    expect(provenanceOf(w)).toEqual([
      "a lighthouse at dusk",
      "scripted",
      SCRIPTED_PLACEHOLDER_IMAGE_MODEL,
      "ledger-1",
      "org-1",
    ]);
  });

  it("records the placeholder model even when the caller names an image model", async () => {
    runtime({ flag: "scripted", mode: "development", nodeEnv: "development" });

    const outcome = await generateArtifactImage({ ...call, model: "gpt-image-1" }, deps());

    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}: ${outcome.error}`);
    expect(outcome.model).toBe(SCRIPTED_PLACEHOLDER_IMAGE_MODEL);
    expect(provenanceOf(written[0])?.slice(1, 3)).toEqual(["scripted", SCRIPTED_PLACEHOLDER_IMAGE_MODEL]);
  });

  it("refuses as no_provider under a production build with the flag on, and writes nothing", async () => {
    runtime({ flag: "scripted", mode: "development", nodeEnv: "production" });

    const outcome = await generateArtifactImage(call, deps());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("no_provider");
    expect(h.claimMaterialization).not.toHaveBeenCalled();
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });

  it("refuses as no_provider with the flag off, and writes nothing", async () => {
    runtime({ flag: "", mode: "development", nodeEnv: "development" });

    const outcome = await generateArtifactImage(call, deps());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("no_provider");
    expect(h.claimMaterialization).not.toHaveBeenCalled();
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });
});

describe("the image tool with a keyed image provider", () => {
  it("uses the keyed provider with the scripted flag on in a development runtime", async () => {
    runtime({ flag: "scripted", mode: "development", nodeEnv: "development" });
    const keyedPicture = Buffer.from("keyed picture bytes").toString("base64");
    const generateImage = vi.fn(async () => ({
      imageData: keyedPicture,
      mimeType: "image/png",
      model: "keyed-image-model",
    }));
    h.resolveDefaultImageProvider.mockResolvedValue({ provider: "gemini", adapter: { generateImage } });

    const outcome = await generateArtifactImage(call, deps());

    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}: ${outcome.error}`);
    expect(outcome.provider).toBe("gemini");
    expect(outcome.model).toBe("keyed-image-model");
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage).toHaveBeenCalledWith({
      prompt: "a lighthouse at dusk",
      logLabel: "artifact_image_generate",
    });
    expect(written[0].bytes.equals(Buffer.from(keyedPicture, "base64"))).toBe(true);
    expect(provenanceOf(written[0])?.slice(1, 3)).toEqual(["gemini", "keyed-image-model"]);
  });
});
