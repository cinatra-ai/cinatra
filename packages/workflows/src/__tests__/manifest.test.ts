import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseWorkflowTemplateManifest, validateWorkflowExtensionPackage } from "../manifest";

const samplePkg = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../../extensions/cinatra-ai/major-release-workflow/package.json"),
    "utf8",
  ),
) as { name: string; cinatra: Record<string, unknown> };

describe("workflow extension package validation (BPMN sidecar shape)", () => {
  it("the shipped sample extension package validates (BPMN sidecar shape)", () => {
    const r = validateWorkflowExtensionPackage(samplePkg);
    expect(r.valid, r.errors.join("; ")).toBe(true);
  });

  it("rejects an inline cinatra.workflow definition (forbidden)", () => {
    const r = validateWorkflowExtensionPackage({
      name: "@cinatra-ai/x-workflow",
      cinatra: { kind: "workflow", workflowVersion: 1, workflow: { key: "x" } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("bpmn_inline_definition_forbidden");
  });

  it("rejects a missing / non-integer workflowVersion", () => {
    expect(validateWorkflowExtensionPackage({ name: "@cinatra-ai/x-workflow", cinatra: { kind: "workflow" } }).valid).toBe(false);
    expect(
      validateWorkflowExtensionPackage({ name: "@cinatra-ai/x-workflow", cinatra: { kind: "workflow", workflowVersion: 1.5 } }).valid,
    ).toBe(false);
  });

  it("rejects unexpected cinatra keys", () => {
    expect(
      validateWorkflowExtensionPackage({ name: "@cinatra-ai/x-workflow", cinatra: { kind: "workflow", workflowVersion: 1, bogus: 1 } })
        .valid,
    ).toBe(false);
  });

  it("permits the cross-kind cinatra.roles declaration (cinatra#151 Stage 5 — shape is the agent-bindings generator's job)", () => {
    const r = validateWorkflowExtensionPackage({
      name: "@cinatra-ai/x-workflow",
      cinatra: { kind: "workflow", workflowVersion: 1, roles: ["x-operator-dashboard"] },
    });
    expect(r.valid, r.errors.join("; ")).toBe(true);
  });

  it("rejects a non-suffixed package name + wrong kind", () => {
    expect(
      validateWorkflowExtensionPackage({ name: "@cinatra-ai/not-suffixed", cinatra: { kind: "workflow", workflowVersion: 1 } }).valid,
    ).toBe(false);
    expect(
      validateWorkflowExtensionPackage({ name: "@cinatra-ai/x-workflow", cinatra: { kind: "artifact", workflowVersion: 1 } }).valid,
    ).toBe(false);
  });

  // parseWorkflowTemplateManifest still validates the DERIVED manifest shape (what
  // the BPMN sidecar produces) — template-valid + trigger-bundling lint.
  it("rejects a derived manifest whose definition is not template-valid", () => {
    const r = parseWorkflowTemplateManifest({ key: "x", version: 1, name: "X", definition: { name: "X", tasks: [] } });
    expect(r.ok).toBe(false);
  });

  it("rejects a derived manifest that bundles a trigger", () => {
    const r = parseWorkflowTemplateManifest({
      key: "x",
      version: 1,
      name: "X",
      definition: {
        name: "X",
        tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "@cinatra-ai/trigger" } }],
      },
    });
    expect(r.ok).toBe(false);
  });
});
