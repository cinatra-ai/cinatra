/**
 * Canonical explicit context-selection-agent OAS pattern.
 *
 * Pins the explicit `context_offeringContext` wiring on `email-outreach-agent`
 * as the reference shape for agents that depend on
 * `@cinatra-ai/context-selection-agent`: the FlowNode + its vendored subflow,
 * ordered control flow (skills_flow → context_offeringContext → drafts_flow),
 * the 4 input DFEs from the hidden Start constants, and the
 * `contextSlotBindings → drafts_flow.contextSlotBindings` output DFE. The
 * orphaned `contextSlotBindings` Start input has been removed (the consumer
 * is now fed by the context FlowNode, not Start).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_ROOT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai", "email-outreach-agent");
const oas = JSON.parse(readFileSync(join(EXT_ROOT, "cinatra", "oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8"));

const refs = oas["$referenced_components"] as Record<string, any>;
const nodeIds = (oas.nodes as Array<{ "$component_ref": string }>).map((n) => n["$component_ref"]);
const cfc = oas.control_flow_connections as Array<any>;
const dfc = oas.data_flow_connections as Array<any>;

describe("email-outreach-agent explicit context-selection-agent wiring", () => {
  it("declares the dependency in package.json cinatra.agentDependencies (NOT in root OAS metadata)", () => {
    expect(pkg.cinatra.agentDependencies["@cinatra-ai/context-selection-agent"]).toBeTruthy();
    expect(oas.metadata?.cinatra?.agentDependencies).toBeUndefined();
  });

  it("has a context_offeringContext FlowNode for the offeringContext slot", () => {
    const fn = refs["context_offeringContext"];
    expect(fn).toBeDefined();
    expect(fn.component_type).toBe("FlowNode");
    expect(fn.subflow["$component_ref"]).toBe("context-offeringContext-subflow");
  });

  it("inlines the real branching context subflow with the contextSlotBindings IO contract", () => {
    const sub = refs["context-offeringContext-subflow"];
    expect(sub).toBeDefined();
    expect(sub.component_type).toBe("Flow");
    const inTitles = (sub.inputs as Array<{ title: string }>).map((i) => i.title);
    expect(inTitles).toEqual(
      expect.arrayContaining(["parentRunId", "parentPackageName", "slotId", "projectId"]),
    );
    const outTitles = (sub.outputs as Array<{ title: string }>).map((o) => o.title);
    expect(outTitles).toContain("contextSlotBindings");
    // The old contextRefs stub output is forbidden.
    expect(outTitles).not.toContain("contextRefs");
    // The subflow includes the real branching architecture's nodes: the
    // resolve_context ApiNode hits /api/context-resolve, the branching node
    // routes interactive vs autonomous, and there is at least one finalize
    // ApiNode hitting /api/context-finalize.
    const subRefs = sub["$referenced_components"] as Record<string, any>;
    const resolveNode = Object.values(subRefs).find(
      (c: any) => c.component_type === "ApiNode" && typeof c.url === "string"
        && c.url.includes("/api/context-resolve"),
    );
    expect(resolveNode, "resolve_context ApiNode required").toBeTruthy();
    const branchNode = Object.values(subRefs).find(
      (c: any) => c.component_type === "BranchingNode",
    );
    expect(branchNode, "select_mode BranchingNode required (interactive vs autonomous)").toBeTruthy();
    const finalizeNodes = Object.values(subRefs).filter(
      (c: any) => c.component_type === "ApiNode" && typeof c.url === "string"
        && c.url.includes("/api/context-finalize"),
    );
    expect(finalizeNodes.length, "≥1 finalize_context ApiNode required").toBeGreaterThan(0);
  });

  it("orders context_offeringContext AFTER skills_flow and BEFORE drafts_flow", () => {
    const si = nodeIds.indexOf("skills_flow");
    const ci = nodeIds.indexOf("context_offeringContext");
    const di = nodeIds.indexOf("drafts_flow");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ci).toBeGreaterThan(si);
    expect(di).toBeGreaterThan(ci);
  });

  it("rewires control flow skills_flow → context_offeringContext → drafts_flow", () => {
    const edge = (from: string, to: string) =>
      cfc.some(
        (c) => c.from_node?.["$component_ref"] === from && c.to_node?.["$component_ref"] === to,
      );
    expect(edge("skills_flow", "drafts_flow"), "the direct bypass edge must be gone").toBe(false);
    expect(edge("skills_flow", "context_offeringContext")).toBe(true);
    expect(edge("context_offeringContext", "drafts_flow")).toBe(true);
  });

  it("wires the four context inputs from hidden Start constants + the contextSlotBindings output", () => {
    const has = (sn: string, so: string, dn: string, di: string) =>
      dfc.some(
        (e) =>
          e.source_node?.["$component_ref"] === sn &&
          e.source_output === so &&
          e.destination_node?.["$component_ref"] === dn &&
          e.destination_input === di,
      );
    expect(has("start", "cinatra_run_id", "context_offeringContext", "parentRunId")).toBe(true);
    expect(has("start", "contextParentPackageName", "context_offeringContext", "parentPackageName")).toBe(true);
    expect(has("start", "offeringContextSlotId", "context_offeringContext", "slotId")).toBe(true);
    expect(has("start", "contextProjectId", "context_offeringContext", "projectId")).toBe(true);
    expect(has("context_offeringContext", "contextSlotBindings", "drafts_flow", "contextSlotBindings")).toBe(true);
  });

  it("supplies the hidden Start constants with the expected defaults + flags", () => {
    const start = refs["start"];
    const byTitle = Object.fromEntries(
      (start.inputs as Array<{ title: string; default?: string }>).map((i) => [i.title, i]),
    );
    expect(byTitle["contextParentPackageName"].default).toBe("@cinatra-ai/email-outreach-agent");
    expect(byTitle["offeringContextSlotId"].default).toBe("offeringContext");
    expect(byTitle["contextProjectId"].default).toBe("");
    const hidden = start.metadata.cinatra.hidden as string[];
    expect(hidden).toEqual(
      expect.arrayContaining(["contextParentPackageName", "offeringContextSlotId", "contextProjectId"]),
    );
    // The orphaned contextSlotBindings Start input is GONE — the consumer is
    // now fed by context_offeringContext, not Start.
    expect(byTitle["contextSlotBindings"], "the orphaned Start input must be removed").toBeUndefined();
  });

  it("NO top-level start.contextSlotBindings → drafts_flow bypass remains", () => {
    const bypass = dfc.find(
      (e) =>
        e.source_node?.["$component_ref"] === "start"
        && e.source_output === "contextSlotBindings"
        && e.destination_node?.["$component_ref"] === "drafts_flow"
        && e.destination_input === "contextSlotBindings",
    );
    expect(bypass).toBeFalsy();
  });

  it("declares zero skillIds anywhere in the OAS (owner law)", () => {
    const s = JSON.stringify(oas);
    expect(s).not.toContain("skillIds");
    expect(s).not.toContain("skill_ids");
  });
});
