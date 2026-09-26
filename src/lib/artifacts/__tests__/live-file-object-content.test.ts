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
  it("preserves the file's existing text content", async () => {
    const content = await buildArtifactContentProjection({
      orgId: "org", artifactId: "artifact", representationRevisionId: "revision", form: "file", mime: "text/plain",
    }, { readPinnedSubstance: async () => ({ class: "text", text: "Keep this content" }) });
    expect(content.kind).toBe("text");
    expect(withLiveFileObjectContent({ ...input, content })).toBe(content);
  });
});
