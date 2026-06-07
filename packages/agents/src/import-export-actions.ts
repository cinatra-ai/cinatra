"use server";

// File-level "use server" directive so these server actions can be imported
// by client components (import-form.tsx, export-button.tsx) safely.

import { createHash, randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireAdminSession } from "@/lib/auth-session";
import {
  readAgentTemplateById,
  createAgentTemplate,
  createAgentVersion,
} from "./store";
import type { CreateAgentTemplateInput } from "./store";
import { createZipBuffer } from "./zip-helpers";
import { importAgentTemplateCore } from "./import-agent-core";

// ---------------------------------------------------------------------------
// exportAgentTemplate
// ---------------------------------------------------------------------------

export async function exportAgentTemplate(
  templateId: string,
): Promise<{ zipBase64: string; fileName: string }> {
  await requireAdminSession();

  const template = await readAgentTemplateById(templateId);
  if (!template) throw new Error("Agent template not found");

  const exportedAt = new Date().toISOString();

  // Guard: compiledPlan must be an array in the ZIP (legacy DB rows may have stored it
  // as a double-encoded string if they were imported from an older ZIP format).
  const compiledPlanSafe = Array.isArray(template.compiledPlan)
    ? template.compiledPlan
    : (typeof template.compiledPlan === "string"
        ? (() => { try { const p = JSON.parse(template.compiledPlan as unknown as string); return Array.isArray(p) ? p : []; } catch { return []; } })()
        : []);

  // Strip UI-only __ fields from inputSchema before export — agent.json is a public capability contract
  const inputSchemaCopy = JSON.parse(JSON.stringify(template.inputSchema)) as Record<string, unknown>;
  const props = inputSchemaCopy.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const key of Object.keys(props)) {
      if (key.startsWith("__")) delete props[key];
    }
  }
  if (Array.isArray(inputSchemaCopy.required)) {
    inputSchemaCopy.required = (inputSchemaCopy.required as string[]).filter((k: string) => !k.startsWith("__"));
  }

  const agentJson = JSON.stringify({
    componentType: "Agent",
    id: template.id,
    name: template.name,
    description: template.description ?? null,
    sourceNl: template.sourceNl,
    status: template.status,
    exportedAt,
    metadata: {
      cinatra: {
        formatVersion: 2,
        packageName: template.packageName ?? undefined,
        packageVersion: template.packageVersion ?? undefined,
        executionProvider: template.executionProvider,
        type: template.type ?? "leaf",
        compiledPlan: compiledPlanSafe,
        inputSchema: inputSchemaCopy,
        outputSchema: template.outputSchema ?? null,
        approvalPolicy: template.approvalPolicy,
        taskSpec: template.taskSpec ?? null,
        hitlScreens: template.hitlScreens ?? [],
      },
    },
  }, null, 2);
  const manifestJson = JSON.stringify({ version: 1, exportedAt, cinatra: "agent-builder-v1" }, null, 2);

  const zipBuf = createZipBuffer([
    { name: "agent.json", content: agentJson },
    { name: "manifest.json", content: manifestJson },
  ]);

  const slug = template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dateStr = exportedAt.slice(0, 10).replace(/-/g, "");
  return { zipBase64: zipBuf.toString("base64"), fileName: `cinatra-agent-${slug}-${dateStr}.zip` };
}

// ---------------------------------------------------------------------------
// importAgentTemplate
// ---------------------------------------------------------------------------

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

