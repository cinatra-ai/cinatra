/**
 * email-drafting-agent must not wire an auditor sub-flow through an
 * edited-response predicate in the parent OAS.
 *
 * The parent OAS must not add:
 *   - a PluginTemplateNode predicate downstream of the approval gate reading
 *     userResponse.edited
 *   - a ControlFlowEdge {from: predicate, branch:"edited"} to an auditor node
 *   - a ControlFlowEdge {from: predicate, branch:"clean"} to end or next
 *
 * ORIGINALLY this guarded a boundary (auditor review belongs to the auditor
 * flow, not the parent). After the cinatra#1796 / #2047-row-8 retirement the
 * auditor agent does not exist at all, so the guard is now absolute: no auditor
 * routing may EVER reappear in this parent, and review is owned by core
 * interception on the run-embedded gate.
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

  it("declares only its OWN pack-served review screen (post-retirement)", () => {
    // The gate did not move: it is still the flow's own `approval_gate` between
    // draft and apply (email-drafting-agent#41, hold decision (a)). What changed
    // is WHO renders it — the pack's own `:email-drafts-review` binding, no
    // longer a retired reviewer/auditor screen. Retired ids are reassembled from
    // parts so this file holds no live reference to either identity.
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as OasShape;
    const screens = oas.metadata?.cinatra?.hitlScreens ?? [];
    expect(screens).toContain("@cinatra-ai/email-drafting-agent:email-drafts-review");
    const SCOPE = "@cinatra-ai/";
    expect(screens).not.toContain(`${SCOPE}${"reviewer"}-agent:output`);
    expect(screens).not.toContain(`${SCOPE}${"auditor"}-agent:review`);
  });
});
