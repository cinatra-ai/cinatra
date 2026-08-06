/**
 * Canonical explicit context-selection-agent OAS pattern.
 *
 * Pins the explicit `context_offeringContext` wiring on `email-outreach-agent`
 * as the reference shape for agents that depend on
 * `@cinatra-ai/context-selection-agent`: the FlowNode + its vendored subflow,
 * control flow that cannot reach `drafts_flow` without passing through it, the
 * 4 input DFEs from the hidden Start constants, and the
 * `contextSlotBindings → drafts_flow.contextSlotBindings` output DFE. The
 * orphaned `contextSlotBindings` Start input has been removed (the consumer
 * is now fed by the context FlowNode, not Start).
 *
 * TWO ASSERTIONS RE-ANCHORED (cinatra#2455).
 *
 * 1. DEPENDENCY VOCABULARY. This used to read
 *    `pkg.cinatra.agentDependencies["@cinatra-ai/context-selection-agent"]`.
 *    That npm-style map is the LEGACY agent-package vocabulary; the canonical
 *    declaration is `cinatra.dependencies: ExtensionDependency[]`, and
 *    `manifest-dependencies.ts` is the single reader every install path uses
 *    (dual-read, canonical winning). This agent declares the edge canonically
 *    and carries no legacy map, so the old check failed on spelling alone.
 *    Reading through `parseManifestDependencyEdges` asserts what the HOST
 *    resolves, and tightens "the key is truthy" to "an install-blocking runtime
 *    edge exists".
 *
 * 2. CONTROL-FLOW ORDER. This used to pin the literal chain
 *    `skills_flow → context_offeringContext → drafts_flow`. `skills_flow` was
 *    RETIRED by the ratified companion commit "refactor(skills): #2090 S3 —
 *    fold the embedded skill into the agent's own configuration"; the stage
 *    before the context node is now `recipients_flow`. Pinning an upstream
 *    node's NAME was never the invariant — the invariant is that context
 *    resolution DOMINATES its consumer. The replacement asserts exactly that:
 *    with `context_offeringContext` deleted from the control-flow graph,
 *    `drafts_flow` must be UNREACHABLE from `start`. That is strictly stronger
 *    than the old edge pair, which permitted any additional bypass edge into
 *    `drafts_flow` as long as the named one also existed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifestDependencyEdges } from "../manifest-dependencies";

const EXT_ROOT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai", "email-outreach-agent");
const oas = JSON.parse(readFileSync(join(EXT_ROOT, "cinatra", "oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8"));

type Node = { "$component_ref"?: string };
type Component = Record<string, unknown> & {
  component_type?: string;
  url?: string;
  subflow?: Node;
};
type ControlEdge = { from_node?: Node; to_node?: Node };
type DataEdge = {
  source_node?: Node;
  source_output?: string;
  destination_node?: Node;
  destination_input?: string;
};

const refs = oas["$referenced_components"] as Record<string, Component>;
const nodeIds = (oas.nodes as Array<{ "$component_ref": string }>).map((n) => n["$component_ref"]);
const cfc = oas.control_flow_connections as ControlEdge[];
const dfc = oas.data_flow_connections as DataEdge[];

const CONTEXT_SELECTION_AGENT = "@cinatra-ai/context-selection-agent";

/** Control-flow successors, optionally with one node deleted from the graph. */
function successors(without?: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of cfc) {
    const from = c.from_node?.["$component_ref"];
    const to = c.to_node?.["$component_ref"];
    if (!from || !to) continue;
    if (from === without || to === without) continue;
    out.set(from, [...(out.get(from) ?? []), to]);
  }
  return out;
}

/** Nodes reachable from `start`, optionally with one node deleted. */
function reachableFromStart(without?: string): Set<string> {
  const succ = successors(without);
  const seen = new Set<string>();
  const queue = without === "start" ? [] : ["start"];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const next of succ.get(n) ?? []) queue.push(next);
  }
  return seen;
}

describe("email-outreach-agent explicit context-selection-agent wiring", () => {
  it("declares the dependency in the package manifest (NOT in root OAS metadata)", () => {
    const edge = parseManifestDependencyEdges(pkg).edges.find(
      (e) => e.packageName === CONTEXT_SELECTION_AGENT,
    );
    expect(edge, `must declare a ${CONTEXT_SELECTION_AGENT} dependency edge`).toBeTruthy();
    // Install-blocking, not merely present.
    expect(edge!.edgeType).toBe("runtime");
    expect(edge!.requirement).toBe("required");
    expect(oas.metadata?.cinatra?.agentDependencies).toBeUndefined();
  });

  it("has a context_offeringContext FlowNode for the offeringContext slot", () => {
    const fn = refs["context_offeringContext"];
    expect(fn).toBeDefined();
    expect(fn.component_type).toBe("FlowNode");
    expect(fn.subflow?.["$component_ref"]).toBe("context-offeringContext-subflow");
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
    const subRefs = sub["$referenced_components"] as Record<string, Component>;
    // EXACT url, never a substring: `.includes()` would accept a decoy such as
    // `{{CINATRA_BASE_URL}}/api/context-resolve-noop` or an off-host origin and
    // report a real context resolver where there is none.
    const apiNodeHitting = (path: string) => (c: Component) =>
      c.component_type === "ApiNode" && c.url === `{{CINATRA_BASE_URL}}${path}`;
    const resolveNode = Object.values(subRefs).find(apiNodeHitting("/api/context-resolve"));
    expect(resolveNode, "resolve_context ApiNode required").toBeTruthy();
    const branchNode = Object.values(subRefs).find(
      (c) => c.component_type === "BranchingNode",
    );
    expect(branchNode, "select_mode BranchingNode required (interactive vs autonomous)").toBeTruthy();
    const finalizeNodes = Object.values(subRefs).filter(apiNodeHitting("/api/context-finalize"));
    expect(finalizeNodes.length, "≥1 finalize_context ApiNode required").toBeGreaterThan(0);
  });

  it("orders context_offeringContext AFTER its upstream stage and BEFORE drafts_flow", () => {
    const ci = nodeIds.indexOf("context_offeringContext");
    const di = nodeIds.indexOf("drafts_flow");
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(di).toBeGreaterThan(ci);
    // Whatever stage feeds the context node, it must be declared before it —
    // asserted on the EDGES, not on a hard-coded upstream node id.
    const predecessors = cfc
      .filter((c) => c.to_node?.["$component_ref"] === "context_offeringContext")
      .map((c) => c.from_node?.["$component_ref"] as string);
    expect(predecessors.length, "context_offeringContext must have an upstream stage")
      .toBeGreaterThan(0);
    for (const pred of predecessors) {
      const pi = nodeIds.indexOf(pred);
      expect(pi, `${pred} must be a declared node`).toBeGreaterThanOrEqual(0);
      expect(pi, `${pred} must be declared before context_offeringContext`).toBeLessThan(ci);
    }
  });

  it("routes control flow THROUGH context_offeringContext — drafts_flow has no bypass", () => {
    const edge = (from: string, to: string) =>
      cfc.some(
        (c) => c.from_node?.["$component_ref"] === from && c.to_node?.["$component_ref"] === to,
      );
    expect(edge("context_offeringContext", "drafts_flow")).toBe(true);
    // Dominance: delete the context node and drafts_flow must fall off the
    // graph. This forbids EVERY bypass path, not just one named edge.
    expect([...reachableFromStart()]).toContain("drafts_flow");
    expect(
      [...reachableFromStart("context_offeringContext")],
      "drafts_flow must be unreachable without context_offeringContext",
    ).not.toContain("drafts_flow");
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
    const hidden = (start.metadata as { cinatra: { hidden: string[] } }).cinatra.hidden;
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
