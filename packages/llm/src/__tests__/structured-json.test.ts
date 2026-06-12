/**
 * parseStructuredJson — behavior pins for the relocated provider-neutral
 * utility (cinatra#151 Stage 2), including parity with the connector
 * original after the ReDoS-hardened fence regex (the dropped `\s*` lands
 * leading whitespace in the capture, which the existing `.trim()` removes).
 */
import { describe, it, expect } from "vitest";
import { parseStructuredJson } from "../structured-json";

describe("parseStructuredJson", () => {
  it("parses raw JSON text", () => {
    expect(parseStructuredJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses a ```json fenced block (whitespace after the fence tag — regex parity)", () => {
    expect(parseStructuredJson('```json\n  {"a": 2}\n```')).toEqual({ a: 2 });
    expect(parseStructuredJson('```json \t {"a": 2} ```')).toEqual({ a: 2 });
    expect(parseStructuredJson('prose before\n```json\n{"a": 2}\n```\nprose after')).toEqual({
      a: 2,
    });
  });

  it("parses a plain fenced block", () => {
    expect(parseStructuredJson('```\n{"b": true}\n```')).toEqual({ b: true });
  });

  it("falls back to the outermost {...} slice", () => {
    expect(parseStructuredJson('the answer is {"c": [1, 2]} — done')).toEqual({ c: [1, 2] });
  });

  it("returns null when nothing parses", () => {
    expect(parseStructuredJson("no json here")).toBeNull();
    expect(parseStructuredJson("")).toBeNull();
  });

  it("stays fast on a pathological unclosed fence (ReDoS hardening)", () => {
    const hostile = "```json" + "\t".repeat(50_000);
    const start = Date.now();
    expect(parseStructuredJson(hostile)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
