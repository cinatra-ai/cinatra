import { describe, it, expect } from "vitest";
import { parseLlmResponse, redactRawResponse } from "../response-parser";

describe("response-parser", () => {
  it("valid {matched, score, rationale} returns ok=true", () => {
    const raw = JSON.stringify({ matched: true, score: 0.85, rationale: "useful for X" });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ matched: true, score: 0.85, rationale: "useful for X" });
    }
  });

  it("invalid JSON returns ok=false with rawRedacted <= 1024 bytes", () => {
    const r = parseLlmResponse("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe("llm_schema_violation");
      expect(Buffer.byteLength(r.rawRedacted, "utf-8")).toBeLessThanOrEqual(1024);
    }
  });

  it("missing score field returns ok=false", () => {
    const raw = JSON.stringify({ matched: true, rationale: "no score" });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("llm_schema_violation");
  });

  it("out-of-range score: 1.5 returns ok=false", () => {
    const raw = JSON.stringify({ matched: true, score: 1.5, rationale: "ok" });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("llm_schema_violation");
  });

  it("out-of-range score: -0.1 returns ok=false", () => {
    const raw = JSON.stringify({ matched: false, score: -0.1, rationale: "ok" });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("llm_schema_violation");
  });

  it("rationale > 500 chars returns ok=false (STRICT, NO truncation)", () => {
    const raw = JSON.stringify({ matched: true, score: 0.5, rationale: "x".repeat(501) });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("llm_schema_violation");
  });

  it("empty string input returns ok=false", () => {
    const r = parseLlmResponse("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("llm_schema_violation");
  });

  it("redactRawResponse on huge input is <= 1024 bytes AND ends with truncation marker", () => {
    const big = "a".repeat(5000);
    const redacted = redactRawResponse(big);
    expect(Buffer.byteLength(redacted, "utf-8")).toBeLessThanOrEqual(1024);
    expect(redacted.endsWith("…[truncated to 1 KiB]")).toBe(true);
  });

  it("redactRawResponse on raw <=1024 bytes is passthrough (no marker)", () => {
    const small = "a".repeat(800);
    const redacted = redactRawResponse(small);
    expect(redacted).toBe(small);
    expect(redacted.endsWith("…[truncated to 1 KiB]")).toBe(false);
  });

  it("redactRawResponse on multibyte UTF-8 stays <= 1024 bytes", () => {
    // 4-byte UTF-8 codepoint (U+1F600 grinning face) — slicing mid-codepoint
    // can insert U+FFFD replacement (3 bytes) and push the cell over 1024.
    const emoji = "😀"; // 4 bytes in UTF-8
    const big = emoji.repeat(500); // 2000 bytes
    const redacted = redactRawResponse(big);
    expect(Buffer.byteLength(redacted, "utf-8")).toBeLessThanOrEqual(1024);
    expect(redacted.endsWith("…[truncated to 1 KiB]")).toBe(true);
    expect(redacted).not.toContain("�"); // no replacement char
  });

  it("redactRawResponse with ascii prefix + emoji stays clean", () => {
    // The 2-byte ascii prefix shifts emoji boundaries so a naive byte-count cut
    // lands mid-codepoint.
    const big = "aa" + "😀".repeat(500); // 2002 bytes
    const redacted = redactRawResponse(big);
    expect(Buffer.byteLength(redacted, "utf-8")).toBeLessThanOrEqual(1024);
    expect(redacted.endsWith("…[truncated to 1 KiB]")).toBe(true);
    expect(redacted).not.toContain("�"); // no replacement char
  });
});
