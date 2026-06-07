import { describe, it, expect } from "vitest";
import { parseDevFixtures, DevFixtureValidationError } from "../dev-fixtures";

describe("parseDevFixtures — declarative dev-fixtures validator", () => {
  it("accepts a well-formed setting fixture + defaults version to 1", () => {
    const out = parseDevFixtures({ fixtures: [{ id: "a", surface: "setting", key: "k", value: "v" }] });
    expect(out.version).toBe(1);
    expect(out.fixtures).toEqual([{ id: "a", surface: "setting", key: "k", value: "v" }]);
  });

  it("accepts a well-formed object fixture + an explicit version", () => {
    const out = parseDevFixtures({
      version: 3,
      fixtures: [{ id: "o", surface: "object", typeId: "@x/y:thing", data: { a: 1 } }],
    });
    expect(out.version).toBe(3);
    expect(out.fixtures[0]).toMatchObject({ surface: "object", typeId: "@x/y:thing" });
  });

  it("throws on a non-object top level", () => {
    expect(() => parseDevFixtures([])).toThrow(DevFixtureValidationError);
    expect(() => parseDevFixtures("nope")).toThrow(DevFixtureValidationError);
    expect(() => parseDevFixtures(null)).toThrow(DevFixtureValidationError);
  });

  it("throws on an empty / missing fixtures array", () => {
    expect(() => parseDevFixtures({ fixtures: [] })).toThrow(/at least one entry/);
    expect(() => parseDevFixtures({})).toThrow(/`fixtures` must be an array/);
  });

  it("throws on an unknown surface (incl. an attempt to target secrets)", () => {
    expect(() => parseDevFixtures({ fixtures: [{ id: "a", surface: "secret", key: "k", value: 1 }] })).toThrow(
      /`surface` must be one of/,
    );
  });

  it("throws on a setting fixture missing key or value", () => {
    expect(() => parseDevFixtures({ fixtures: [{ id: "a", surface: "setting", value: 1 }] })).toThrow(/non-empty string `key`/);
    expect(() => parseDevFixtures({ fixtures: [{ id: "a", surface: "setting", key: "k" }] })).toThrow(/needs a `value`/);
  });

  it("throws on an object fixture missing typeId or data", () => {
    expect(() => parseDevFixtures({ fixtures: [{ id: "a", surface: "object", data: {} }] })).toThrow(/non-empty string `typeId`/);
    expect(() => parseDevFixtures({ fixtures: [{ id: "a", surface: "object", typeId: "t" }] })).toThrow(/needs a `data` object/);
  });

  it("rejects forbidden (non-declarative) keys anywhere in a fixture", () => {
    expect(() =>
      parseDevFixtures({ fixtures: [{ id: "a", surface: "setting", key: "k", value: 1, js: "doEvil()" }] }),
    ).toThrow(/forbidden key "js"/);
    expect(() =>
      parseDevFixtures({ fixtures: [{ id: "a", surface: "object", typeId: "t", data: { sql: "DROP" } }] }),
    ).toThrow(/forbidden key "sql"/);
  });

  it("rejects duplicate fixture ids", () => {
    expect(() =>
      parseDevFixtures({
        fixtures: [
          { id: "dup", surface: "setting", key: "a", value: 1 },
          { id: "dup", surface: "setting", key: "b", value: 2 },
        ],
      }),
    ).toThrow(/duplicate fixture id "dup"/);
  });

  it("rejects a non-positive-integer version", () => {
    expect(() => parseDevFixtures({ version: 0, fixtures: [{ id: "a", surface: "setting", key: "k", value: 1 }] })).toThrow(
      /positive integer/,
    );
    expect(() => parseDevFixtures({ version: 1.5, fixtures: [{ id: "a", surface: "setting", key: "k", value: 1 }] })).toThrow(
      /positive integer/,
    );
  });
});
