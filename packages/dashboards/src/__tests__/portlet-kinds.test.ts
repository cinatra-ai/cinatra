import { describe, it, expect, beforeAll } from "vitest";
import { registerCorePortletKinds } from "../portlets/kinds";
import { getPortletKind, validatePortletConfig } from "../portlets/registry";

const V = "1.0.0";
const vc = (kind: string, config: Record<string, unknown>, inputs?: Record<string, unknown>) =>
  validatePortletConfig(kind, V, { config, inputs });

beforeAll(() => registerCorePortletKinds());

describe("core portlet kinds (PORT-02..10)", () => {
  it("registers all 9 kinds with a session scopePolicy", () => {
    for (const kind of [
      "object-list",
      "object-detail",
      "artifact-list",
      "artifact-edit-text",
      "artifact-edit-binary-prompt",
      "artifact-version-history",
      "workflow-launcher",
      "agent-launcher",
      "workflow-status",
    ]) {
      const e = getPortletKind(kind, V);
      expect(e, kind).toBeDefined();
      expect(e!.scopePolicy.scopeFrom).toBe("session");
    }
  });

  it("object-list requires config.typeId", () => {
    expect(vc("object-list", {})[0].code).toBe("port_object_list_missing_type");
    expect(vc("object-list", { typeId: "@cinatra-ai/assets:blog-project" })).toEqual([]);
  });

  it("artifact-edit-text requires refSwapPrimitive + parentObjectField", () => {
    expect(vc("artifact-edit-text", {})[0].code).toBe("port_edit_text_missing_refswap");
    expect(vc("artifact-edit-text", { refSwapPrimitive: "blog_post_update", parentObjectField: "postArtifactId" })).toEqual([]);
  });

  it("artifact-edit-binary-prompt enforces refSwapMode auto/manual + refSwapPrimitive rule", () => {
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "auto" })).toEqual([]);
    // auto + refSwapPrimitive present → reject
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "auto", refSwapPrimitive: "x" }).length).toBeGreaterThan(0);
    // manual without refSwapPrimitive → reject
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "manual" }).length).toBeGreaterThan(0);
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "manual", refSwapPrimitive: "x" })).toEqual([]);
  });

  it("workflow-status requires a workflowId OR projectId input binding", () => {
    expect(vc("workflow-status", {}, {})[0].code).toBe("port_workflow_status_missing_binding");
    expect(vc("workflow-status", {}, { projectId: { fromDashboard: "projectId" } })).toEqual([]);
    expect(vc("workflow-status", {}, { workflowId: { fromInstanceId: "launcher", key: "workflowId" } })).toEqual([]);
  });

  it("workflow-launcher requires templateKey; agent-launcher requires an agent ref", () => {
    expect(vc("workflow-launcher", {})[0].code).toBe("port_workflow_launcher_missing_template");
    expect(vc("workflow-launcher", { templateKey: "blog-content-workflow" })).toEqual([]);
    expect(vc("agent-launcher", {})[0].code).toBe("port_agent_launcher_missing_agent");
    expect(vc("agent-launcher", { agentPackage: "@cinatra-ai/x-agent" })).toEqual([]);
  });

  it("launcher kinds allow arbitrary input keys", () => {
    expect(getPortletKind("workflow-launcher", V)!.allowsArbitraryInputs).toBe(true);
    expect(getPortletKind("agent-launcher", V)!.allowsArbitraryInputs).toBe(true);
    expect(getPortletKind("object-list", V)!.allowsArbitraryInputs).toBeUndefined();
  });
});
