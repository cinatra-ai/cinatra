import { describe, expect, it } from "vitest";
import {
  mimeAcceptedByAccepts,
  resolveUploadArtifactTypeFromCandidates,
  type UploadArtifactTypeCandidate,
} from "../upload-artifact-type-map";

// The four REQUIRED system-base packs' registered types + accepts, as the
// registry-reading wrapper would surface them (epic #1785, wave A3).
const BASE_CANDIDATES: UploadArtifactTypeCandidate[] = [
  { objectTypeId: "@cinatra-ai/pdf-artifact:document", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/audio-artifact:recording", acceptMimes: ["audio/*"] },
  { objectTypeId: "@cinatra-ai/video-artifact:video", acceptMimes: ["video/mp4", "video/webm", "video/ogg"] },
  { objectTypeId: "@cinatra-ai/image-artifact:image", acceptMimes: ["image/*"] },
];

describe("mimeAcceptedByAccepts", () => {
  it("matches an exact declared MIME", () => {
    expect(mimeAcceptedByAccepts(["application/pdf"], "application/pdf")).toBe(true);
    expect(mimeAcceptedByAccepts(["application/pdf"], "image/png")).toBe(false);
  });

  it("matches a `type/*` wildcard against any subtype", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "image/png")).toBe(true);
    expect(mimeAcceptedByAccepts(["image/*"], "image/svg+xml")).toBe(true);
    expect(mimeAcceptedByAccepts(["image/*"], "audio/mpeg")).toBe(false);
  });

  it("strips MIME parameters and is case-insensitive", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "IMAGE/PNG; charset=binary")).toBe(true);
    expect(mimeAcceptedByAccepts(["application/pdf"], "Application/PDF")).toBe(true);
  });

  it("rejects an empty / whitespace MIME", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "")).toBe(false);
    expect(mimeAcceptedByAccepts(["image/*"], "   ")).toBe(false);
    expect(mimeAcceptedByAccepts(["image/*"], undefined)).toBe(false);
  });
});

describe("resolveUploadArtifactTypeFromCandidates", () => {
  it("resolves an exact-MIME upload to the one base pack", () => {
    const r = resolveUploadArtifactTypeFromCandidates("application/pdf", BASE_CANDIDATES);
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/pdf-artifact:document" });
  });

  it("resolves a wildcard-accepted upload (image/png → image pack)", () => {
    const r = resolveUploadArtifactTypeFromCandidates("image/png", BASE_CANDIDATES);
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/image-artifact:image" });
  });

  it("resolves an enumerated video MIME, refuses a non-enumerated one", () => {
    expect(resolveUploadArtifactTypeFromCandidates("video/mp4", BASE_CANDIDATES)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/video-artifact:video",
    });
    const miss = resolveUploadArtifactTypeFromCandidates("video/quicktime", BASE_CANDIDATES);
    expect(miss.ok).toBe(false);
  });

  it("REFUSES a MIME no base pack accepts (fail closed — e.g. URL-import markdown)", () => {
    const r = resolveUploadArtifactTypeFromCandidates("text/markdown", BASE_CANDIDATES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.matched).toEqual([]);
      expect(r.reason).toMatch(/no installed system-base artifact pack/);
    }
  });

  it("REFUSES an empty / missing MIME (fail closed)", () => {
    expect(resolveUploadArtifactTypeFromCandidates(undefined, BASE_CANDIDATES).ok).toBe(false);
    expect(resolveUploadArtifactTypeFromCandidates("", BASE_CANDIDATES).ok).toBe(false);
  });

  it("REFUSES an ambiguous MIME accepted by more than one base type", () => {
    const ambiguous: UploadArtifactTypeCandidate[] = [
      { objectTypeId: "@cinatra-ai/image-artifact:image", acceptMimes: ["image/*"] },
      // A (hypothetical) second registered type also accepting image/png.
      { objectTypeId: "@cinatra-ai/screenshot-artifact:screenshot", acceptMimes: ["image/png"] },
    ];
    const r = resolveUploadArtifactTypeFromCandidates("image/png", ambiguous);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.matched.sort()).toEqual([
        "@cinatra-ai/image-artifact:image",
        "@cinatra-ai/screenshot-artifact:screenshot",
      ]);
      expect(r.reason).toMatch(/ambiguously accepted/);
    }
  });

  it("de-dupes a single type that lists a MIME twice (not an ambiguity)", () => {
    const dup: UploadArtifactTypeCandidate[] = [
      { objectTypeId: "@cinatra-ai/pdf-artifact:document", acceptMimes: ["application/pdf", "application/pdf"] },
    ];
    expect(resolveUploadArtifactTypeFromCandidates("application/pdf", dup)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/pdf-artifact:document",
    });
  });
});
