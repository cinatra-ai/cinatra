/**
 * THE SHIPPED WORKFLOW TEMPLATE CARRIES WHAT THE ROUTES REQUIRE
 * (cinatra#2815 S3 part 3).
 *
 * `/api/context-finalize` requires the allocation token and validates the
 * submission against the ALLOCATION rather than the candidate pool. Both rules
 * live on the server, and both are unreachable if the workflow that calls those
 * routes never carries the fields: a finalize with no token is refused outright,
 * and a renderer offered the full candidate pool lets a person choose a ref
 * finalize will then refuse.
 *
 * This suite reads the shipped template and pins the transport, because the
 * template is the only caller in production and a route contract nothing
 * satisfies is a broken feature, not a strict one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const TEMPLATE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "docker/wayflow/context_subflow_template.json"),
    "utf8",
  ),
) as {
  subflow: {
    $referenced_components: Record<
      string,
      {
        data?: Record<string, string>;
        inputs?: { title: string }[];
        outputs?: { title: string }[];
      }
    >;
    data_flow_connections: Array<{
      source_node: { $component_ref?: string } | string;
      destination_node: { $component_ref?: string } | string;
      source_output: string;
      destination_input: string;
    }>;
  };
};

const NODES = TEMPLATE.subflow.$referenced_components;
const RESOLVE = "ctx-__SLOT__-resolve_context";
const FINALIZE_INTERACTIVE = "ctx-__SLOT__-finalize_interactive";
const FINALIZE_AUTONOMOUS = "ctx-__SLOT__-finalize_autonomous";
const RENDERER = "ctx-__SLOT__-emit_context_payload";

function ref(node: { $component_ref?: string } | string): string {
  return typeof node === "string" ? node : (node.$component_ref ?? "");
}

function edgesInto(nodeId: string) {
  return TEMPLATE.subflow.data_flow_connections.filter(
    (e) => ref(e.destination_node) === nodeId,
  );
}

function titles(list: { title: string }[] | undefined): string[] {
  return (list ?? []).map((i) => i.title);
}

describe("the allocation token reaches finalize on both paths", () => {
  it("is an output of the resolve call", () => {
    expect(titles(NODES[RESOLVE].outputs)).toContain("allocationToken");
  });

  for (const finalize of [FINALIZE_INTERACTIVE, FINALIZE_AUTONOMOUS]) {
    it(`is a declared input, a sent field and a wired edge on ${finalize}`, () => {
      expect(titles(NODES[finalize].inputs)).toContain("allocationToken");
      expect(NODES[finalize].data?.allocationToken).toBeTruthy();
      const wired = edgesInto(finalize).some(
        (e) =>
          ref(e.source_node) === RESOLVE &&
          e.source_output === "allocationToken" &&
          e.destination_input === "allocationToken",
      );
      expect(wired).toBe(true);
    });
  }
});

describe("the renderer and the autonomous finalize are offered the PLANNED set", () => {
  it("the planned set is an output of the resolve call", () => {
    expect(titles(NODES[RESOLVE].outputs)).toContain("plannedRefs");
  });

  it("the renderer's choices come from the planned set, not the candidate pool", () => {
    // The pool is strictly wider than the allocation: an override slot resolves
    // several candidates and is allocated exactly one, and a ref the cross-slot
    // dedupe removed is still in a later slot's pool. Offering the pool offers
    // a choice finalize refuses with ref_not_in_candidates.
    for (const edge of edgesInto(RENDERER)) {
      if (edge.destination_input === "candidates" || edge.destination_input === "selectedRefs") {
        expect(edge.source_output).toBe("plannedRefs");
      }
    }
    const fed = edgesInto(RENDERER).filter((e) => e.source_output === "plannedRefs");
    expect(fed.length).toBeGreaterThan(0);
  });

  it("the autonomous finalize submits the planned set", () => {
    // The envelope KEY stays `selectedRefs`, which is what the finalize route
    // parses; only its VALUE now comes from the planned set.
    expect(NODES[FINALIZE_AUTONOMOUS].data?.userResponse).toContain(
      '"selectedRefs":{{ plannedRefs | tojson }}',
    );
    expect(edgesInto(FINALIZE_AUTONOMOUS).some((e) => e.source_output === "selectedRefs")).toBe(
      false,
    );
    expect(
      edgesInto(FINALIZE_AUTONOMOUS).some(
        (e) => e.source_output === "plannedRefs" && e.destination_input === "plannedRefs",
      ),
    ).toBe(true);
  });
});
