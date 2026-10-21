/**
 * cinatra#4223 — a file row's own fields reach its display as the live object
 * projection.
 *
 * A screenshot is a file-form artifact whose mime the file channel projects no
 * class for, so the channel answers `unsupported-form`. The row itself carries
 * the three facts its type declares beyond the host envelope — where it was
 * taken, at what viewport, when — and `resolveFileObjectContentProjection` is
 * the one place both display builders (the artifact page and the review card)
 * turn those into `kind: "object"`. The helper names no type; this suite does,
 * because the screenshot is the case the issue is about.
 *
 * PURE: no mocks, no ports.
 *
 *   npx vitest run src/lib/artifacts/__tests__/file-object-content-projection-4223.test.ts
 */
import { describe, expect, it } from "vitest";

import { resolveFileObjectContentProjection } from "@/lib/artifacts/artifact-content-channel";
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
      objectData: { ...ENVELOPE, ...FACTS, notes: "x".repeat(cap + 1) },
      fileProjection: UNSUPPORTED,
    });
    expect(out).toMatchObject({ kind: "none", reason: "over-cap" });
  });
});
