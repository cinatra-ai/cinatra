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
