import { describe, it, expect } from "vitest";
import { allFixtures } from "./fixtures";
import { validateDraft, validateStart } from "../spec";

describe("fixture pack validity", () => {
  for (const [name, spec] of Object.entries(allFixtures)) {
    it(`${name} fixture is draft-valid`, () => {
      const r = validateDraft(spec);
      expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    });
  }

  it("non-agent / agent / DST fixtures are start-valid", () => {
    expect(validateStart(allFixtures.nonAgent).ok).toBe(true);
    expect(validateStart(allFixtures.agent).ok).toBe(true);
    expect(validateStart(allFixtures.dst).ok).toBe(true);
  });

  it("approval fixture is draft-valid AND start-valid (approval gate holds it pending)", () => {
    expect(validateDraft(allFixtures.approval).ok).toBe(true);
    expect(validateStart(allFixtures.approval).ok).toBe(true);
  });
});
