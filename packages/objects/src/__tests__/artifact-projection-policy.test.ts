import { describe, expect, it, vi } from "vitest";

// graphiti-projector is `import "server-only"` — neutralise for node test.
vi.mock("server-only", () => ({}));

import { projectArtifactSafe } from "../graphiti-projector";

// The projector must NEVER leak artifact bytes/body/storage keys into
// Graphiti episode bodies.

describe("projectArtifactSafe projection policy", () => {
  it("returns null for non-artifact data (legacy raw projection kept)", () => {
    expect(projectArtifactSafe({ name: "Acme", website: "acme.com" })).toBeNull();
    expect(projectArtifactSafe({ artifactType: "file" })).toBeNull(); // no latestRepresentationRevisionId
  });

  it("projects ONLY whitelisted metadata; strips bytes/body/storage keys", () => {
    const out = projectArtifactSafe({
      artifactType: "file",
      latestRepresentationRevisionId: "ver_123",
      latestDigest: "sha256:abc",
      mime: "application/pdf",
      size: 4096,
      originKind: "upload",
      viewerHint: "mime",
      title: "Q3 report",
      excerpt: "x".repeat(5000),
      // forbidden — must NOT appear in the projection:
      storageKey: "orgs/o/artifacts/a/versions/v/blob.bin",
      imageBase64: "data:image/png;base64,AAAA....",
      bodyText: "the full editable markdown body".repeat(100),
      data: { bytes: "secret" },
    });
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    expect(json).not.toContain("storageKey");
    expect(json).not.toContain("imageBase64");
    expect(json).not.toContain("bodyText");
    expect(json).not.toContain("secret");
    expect(out).toMatchObject({
      artifactType: "file",
      latestRepresentationRevisionId: "ver_123",
      latestDigest: "sha256:abc",
      mime: "application/pdf",
      size: 4096,
      originKind: "upload",
      viewerHint: "mime",
      title: "Q3 report",
    });
    expect((out!.excerpt as string).length).toBe(2000); // hard-capped
  });

  it("surfaces artifact semantic identity (primaryExtension + eligibleExtensions)", () => {
    // The default-artifact floor is eligible IFF no non-default eligible
    // exists. So a multi-extension eligibles fixture must use only
    // NON-default extensions; the floor would be archived by the rebalance
    // the moment a non-default eligible lands.
    const out = projectArtifactSafe(
      {
        artifactType: "file",
        latestRepresentationRevisionId: "ver_123",
        latestDigest: "sha256:abc",
        mime: "image/png",
        size: 1024,
        originKind: "upload",
        viewerHint: "mime",
        title: "screenshot",
      },
      {
        eligibleExtensions: [
          "@cinatra-ai/screenshot-artifact",
          "@cinatra-ai/dashboard-artifact",
        ],
        primaryExtension: "@cinatra-ai/dashboard-artifact",
      },
    );
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      primaryExtension: "@cinatra-ai/dashboard-artifact",
      eligibleExtensions: [
        "@cinatra-ai/screenshot-artifact",
        "@cinatra-ai/dashboard-artifact",
      ],
    });
  });

  it("defaults to floor primary + empty eligibles when caller does not pass identity", () => {
    const out = projectArtifactSafe({
      artifactType: "file",
      latestRepresentationRevisionId: "ver_xyz",
      latestDigest: "sha256:def",
      mime: "image/png",
      size: 4,
      originKind: "upload",
      viewerHint: "mime",
    });
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      primaryExtension: "@cinatra-ai/default-artifact",
      eligibleExtensions: [],
    });
  });
});
