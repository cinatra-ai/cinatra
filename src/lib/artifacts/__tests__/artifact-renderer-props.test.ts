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
// The PUBLIC, author-facing copy the SDK re-exports for extension renderers
// (cinatra#1627 AC3). Host-neutral MIRROR of the type above — the two MUST stay
// structurally identical.
import type { ArtifactRendererProps as SdkArtifactRendererProps } from "@cinatra-ai/sdk-extensions/artifact-renderer-props";
import { ARTIFACT_RENDERER_PROPS_API_VERSION as SDK_ARTIFACT_RENDERER_PROPS_API_VERSION } from "@cinatra-ai/sdk-extensions/artifact-renderer-props";

// --- SDK re-export drift guard (cinatra#1627 AC3) --------------------------
// COMPILE-TIME parity, fail-closed. Mutual assignability alone is NOT enough:
// an OPTIONAL property added on either side ({ x } vs { x; future?: y }) passes
// both one-way checks with zero diagnostics. The Equals<> identity probe below
// closes that hole, so a field added/removed/retyped/made-optional anywhere in
// either the host type or the SDK mirror fails the host typecheck here — the
// public props type the scaffolder's `--with-ui` renderer stub imports can
// never silently diverge from what the host actually builds. (Unused TYPE
// aliases are not flagged by noUnusedLocals; they exist purely to force the
// check.)
type AssertTrue<T extends true> = T;
// NB: `? true : false` (never `: never`) — `never extends true` is true, so a
// `: never` false-branch would silently pass on drift; `: false` fails closed.
// The one-way checks stay for readable diagnostics on drift (each names the
// offending member); the Equals<> probe is the exhaustive backstop.
type _HostFitsSdk = AssertTrue<ArtifactRendererProps extends SdkArtifactRendererProps ? true : false>;
type _SdkFitsHost = AssertTrue<SdkArtifactRendererProps extends ArtifactRendererProps ? true : false>;
// EXACT type identity via the standard conditional-type variance probe: the two
// generic signatures are mutually assignable iff A and B are IDENTICAL types —
// strict enough to catch optional-property and readonly-modifier drift (at any
// nesting depth) that plain assignability erases.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _HostSdkExact = AssertTrue<Equals<ArtifactRendererProps, SdkArtifactRendererProps>>;

const identity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/contract-artifact",
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
  presentationIdentity: identity,
  presentationSuggestions: [],
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
    });
    expect(props.actions).toEqual({
      download: "/api/artifacts/art_1/versions/rev_1/content",
      openInSource: "https://example.com/source",
    });
  });

  it("flattens a non-extension identity to null extension/basis", () => {
    const floor: EffectiveIdentity = { kind: "no-primary" };
    const props = buildArtifactRendererProps({
      artifact: { ...artifact, effectiveIdentity: floor },
      representation: null,
      previewHref: null,
      downloadHref: null,
    });
    expect(props.identity).toEqual({ kind: "no-primary", extension: null });
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

describe("SDK re-export parity (cinatra#1627 AC3)", () => {
  it("keeps the public @cinatra-ai/sdk-extensions props ABI version in lockstep with the host", () => {
    expect(SDK_ARTIFACT_RENDERER_PROPS_API_VERSION).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
  });

  it("a host-built snapshot is assignable to the public SDK props type", () => {
    const props = buildArtifactRendererProps({
      artifact,
      representation: { revisionId: "rev_1", mime: "application/pdf" },
      previewHref: "/p",
      downloadHref: "/d",
    });
    // Compile-time: the value the host builds satisfies the type an extension
    // renderer imported from the SDK expects.
    const asSdk: SdkArtifactRendererProps = props;
    expect(asSdk.propsApiVersion).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
  });
});
