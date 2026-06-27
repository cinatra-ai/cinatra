// Registration of the generic portlet KIND metadata: the 9 generic kinds plus
// the keystone `analytics` kind (and its `cube-dashboard` alias, cinatra#325).
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
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";

const PORTLET_VERSION = "1.0.0";

/** Version stamped on the analytics portlet a wrapped operator/agent dashboard
 *  carries (cinatra#326 wrap path). Exported so the apiVersion 1.2 envelope
 *  helper stamps the SAME version the kind is registered under — no drift. */
export const ANALYTICS_PORTLET_VERSION = PORTLET_VERSION;

/** The kind name for the keystone analytics portlet (cinatra#325) and its alias.
 *  Both names register identical metadata so either validates. The portlet wraps
 *  a WHOLE drizzle-cube DashboardConfig as one embedded view at
 *  `config.dashboard` (NOT one portlet per chart) — see the apiVersion 1.2 design §1. */
export const ANALYTICS_PORTLET_KIND = "analytics" as const;
export const ANALYTICS_PORTLET_KIND_ALIAS = "cube-dashboard" as const;
export const ANALYTICS_PORTLET_KINDS = [
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
] as const;

/** True when a portlet kind is the embedded-analytics (drizzle-cube) kind. */
export function isAnalyticsPortletKind(kind: string): boolean {
  return kind === ANALYTICS_PORTLET_KIND || kind === ANALYTICS_PORTLET_KIND_ALIAS;
}

/** Install-time validation for the analytics kind: `config.dashboard` must be a
 *  structurally-valid drizzle-cube DashboardConfig (the 1.1 shape, which is the
 *  embedded format). The 1.1 schema is `.passthrough()`, so future DC fields are
 *  tolerated; deep chart semantics stay DC-owned (mirrors how 1.1 keeps
 *  `analysisConfig` opaque). Codex round-0: tightened from a loose "object with
 *  portlets array" to the real 1.1 schema so a malformed embedded config fails
 *  closed at materialization. */
function validateAnalyticsPortletConfig(p: PortletInstanceForValidation): PortletConfigError[] {
  const dashboard = p.config.dashboard;
  if (typeof dashboard !== "object" || dashboard === null) {
    return [{ code: "port_analytics_missing_dashboard", message: "config.dashboard (the embedded drizzle-cube dashboard config) is required" }];
  }
  const res = DashboardConfigV1_1Schema.safeParse(dashboard);
  if (!res.success) {
    return [
      {
        code: "port_analytics_invalid_dashboard",
        message: `config.dashboard is not a valid analytics dashboard: ${res.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      },
    ];
  }
  return [];
}

function reqConfigString(portlet: PortletInstanceForValidation, key: string, code: string): PortletConfigError[] {
  return typeof portlet.config[key] === "string" && (portlet.config[key] as string).length > 0
    ? []
    : [{ code, message: `portlet config.${key} is required` }];
}

export function registerCorePortletKinds(): void {
  // object-list — list cinatra.objects by config typeId + query.
  registerPortletKind({
    kind: "object-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentId"],
    outputKeys: ["selectedId"],
    validateConfig: (p) => reqConfigString(p, "typeId", "port_object_list_missing_type"),
  });

  // object-detail — read-only detail for the selected object id.
  registerPortletKind({
    kind: "object-detail",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["objectId"],
    outputKeys: [],
  });

  // artifact-list — list artifact rows by config extensionPackageName.
  registerPortletKind({
    kind: "artifact-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.read" },
    inputKeys: [],
    outputKeys: ["selectedArtifactId"],
    validateConfig: (p) => reqConfigString(p, "extensionPackageName", "port_artifact_list_missing_extension"),
  });

  // artifact-edit-text — ref-swap inline text edit on a parent object.
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

  // artifact-edit-binary-prompt — prompt-driven binary regen (auto/manual).
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

  // artifact-version-history — parent object's ref-swap timeline.
  registerPortletKind({
    kind: "artifact-version-history",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => reqConfigString(p, "parentObjectField", "port_version_history_missing_field"),
  });

  // workflow-launcher — wraps workflow_template_instantiate (dynamic prefills).
  registerPortletKind({
    kind: "workflow-launcher",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "workflow" },
    inputKeys: ["projectId"],
    outputKeys: ["workflowId"],
    allowsArbitraryInputs: true,
    validateConfig: (p) => reqConfigString(p, "templateKey", "port_workflow_launcher_missing_template"),
  });

  // agent-launcher — wraps agent_run start (dynamic prefills).
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

  // workflow-status — status summary; single-workflow OR project-scope mode.
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

  // analytics (keystone, cinatra#325) — embeds a WHOLE drizzle-cube
  // DashboardConfig at `config.dashboard` and renders the full interactive grid
  // (charts/filters/save/drag-resize) via PortletHost → embedded-drizzle-cube-dashboard-grid.
  // Self-contained: no inputs/outputs (the cube SQL predicate owns tenant
  // isolation, so the scopePolicy carries no op — like the launcher kinds that
  // delegate authz to the wrapped primitive). Registered under both the
  // canonical name and the `cube-dashboard` alias.
  for (const kind of ANALYTICS_PORTLET_KINDS) {
    registerPortletKind({
      kind,
      version: PORTLET_VERSION,
      scopePolicy: { scopeFrom: "session", resource: "dashboard" },
      inputKeys: [],
      outputKeys: [],
      validateConfig: validateAnalyticsPortletConfig,
    });
  }
}
