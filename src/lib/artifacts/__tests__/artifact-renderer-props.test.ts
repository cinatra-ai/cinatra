/**
 * The versioned, serializable renderer props contract (cinatra#1629, epic #1620
 * S2, AC-5): normalized snapshot, host-authorized URLs, sanctioned action
 * handles — and NOTHING non-serializable crosses the boundary.
 */
import { describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  buildArtifactRendererProps,
  assertSerializableRendererProps,
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

const identity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/contract-artifact",
  basis: "binding",
  selectable: true,
  assertionId: "sa_1",
};

const artifact: ArtifactSummary = {
  artifactId: "art_1",
  latestRepresentationRevisionId: "rev_1",
  objectType: "@cinatra-ai/contract-artifact:artifact",
  artifactType: "@cinatra-ai/contract-artifact:artifact",
  title: "Q3 contract",
  mime: "application/pdf",
  size: 1234,
  originKind: "upload",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T01:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  eligibleExtensions: ["@cinatra-ai/contract-artifact"],
  primaryExtension: "@cinatra-ai/contract-artifact",
  effectiveIdentity: identity,
  sourceUrl: "https://example.com/source",
};

describe("buildArtifactRendererProps", () => {
  it("normalizes the row + representation + hrefs into a versioned snapshot", () => {
    const props = buildArtifactRendererProps({
      artifact,
      representation: { revisionId: "rev_1", mime: "application/pdf" },
      previewHref: "/api/artifacts/art_1/versions/rev_1/preview",
      downloadHref: "/api/artifacts/art_1/versions/rev_1/content",
    });
    expect(props.propsApiVersion).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
    expect(props.artifact).toMatchObject({
      id: "art_1",
      title: "Q3 contract",
      objectType: "@cinatra-ai/contract-artifact:artifact",
      mime: "application/pdf",
      size: 1234,
      sourceUrl: "https://example.com/source",
    });
    expect(props.representation).toEqual({ revisionId: "rev_1", mime: "application/pdf" });
    expect(props.urls).toEqual({
      preview: "/api/artifacts/art_1/versions/rev_1/preview",
      download: "/api/artifacts/art_1/versions/rev_1/content",
    });
    expect(props.identity).toEqual({
      kind: "extension",
      extension: "@cinatra-ai/contract-artifact",
      basis: "binding",
      selectable: true,
    });
    expect(props.actions).toEqual({
      download: "/api/artifacts/art_1/versions/rev_1/content",
      openInSource: "https://example.com/source",
    });
  });

  it("flattens a non-extension identity to null extension/basis", () => {
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    const props = buildArtifactRendererProps({
      artifact: { ...artifact, effectiveIdentity: floor },
      representation: null,
      previewHref: null,
      downloadHref: null,
    });
    expect(props.identity).toEqual({ kind: "default-artifact", extension: null, basis: null, selectable: true });
    expect(props.representation).toBeNull();
  });

  it("produces a JSON-serializable snapshot (survives a round-trip)", () => {
    const props = buildArtifactRendererProps({
      artifact,
      representation: { revisionId: "rev_1", mime: "application/pdf" },
      previewHref: "/p",
      downloadHref: "/d",
    });
    expect(() => assertSerializableRendererProps(props)).not.toThrow();
    expect(JSON.parse(JSON.stringify(props))).toEqual(props);
  });
});

describe("assertSerializableRendererProps", () => {
  it("rejects a smuggled function (non-serializable host context)", () => {
    const bad = {
      propsApiVersion: 1,
      artifact: { id: "x", leak: () => "secret" },
    } as unknown as ArtifactRendererProps;
    expect(() => assertSerializableRendererProps(bad)).toThrow(/non-serializable function/);
  });
});
