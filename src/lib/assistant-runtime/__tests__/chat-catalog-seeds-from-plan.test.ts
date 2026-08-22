import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// THE CATALOG'S SEEDING SITE (cinatra#2817 slice 1).
//
// WHAT THIS CAN AND CANNOT SEE. The BEHAVIOUR of the seam — that a plan's
// servable subset is exactly what `registerTool` accepted, for the default,
// hot-installed, collision, malformed-schema and version-pinned cases — is
// pinned against the REAL runtime server in
// `packages/mcp-server/src/__tests__/capability-plan-parity.test.ts`. It is
// pinned there because that is where the property lives.
//
// What is left is the one thing a behavioural test on the seam cannot see: that
// the DB-bound call sites still ROUTE through it. `resolveChatMcpCatalogState`
// and `buildDelegatedChatCapabilityPlan` both need the whole connector/module
// graph and a database, so a behavioural test of them is a test of a mock. A
// seeding site that went back to reading a static name list would leave every
// seam test green while shipping a catalog the perimeter never agreed to.
// ---------------------------------------------------------------------------

const runtimeSource = readFileSync(new URL("../runtime.ts", import.meta.url), "utf8");
const mcpServerSource = readFileSync(new URL("../../mcp-server.ts", import.meta.url), "utf8");

describe("the chat catalog seeds from the request-scoped capability plan", () => {
  it("resolveChatMcpCatalogState builds a plan and maps its SERVABLE subset", () => {
    expect(runtimeSource).toContain("buildDelegatedChatCapabilityPlan({");
    expect(runtimeSource).toContain("plan.servable.map((entry)");
  });

  it("the catalog no longer reads the static allowed-name accessor", () => {
    // The accessor is what #2777 had to seed from, and what this slice
    // replaces. Reading it here again would restore the two-answer shape.
    expect(runtimeSource).not.toContain("delegatedChatAllowedToolNames()");
  });

  it("the capability key resolved from the LIVE connector catalog rides the plan", () => {
    // The key must be resolved as part of PLANNING, not bolted on afterwards:
    // slice 3's evaluator reads it off the planned entry, and a key computed on
    // a second walk could disagree with the one the plan carries.
    expect(runtimeSource).toContain("resolveCapabilityKey: capabilityKeyFor");
    expect(runtimeSource).toContain("capabilityKey: entry.capabilityKey");
  });

  it("buildDelegatedChatCapabilityPlan runs ONE delegated-chat registration pass", () => {
    expect(mcpServerSource).toContain('toolPolicyMode: "delegated-chat"');
    expect(mcpServerSource).toContain("registerCapabilities: registerAllCapabilities");
    expect(mcpServerSource).toContain("onCapabilityPlan:");
  });

  it("an unemitted plan reads as EMPTY, never as everything", () => {
    expect(mcpServerSource).toContain("return { entries: [], outcomes: [], servable: [] };");
  });
});
