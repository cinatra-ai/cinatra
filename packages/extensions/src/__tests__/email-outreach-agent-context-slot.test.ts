/**
 * Pins the contextSlots contract on the email-outreach-agent OAS.
 *
 * The contextSlot is declared additively alongside the existing
 * `offeringCompanyWebsite` input. That input should be stripped only
 * once the agent's OAS carries the explicit `context-agent` FlowNode
 * and the FlowNode's `contextRefs` output is data-flow-wired into the
 * consuming node, replacing the existing field.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/email-outreach-agent-context-slot.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { readAgentContextSlotsFromOas } from "../agent-context-slots-reader";

const OAS_PATH = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json",
);

function loadOas(): unknown {
  return JSON.parse(readFileSync(OAS_PATH, "utf-8"));
}

describe("email-outreach-agent contextSlot declaration", () => {
  it("OAS declares exactly one contextSlot", () => {
    const slots = readAgentContextSlotsFromOas(loadOas());
    expect(slots).toHaveLength(1);
  });

  it("slotId is 'offeringContext'", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.slotId).toBe("offeringContext");
  });

  it("acceptedArtifactExtensions are exactly ICP + strategy + product-portfolio", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.acceptedArtifactExtensions).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
      "@cinatra-ai/marketing-strategy-artifact",
      "@cinatra-ai/product-portfolio-artifact",
    ]);
  });

  it("resolutionMode is 'accumulate' (LLM sees all matching refs narrow→broad)", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.resolutionMode).toBe("accumulate");
  });

  it("selectionMode is 'interactive' (HITL pick from candidates)", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.selectionMode).toBe("interactive");
  });

  it("minItems is 0 (slot is optional — outreach runs without context if no match)", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.minItems).toBe(0);
  });

  it("maxItems is 5 (cap on accumulate-mode refs the LLM sees)", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.maxItems).toBe(5);
  });

  it("readableOnly is true", () => {
    const [slot] = readAgentContextSlotsFromOas(loadOas());
    expect(slot.readableOnly).toBe(true);
  });
});

describe("email-outreach-agent additive-conversion invariant", () => {
  // The slot is additive: it is declared while offeringCompanyWebsite
  // stays in the OAS as an existing input until the explicit
  // `context-agent` FlowNode is added and its contextRefs output is
  // data-flow-wired into the consuming node. This test pins the
  // additive shape so any strip-when-live change must consciously
  // update this assertion.
  it("offeringCompanyWebsite legacy references pinned to EXACT count (additive conversion)", () => {
    // Pin the EXACT occurrence count, not just ">0". Any partial strip
    // (for example, removing a DataFlowEdge but leaving one prompt
    // mention) must consciously update this assertion so we never
    // silently break production wiring. Current count is 15
    // (14 lines; one line has both source_output + destination_input
    // references). When the strip-when-live path is implemented, update
    // this to expect(0) and remove the comment block.
    const raw = readFileSync(OAS_PATH, "utf-8");
    const count = (raw.match(/offeringCompanyWebsite/g) ?? []).length;
    expect(count).toBe(15);
  });
});
