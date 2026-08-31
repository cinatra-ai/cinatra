import { describe, expect, it } from "vitest";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// THE PROPS VERSION AND THE REFERENCE IT CARRIES.
//
// §6.1, wave 3 row: "the props version (0.4) on every display; the byte
// capability and its serving route (0.6) for the six media displays and the CMS
// picture pair; the three browser fetchers — json, cms-snapshot, text — onto the
// content channel (0.3)".
//
// The host half of that sentence is a new props version whose snapshot carries
// the island-scoped byte REFERENCE, and a boundary assertion that a byte of the
// work can never be carried in its place.

import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
  assertNoInlineBytesInRendererProps,
  assertSerializableRendererProps,
  absentArtifactContent,
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import { ARTIFACT_RENDERER_PROPS_API_VERSION as LEAF_VERSION } from "@cinatra-ai/sdk-extensions/artifact-renderer-props";
import {
  HOST_MIN_SUPPORTED_PROPS_API_VERSION,
  HOST_PROPS_API_VERSION,
  hostSupportedPropsApiVersions,
  negotiatePropsApiVersion,
} from "@/lib/artifacts/props-version-negotiation";
import { resolveArtifactContentClass } from "@/lib/artifacts/artifact-content-channel";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const ARTIFACT = {
  artifactId: "art_1",
  title: "Checkout — step 2",
  objectType: "@cinatra-ai/screenshot-artifact:artifact",
  mime: "image/png",
  size: 4096,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/screenshot-artifact" },
} as unknown as ArtifactSummary;

const BASE = {
  artifact: ARTIFACT,
  representation: { revisionId: "rev_1", mime: "image/png" },
  previewHref: "/api/artifacts/art_1/versions/rev_1/preview",
  downloadHref: "/api/artifacts/art_1/versions/rev_1/content",
  content: absentArtifactContent("rev_1", "unsupported-form"),
};

describe("wave 3 — the new props version", () => {
  it("is the byte-reference version, and the SDK leaf carries the same integer", () => {
    expect(ARTIFACT_RENDERER_PROPS_API_VERSION).toBe(
      ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    );
    expect(ARTIFACT_RENDERER_PROPS_API_VERSION).toBeGreaterThan(1);
    expect(LEAF_VERSION).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
  });

  it("widens the host window instead of flag-daying the fleet — v1 is still admitted at v1", () => {
    expect(HOST_PROPS_API_VERSION).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
    expect(HOST_MIN_SUPPORTED_PROPS_API_VERSION).toBe(1);
    expect(hostSupportedPropsApiVersions()).toEqual([
      1,
      ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    ]);
    expect(negotiatePropsApiVersion(1)).toEqual({ ok: true, version: 1 });
    expect(negotiatePropsApiVersion(ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION)).toEqual({
      ok: true,
      version: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    });
    expect(
      negotiatePropsApiVersion(ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION + 1),
    ).toEqual({ ok: false, reason: "too-new" });
  });
});

describe("wave 3 — the snapshot carries the byte REFERENCE at the new version only", () => {
  it("emits the island reference for a display that negotiated the new version", () => {
    const props = buildArtifactRendererProps({
      ...BASE,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
      bytes: {
        road: "island",
        preview: "/api/lifecycle-views/artifact-bytes?bc=sealed-preview",
        download: "/api/lifecycle-views/artifact-bytes?bc=sealed-download",
      },
    });
    expect(props.bytes).toEqual({
      road: "island",
      preview: "/api/lifecycle-views/artifact-bytes?bc=sealed-preview",
      download: "/api/lifecycle-views/artifact-bytes?bc=sealed-download",
    });
    // The session addresses stay where they were: the new field is an ADDITION,
    // never a replacement, so nothing that reads `urls` today changes meaning.
    expect(props.urls.preview).toBe(BASE.previewHref);
  });

  it("emits NO byte field at all for a display still on v1", () => {
    const props = buildArtifactRendererProps({
      ...BASE,
      propsApiVersion: 1,
      bytes: {
        road: "island",
        preview: "/api/lifecycle-views/artifact-bytes?bc=sealed-preview",
        download: null,
      },
    });
    expect(Object.prototype.hasOwnProperty.call(props, "bytes")).toBe(false);
    expect(props.propsApiVersion).toBe(1);
  });

  it("says which road it is on when the caller is a cookie surface", () => {
    const props = buildArtifactRendererProps({
      ...BASE,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    });
    expect(props.bytes).toEqual({
      road: "session",
      preview: BASE.previewHref,
      download: BASE.downloadHref,
    });
  });
});

describe("wave 3 — nothing passes a byte through the snapshot", () => {
  const props = buildArtifactRendererProps({
    ...BASE,
    propsApiVersion: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
  });

  it("passes a reference-only snapshot", () => {
    expect(() => assertNoInlineBytesInRendererProps(props)).not.toThrow();
  });

  it("refuses a binary payload smuggled onto any field", () => {
    for (const payload of [
      Buffer.from("PNG-bytes"),
      new Uint8Array([1, 2, 3]),
      new ArrayBuffer(8),
    ]) {
      const smuggled = { ...props, artifact: { ...props.artifact, blob: payload } };
      expect(() =>
        assertNoInlineBytesInRendererProps(smuggled as never),
      ).toThrow(/inline bytes/i);
    }
  });

  it("refuses a non-text data: URI in place of an address", () => {
    const smuggled = {
      ...props,
      urls: { preview: "data:image/png;base64,iVBORw0KGgo=", download: null },
    };
    expect(() => assertNoInlineBytesInRendererProps(smuggled as never)).toThrow(
      /inline bytes/i,
    );
  });

  it("runs at the serialization boundary, with the other boundary assertions", () => {
    const smuggled = {
      ...props,
      urls: { preview: "data:application/pdf;base64,JVBERi0=", download: null },
    };
    expect(() => assertSerializableRendererProps(smuggled as never)).toThrow(
      /inline bytes/i,
    );
  });
});

describe("wave 3 — the content channel refuses the six media forms by construction", () => {
  it("has no content class for a media form: its bytes are the byte road's", () => {
    for (const mime of [
      "image/png",
      "video/mp4",
      "audio/mpeg",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
    ]) {
      expect(resolveArtifactContentClass({ form: "file", mime }), mime).toBeNull();
    }
  });

  it("projects the three browser fetchers' forms as text, so no display fetches", () => {
    for (const mime of [
      "application/json",
      "application/vnd.cinatra.cms-fields+json",
      "text/csv",
    ]) {
      expect(resolveArtifactContentClass({ form: "file", mime }), mime).toBe("text");
    }
  });
});
