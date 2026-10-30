import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { resolveWordPressInstanceAdmin } from "@/lib/connector-client-providers";
import { createInstanceUseAuthority } from "@/lib/connector-instance-write-authority";
import { getMergedFieldRendererBindings } from "./field-renderer-bindings.server";
import { resolveAgentRuntimeMountDir, resolveDevExtensionSourceRoot } from "./agent-runtime-mount";
import type { AgentRunRecord } from "./store";
import type { AgentHitlScreenActor } from "./agent-hitl-screen-core";
import type { AgentHitlScreenGate, HitlRenderInputs } from "./agent-hitl-screen";

/** Optional display data, never a gate input or an answer. A declaration does
 * not grant access: the existing live per-instance USE gate decides it anew for
 * the SAME verified reader that passed the run access door. */
export async function projectHitlRenderInputs(
  run: AgentRunRecord,
  gate: AgentHitlScreenGate,
  who: AgentHitlScreenActor,
): Promise<HitlRenderInputs | undefined> {
  try {
    const binding = getMergedFieldRendererBindings().find(b => b.id === gate.xRenderer);
    const declaration = binding?.params?.renderInputs as { siteHost?: unknown } | undefined;
    const spec = declaration?.siteHost as Record<string, unknown> | undefined;
    if (!binding || !spec || spec.provider !== "connector-destination-host" || spec.connectorKind !== "wordpress") return;
    if (typeof spec.instanceField !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(spec.instanceField)) return;
    if (!Array.isArray(spec.identityFields) || spec.identityFields.length === 0 || spec.identityFields.length > 8 || spec.identityFields.some(k => typeof k !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k))) return;
    const connectorPackage = getConnectorDescriptorBySlug("wordpress-mcp-connector")?.packageId;
    if (!connectorPackage || spec.connectorPackage !== connectorPackage || !/^@[\w-]+\/[\w-]+$/.test(binding.declaredBy)) return;
    // Resolve only the declaring package's maintained manifest. The generated
    // binding takes precedence; a divergent installed declaration cannot supply
    // a dependency or change the input contract underneath it.
    let manifest: { name?: unknown; cinatra?: { dependencies?: unknown; fieldRenderers?: unknown } } | undefined;
    for (const root of [resolveDevExtensionSourceRoot(), resolveAgentRuntimeMountDir()]) {
      try {
        let candidate: typeof manifest;
        // Maintained dev sources use scope/name without the leading @; runtime
        // mounts may retain npm's @scope/name. Both are exact bounded paths.
        for (const packagePath of [binding.declaredBy.slice(1), binding.declaredBy]) {
          try { candidate = JSON.parse(readFileSync(join(root, packagePath, "package.json"), "utf8")) as typeof manifest; break; } catch { /* Try the other maintained namespace layout. */ }
        }
        const declarations = candidate?.cinatra?.fieldRenderers;
        if (candidate?.name === binding.declaredBy && Array.isArray(declarations) && declarations.some(b => b?.id === binding.id && JSON.stringify(b.params ?? {}) === JSON.stringify(binding.params ?? {}))) { manifest = candidate; break; }
      } catch { /* Missing declaration means no display projection. */ }
    }
    const dependencies = manifest?.cinatra?.dependencies;
    if (!Array.isArray(dependencies) || !dependencies.some(d => d?.packageName === connectorPackage && d.kind === "connector" && d.requirement === "required" && d.edgeType === "runtime")) return;
    const instanceId = run.inputParams?.[spec.instanceField];
    if (typeof instanceId !== "string" || !instanceId || instanceId.length > 256 || gate.currentValues[spec.instanceField] !== instanceId) return;
    const userId = who.actor.actorType === "human" ? who.actor.userId : undefined;
    const orgId = who.roleHints.actorOrganizationId;
    if (!userId || !orgId || orgId !== run.orgId) return;
    const identityValues: Record<string, string> = {};
    for (const key of spec.identityFields as string[]) {
      const value = gate.currentValues[key];
      if (typeof value !== "string" || !value || value.length > 512) return;
      identityValues[key] = value;
    }
    await createInstanceUseAuthority("wordpress")({
      userId, orgId,
      actor: { principalType: "HumanUser", principalId: userId, organizationId: orgId, authSource: who.actor.source === "ui" ? "ui" : "mcp", policyVersion: "v2" },
    }, { instanceId, primitiveName: "hitl_destination_host" });
    const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId);
    if (!row || row.id !== instanceId || row.orgId !== orgId || typeof row.siteUrl !== "string") return;
    const url = new URL(row.siteUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.host) return;
    // host has no userinfo, path, query or fragment. Nondefault port and IPv6
    // remain the actual connection's address; no site/network/catalog read.
    return { bindingId: binding.id, reviewTaskId: gate.reviewTaskId, instanceField: spec.instanceField, instanceId, identityValues, siteHost: url.host };
  } catch { return undefined; }
}
