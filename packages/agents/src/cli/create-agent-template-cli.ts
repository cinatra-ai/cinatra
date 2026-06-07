// CLI-safe createLocalAgentTemplateVersion.
// Does NOT import "server-only" — safe for plain Node.js CLI processes.
// Re-implements the logic from import-export-actions.ts (which has "use server"
// and imports next/navigation + requireAdminSession — both CLI-hostile) using
// direct imports from store.ts.

import { createHash, randomUUID } from "node:crypto";
import {
  createAgentTemplate,
  createAgentVersion,
} from "../store";
import type { CreateAgentTemplateInput } from "../store";

export type LocalAgentTemplateSeedCli = {
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
  agentDependencies?: Record<string, string>;
  type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative";
  lgGraphCode?: string | null;
  lgGraphId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function normalizeCompiledPlan(
  value: unknown,
): CreateAgentTemplateInput["compiledPlan"] {
  return Array.isArray(value)
    ? (value as CreateAgentTemplateInput["compiledPlan"])
    : [];
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return isRecord(value) ? value : null;
}

function normalizeApprovalPolicy(
  value: unknown,
): CreateAgentTemplateInput["approvalPolicy"] {
  return isRecord(value)
    ? (value as CreateAgentTemplateInput["approvalPolicy"])
    : { steps: [] };
}

const VALID_STATUSES = ["draft", "published"] as const;
type ValidStatus = typeof VALID_STATUSES[number];

function normalizeStatus(value: unknown): ValidStatus {
  if (value === "published") return "published";
  return "draft"; // default for anything else including "archived" or unknown strings
}

/**
 * CLI-safe version of createLocalAgentTemplateVersion.
 * Writes an agent template + initial version row to the DB using Drizzle.
 * Requires SUPABASE_DB_URL to be set in the environment.
 */
export async function createLocalAgentTemplateVersionCli(input: {
  seed: LocalAgentTemplateSeedCli;
  nameOverride?: string;
}): Promise<{ templateId: string; versionId: string }> {
  const snapshotInput = isRecord(input.seed.snapshot) ? input.seed.snapshot : {};
  const sourceNlValue = snapshotInput.sourceNl ?? input.seed.sourceNl;
  const compiledPlanValue = snapshotInput.compiledPlan ?? input.seed.compiledPlan;
  const inputSchemaValue = snapshotInput.inputSchema ?? input.seed.inputSchema;
  const outputSchemaValue = snapshotInput.outputSchema ?? input.seed.outputSchema;
  const approvalPolicyValue =
    snapshotInput.approvalPolicy ?? input.seed.approvalPolicy;
  const taskSpecValue = snapshotInput.taskSpec ?? input.seed.taskSpec;
  const sourceNl =
    typeof sourceNlValue === "string" ? sourceNlValue : "";
  const compiledPlan = normalizeCompiledPlan(compiledPlanValue);
  const inputSchema = normalizeRecord(inputSchemaValue);
  const outputSchema = normalizeNullableRecord(outputSchemaValue);
  const approvalPolicy = normalizeApprovalPolicy(approvalPolicyValue);
  const taskSpec =
    typeof taskSpecValue === "string" ? taskSpecValue : null;
  const templateId = randomUUID();
  const versionId = randomUUID();
  const name =
    input.nameOverride?.trim() ||
    input.seed.name?.trim() ||
    "Imported Agent";
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
    type: input.seed.type,
    lgGraphCode: input.seed.lgGraphCode ?? null,
    lgGraphId: input.seed.lgGraphId ?? null,
    status: normalizeStatus(input.seed.status),
  });

  await createAgentVersion({
    id: versionId,
    templateId: template.id,
    contentHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    snapshot,
  });

  return { templateId: template.id, versionId };
}
