/**
 * First-party FLOOR handler-selection tests for the `/artifacts/[id]` detail page.
 *
 * G2 CUTOVER (epic #1620 M1 Slice B, cinatra#1630): pdf / image / audio / video
 * MIGRATED to the system `-artifact` bases — they resolve to the extension
 * representation viewer, NOT a `pickHandler` host handler. What `pickHandler`
 * still selects is the core-owned never-blank floor: markdown (DEFER) + escaped
 * plain-text (STAY). The detail-surface coverage invariant therefore shifts to:
 * every allowlisted MIME is covered by EITHER the host floor OR a system base
 * representation provider — asserted below against the boot-registrar spec.
 */
import { describe, expect, it } from "vitest";

import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";
import { representationMatchSpecificity } from "@cinatra-ai/objects/artifact-renderer-registry";
import { systemRepresentationProviderSpecs } from "@/lib/artifacts/system-artifact-renderer-registrar";
import { pickHandler } from "../pick-handler";

describe("pickHandler — the core-owned never-blank floor", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["text/markdown", "markdown"],
    ["text/x-markdown", "markdown"],
    ["text/plain", "text"],
  ];
  it.each(cases)("%s -> %s", (mime, expected) => {
    expect(pickHandler(mime)).toBe(expected);
  });

  // The migrated media families no longer select a HOST handler — they resolve
  // to their system base extension viewer, so `pickHandler` returns `fallback`.
  const migratedToExtension: ReadonlyArray<string> = [
    "application/pdf",
    "image/png",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/flac",
  ];
  it.each(migratedToExtension)("migrated %s -> fallback (extension-owned, not a host handler)", (mime) => {
    expect(pickHandler(mime)).toBe("fallback");
  });

  const fallbackCases: ReadonlyArray<string> = [
    "", // missing MIME
    "text/html", // scripts even under sandbox — metadata card only
    "image/bmp",
    "video/quicktime",
    "audio/midi",
    "application/octet-stream",
    "application/zip",
    "application/vnd.google-apps.document",
  ];
  it.each(fallbackCases)("non-allowlisted %s -> fallback", (mime) => {
    expect(pickHandler(mime)).toBe("fallback");
  });
});

describe("detail-surface coverage invariant (post-cutover)", () => {
  // A system base covers a MIME iff one of its detail-slot representation specs
  // matches it (exact / type-wildcard / catch-all).
  const detailSpecs = systemRepresentationProviderSpecs().filter((s) => s.slot === "detail");
  const coveredByBase = (mime: string): boolean =>
    detailSpecs.some((s) => representationMatchSpecificity(s.pattern, mime) >= 0);

  it("every allowlisted MIME is covered by the host floor OR a system base (never blank)", () => {
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      const covered = pickHandler(mime) !== "fallback" || coveredByBase(mime);
      expect(covered, `no host floor and no system base covers ${mime}`).toBe(true);
    }
  });
});
