/**
 * Split-disposition unit tests.
 *
 * Guardrail: `downloadDispositionFor` and `previewDispositionFor` are
 * intentionally separate so neither can be subverted into the other's
 * behaviour by a future MIME-allowlist edit. These tests pair the two
 * helpers on every MIME class the preview route handles, plus the
 * negative cases (HTML, non-allowlisted video/audio containers,
 * application/octet-stream) that preview must fall back to `attachment`.
 *
 * The two helpers do NOT share a code path; if a future refactor tries
 * to consolidate them, this test pair MUST be updated to keep covering
 * each helper independently.
 */
import { describe, expect, it } from "vitest";

import {
  downloadDispositionFor,
  previewDispositionFor,
  PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS,
} from "@/lib/artifacts/artifact-read";

describe("downloadDispositionFor — always attachment", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["text/markdown", "draft.md"],
    ["text/plain", "log.txt"],
    ["application/pdf", "spec.pdf"],
    ["image/png", "diagram.png"],
    ["image/jpeg", "photo.jpg"],
    ["image/svg+xml", "icon.svg"],
    ["text/html", "page.html"],
    ["video/mp4", "demo.mp4"],
    ["audio/mpeg", "clip.mp3"],
    ["application/octet-stream", "blob.bin"],
    ["application/zip", "bundle.zip"],
  ];
  it.each(cases)("returns attachment for %s", (mime, filename) => {
    const out = downloadDispositionFor(mime, filename);
    expect(out).toMatch(/^attachment;/);
    expect(out).toContain(`filename="${filename}"`);
  });

  it("sanitises filename with disallowed characters", () => {
    const out = downloadDispositionFor("text/plain", "a/b\\c..foo bar.txt");
    expect(out).toMatch(/^attachment; filename="[\w.\- ]+"$/);
  });

  it("falls back to 'artifact' when filename sanitises empty", () => {
    // Empty input goes through `replace` unchanged → `slice` returns empty
    // → fallback `|| "artifact"` kicks in. Distinguish from "***" which
    // collapses to a non-empty `_` (regex run match).
    const out = downloadDispositionFor("text/plain", "");
    expect(out).toContain('filename="artifact"');
  });
});

describe("previewDispositionFor — inline only for allowlisted MIMEs", () => {
  const inlineCases: ReadonlyArray<readonly [string, string]> = [
    ["text/markdown", "draft.md"],
    ["text/x-markdown", "doc.md"],
    ["text/plain", "log.txt"],
    ["application/pdf", "spec.pdf"],
    ["image/png", "diagram.png"],
    ["image/jpeg", "photo.jpg"],
    ["image/gif", "anim.gif"],
    ["image/webp", "shot.webp"],
    ["image/svg+xml", "icon.svg"],
    ["video/mp4", "demo.mp4"],
    ["video/webm", "clip.webm"],
    ["video/ogg", "reel.ogv"],
    ["audio/mpeg", "clip.mp3"],
    ["audio/mp4", "voice.m4a"],
    ["audio/x-m4a", "memo.m4a"],
    ["audio/ogg", "pod.ogg"],
    ["audio/wav", "take.wav"],
    ["audio/x-wav", "take2.wav"],
    ["audio/webm", "note.weba"],
    ["audio/flac", "master.flac"],
    ["audio/aac", "stream.aac"],
  ];
  it.each(inlineCases)("returns inline for %s", (mime, filename) => {
    const out = previewDispositionFor(mime, filename);
    expect(out).toMatch(/^inline;/);
    expect(out).toContain(`filename="${filename}"`);
  });

  const attachmentCases: ReadonlyArray<readonly [string, string]> = [
    ["text/html", "page.html"],
    // Media containers deliberately OUTSIDE the allowlist (codec support
    // too inconsistent for an inline player) must stay `attachment`.
    ["video/quicktime", "capture.mov"],
    ["video/x-msvideo", "legacy.avi"],
    ["video/x-matroska", "rip.mkv"],
    ["audio/midi", "tune.mid"],
    ["application/octet-stream", "blob.bin"],
    ["application/zip", "bundle.zip"],
    ["application/vnd.google-apps.document", "gdoc.ref"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word.docx"],
  ];
  it.each(attachmentCases)("falls back to attachment for non-allowlisted %s", (mime, filename) => {
    const out = previewDispositionFor(mime, filename);
    expect(out).toMatch(/^attachment;/);
  });

  it("falls back to attachment for empty MIME", () => {
    expect(previewDispositionFor("", "x.bin")).toMatch(/^attachment;/);
  });
});

describe("guardrail — helpers do not share a code path", () => {
  it("downloadDispositionFor returns attachment even for the inline allowlist", () => {
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      expect(downloadDispositionFor(mime, "x.bin")).toMatch(/^attachment;/);
    }
  });

  it("previewDispositionFor inline set matches the published allowlist exactly", () => {
    const expected = new Set([
      "text/markdown",
      "text/x-markdown",
      "text/plain",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "video/mp4",
      "video/webm",
      "video/ogg",
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/ogg",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
      "audio/flac",
      "audio/aac",
    ]);
    // Drift detector — if the production set diverges, this test fails
    // and the helper docstring + the preview route's 415 list must be
    // updated to match.
    expect(new Set(PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS)).toEqual(expected);
  });
});
