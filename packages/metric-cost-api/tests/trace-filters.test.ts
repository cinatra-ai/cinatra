import { describe, it, expect } from "vitest";
import { parseTraceFilters } from "../src/trace-filters";

describe("parseTraceFilters (#491)", () => {
  it("returns empty for no params", () => {
    expect(parseTraceFilters({})).toEqual({});
  });

  it("parses a date-only 'from' as UTC start-of-day", () => {
    const { from } = parseTraceFilters({ from: "2026-06-26" });
    expect(from?.toISOString()).toBe("2026-06-26T00:00:00.000Z");
  });

  it("parses a date-only 'to' as UTC end-of-day (inclusive of the whole day)", () => {
    const { to } = parseTraceFilters({ to: "2026-06-26" });
    expect(to?.toISOString()).toBe("2026-06-26T23:59:59.999Z");
  });

  it("accepts a full ISO instant as-is", () => {
    const { from } = parseTraceFilters({ from: "2026-06-26T12:30:00.000Z" });
    expect(from?.toISOString()).toBe("2026-06-26T12:30:00.000Z");
  });

  it("ignores invalid dates and blank/'all' service", () => {
    expect(
      parseTraceFilters({ from: "not-a-date", to: "", service: "  " }),
    ).toEqual({});
    expect(parseTraceFilters({ service: "all" })).toEqual({});
  });

  it("keeps a real, trimmed service filter", () => {
    expect(parseTraceFilters({ service: " cinatra-app " })).toEqual({
      service: "cinatra-app",
    });
  });
});
