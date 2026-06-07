import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { validateDevFixtureFile, discoverDeclaredFixtures } from "../dev-fixtures-gate.mjs";

describe("dev-fixtures-gate — validateDevFixtureFile", () => {
  it("accepts a well-formed setting fixture file", () => {
    expect(
      validateDevFixtureFile({
        version: 1,
        fixtures: [{ id: "a", surface: "setting", key: "k", value: "v" }],
      }),
    ).toEqual([]);
  });

  it("accepts a well-formed object fixture file", () => {
    expect(
      validateDevFixtureFile({
        fixtures: [{ id: "o", surface: "object", typeId: "@x/y:thing", data: { a: 1 } }],
      }),
    ).toEqual([]);
  });

  it("rejects a non-object top level", () => {
    expect(validateDevFixtureFile([]).length).toBeGreaterThan(0);
    expect(validateDevFixtureFile("nope").length).toBeGreaterThan(0);
  });

  it("rejects an empty fixtures array", () => {
    expect(validateDevFixtureFile({ fixtures: [] })).toContain("`fixtures` must declare at least one entry");
  });

  it("rejects an unknown surface", () => {
    const errs = validateDevFixtureFile({ fixtures: [{ id: "a", surface: "secretz", key: "k", value: 1 }] });
    expect(errs.some((e) => e.includes("`surface` must be one of"))).toBe(true);
  });

  it("rejects a setting fixture missing key or value", () => {
    expect(validateDevFixtureFile({ fixtures: [{ id: "a", surface: "setting", value: 1 }] }).length).toBeGreaterThan(0);
    expect(validateDevFixtureFile({ fixtures: [{ id: "a", surface: "setting", key: "k" }] }).length).toBeGreaterThan(0);
  });

  it("rejects an object fixture missing typeId or data", () => {
    expect(validateDevFixtureFile({ fixtures: [{ id: "a", surface: "object", data: {} }] }).length).toBeGreaterThan(0);
    expect(validateDevFixtureFile({ fixtures: [{ id: "a", surface: "object", typeId: "t" }] }).length).toBeGreaterThan(0);
  });

  it("rejects forbidden (non-declarative) keys", () => {
    const errs = validateDevFixtureFile({
      fixtures: [{ id: "a", surface: "setting", key: "k", value: 1, sql: "DROP TABLE x" }],
    });
    expect(errs.some((e) => e.includes('forbidden key "sql"'))).toBe(true);
  });

  it("rejects duplicate fixture ids", () => {
    const errs = validateDevFixtureFile({
      fixtures: [
        { id: "dup", surface: "setting", key: "a", value: 1 },
        { id: "dup", surface: "setting", key: "b", value: 2 },
      ],
    });
    expect(errs.some((e) => e.includes('duplicate fixture id "dup"'))).toBe(true);
  });

  it("rejects a non-integer version", () => {
    expect(validateDevFixtureFile({ version: 1.5, fixtures: [{ id: "a", surface: "setting", key: "k", value: 1 }] }).length).toBeGreaterThan(0);
  });
});

describe("dev-fixtures-gate — every declared fixture file in the repo is valid", () => {
  it("validates the real declared fixtures (the proof fixture + any others)", () => {
    const declared = discoverDeclaredFixtures();
    // At least the google-calendar proof fixture is declared.
    expect(declared.length).toBeGreaterThanOrEqual(1);
    const findings = [];
    for (const ext of declared) {
      expect(existsSync(ext.filePath), `${ext.packageName}: ${ext.declared} must exist`).toBe(true);
      const parsed = JSON.parse(readFileSync(ext.filePath, "utf8"));
      for (const e of validateDevFixtureFile(parsed)) findings.push(`${ext.packageName}: ${e}`);
    }
    expect(findings).toEqual([]);
  });
});
