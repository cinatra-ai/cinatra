// Registration of the 9 generic portlet KIND metadata (PORT-02..10).
// METADATA ONLY (scopePolicy, input/output keys, install-time validateConfig) —
// server-safe, imported by the dashboard install validator. The interactive
// client components are resolved separately by the client PortletHost
// (portlet-host.tsx).
//
// Key-naming convention: kinds declare GENERIC input/output keys (e.g.
// object-list emits "selectedId"); dashboard.json instances wire via
// { fromInstanceId, key } using these generic keys, distinguished by
// instanceId — NOT instance-specific output names. Launcher kinds set
// allowsArbitraryInputs (dynamic prefill keys).
import { registerPortletKind, type PortletConfigError, type PortletInstanceForValidation } from "./registry";

const PORTLET_VERSION = "1.0.0";

function reqConfigString(portlet: PortletInstanceForValidation, key: string, code: string): PortletConfigError[] {
  return typeof portlet.config[key] === "string" && (portlet.config[key] as string).length > 0
    ? []
    : [{ code, message: `portlet config.${key} is required` }];
}

export function registerCorePortletKinds(): void {
  // PORT-02 object-list — list cinatra.objects by config typeId + query.
  registerPortletKind({
    kind: "object-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentId"],
    outputKeys: ["selectedId"],
    validateConfig: (p) => reqConfigString(p, "typeId", "port_object_list_missing_type"),
  });

  // PORT-03 object-detail — read-only detail for the selected object id.
  registerPortletKind({
    kind: "object-detail",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["objectId"],
    outputKeys: [],
  });

  // PORT-04 artifact-list — list artifact rows by config extensionPackageName.
  registerPortletKind({
    kind: "artifact-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.read" },
    inputKeys: [],
    outputKeys: ["selectedArtifactId"],
    validateConfig: (p) => reqConfigString(p, "extensionPackageName", "port_artifact_list_missing_extension"),
  });

  // PORT-05 artifact-edit-text — ref-swap inline text edit on a parent object.
  registerPortletKind({
    kind: "artifact-edit-text",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.update" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => [
      ...reqConfigString(p, "refSwapPrimitive", "port_edit_text_missing_refswap"),
      ...reqConfigString(p, "parentObjectField", "port_edit_text_missing_refswap"),
    ],
  });

  // PORT-06 artifact-edit-binary-prompt — prompt-driven binary regen (auto/manual).
  registerPortletKind({
    kind: "artifact-edit-binary-prompt",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.update" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => {
      const errs: PortletConfigError[] = [
        ...reqConfigString(p, "generationPrimitive", "port_edit_binary_invalid_config"),
        ...reqConfigString(p, "parentObjectField", "port_edit_binary_invalid_config"),
      ];
      const mode = p.config.refSwapMode;
      if (mode !== "auto" && mode !== "manual") {
        errs.push({ code: "port_edit_binary_invalid_config", message: 'config.refSwapMode must be "auto" | "manual"' });
      } else if (mode === "manual" && typeof p.config.refSwapPrimitive !== "string") {
        errs.push({ code: "port_edit_binary_invalid_config", message: "config.refSwapPrimitive is required when refSwapMode is manual" });
      } else if (mode === "auto" && p.config.refSwapPrimitive !== undefined) {
        errs.push({ code: "port_edit_binary_invalid_config", message: "config.refSwapPrimitive must be absent when refSwapMode is auto" });
      }
      return errs;
    },
  });

  // PORT-07 artifact-version-history — parent object's ref-swap timeline.
  registerPortletKind({
    kind: "artifact-version-history",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => reqConfigString(p, "parentObjectField", "port_version_history_missing_field"),
  });

  // PORT-08 workflow-launcher — wraps workflow_template_instantiate (dynamic prefills).
  registerPortletKind({
    kind: "workflow-launcher",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "workflow" },
    inputKeys: ["projectId"],
    outputKeys: ["workflowId"],
    allowsArbitraryInputs: true,
    validateConfig: (p) => reqConfigString(p, "templateKey", "port_workflow_launcher_missing_template"),
  });

  // PORT-09 agent-launcher — wraps agent_run start (dynamic prefills).
  registerPortletKind({
    kind: "agent-launcher",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "none" },
    inputKeys: [],
    outputKeys: ["runId"],
    allowsArbitraryInputs: true,
    validateConfig: (p) =>
      typeof p.config.agentRef === "string" || typeof p.config.agentPackage === "string"
        ? []
        : [{ code: "port_agent_launcher_missing_agent", message: "config.agentRef or config.agentPackage is required" }],
  });

  // PORT-10 workflow-status — Gantt/status; single-workflow OR project-scope mode.
  registerPortletKind({
    kind: "workflow-status",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "workflow" },
    inputKeys: ["workflowId", "projectId"],
    outputKeys: [],
    validateConfig: (p) => {
      const inputs = p.inputs ?? {};
      return inputs.workflowId !== undefined || inputs.projectId !== undefined
        ? []
        : [{ code: "port_workflow_status_missing_binding", message: "workflow-status requires a workflowId or projectId input binding" }];
    },
  });
}
