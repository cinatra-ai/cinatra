import { describe, expect, it } from "vitest";
import { absentArtifactContent } from "../artifact-renderer-props";
import { ARTIFACT_CONTENT_CHANNEL_CAPS, buildArtifactContentProjection } from "../artifact-content-channel";
import { withLiveFileObjectContent } from "../live-file-object-content";

const facts = { capturedUrl: "http://localhost:8087/", viewport: { width: 1440, height: 1000 }, capturedAt: "2026-09-19T13:21:51.926Z" };
const input = {
  content: absentArtifactContent("file-revision", "unsupported-form"),
  form: "file" as const, objectType: "@test/screenshot:record", authorizedLiveData: facts,
};

describe("live file record beside a binary representation", () => {
  it("carries real facts as live object content without claiming they are a pinned snapshot", () => {
    expect(withLiveFileObjectContent(input)).toMatchObject({
      kind: "object", source: "live", representationRevisionId: null,
      objectType: input.objectType, data: facts,
    });
  });
  it("does not invent record data or replace an absent/over-cap content result", () => {
    expect(withLiveFileObjectContent({ ...input, authorizedLiveData: undefined })).toBe(input.content);
    for (const reason of ["absent", "over-cap"] as const) {
      const content = absentArtifactContent("file-revision", reason);
      expect(withLiveFileObjectContent({ ...input, content })).toBe(content);
    }
    const content = absentArtifactContent(null, "unsupported-form");
    expect(withLiveFileObjectContent({ ...input, content })).toBe(content);
  });
  it("leaves non-file forms alone and enforces the existing object content cap", () => {
    expect(withLiveFileObjectContent({ ...input, form: "connectorRef" })).toBe(input.content);
    expect(withLiveFileObjectContent({ ...input, authorizedLiveData: { oversized: "x".repeat(ARTIFACT_CONTENT_CHANNEL_CAPS.object + 1) } })).toMatchObject({ kind: "none", reason: "over-cap" });
  });
  it("gives a pdf or image row that carries only the core file envelope no live content", () => {
    for (const [objectType, mime] of [["@acme/pdf:document", "application/pdf"], ["@acme/image:picture", "image/png"]] as const) {
      const envelope = {
        artifactType: "file", latestRepresentationRevisionId: "revision", latestDigest: "f00d".repeat(16),
        mime, size: 2048, originKind: "upload", viewerHint: "mime", title: "Quarterly report",
      };
      expect(withLiveFileObjectContent({ ...input, objectType, authorizedLiveData: envelope })).toBe(input.content);
    }
  });
  it("carries a typed record beside the envelope, and refuses data that is no record", () => {
    const envelope = {
      artifactType: "file", latestRepresentationRevisionId: "revision", latestDigest: "f00d".repeat(16),
      mime: "image/png", size: 2048, originKind: "agent_generated", viewerHint: "mime", title: "WordPress screenshot",
    };
    expect(withLiveFileObjectContent({ ...input, authorizedLiveData: { ...envelope, ...facts } })).toMatchObject({
      kind: "object", source: "live", objectType: input.objectType, data: { ...envelope, ...facts },
    });
    for (const authorizedLiveData of [null, "capturedUrl", ["capturedUrl"], {}]) {
      expect(withLiveFileObjectContent({ ...input, authorizedLiveData })).toBe(input.content);
    }
  });
  it("counts a producer's own excerpt or connectorRef field as a typed record, as the file writer stamps neither", () => {
    const envelope = {
      artifactType: "file", latestRepresentationRevisionId: "revision", latestDigest: "f00d".repeat(16),
      mime: "application/pdf", size: 2048, originKind: "agent_generated", viewerHint: "mime", title: "Measured report",
    };
    for (const own of [{ excerpt: "measured summary" }, { connectorRef: { url: "https://example.com/doc" } }]) {
      expect(withLiveFileObjectContent({ ...input, authorizedLiveData: { ...envelope, ...own } })).toMatchObject({
        kind: "object", source: "live", data: { ...envelope, ...own },
      });
    }
  });
  it("refuses a non-plain object and an extra field that holds no value", () => {
    class Measured { capturedAt = facts.capturedAt; }
    const envelope = {
      artifactType: "file", latestRepresentationRevisionId: "revision", latestDigest: "f00d".repeat(16),
      mime: "image/png", size: 2048, originKind: "upload", viewerHint: "mime", title: "Holiday picture",
    };
    for (const authorizedLiveData of [
      new Measured(), new Date(), new Map([["capturedAt", facts.capturedAt]]),
      { capturedAt: undefined }, { ...envelope, capturedAt: undefined },
      Object.create({ capturedAt: facts.capturedAt }),
    ]) {
      expect(withLiveFileObjectContent({ ...input, authorizedLiveData })).toBe(input.content);
    }
    const nullPrototype = Object.assign(Object.create(null), facts);
    expect(withLiveFileObjectContent({ ...input, authorizedLiveData: nullPrototype })).toMatchObject({ kind: "object", source: "live" });
  });
  it("preserves the file's existing text content", async () => {
    const content = await buildArtifactContentProjection({
      orgId: "org", artifactId: "artifact", representationRevisionId: "revision", form: "file", mime: "text/plain",
    }, { readPinnedSubstance: async () => ({ class: "text", text: "Keep this content" }) });
    expect(content.kind).toBe("text");
    expect(withLiveFileObjectContent({ ...input, content })).toBe(content);
  });
});
