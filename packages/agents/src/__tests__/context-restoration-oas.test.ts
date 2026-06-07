import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateOasAgentJson } from "../validate-agent-json";
import { scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";

const PKGS = [
  "context-selection-agent",
  "email-outreach-agent",
  "blog-idea-generator-agent",
  "blog-draft-writer-agent",
  "blog-image-prompt-agent",
  "blog-pipeline-agent",
];

describe.each(PKGS)("%s OAS validates", (pkg) => {
  const oas = JSON.parse(
    readFileSync(
      join(__dirname, `../../../../extensions/cinatra-ai/${pkg}/cinatra/oas.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;

  it("validateOasAgentJson clean", () => {
    const errors = validateOasAgentJson(oas);
    if (errors.length) console.error(`[${pkg}] VALIDATE ERRORS:\n` + errors.join("\n"));
    expect(errors).toEqual([]);
  });

  it("runtime-invariant scan: no blockers", () => {
    const findings = scanOasForRuntimeInvariantFindings(oas).filter(
      (f) => f.severity === "blocker",
    );
    if (findings.length) console.error(`[${pkg}] BLOCKERS:\n` + JSON.stringify(findings, null, 2));
    expect(findings).toEqual([]);
  });
});

// The shared context-selection-agent subflow
// structurally supports the autonomous path — branching node routes
// `autonomous` around the InputMessageNode gate to a finalize_autonomous
// ApiNode (no HITL on the autonomous branch). The branch-routing logic in
// `select_mode` mapping `{autonomous: "autonomous"}` is the gate-skip.
describe("context-selection-agent: autonomous-slot structural coverage", () => {
  const oas = JSON.parse(
    readFileSync(
      join(__dirname, "../../../../extensions/cinatra-ai/context-selection-agent/cinatra/oas.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const refs = (oas["$referenced_components"] ?? {}) as Record<string, Record<string, unknown>>;

  it("has a BranchingNode `select_mode` with `autonomous` branch mapping", () => {
    const branch = refs["select_mode"];
    expect(branch).toBeDefined();
    expect(branch.component_type).toBe("BranchingNode");
    expect(branch.branches).toEqual(expect.arrayContaining(["default", "autonomous"]));
    expect((branch.mapping as Record<string, string>).autonomous).toBe("autonomous");
  });

  it("has a finalize_autonomous ApiNode that does NOT go through the HITL gate", () => {
    const fin = refs["finalize_autonomous"];
    expect(fin).toBeDefined();
    expect(fin.component_type).toBe("ApiNode");
    expect((fin.url as string)).toContain("/api/context-finalize");
    // Autonomous path: select_mode --autonomous--> finalize_autonomous (NO emit, NO gate).
    const cfes = (oas.control_flow_connections ?? []) as Array<Record<string, unknown>>;
    const autoEdge = cfes.find(
      (e) =>
        (e.from_node as { "$component_ref"?: string })?.["$component_ref"] === "select_mode"
        && e.from_branch === "autonomous"
        && (e.to_node as { "$component_ref"?: string })?.["$component_ref"] === "finalize_autonomous",
    );
    expect(autoEdge, "select_mode --autonomous--> finalize_autonomous").toBeTruthy();
    // No CFE from select_mode autonomous to the gate (the gate is on default branch only).
    const autoToGate = cfes.find(
      (e) =>
        (e.from_node as { "$component_ref"?: string })?.["$component_ref"] === "select_mode"
        && e.from_branch === "autonomous"
        && (e.to_node as { "$component_ref"?: string })?.["$component_ref"] === "context_select_gate",
    );
    expect(autoToGate, "autonomous branch must NOT route through the HITL gate").toBeFalsy();
  });

  it("the autonomous finalize synthesizes userResponse via Jinja |tojson (no DFE type-coercion)", () => {
    const fin = refs["finalize_autonomous"];
    const data = fin.data as Record<string, string>;
    expect(data.userResponse).toBeDefined();
    // The synthesized envelope embeds selectedRefs via |tojson.
    expect(data.userResponse).toContain("selectedRefs | tojson");
    // Sentinel comment exposes the bare names to pyagentspec's placeholder regex
    // (filters like |tojson are invisible to it).
    expect(data.userResponse).toContain("pyagentspec-input-hint");
  });
});

// KNOWN_BROKEN_AGENTS must remain empty (no agent
// is allowlisted as broken — keeps the green-up clean).
describe("KNOWN_BROKEN_AGENTS stays empty", () => {
  it("the allowlist is empty", async () => {
    const mod = await import("./__fixtures__/known-broken-agents");
    expect(Object.keys(mod.KNOWN_BROKEN_AGENTS)).toEqual([]);
  });
});
