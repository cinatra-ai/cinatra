import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Agent-builder MCP handlers scope-routing.
//
// Source-text gates that verify scope-routing invariants. Functional
// integration coverage for deny vs allow flows lives elsewhere.
// ---------------------------------------------------------------------------

import { join } from "node:path";

const HANDLERS = readFileSync(
  join(__dirname, "..", "mcp", "handlers.ts"),
  "utf-8",
);

describe("agent-builder MCP handlers scope routing", () => {
  it("does NOT import getActorContextOrThrow from the llm package", () => {
    // `getActorContext` / `getActorContextOrThrow` imports stay out of handlers.ts.
    // The kernel-routing path is via enforceRunAccess + per-row policy enforcement only.
    // Strip comments before searching so doc-comments referencing the removed symbols
    // do not trip the gate.
    const stripped = HANDLERS.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(stripped).not.toContain("getActorContextOrThrow");
    expect(stripped).not.toMatch(/from\s+["']@cinatra-ai\/llm["']/);
  });

  it("does not call getActorContextOrThrow in read handlers", () => {
    // Read handlers do not call getActorContext()/getActorContextOrThrow().
    // They route via enforceRunAccess + kernel filtering.
    // Strip comments first to avoid matching doc-comments that reference these symbols.
    const stripped = HANDLERS.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const matches = (stripped.match(/getActorContextOrThrow\(\)/g) ?? []).length;
    expect(matches).toBe(0);
  });

  it("retains enforceRunAccess as the canonical kernel routing call", () => {
    const matches = (HANDLERS.match(/enforceRunAccess\(/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("contains no ad-hoc organizationId compares (kernel-only filtering)", () => {
    // Strip line comments before searching so doc-comments referencing
    // 'organizationId !==' don't trip the gate.
    const stripped = HANDLERS.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(stripped).not.toMatch(/row\.organizationId !==/);
    expect(stripped).not.toMatch(/organizationId === actor/);
  });
});
