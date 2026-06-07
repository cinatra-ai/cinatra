// Cinatra extension-dashboard config schema v1.2.
//
// This is a SEPARATE schema from the operator-authored dashboard config
// (`store/dashboard-config.ts`, semver `config_version` 1.0.0/1.1.0). v1.2 is
// the extension-shipped `cinatra/dashboard.json` shape: a typed-portlet
// composition with portlet-to-portlet + portlet-to-dashboard-row input wiring.
// Extension dashboards are distinguished at the row level by
// `extension_id`/`config_version`, so the two config families never collide.

import { z } from "zod";

export const DASHBOARD_CONFIG_V12_VERSION = "v1.2" as const;

export const DASHBOARD_SCOPE_LEVELS = ["user", "team", "organization", "workspace", "project"] as const;
export type DashboardScopeLevel = (typeof DASHBOARD_SCOPE_LEVELS)[number];

// The dashboard-row fields a portlet may bind to via `{ fromDashboard }`.
export const DASHBOARD_ROW_FIELDS = ["projectId", "organizationId", "ownerLevel", "ownerId", "scopeLevel"] as const;
export type DashboardRowField = (typeof DASHBOARD_ROW_FIELDS)[number];

const portletInputBindingSchema = z.union([
  z.object({ fromInstanceId: z.string().min(1), key: z.string().min(1) }).strict(),
  z.object({ fromDashboard: z.enum(DASHBOARD_ROW_FIELDS) }).strict(),
]);

export const portletConfigV12Schema = z
  .object({
    instanceId: z.string().min(1),
    kind: z.string().min(1),
    version: z.string().min(1),
    slot: z.enum(["fixed", "optional"]),
    config: z.record(z.string(), z.unknown()).default({}),
    inputs: z.record(z.string(), portletInputBindingSchema).optional(),
    outputs: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const dashboardConfigV12Schema = z
  .object({
    apiVersion: z.literal(DASHBOARD_CONFIG_V12_VERSION),
    scopeLevel: z.enum(DASHBOARD_SCOPE_LEVELS),
    portlets: z.array(portletConfigV12Schema),
  })
  .strict();

export type PortletConfigV12 = z.infer<typeof portletConfigV12Schema>;
export type DashboardConfigV12 = z.infer<typeof dashboardConfigV12Schema>;

/** A typed portlet registry entry (the PORT-01 registry shape, injected). */
export type PortletKindDescriptor = {
  kind: string;
  version: string;
  /** Input keys this kind accepts (binding targets). */
  inputKeys: readonly string[];
  /** Output keys this kind emits (binding sources). */
  outputKeys: readonly string[];
  /** Launcher portlets accept arbitrary prefill input keys — skip the strict
   *  input-key-declared check for them. */
  allowsArbitraryInputs?: boolean;
};

export type PortletKindLookup = (kind: string, version: string) => PortletKindDescriptor | undefined;

export type DashboardConfigV12Result =
  | { ok: true; config: DashboardConfigV12 }
  | { ok: false; code: "dashboard_config_invalid"; errors: string[] };

/**
 * Structural + cross-field validation of an extension `dashboard.json` (v1.2).
 * When `getPortletKind` is provided (typed-portlet registry), also validates
 * kind existence/version and that every input/output binding key is declared by
 * the relevant portlet kind. Without it (unit scope), only structural +
 * wiring-integrity checks run.
 */
export function validateDashboardConfigV12(
  raw: unknown,
  opts: { getPortletKind?: PortletKindLookup } = {},
): DashboardConfigV12Result {
  const parsed = dashboardConfigV12Schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "dashboard_config_invalid",
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }
  const config = parsed.data;
  const errors: string[] = [];

  // Unique instanceIds + slot lookup.
  const slotByInstance = new Map<string, "fixed" | "optional">();
  for (const p of config.portlets) {
    if (slotByInstance.has(p.instanceId)) {
      errors.push(`duplicate portlet instanceId "${p.instanceId}"`);
    }
    slotByInstance.set(p.instanceId, p.slot);
  }

  for (const p of config.portlets) {
    const desc = opts.getPortletKind?.(p.kind, p.version);
    if (opts.getPortletKind && !desc) {
      errors.push(`portlet "${p.instanceId}" references unknown kind/version "${p.kind}@${p.version}"`);
    }
    // declared output keys must exist on the kind (when registry present).
    if (desc && p.outputs) {
      for (const o of p.outputs) {
        if (!desc.outputKeys.includes(o)) {
          errors.push(`portlet "${p.instanceId}" declares output "${o}" not emitted by kind "${p.kind}"`);
        }
      }
    }
    if (!p.inputs) continue;
    for (const [inputKey, binding] of Object.entries(p.inputs)) {
      // input key must be accepted by the consuming kind (when registry present),
      // unless the kind accepts arbitrary prefill keys (launcher portlets).
      if (desc && !desc.allowsArbitraryInputs && !desc.inputKeys.includes(inputKey)) {
        errors.push(`portlet "${p.instanceId}" binds undeclared input "${inputKey}" for kind "${p.kind}"`);
      }
      if ("fromInstanceId" in binding) {
        const sourceSlot = slotByInstance.get(binding.fromInstanceId);
        if (sourceSlot === undefined) {
          errors.push(`portlet "${p.instanceId}" input "${inputKey}" references unknown source instanceId "${binding.fromInstanceId}"`);
        } else if (sourceSlot === "optional") {
          // Source must be a fixed-slot portlet — operator-added optional portlets
          // may never feed another portlet (prevents operator state from poisoning
          // extension behavior). Holds regardless of the consumer's own slot.
          errors.push(`portlet "${p.instanceId}" input "${inputKey}" binds an OPTIONAL source portlet "${binding.fromInstanceId}" (only fixed-slot outputs may be consumed)`);
        } else if (desc) {
          // source output key must be declared by the source portlet's kind.
          const sourcePortlet = config.portlets.find((q) => q.instanceId === binding.fromInstanceId);
          const sourceDesc = sourcePortlet ? opts.getPortletKind?.(sourcePortlet.kind, sourcePortlet.version) : undefined;
          if (sourceDesc && !sourceDesc.outputKeys.includes(binding.key)) {
            errors.push(`portlet "${p.instanceId}" input "${inputKey}" reads output "${binding.key}" not emitted by source kind "${sourcePortlet?.kind}"`);
          }
        }
      }
      // `{ fromDashboard }` enum membership is already enforced by Zod.
    }
  }

  if (errors.length > 0) return { ok: false, code: "dashboard_config_invalid", errors };
  return { ok: true, config };
}
