/**
 * cinatra#4223 — a file row's own fields reach its display as the live object
 * projection.
 *
 * A screenshot is a file-form artifact whose mime the file channel projects no
 * class for, so the channel answers `unsupported-form`. The row itself carries
 * the three facts its type declares beyond the host envelope — where it was
 * taken, at what viewport, when. `resolveFileObjectContentProjection` turns
 * them into the artifact page's live `kind: "object"`, and
 * `resolvePinnedFileObjectContentProjection` turns ONE revision's recorded
 * facts into the review card's snapshot. Only a page capture's three facts are
 * projected: every other unsupported file row keeps the file channel's answer.
 *
 * PURE: no mocks, no ports.
 *
 *   npx vitest run src/lib/artifacts/__tests__/file-object-content-projection-4223.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  resolveFileObjectContentProjection,
  resolvePinnedFileObjectContentProjection,
} from "@/lib/artifacts/artifact-content-channel";
import {
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  artifactContentCapFor,
  type ArtifactContentProjection,
} from "@cinatra-ai/sdk-extensions/artifact-content-channel";

const SCREENSHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const REVISION = "rep-4223";

const UNSUPPORTED: ArtifactContentProjection = {
  kind: "none",
  channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
  representationRevisionId: REVISION,
  reason: "unsupported-form",
};

/** Every key the host writes into an artifact row (`ArtifactObjectData`). */
const ENVELOPE = {
  artifactType: SCREENSHOT_TYPE,
  latestRepresentationRevisionId: REVISION,
  latestDigest: "sha256:abc",
  mime: "image/png",
  size: 67,
  originKind: "generated",
  viewerHint: "image",
  title: "The about page",
  excerpt: "",
  connectorRef: { url: "https://docs.example.com/d/1" },
};

const FACTS = {
  capturedUrl: "http://localhost:4223/about/",
  viewport: { width: 1280, height: 900 },
  capturedAt: "2026-10-17T16:30:00.000Z",
};

describe("cinatra#4223 resolveFileObjectContentProjection", () => {
  it("(a) projects the row's own fields as live object content when the file channel has no class", () => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE, ...FACTS },
      fileProjection: UNSUPPORTED,
    });
    expect(out.kind).toBe("object");
    if (out.kind !== "object") return;
    expect(out.objectType).toBe(SCREENSHOT_TYPE);
    expect(out.data).toEqual(FACTS);
    expect(Object.keys(out.data as Record<string, unknown>).sort()).toEqual([
      "capturedAt",
      "capturedUrl",
      "viewport",
    ]);
    expect(out.source).toBe("live");
    expect(out.representationRevisionId).toBeNull();
  });

  it("(b) passes the absence through unchanged when the row carries only envelope keys", () => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE },
      fileProjection: UNSUPPORTED,
    });
    expect(out).toBe(UNSUPPORTED);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "capturedUrl"],
    ["a number", 42],
    ["an array", [FACTS]],
  ])("(c) passes the absence through when the object data is %s", (_label, objectData) => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData,
      fileProjection: UNSUPPORTED,
    });
    expect(out).toBe(UNSUPPORTED);
  });

  it.each<[string, ArtifactContentProjection]>([
    [
      "a text projection",
      {
        kind: "text",
        channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
        representationRevisionId: REVISION,
        text: "# notes",
        encoding: "utf-8",
        byteLength: 7,
        projectedByteLength: 7,
        cap: artifactContentCapFor("text"),
        truncated: false,
      },
    ],
    [
      "an absent projection",
      {
        kind: "none",
        channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
        representationRevisionId: null,
        reason: "absent",
      },
    ],
    [
      "an over-cap projection",
      {
        kind: "none",
        channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
        representationRevisionId: REVISION,
        reason: "over-cap",
      },
    ],
  ])("(d) passes %s through by identity, even with own keys present", (_label, fileProjection) => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE, ...FACTS },
      fileProjection,
    });
    expect(out).toBe(fileProjection);
  });

  it("(e) own fields over the object cap give the named over-cap absence", () => {
    const cap = artifactContentCapFor("object");
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE, ...FACTS, capturedUrl: `https://a.example/${"x".repeat(cap)}` },
      fileProjection: UNSUPPORTED,
    });
    expect(out).toMatchObject({ kind: "none", reason: "over-cap" });
  });

  it("(f) any other unsupported file row keeps the file channel's answer, whatever own fields it carries", () => {
    // A generated picture whose type declares fields of its own: it is not a
    // page capture, and its display receives exactly what it received before.
    const out = resolveFileObjectContentProjection({
      objectType: "@cinatra-ai/featured-image-artifact:featured-image",
      objectData: { ...ENVELOPE, post: "art-9", placement: "featured" },
      fileProjection: UNSUPPORTED,
    });
    expect(out).toBe(UNSUPPORTED);
  });

  it.each([
    ["capturedUrl is not a string", { ...FACTS, capturedUrl: 42 }],
    ["viewport is missing", { capturedUrl: FACTS.capturedUrl, capturedAt: FACTS.capturedAt }],
    ["viewport has no height", { ...FACTS, viewport: { width: 1280 } }],
    ["capturedAt is missing", { capturedUrl: FACTS.capturedUrl, viewport: FACTS.viewport }],
  ])("(g) a row whose facts are not a page capture's (%s) keeps the file channel's answer", (_l, facts) => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE, ...facts },
      fileProjection: UNSUPPORTED,
    });
    expect(out).toBe(UNSUPPORTED);
  });

  it("(h) carries exactly the three facts, never another own field beside them", () => {
    const out = resolveFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      objectData: { ...ENVELOPE, ...FACTS, notes: "beside" },
      fileProjection: UNSUPPORTED,
    });
    expect(out.kind).toBe("object");
    if (out.kind !== "object") return;
    expect(out.data).toEqual(FACTS);
  });
});

describe("cinatra#4223 resolvePinnedFileObjectContentProjection", () => {
  it("(p1) projects the pinned revision's own recorded facts as a snapshot naming that revision", () => {
    const out = resolvePinnedFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      representationRevisionId: REVISION,
      revisionFacts: FACTS,
      fileProjection: UNSUPPORTED,
    });
    expect(out.kind).toBe("object");
    if (out.kind !== "object") return;
    expect(out.data).toEqual(FACTS);
    expect(out.source).toBe("snapshot");
    expect(out.representationRevisionId).toBe(REVISION);
  });

  it.each([
    ["no record", null],
    ["a record that is not a capture's", { post: "art-9" }],
  ])("(p2) %s keeps the file channel's answer", (_l, revisionFacts) => {
    const out = resolvePinnedFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      representationRevisionId: REVISION,
      revisionFacts,
      fileProjection: UNSUPPORTED,
    });
    expect(out).toBe(UNSUPPORTED);
  });

  it("(p3) a projection other than unsupported-form passes through by identity", () => {
    const overCap: ArtifactContentProjection = {
      kind: "none",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: REVISION,
      reason: "over-cap",
    };
    const out = resolvePinnedFileObjectContentProjection({
      objectType: SCREENSHOT_TYPE,
      representationRevisionId: REVISION,
      revisionFacts: FACTS,
      fileProjection: overCap,
    });
    expect(out).toBe(overCap);
  });
});
