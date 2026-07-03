// #822/#825 — compiled-workflow slot-binding spoof matrix.
// Covered at the pure-logic seam (route-io stays IO-thin, matching the
// existing context-route-support test split). The synthetic OAS below mirrors
// the real compiled shape of blog-pipeline-agent's cinatra/oas.json: child
// subflow DEFINITIONS hold the author-placed context-resolution marker, and
// the REFERENCING FlowNodes carry the child package identity — so ownership is
// a two-pass `$component_ref` join, not a nearest-enclosing-metadata walk.
import { describe, it, expect } from "vitest";
import { findBoundChildPackageForSlot } from "../context-route-support";

function orchestratorOas(): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "orchestrator-root",
    start_node: "start",
    metadata: {
      cinatra: { packageName: "@cinatra-ai/orchestrator", type: "flow" },
    },
    $referenced_components: {
      "child-a-subflow": {
        component_type: "Flow",
        id: "child-a-subflow",
        start_node: "a-start",
        $referenced_components: {
          "child-a__context_slotA": {
            component_type: "FlowNode",
            id: "child-a__context_slotA",
            subflow: { $component_ref: "child-a__context-slotA-subflow" },
            metadata: {
              cinatra: { purpose: "author-placed-context-resolution-for-slotA" },
            },
          },
        },
      },
      "child-b-subflow": {
        component_type: "Flow",
        id: "child-b-subflow",
        start_node: "b-start",
        $referenced_components: {
          "child-b__context_slotB": {
            component_type: "FlowNode",
            id: "child-b__context_slotB",
            subflow: { $component_ref: "child-b__context-slotB-subflow" },
            metadata: {
              cinatra: { purpose: "author-placed-context-resolution-for-slotB" },
            },
          },
        },
      },
      a_flow: {
        component_type: "FlowNode",
        id: "a_flow",
        subflow: { $component_ref: "child-a-subflow" },
        metadata: { cinatra: { packageName: "@cinatra-ai/child-a" } },
      },
      b_flow: {
        component_type: "FlowNode",
        id: "b_flow",
        subflow: { $component_ref: "child-b-subflow" },
        metadata: { cinatra: { packageName: "@cinatra-ai/child-b" } },
      },
    },
  };
}

describe("findBoundChildPackageForSlot", () => {
  it("resolves each slot to exactly the composing child that owns it", () => {
    const oas = orchestratorOas();
    expect(findBoundChildPackageForSlot(oas, "slotA")).toBe("@cinatra-ai/child-a");
    expect(findBoundChildPackageForSlot(oas, "slotB")).toBe("@cinatra-ai/child-b");
  });

  it("MISMATCHED (package, slot) is rejected: slotA binds only to child-a, so a child-b claim for slotA is not the owner (route → 403)", () => {
    const oas = orchestratorOas();
    // slotA resolves to exactly child-a; the route compares this against the
    // caller-supplied parentPackageName, so a child-b claim for slotA mismatches
    // and 403s. (Covers the undeclared/mismatched-owner spoof classes.)
    const owner = findBoundChildPackageForSlot(oas, "slotA");
    expect(owner).toBe("@cinatra-ai/child-a");
    expect(owner).not.toBe("@cinatra-ai/child-b");
  });

  it("documents the KNOWN residual (cinatra#907): a MATCHED sibling pair resolves by construction — the walker verifies (package, slot) consistency, NOT caller identity", () => {
    // The walker (and the route's acceptance) proves that the claimed package is
    // slotId's structural owner; it cannot prove WHICH child is calling, because
    // children share the run's bridge auth with no per-child identity. So a
    // composed child supplying a sibling's own bound (package, slot) still
    // resolves — an intra-run, intra-user residual tracked by cinatra#907 and
    // closable only with a WayFlow per-child identity change. This test pins that
    // behavior so a future fix that CLOSES it must consciously update this case.
    const oas = orchestratorOas();
    expect(findBoundChildPackageForSlot(oas, "slotB")).toBe("@cinatra-ai/child-b");
  });

  it("returns null for a slot the workflow does not bind (fail closed)", () => {
    expect(findBoundChildPackageForSlot(orchestratorOas(), "unknownSlot")).toBeNull();
  });

  it("returns null when a marker sits in the root flow with no package-named referencer", () => {
    const oas = orchestratorOas();
    (oas["$referenced_components"] as Record<string, unknown>)["rogue"] = {
      component_type: "FlowNode",
      id: "orchestrator__context_rootSlot",
      metadata: {
        cinatra: { purpose: "author-placed-context-resolution-for-rootSlot" },
      },
    };
    expect(findBoundChildPackageForSlot(oas, "rootSlot")).toBeNull();
  });

  it("returns null when two DIFFERENT packages bind the same slot (ambiguity fails closed)", () => {
    const oas = orchestratorOas();
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    // a second referencer of child-a's subflow claiming a different package
    refs["evil_flow"] = {
      component_type: "FlowNode",
      id: "evil_flow",
      subflow: { $component_ref: "child-a-subflow" },
      metadata: { cinatra: { packageName: "@cinatra-ai/child-evil" } },
    };
    expect(findBoundChildPackageForSlot(oas, "slotA")).toBeNull();
  });
});
