/**
 * Split-disposition unit tests.
 *
 * Guardrail: `downloadDispositionFor` (always `attachment`) and
 * `previewDispositionFor` (inline ONLY when the caller resolved inline-transport
 * eligibility through the representation-provider capability — cinatra#1630 AC-2)
 * are intentionally separate helpers that do NOT share a code path, so a preview
 * refactor can never make the download route serve `inline`. `previewDispositionFor`
 * no longer re-derives a concrete-MIME allowlist — its disposition follows ONLY the
 * resolved eligibility boolean. A separate test pins the host safe-transport format
 * set (the registrar's system-base wildcard bound).
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

describe("previewDispositionFor — inline follows the resolved eligibility boolean", () => {
  it("returns inline for an eligible representation", () => {
    const out = previewDispositionFor(true, "photo.jpg");
    expect(out).toMatch(/^inline;/);
    expect(out).toContain('filename="photo.jpg"');
  });

  it("returns attachment for an ineligible representation", () => {
    const out = previewDispositionFor(false, "blob.bin");
    expect(out).toMatch(/^attachment;/);
    expect(out).toContain('filename="blob.bin"');
  });

  it("sanitises the filename", () => {
    const out = previewDispositionFor(true, "a/b\\c..foo bar.jpg");
    expect(out).toMatch(/^inline; filename="[\w.\- ]+"$/);
  });

  it("falls back to 'artifact' when the filename sanitises empty", () => {
    expect(previewDispositionFor(true, "")).toContain('filename="artifact"');
  });
});

describe("guardrail — helpers do not share a code path", () => {
  it("downloadDispositionFor returns attachment for every host safe-transport MIME", () => {
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      expect(downloadDispositionFor(mime, "x.bin")).toMatch(/^attachment;/);
    }
  });

  it("previewDispositionFor ignores the MIME entirely — disposition is ONLY the boolean", () => {
    // The helper no longer re-derives a concrete-MIME allowlist: an eligible
    // representation is inline and an ineligible one is attachment regardless of
    // MIME, so a future capability admission cannot leak into `downloadDispositionFor`.
    expect(previewDispositionFor(true, "x.bin")).toMatch(/^inline;/);
    expect(previewDispositionFor(false, "x.bin")).toMatch(/^attachment;/);
  });
});

describe("host safe-transport format set (the registrar's system-base wildcard bound)", () => {
  it("pins the exact concrete MIME set the system bases' wildcards expand to", () => {
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
    // Drift detector for the host safe-transport set: this bounds which concrete
    // formats the system bases' `image/*`/`audio/*`/`video/*` providers claim (so a
    // wildcard never claims e.g. `image/bmp`). It is NO LONGER the preview route's
    // eligibility gate (that resolves through the capability), but the bound itself
    // is still host safe-transport policy and is pinned here.
    expect(new Set(PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS)).toEqual(expected);
  });
});
