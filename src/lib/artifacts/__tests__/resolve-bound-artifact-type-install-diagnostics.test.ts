/**
 * cinatra#2536 — the materializer must stop blaming a correct manifest.
 *
 * The reported symptom of an incomplete install was, on EVERY run of the blog
 * pipeline's producer:
 *
 *   extension "@cinatra-ai/blog-post-artifact" declares no artifact-safe object
 *   type — cannot materialize a binding (declare a produces/binding
 *   objectTypeId over an artifact-safe claim)
 *
 * …while `extensions/cinatra-ai/blog-post-artifact/package.json` DOES declare
 * `@cinatra-ai/blog-post-artifact:post` as an `artifact-safe` `dedicated` claim
 * and the type IS registered. The advice was unactionable: the real cause was a
 * missing `installed_extension` row, so `artifact_type_claims` never seeded and
 * the effective set was empty.
 *
 * These cases pin BOTH directions: the zero-claim failure is re-explained in
 * install terms, and a genuine binding/manifest error is left alone.
 *
 * Run: pnpm exec vitest run \
 *   src/lib/artifacts/__tests__/resolve-bound-artifact-type-install-diagnostics.test.ts
 */
import { describe, it, expect, vi } from "vitest";

import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";

const EXT = "@cinatra-ai/blog-post-artifact";
const TYPE = `${EXT}:post`;
const MANIFEST_BLAME = "declares no artifact-safe object type";

describe("resolveBoundArtifactTarget — zero-claim diagnostics", () => {
  it("an extension with NO effective claims reports the INSTALL cause, not the manifest", async () => {
    const explain = vi.fn(async () => "INSTALL-CAUSE: no installed_extension row exists");

    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => [TYPE],
        explainAbsentClaims: explain,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("INSTALL-CAUSE: no installed_extension row exists");
    expect(result.ok === false && result.error).not.toContain(MANIFEST_BLAME);
    // The declared type is threaded through so the message can NAME it.
    expect(explain).toHaveBeenCalledWith({
      orgId: "org_1",
      extension: EXT,
      declaredObjectTypeIds: [TYPE],
    });
  });

  it("the same re-explanation applies when the binding pins an explicit objectTypeId", async () => {
    // Pre-fix this produced `objectTypeId "…" is not an artifact-safe declared
    // type of extension "…" (declares: [none])` — same wrong finger, at the
    // binding instead of the manifest.
    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      bindingObjectTypeId: TYPE,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => [TYPE],
        explainAbsentClaims: async () => "INSTALL-CAUSE",
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toBe("INSTALL-CAUSE");
  });

  it("does NOT over-reach: an explicit id outside a NON-empty claim set keeps the binding error", async () => {
    const explain = vi.fn(async () => "INSTALL-CAUSE");

    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      bindingObjectTypeId: `${EXT}:nope`,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [TYPE],
        explainAbsentClaims: explain,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("is not an artifact-safe declared type");
    expect(explain).not.toHaveBeenCalled();
  });

  it("does NOT over-reach: a pack that genuinely declares NO object types keeps the manifest error", async () => {
    const explain = vi.fn(async () => "INSTALL-CAUSE");

    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => [], // manifest declares nothing
        explainAbsentClaims: explain,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toContain(MANIFEST_BLAME);
    expect(explain).not.toHaveBeenCalled();
  });

  it("does NOT over-reach: an explicit id the pack never declares keeps the binding error", async () => {
    const explain = vi.fn(async () => "INSTALL-CAUSE");

    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      bindingObjectTypeId: `${EXT}:typo`,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => [TYPE],
        explainAbsentClaims: explain,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toContain("is not an artifact-safe declared type");
    expect(explain).not.toHaveBeenCalled();
  });

  it("an UNREADABLE pack manifest is not evidence about the manifest — it keeps the install diagnosis", async () => {
    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => null,
        explainAbsentClaims: async () => "INSTALL-CAUSE",
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toBe("INSTALL-CAUSE");
  });

  it("does NOT over-reach: an ambiguous multi-claim pack keeps its disambiguation error", async () => {
    const explain = vi.fn(async () => "INSTALL-CAUSE");

    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [TYPE, `${EXT}:other`],
        explainAbsentClaims: explain,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toContain("must set an explicit objectTypeId");
    expect(explain).not.toHaveBeenCalled();
  });

  it("a healthy claim still resolves (the fix adds no new failure path)", async () => {
    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [TYPE],
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result).toEqual({
      ok: true,
      target: { objectTypeId: TYPE, acceptedFileMimeTypes: ["text/markdown"] },
    });
  });

  it("a THROWING declared-type read degrades to a still-non-manifest-blaming message", async () => {
    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => {
          throw new Error("store unavailable");
        },
        explainAbsentClaims: async (arg) => `INSTALL-CAUSE names=${arg.declaredObjectTypeIds ?? "none"}`,
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok === false && result.error).toBe("INSTALL-CAUSE names=none");
    expect(result.ok === false && result.error).not.toContain(MANIFEST_BLAME);
  });

  it("a THROWING explainer never throws out of the materializer's failure path", async () => {
    const result = await resolveBoundArtifactTarget({
      orgId: "org_1",
      extension: EXT,
      deps: {
        readEffectiveArtifactSafeTypeIds: () => [],
        readExtensionPackDeclaredObjectTypeIds: async () => [TYPE],
        explainAbsentClaims: async () => {
          throw new Error("db down");
        },
        readExtensionPackAcceptedMimeTypes: async () => ["text/markdown"],
        resolveRegisteredType: () => null,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("install state could not be read");
    expect(result.ok === false && result.error).not.toContain(MANIFEST_BLAME);
  });
});
