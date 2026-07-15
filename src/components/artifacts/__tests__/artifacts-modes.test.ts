/**
 * §I identity-gated mode resolution tests (cinatra#1431, spec design@4c6799db
 * §I/§IV). Pins the authorization boundary: a non-admin can only ever resolve
 * to Library; every admin-mode deep link by a non-admin resolves to `denied`
 * (the refusal panel), never silently to Library and never to admin data.
 */
import { describe, expect, it } from "vitest";

import {
  ADMIN_ARTIFACTS_MODES,
  isAdminArtifactsMode,
  isArtifactsMode,
  planArtifactsContent,
  resolveRequestedArtifactsMode,
} from "../artifacts-modes";

describe("resolveRequestedArtifactsMode — non-admin", () => {
  it("resolves a missing mode to Library (allowed)", () => {
    expect(resolveRequestedArtifactsMode(undefined, false)).toEqual({
      kind: "allowed",
      mode: "library",
    });
  });

  it("resolves an unknown mode to Library (allowed)", () => {
    expect(resolveRequestedArtifactsMode("bogus", false)).toEqual({
      kind: "allowed",
      mode: "library",
    });
  });

  it("allows an explicit Library request", () => {
    expect(resolveRequestedArtifactsMode("library", false)).toEqual({
      kind: "allowed",
      mode: "library",
    });
  });

  it.each(ADMIN_ARTIFACTS_MODES)(
    "DENIES a non-admin deep link into admin mode %s",
    (mode) => {
      expect(resolveRequestedArtifactsMode(mode, false)).toEqual({
        kind: "denied",
        mode,
      });
    },
  );
});

describe("resolveRequestedArtifactsMode — admin", () => {
  it("allows Library", () => {
    expect(resolveRequestedArtifactsMode("library", true)).toEqual({
      kind: "allowed",
      mode: "library",
    });
  });

  it.each(ADMIN_ARTIFACTS_MODES)("allows admin mode %s", (mode) => {
    expect(resolveRequestedArtifactsMode(mode, true)).toEqual({
      kind: "allowed",
      mode,
    });
  });
});

describe("mode predicates", () => {
  it("isArtifactsMode narrows only the known modes", () => {
    expect(isArtifactsMode("library")).toBe(true);
    expect(isArtifactsMode("raw")).toBe(true);
    expect(isArtifactsMode("types")).toBe(true);
    expect(isArtifactsMode("undo")).toBe(true);
    // Relocated merge-proposals admin mode (cinatra#1431; off-spec, tracked by
    // a spec-delta follow-up).
    expect(isArtifactsMode("merge")).toBe(true);
    expect(isArtifactsMode("data")).toBe(false);
    expect(isArtifactsMode(null)).toBe(false);
    expect(isArtifactsMode(42)).toBe(false);
  });

  it("Library is never an admin mode; raw/types/undo/merge always are", () => {
    expect(isAdminArtifactsMode("library")).toBe(false);
    expect(isAdminArtifactsMode("raw")).toBe(true);
    expect(isAdminArtifactsMode("types")).toBe(true);
    expect(isAdminArtifactsMode("undo")).toBe(true);
    expect(isAdminArtifactsMode("merge")).toBe(true);
  });
});

/**
 * §VI carve-out (design@94cfbcf5 §I/§VI, #1638): planArtifactsContent layers
 * the non-admin targeted-restore resolution over the pure admin-mode gate.
 * The base resolver is UNCHANGED (still denies non-admin admin-mode deep
 * links); this second pure step decides what the page actually renders.
 */
describe("planArtifactsContent — §VI non-admin undo carve-out", () => {
  const adminUndo = resolveRequestedArtifactsMode("undo", true); // allowed
  const nonAdminUndo = resolveRequestedArtifactsMode("undo", false); // denied
  const nonAdminRaw = resolveRequestedArtifactsMode("raw", false); // denied
  const nonAdminLibrary = resolveRequestedArtifactsMode("library", false); // allowed

  it("passes allowed modes straight through (admin undo → the browser)", () => {
    expect(
      planArtifactsContent({ resolved: adminUndo, openRestore: "cs_1", targetedRestoreEligible: false }),
    ).toEqual({ render: "undo" });
    expect(
      planArtifactsContent({ resolved: nonAdminLibrary, openRestore: undefined, targetedRestoreEligible: false }),
    ).toEqual({ render: "library" });
  });

  it("keeps the not-authorized panel for a non-admin deep link into a NON-undo admin mode", () => {
    expect(
      planArtifactsContent({ resolved: nonAdminRaw, openRestore: undefined, targetedRestoreEligible: false }),
    ).toEqual({ render: "denied", mode: "raw" });
  });

  it("a non-admin undo deep link with a valid + AUTHORIZED openRestore → the targeted restore", () => {
    expect(
      planArtifactsContent({ resolved: nonAdminUndo, openRestore: "cs_9", targetedRestoreEligible: true }),
    ).toEqual({ render: "targeted-restore" });
  });

  it("a non-admin undo deep link that is UNAUTHORIZED → plain Library (never the not-authorized panel)", () => {
    expect(
      planArtifactsContent({ resolved: nonAdminUndo, openRestore: "cs_9", targetedRestoreEligible: false }),
    ).toEqual({ render: "library" });
  });

  it.each([undefined, null, ""])(
    "a non-admin undo request with a MISSING / empty openRestore (%p) → plain Library, no panel",
    (openRestore) => {
      expect(
        planArtifactsContent({ resolved: nonAdminUndo, openRestore, targetedRestoreEligible: true }),
      ).toEqual({ render: "library" });
    },
  );
});
