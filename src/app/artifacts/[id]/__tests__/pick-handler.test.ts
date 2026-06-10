/**
 * Handler-selection parity tests for the `/artifacts/[id]` detail page.
 *
 * Guardrail: every MIME in the preview route's inline allowlist MUST map
 * to a concrete (non-fallback) handler — otherwise the page would show a
 * metadata card for a MIME the preview route happily serves inline (or,
 * inverted, mount a player against a 415). Non-allowlisted MIMEs must
 * fall back regardless of their top-level type.
 */
import { describe, expect, it } from "vitest";

import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";
import { pickHandler } from "../pick-handler";

describe("pickHandler", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["text/markdown", "markdown"],
    ["text/x-markdown", "markdown"],
    ["text/plain", "text"],
    ["application/pdf", "pdf"],
    ["image/png", "image"],
    ["image/svg+xml", "image"],
    ["video/mp4", "video"],
    ["video/webm", "video"],
    ["video/ogg", "video"],
    ["audio/mpeg", "audio"],
    ["audio/mp4", "audio"],
    ["audio/x-m4a", "audio"],
    ["audio/ogg", "audio"],
    ["audio/wav", "audio"],
    ["audio/x-wav", "audio"],
    ["audio/webm", "audio"],
    ["audio/flac", "audio"],
    ["audio/aac", "audio"],
  ];
  it.each(cases)("%s -> %s", (mime, expected) => {
    expect(pickHandler(mime)).toBe(expected);
  });

  const fallbackCases: ReadonlyArray<string> = [
    "", // missing MIME
    "text/html", // scripts even under sandbox — metadata card only
    "image/bmp",
    "image/tiff",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "audio/midi",
    "application/octet-stream",
    "application/zip",
    "application/vnd.google-apps.document",
  ];
  it.each(fallbackCases)("non-allowlisted %s -> fallback", (mime) => {
    expect(pickHandler(mime)).toBe("fallback");
  });

  it("parity: every allowlisted MIME maps to a concrete handler (never fallback)", () => {
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      expect(pickHandler(mime), `expected a concrete handler for ${mime}`).not.toBe(
        "fallback",
      );
    }
  });
});
