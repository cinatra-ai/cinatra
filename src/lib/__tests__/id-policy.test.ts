// cinatra#1907 (owner-ratified spec): entityId() is the single mint for auth
// entity-row ids — UUIDs for every new row (the better-auth
// `advanced.database.generateId` override and all five direct mint paths
// consume it; the companion grep gate is entity-id-mint-gate.test.ts) — while
// legacy 32-char better-auth ids remain valid for existing rows.

import { describe, it, expect } from "vitest";
import { ENTITY_UUID_RE, LEGACY_NANOID_RE, entityId } from "../id-policy";

describe("entityId", () => {
  it("mints canonical UUIDs", () => {
    for (let i = 0; i < 20; i++) {
      expect(entityId()).toMatch(ENTITY_UUID_RE);
    }
  });
});

describe("LEGACY_NANOID_RE (better-auth pre-override ids)", () => {
  it("matches the real legacy ids from cinatra#1907", () => {
    expect(LEGACY_NANOID_RE.test("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs")).toBe(true);
    expect(LEGACY_NANOID_RE.test("bgEWkNFcoODy5NtsIxvPaM1F0lww7GSR")).toBe(true);
  });

  it("is exactly 32 base62 chars — UUIDs and near-misses do not match", () => {
    expect(LEGACY_NANOID_RE.test("faada9fe-8b14-4a4c-9cc5-4ccc757a2f7c")).toBe(false);
    expect(LEGACY_NANOID_RE.test("Ul5HrhxiVFOBJmghOIUWjptssxRMaRX")).toBe(false); // 31 chars
    expect(LEGACY_NANOID_RE.test("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXsX")).toBe(false); // 33 chars
    expect(LEGACY_NANOID_RE.test("Ul5Hrhxi-FOBJmghOIUWjptssxRMaRXs")).toBe(false); // punctuation
    expect(LEGACY_NANOID_RE.test("a".repeat(32))).toBe(true);
    expect(LEGACY_NANOID_RE.test("")).toBe(false);
  });
});
