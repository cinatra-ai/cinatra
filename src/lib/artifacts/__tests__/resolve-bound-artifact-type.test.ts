/**
 * Bound-artifact-type resolution seam (cinatra#1454) — the email-artifacts →
 * email:body proof + the org-chain winner-arbitration eligibility source.
 *
 *   npx vitest run src/lib/artifacts/__tests__/resolve-bound-artifact-type.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { readClaimsMock, resolveRegisteredMock } = vi.hoisted(() => ({
  readClaimsMock: vi.fn(),
  resolveRegisteredMock: vi.fn(),
}));

// The org-chain DB claim registry (winner arbitration reads these rows).
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: readClaimsMock,
}));
// The static registry — email:body is a HOST-registered type (register-types.ts);
// the intersection requires resolve() to be non-null.
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { resolve: resolveRegisteredMock },
}));

import {
  readEffectiveArtifactSafeTypeIdsForExtension,
  resolveBoundArtifactTarget,
} from "../resolve-bound-artifact-type";

const EMAIL_EXT = "@cinatra-ai/email-artifacts";

// The email-artifacts pack's real claim shape: three artifact-safe types + one
// projection:none (recipient). All host-registered under `@cinatra-ai/email:*`.
function emailClaims() {
  const base = {
    scope: "platform",
    claimKind: "dedicated" as const,
    status: "active" as const,
    extensionPackage: EMAIL_EXT,
    extensionVersion: "0.1.0",
    generation: 1,
    installId: "inst-1",
  };
  return [
    { ...base, id: "c1", objectTypeId: "@cinatra-ai/email:body", dispositions: { projection: "artifact-safe" } },
    { ...base, id: "c2", objectTypeId: "@cinatra-ai/email:sent-email", dispositions: { projection: "artifact-safe" } },
    { ...base, id: "c3", objectTypeId: "@cinatra-ai/email:received-reply", dispositions: { projection: "artifact-safe" } },
    { ...base, id: "c4", objectTypeId: "@cinatra-ai/email:recipient", dispositions: { projection: "none" } },
  ];
}

describe("readEffectiveArtifactSafeTypeIdsForExtension (org-chain winner ∩ registered)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readClaimsMock.mockReturnValue(emailClaims());
    // All `@cinatra-ai/email:*` types are host-registered.
    resolveRegisteredMock.mockImplementation((typeId: string) =>
      typeId.startsWith("@cinatra-ai/email:") ? { type: typeId } : null,
    );
  });

  it("returns exactly the ARTIFACT-SAFE declared types (recipient/projection:none excluded)", () => {
    const ids = readEffectiveArtifactSafeTypeIdsForExtension("org-a", EMAIL_EXT);
    expect(ids).toEqual([
      "@cinatra-ai/email:body",
      "@cinatra-ai/email:received-reply",
      "@cinatra-ai/email:sent-email",
    ]);
  });

  it("intersects with a REGISTERED host type — an unregistered claimed type is dropped", () => {
    resolveRegisteredMock.mockImplementation((typeId: string) =>
      typeId === "@cinatra-ai/email:body" ? { type: typeId } : null,
    );
    expect(readEffectiveArtifactSafeTypeIdsForExtension("org-a", EMAIL_EXT)).toEqual([
      "@cinatra-ai/email:body",
    ]);
  });

  it("returns [] for an extension with no winning claims", () => {
    expect(readEffectiveArtifactSafeTypeIdsForExtension("org-a", "@cinatra-ai/other")).toEqual([]);
  });
});

describe("resolveBoundArtifactTarget — @cinatra-ai/email-artifacts → email:body", () => {
  const injected = {
    readEffectiveArtifactSafeTypeIds: () => [
      "@cinatra-ai/email:body",
      "@cinatra-ai/email:sent-email",
      "@cinatra-ai/email:received-reply",
    ],
    readExtensionPackAcceptedMimeTypes: async () => ["text/markdown", "text/plain"],
    resolveRegisteredType: () => null, // host claim type → pack accepts sourced
  };

  it("resolves an explicit binding objectTypeId to email:body with the pack accepts", async () => {
    const res = await resolveBoundArtifactTarget({
      orgId: "org-a",
      extension: EMAIL_EXT,
      bindingObjectTypeId: "@cinatra-ai/email:body",
      deps: injected,
    });
    expect(res).toEqual({
      ok: true,
      target: { objectTypeId: "@cinatra-ai/email:body", acceptedFileMimeTypes: ["text/markdown", "text/plain"] },
    });
  });

  it("resolves from a TYPED produces entry when the binding is coarse", async () => {
    const res = await resolveBoundArtifactTarget({
      orgId: "org-a",
      extension: EMAIL_EXT,
      producesObjectTypeId: "@cinatra-ai/email:body",
      deps: injected,
    });
    expect(res.ok && res.target.objectTypeId).toBe("@cinatra-ai/email:body");
  });

  it("FAILS CLOSED on the ambiguous multi-type pack with no objectTypeId", async () => {
    const res = await resolveBoundArtifactTarget({
      orgId: "org-a",
      extension: EMAIL_EXT,
      deps: injected,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/must set an explicit objectTypeId to disambiguate/);
  });

  it("prefers a self-registered def's isArtifact.accepts over the pack manifest", async () => {
    const res = await resolveBoundArtifactTarget({
      orgId: "org-a",
      extension: "@cinatra-ai/blog-post-artifact",
      deps: {
        readEffectiveArtifactSafeTypeIds: () => ["@cinatra-ai/blog-post-artifact:post"],
        readExtensionPackAcceptedMimeTypes: async () => {
          throw new Error("should not read the pack manifest for a self-registered def");
        },
        resolveRegisteredType: () => ({ isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } } }),
      },
    });
    expect(res).toEqual({
      ok: true,
      target: { objectTypeId: "@cinatra-ai/blog-post-artifact:post", acceptedFileMimeTypes: ["text/markdown"] },
    });
  });

  it("FAILS CLOSED when neither a self-registered def nor the pack manifest yields accepts", async () => {
    const res = await resolveBoundArtifactTarget({
      orgId: "org-a",
      extension: EMAIL_EXT,
      bindingObjectTypeId: "@cinatra-ai/email:body",
      deps: {
        readEffectiveArtifactSafeTypeIds: () => ["@cinatra-ai/email:body"],
        readExtensionPackAcceptedMimeTypes: async () => null,
        resolveRegisteredType: () => null,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no resolvable representation accepts/);
  });
});
