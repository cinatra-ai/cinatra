// cinatra#1907: the single entity-id policy — UUIDs for every new row (both
// the bootstrap call sites and the better-auth `advanced.database.generateId`
// override consume generateEntityId), while legacy 32-char better-auth ids
// remain valid for existing rows.

import { describe, it, expect } from "vitest";
import {
  ENTITY_UUID_RE,
  LEGACY_NANOID_RE,
  generateEntityId,
  isEntityIdLike,
} from "../id-policy";

describe("generateEntityId", () => {
  it("mints canonical UUIDs", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateEntityId()).toMatch(ENTITY_UUID_RE);
    }
  });
});

describe("isEntityIdLike", () => {
  it("accepts both live id shapes (real ids from cinatra#1907)", () => {
    expect(isEntityIdLike("faada9fe-8b14-4a4c-9cc5-4ccc757a2f7c")).toBe(true);
    expect(isEntityIdLike("9c0dfce6-b2cb-4dab-8a01-661ca3288b9a")).toBe(true);
    expect(isEntityIdLike("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs")).toBe(true);
    expect(isEntityIdLike("bgEWkNFcoODy5NtsIxvPaM1F0lww7GSR")).toBe(true);
  });

  it("rejects non-id strings", () => {
    expect(isEntityIdLike("settings")).toBe(false);
    expect(isEntityIdLike("")).toBe(false);
    expect(isEntityIdLike("Ul5HrhxiVFOBJmghOIUWjptssxRMaRX")).toBe(false); // 31 chars
    expect(isEntityIdLike("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXsX")).toBe(false); // 33 chars
    expect(isEntityIdLike("Ul5Hrhxi-FOBJmghOIUWjptssxRMaRXs")).toBe(false); // punctuation
    expect(isEntityIdLike("faada9fe-8b14-4a4c-9cc5")).toBe(false); // truncated UUID
  });

  it("LEGACY_NANOID_RE is exactly 32 base62 chars", () => {
    expect(LEGACY_NANOID_RE.test("a".repeat(32))).toBe(true);
    expect(LEGACY_NANOID_RE.test("a".repeat(31))).toBe(false);
    expect(LEGACY_NANOID_RE.test("a".repeat(33))).toBe(false);
  });
});
