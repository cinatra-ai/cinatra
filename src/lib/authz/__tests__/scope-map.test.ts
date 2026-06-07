import { describe, it, expect } from "vitest";
import { parseTokenScopes } from "@/lib/authz/scope-map";

describe("scope-map — parseTokenScopes", () => {
  it("parses known permission strings", () => {
    const result = parseTokenScopes("run.read agent.execute");
    expect(result).toContain("run.read");
    expect(result).toContain("agent.execute");
    expect(result).toHaveLength(2);
  });

  it("silently drops unknown scope strings", () => {
    const result = parseTokenScopes("run.read unknown.scope foobar");
    expect(result).toEqual(["run.read"]);
  });

  it("returns empty array for undefined input", () => {
    expect(parseTokenScopes(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTokenScopes("")).toEqual([]);
  });

  it("handles extra whitespace", () => {
    const result = parseTokenScopes("  run.read   agent.execute  ");
    expect(result).toContain("run.read");
    expect(result).toContain("agent.execute");
    expect(result).toHaveLength(2);
  });

  it("is case-sensitive — RUN.READ is not a valid scope", () => {
    expect(parseTokenScopes("RUN.READ")).toEqual([]);
  });
});
