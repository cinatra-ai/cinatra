// Pins the SINGLE-canonical artifact cinatra-key allowlist
// (`ARTIFACT_ALLOWED_CINATRA_KEYS`) — the source of truth the three host
// consumers import instead of re-listing (cinatra#979 addendum). Guards the
// cinatra#1570 widening: `vendor` is admitted (cross-kind presentation
// metadata for the installed-card byline) while the allowlist stays a narrow,
// closed set that continues to reject anything unknown.

import { describe, it, expect } from "vitest";
import { ARTIFACT_ALLOWED_CINATRA_KEYS } from "../artifact-contract";

describe("ARTIFACT_ALLOWED_CINATRA_KEYS", () => {
  it("admits the cross-kind vendor key (cinatra#1570 installed-card byline)", () => {
    expect(ARTIFACT_ALLOWED_CINATRA_KEYS.has("vendor")).toBe(true);
  });

  it("admits the chat renderable-view carrier key (cinatra#1626 — the artifact kind is the initial cinatra.views carrier)", () => {
    expect(ARTIFACT_ALLOWED_CINATRA_KEYS.has("views")).toBe(true);
  });

  it("admits the field-renderer binding carrier key (eng#548 ruling 133-1 / epic #1620 / #1625 — the artifact pack hosts the relocated email HITL field-renderer bindings)", () => {
    expect(ARTIFACT_ALLOWED_CINATRA_KEYS.has("fieldRenderers")).toBe(true);
  });

  it("admits exactly the expected closed set (narrowly additive)", () => {
    expect([...ARTIFACT_ALLOWED_CINATRA_KEYS].sort()).toEqual(
      [
        "apiVersion",
        "artifact",
        "dependencies",
        "displayName",
        "fieldRenderers",
        "kind",
        "roles",
        "vendor",
        "views",
      ].sort(),
    );
  });

  it("continues to reject unknown / drift keys", () => {
    for (const unknown of [
      "toolAccess",
      "oas",
      "serverEntry",
      "migrationsDir",
      "vendored", // near-miss of `vendor` — must NOT be admitted
      "vendors",
    ]) {
      expect(ARTIFACT_ALLOWED_CINATRA_KEYS.has(unknown)).toBe(false);
    }
  });
});
