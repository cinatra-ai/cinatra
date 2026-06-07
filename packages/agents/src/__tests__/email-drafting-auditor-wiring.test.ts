/**
 * email-drafting-agent must not wire auditor-agent through an edited-response
 * predicate in the parent OAS.
 *
 * The parent OAS must not add:
 *   - a PluginTemplateNode predicate downstream of the reviewer approval_gate
 *     reading userResponse.edited
 *   - a ControlFlowEdge {from: predicate, branch:"edited"} to an auditor-agent node
 *   - a ControlFlowEdge {from: predicate, branch:"clean"} to end or next
 *
 * Auditor review belongs to the auditor-agent flow, not the parent email-drafting
 * flow. These assertions prevent accidental re-introduction of parent-level
 * auditor routing.
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/email-drafting-auditor-wiring.test.ts
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const OAS_PATH = path.join(
  REPO_ROOT,
  "extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json",
);

interface OasShape {
  metadata?: { cinatra?: { hitlScreens?: string[] } };
  control_flow_connections?: Array<{
    from_node?: { $component_ref?: string };
    to_node?: { $component_ref?: string };
    branch?: string;
    name?: string;
  }>;
  $referenced_components?: Record<
    string,
    {
      component_type?: string;
      id?: string;
      branches?: string[];
      template?: string;
    }
  >;
}

describe("email-drafting-agent auditor wiring", () => {
  // Auditor wiring is intentionally absent from the parent email-drafting flow.
  // These assertions lock in the absence of the auditor predicate node and edges
  // so future regressions that re-introduce them are surfaced.
  it("does not declare a PluginTemplateNode whose id matches /edited|audit/i", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const refs = oas.$referenced_components ?? {};
    const matching = Object.values(refs).filter(
      (n) =>
        n.component_type === "PluginTemplateNode" &&
        typeof n.id === "string" &&
        /edited|audit/i.test(n.id),
    );
    expect(matching).toEqual([]);
  });

  it("does not declare an /edited|audit/i predicate node", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const refs = oas.$referenced_components ?? {};
    const predicate = Object.values(refs).find(
      (n) =>
        n.component_type === "PluginTemplateNode" &&
        typeof n.id === "string" &&
        /edited|audit/i.test(n.id),
    );
    expect(predicate).toBeUndefined();
  });

  it("does not declare a control-flow edge with branch='edited'", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const edges = oas.control_flow_connections ?? [];
    const editedEdge = edges.find((e) => e.branch === "edited");
    expect(editedEdge).toBeUndefined();
  });

  it("does not declare a control-flow edge targeting a node with id matching /auditor/i", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const edges = oas.control_flow_connections ?? [];
    const auditorTarget = edges.find((e) =>
      /auditor/i.test(e.to_node?.$component_ref ?? ""),
    );
    expect(auditorTarget).toBeUndefined();
  });

  it("leaves metadata.cinatra.hitlScreens unchanged", () => {
    // Auditor's own HITL screen lives in auditor-agent's own OAS, not parent.
    // Parent hitlScreens should not gain '@cinatra-ai/auditor-agent:review'.
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const screens = oas.metadata?.cinatra?.hitlScreens ?? [];
    expect(screens).toContain("@cinatra-ai/reviewer-agent:output");
    // Conservative: it must contain only reviewer's screens because auditor is a child flow.
    expect(screens).not.toContain("@cinatra-ai/auditor-agent:review");
  });
});
