/**
 * cinatra#3032 (epic #3023, lifecycle-c W8) — THE IMAGE TOOL'S STATED REFUSALS.
 *
 * Acceptance item 3, "A request without a provider is refused with its reason",
 * is the item this file exists for: a deployment with no configured image
 * provider must answer a sentence, not a stack, and must not have written
 * anything on the way to answering it. The other refusals here are the rest of
 * enabler 0.28's own guards — "a stated refusal without a provider, a per-run
 * cap" — proved the same way: a returned reason, never a throw.
 *
 * PURE TIER. Every seam is supplied, so this file needs neither a database nor
 * a provider: the point is exactly that a refusal is decided BEFORE either is
 * reached. The write itself is proved against a real Postgres in
 * `artifacts/__tests__/lifecycle-c-w8-image-tool.integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

// The two seams the accepts check below needs are module imports, not injected
// deps, so this file supplies them the way vitest supplies a module.
const { resolveBoundArtifactTargetMock, isArtifactExtensionWriteAllowedMock } = vi.hoisted(
  () => ({
    resolveBoundArtifactTargetMock: vi.fn(),
    isArtifactExtensionWriteAllowedMock: vi.fn(async () => true),
  }),
);
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isArtifactExtensionWriteAllowedMock,
}));

import {
  MAX_IMAGES_PER_RUN,
  generateArtifactImage,
  type ArtifactImageToolDeps,
} from "@/lib/artifact-image-tool";

const PROVIDER_NEVER_CALLED = () => {
  throw new Error("the provider must not be reached on a refused call");
};

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
    loadProducesRefs: async () => [{ extension: "@cinatra-ai/picture-artifact" }],
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
  extension: "@cinatra-ai/picture-artifact",
  title: "A picture",
  prompt: "a lighthouse at dusk",
};

describe("acceptance item 3 — a request without a provider is refused with its reason", () => {
  it("answers a stated no-provider refusal instead of throwing, and writes nothing", async () => {
    const countRunImages = vi.fn(async () => 0);
    const loadProducesRefs = vi.fn(async () => [
      { extension: "@cinatra-ai/picture-artifact" },
    ]);
    const outcome = await generateArtifactImage(
      call,
      deps({
        resolveImageProvider: async () => null,
        countRunImages,
        loadProducesRefs,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("no_provider");
    // The REASON is a sentence a person can act on, not a token.
    expect(outcome.error).toMatch(/no image provider is configured/i);
    expect(outcome.error).toMatch(/no picture was made/i);
    // Nothing was read and nothing was counted on the way to the refusal.
    expect(loadProducesRefs).not.toHaveBeenCalled();
    expect(countRunImages).not.toHaveBeenCalled();
  });

  it("treats a configured provider whose adapter cannot make a picture as no provider", async () => {
    // `resolveDefaultImageProvider` only ever answers with an adapter that can
    // generate an image, so "configured but incapable" reaches this road as the
    // same null — and must reach the caller as the same stated refusal.
    const outcome = await generateArtifactImage(
      call,
      deps({ resolveImageProvider: async () => null }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("no_provider");
  });
});

describe("enabler 0.28 — the rest of the tool's stated refusals", () => {
  it("refuses an extension the run package did not declare it produces", async () => {
    const outcome = await generateArtifactImage(
      { ...call, extension: "@cinatra-ai/other-artifact" },
      deps({
        resolveImageProvider: async () => ({
          provider: "test-provider",
          generateImage: PROVIDER_NEVER_CALLED,
        }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("not_produced");
    expect(outcome.error).toMatch(/cinatra\.produces/);
  });

  it("refuses past the per-run cap, before the provider is asked for anything", async () => {
    const outcome = await generateArtifactImage(
      call,
      deps({
        countRunImages: async () => MAX_IMAGES_PER_RUN,
        resolveImageProvider: async () => ({
          provider: "test-provider",
          generateImage: PROVIDER_NEVER_CALLED,
        }),
        loadProducesRefs: async () => [{ extension: "@cinatra-ai/picture-artifact" }],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("run_cap_exceeded");
    expect(outcome.error).toMatch(new RegExp(`allowance of ${MAX_IMAGES_PER_RUN}`));
    expect(outcome.error).toMatch(/no picture was made/);
  });

  it("refuses an empty prompt — a picture is made from what it is asked for", async () => {
    const outcome = await generateArtifactImage({ ...call, prompt: "   " }, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toMatch(/prompt must be a non-empty string/);
  });
});

/**
 * THE PICTURE'S FORM AGAINST THE TYPE'S DECLARED ACCEPTS.
 *
 * The canonical writer and the revision-append road both ask this question with
 * the wildcard-aware matcher (`mimeAcceptedByAccepts`). This tool must ask it
 * the same way: a type declaring `image/*` accepts a PNG, and refusing it here
 * would refuse a picture the writer one call later would have taken — after the
 * provider had already been paid for making it.
 */
describe("the generated picture is matched against the accepts the writer uses", () => {
  const target = (mimeTypes: string[]) => ({
    ok: true as const,
    target: {
      objectTypeId: "@cinatra-ai/picture-artifact:picture",
      acceptedFileMimeTypes: mimeTypes,
    },
  });

  it("a type declaring the `image/*` wildcard accepts the generated PNG", async () => {
    resolveBoundArtifactTargetMock.mockResolvedValue(target(["image/*"]));
    const outcome = await generateArtifactImage(call, deps());

    expect(outcome.ok).toBe(false); // no database in this tier
    if (outcome.ok) throw new Error("unreachable");
    // The accepts gate was PASSED: the refusal is the ledger's, never the
    // form's. A literal `includes` answered the sentence below instead.
    expect(outcome.error).not.toContain("accepts [image/*]");
    expect(outcome.error).toContain("filing the picture failed");
  });

  it("a type that accepts no picture form still refuses, before any write", async () => {
    resolveBoundArtifactTargetMock.mockResolvedValue(target(["application/pdf"]));
    const outcome = await generateArtifactImage(call, deps());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toContain("accepts [application/pdf]");
  });
});
