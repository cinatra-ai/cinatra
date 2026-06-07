import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The /api/llm-bridge widening is ADDITIVE:
// a new optional top-level `attachments` array; the legacy `media`
// external-URL Gemini branch is left untouched. The real schema is module-
// internal (importing the route pulls heavy deps), so this guards the
// source: additive field present, media branch intact, attachments
// optional + bounded.

const ROUTE = readFileSync(
  path.join(__dirname, "../route.ts"),
  "utf8",
);

describe("/api/llm-bridge schema widening", () => {
  it("adds an optional, bounded top-level `attachments` array", () => {
    expect(ROUTE).toMatch(/attachments:\s*z[\s\S]*\.array\(/);
    expect(ROUTE).toMatch(/\.max\(20\)\s*\.optional\(\)/);
    // ref shape carries the pinned-representation identity, never bytes
    // the revision id aligns with the semantic Representation contract.
    expect(ROUTE).toMatch(/artifactId:\s*z\.string\(\)\.min\(1\)/);
    expect(ROUTE).toMatch(/representationRevisionId:\s*z\.string\(\)\.min\(1\)/);
    expect(ROUTE).toMatch(/digest:\s*z\.string\(\)\.min\(1\)/);
    // the attachments block itself carries only pinned-ref identity —
    // never inline bytes/base64 (slice the block, then assert)
    const start = ROUTE.indexOf("attachments: z");
    const block = ROUTE.slice(start, ROUTE.indexOf(".max(20)", start));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/base64|bytes|\bdata\b/i);
  });

  it("leaves the legacy `media` external-URL branch untouched", () => {
    expect(ROUTE).toMatch(/media:\s*z[\s\S]*url:\s*z\.string\(\)\.url\(\)/);
    expect(ROUTE).toMatch(/kind:\s*z\.preprocess/);
  });
});
