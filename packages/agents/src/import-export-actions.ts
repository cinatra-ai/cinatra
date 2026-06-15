"use server";

// File-level "use server" directive so these server actions can be imported
// by client components (import-form.tsx) safely.
//
// Agent ZIP format (app upload path — import-form.tsx, the MCP import
// handler, and the startup ensure-agent-package builders all produce or
// consume this shape):
//   - agent.json    : an OAS Flow document (component_type: "Flow"). DB
//                     column values (inputSchema, approvalPolicy, prompt,
//                     packageName, ...) are DERIVED by compileOasAgentJson,
//                     never read as literal fields.
//   - manifest.json : { version: 1, ... } — importAgentTemplateCore rejects
//                     any other version.
//   - package.json  : optional sibling carrying packageName/packageVersion +
//                     cinatra.agentDependencies (and the SPDX `license` field
//                     consumed by detectSpdxLicense).
//   - LICENSE / LICENSE.md / COPYING / .spdx : optional license sidecars,
//                     staged for the SPDX detection gate. The MCP
//                     agent_export handler ships the real on-disk
//                     package.json + license files so its archives pass this
//                     gate and upsert by packageName on restore.
// The round trip is guarded by the manifest-version check plus full OAS
// compilation/validation on import. (A former exportAgentTemplate server
// action emitted a different, incompatible envelope — componentType "Agent"
// with metadata.cinatra.formatVersion 2 — that the importer could never
// parse; it had no callers and was removed. The CLI's `cinatra agent
// export/import` pair speaks its own self-consistent legacy formatVersion-1
// shape and is intentionally NOT covered by this contract.)

import { createHash, randomUUID } from "node:crypto";
import { requireAdminSession } from "@/lib/auth-session";
import {
  createAgentTemplate,
  createAgentVersion,
} from "./store";
import type { CreateAgentTemplateInput } from "./store";
import { importAgentTemplateCore } from "./import-agent-core";

// ---------------------------------------------------------------------------
// createLocalAgentTemplateVersion — shared creation path for ZIP imports and
// registry installs
// ---------------------------------------------------------------------------

export type LocalAgentTemplateSeed = {
  name?: string;
  description?: string | null;
  sourceNl?: string;
  compiledPlan?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown | null;
  approvalPolicy?: unknown;
  taskSpec?: unknown;
  snapshot?: Record<string, unknown> | null;
  creatorId?: string;
  orgId?: string;
  status?: string;
  packageName?: string;
  packageVersion?: string;
  /**
   * @deprecated DECLARE/WRITE surface for the legacy `cinatra.agentDependencies`
   * vocabulary. The canonical replacement is `cinatra.dependencies` (read via
   * `parseManifestDependencyEdges`). Kept during the deprecation window for
   * back-compat with the ZIP-import / registry-install seed shape. (Removal
   * tracked as a follow-up milestone.)
   */
  agentDependencies?: Record<string, string>; // @cinatra/* dep ranges; undefined when manifest had no value
  type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "flow" | "node"; // defaults to "leaf" if omitted
  lgGraphCode?: string | null;
  lgGraphId?: string | null;
  executionProvider?: "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default";
  // Install-time owner tier. NULL means a row whose owner tier has not been
  // normalized yet. Threaded from installRegistryPackageAtScope's target
  // through installAgentPackageWithDependencies -> installAgentFromPackage.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function normalizeCompiledPlan(value: unknown): CreateAgentTemplateInput["compiledPlan"] {
  return Array.isArray(value) ? (value as CreateAgentTemplateInput["compiledPlan"]) : [];
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return isRecord(value) ? value : null;
}

function normalizeApprovalPolicy(value: unknown): CreateAgentTemplateInput["approvalPolicy"] {
  return isRecord(value)
    ? (value as CreateAgentTemplateInput["approvalPolicy"])
    : { steps: [] };
}

/**
 * Shared local creation path for ZIP imports and registry installs.
 * Creates an agent template + initial version from a seed payload.
 */
export async function createLocalAgentTemplateVersion(input: {
  seed: LocalAgentTemplateSeed;
  nameOverride?: string;
}): Promise<{ templateId: string; versionId: string }> {
  const snapshotInput = isRecord(input.seed.snapshot) ? input.seed.snapshot : {};
  const sourceNlValue = snapshotInput.sourceNl ?? input.seed.sourceNl;
  const compiledPlanValue = snapshotInput.compiledPlan ?? input.seed.compiledPlan;
  const inputSchemaValue = snapshotInput.inputSchema ?? input.seed.inputSchema;
  const outputSchemaValue = snapshotInput.outputSchema ?? input.seed.outputSchema;
  const approvalPolicyValue = snapshotInput.approvalPolicy ?? input.seed.approvalPolicy;
  const taskSpecValue = snapshotInput.taskSpec ?? input.seed.taskSpec;
  const sourceNl = typeof sourceNlValue === "string" ? sourceNlValue : "";
  const compiledPlan = normalizeCompiledPlan(compiledPlanValue);
  const inputSchema = normalizeRecord(inputSchemaValue);
  const outputSchema = normalizeNullableRecord(outputSchemaValue);
  const approvalPolicy = normalizeApprovalPolicy(approvalPolicyValue);
  const taskSpec = typeof taskSpecValue === "string" ? taskSpecValue : null;
  const templateId = randomUUID();
  const versionId = randomUUID();
  const name = input.nameOverride?.trim() || input.seed.name?.trim() || "Imported Agent";
  const snapshot = {
    ...snapshotInput,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema,
    approvalPolicy,
    taskSpec,

  };

  const template = await createAgentTemplate({
    id: templateId,
    orgId: input.seed.orgId,
    // Owner tier threaded from installRegistryPackageAtScope.
    ownerLevel: input.seed.ownerLevel,
    ownerId: input.seed.ownerId,
    creatorId: input.seed.creatorId,
    name,
    description: input.seed.description ?? undefined,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema: outputSchema ?? undefined,
    approvalPolicy,

    taskSpec: taskSpec ?? undefined,
    packageName: input.seed.packageName,
    packageVersion: input.seed.packageVersion,
    agentDependencies: input.seed.agentDependencies,
    type: input.seed.type, // serializer defaults to "leaf" when undefined
    lgGraphCode: input.seed.lgGraphCode ?? null,
    lgGraphId: input.seed.lgGraphId ?? null,
    executionProvider: input.seed.executionProvider ?? undefined,
    status: (input.seed.status as "draft" | "published") ?? "draft",
  });

  await createAgentVersion({
    id: versionId,
    templateId: template.id,
    contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    snapshot,
  });

  return { templateId: template.id, versionId };
}

export async function importAgentTemplate(
  zipBase64: string,
  nameOverride?: string,
  options?: {
    redirect?: boolean;
    status?: "draft" | "published";
    /** Destination chosen via PublishDestinationPicker; importAgentTemplateCore
     *  resolves the publish destination. */
    destination?: "private" | "public";
    /** Set true after user acknowledges LicenseWarningDialog for copyleft.
     *  importAgentTemplateCore re-validates the flag before registering. */
    licenseAcknowledged?: boolean;
    /** Upload-time permissions captured by PermissionsFormDraft on
     *  the ZIP upload form. The new template lands in cinatra.agent_templates
     *  and its polymorphic permission rows are seeded after registration. */
    permissions?: {
      policy?: import("./auth-policy-types").AgentAuthPolicy;
      coOwnerUserIds?: string[];
    };
  },
): Promise<{ templateId: string; upserted: boolean; warnings: string[] }> {
  const session = await requireAdminSession();
  // Capture the import actor as the agent template's creator. This attributes
  // the template so /configuration/extensions list views can show "installed by"
  // and supports per-template access-policy gates.
  const creatorId = session.user?.id ?? undefined;
  const { permissions, ...coreOptions } = options ?? {};
  const result = await importAgentTemplateCore(zipBase64, nameOverride, {
    ...coreOptions,
    creatorId,
  });

  // Record install actor + seed upload-time policy / co-owners via the generic
  // permissions backend. Same shape as the GitHub flow: best-effort, warnings
  // surfaced to the operator.
  const warnings: string[] = [];
  if (creatorId) {
    try {
      const { setExtensionInstaller } = await import("@cinatra-ai/extensions/permissions-actions");
      const setResult = await setExtensionInstaller(
        "agent_template",
        result.templateId,
        creatorId,
      );
      if (!setResult.ok) {
        warnings.push(
          `Could not record install actor as primary owner — manage access at /configuration/extensions/${result.templateId} or contact an admin.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[agents/import-export-actions] setExtensionInstaller failed (non-fatal):",
        message,
      );
      warnings.push(
        `Could not record install actor as primary owner — manage access at /configuration/extensions/${result.templateId} or contact an admin.`,
      );
    }
  }

  if (permissions) {
    const { policy, coOwnerUserIds } = permissions;
    if (policy) {
      try {
        const { saveExtensionAccessPolicy } = await import("@cinatra-ai/extensions/permissions-actions");
        const policyResult = await saveExtensionAccessPolicy(
          "agent_template",
          result.templateId,
          policy,
        );
        if (!policyResult.ok) {
          warnings.push(`Could not save access policy — re-save from the agent template detail page.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          "[agents/import-export-actions] saveExtensionAccessPolicy failed (non-fatal):",
          message,
        );
        warnings.push(`Could not save access policy — re-save from the agent template detail page.`);
      }
    }
    if (coOwnerUserIds && coOwnerUserIds.length > 0) {
      const { addExtensionCoOwner } = await import("@cinatra-ai/extensions/permissions-actions");
      const failedUserIds: string[] = [];
      for (const targetUserId of coOwnerUserIds) {
        try {
          const addResult = await addExtensionCoOwner(
            "agent_template",
            result.templateId,
            targetUserId,
          );
          if (!addResult.ok) failedUserIds.push(targetUserId);
        } catch (err) {
          console.warn(
            `[agents/import-export-actions] addExtensionCoOwner ${targetUserId} failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
          failedUserIds.push(targetUserId);
        }
      }
      if (failedUserIds.length > 0) {
        warnings.push(
          `Could not add ${failedUserIds.length} co-owner${failedUserIds.length === 1 ? "" : "s"} — re-add from the agent template detail page.`,
        );
      }
    }
  }

  return { ...result, warnings };
}

