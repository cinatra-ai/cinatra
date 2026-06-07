/**
 * Runtime-invariant cleanliness/parity guard.
 *
 * The explicit context-agent pattern composes context handling from the
 * shipped `@cinatra-ai/context-selection-agent`.
 *
 * context-selection-agent wires `contextRefs` via a real DataFlowEdge
 * (start.contextRefs -> end.contextRefs) so it has a genuine flow-graph
 * producer, and the context-using agents use a flow-wired
 * `contextSlotBindings` input. Both OAS are runtime-invariant CLEAN (zero
 * findings) AND mount in WayFlow's pyagentspec loader.
 *
 * This test pins PARITY at the new clean baseline: the shipped context-agent
 * OAS has ZERO runtime-invariant findings, and `email-outreach-agent`
 * introduces ZERO of its own — i.e. the composition adds no NEW defect. Blog
 * agents copy this pattern; this guard ensures none of them regress a finding.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/email-outreach-explicit-context-selection-agent-runtime-invariant.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");
const contextAgentOas = JSON.parse(
  readFileSync(join(EXT, "context-selection-agent", "cinatra", "oas.json"), "utf8"),
);
const emailOas = JSON.parse(
  readFileSync(join(EXT, "email-outreach-agent", "cinatra", "oas.json"), "utf8"),
);

describe("email-outreach-agent runtime-invariant parity with shipped context-agent", () => {
  it("the shipped context-agent OAS is runtime-invariant clean — zero findings; contextRefs is wired to a real producer", () => {
    const findings = scanOasForRuntimeInvariantFindings(contextAgentOas);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("email-outreach introduces NO runtime-invariant findings (parity with the clean context-agent baseline)", () => {
    const findings = scanOasForRuntimeInvariantFindings(emailOas);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
