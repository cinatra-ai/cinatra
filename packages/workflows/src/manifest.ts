import { z } from "zod";
import { workflowSpecSchema } from "./spec/schema";
import { validateTemplate } from "./spec/validate";
import { lintWorkflowSpecForTriggerBundling } from "./lint/trigger-bundling";

// `cinatra.workflow` manifest: a workflow template packaged as a declarative
// `kind:"workflow"` marketplace extension. The `definition` is a WorkflowSpec
// (relative-scheduled, placeholdered DAG) and must be template-valid.

export const workflowTemplateManifestSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  definition: workflowSpecSchema,
});

export type WorkflowTemplateManifest = z.infer<typeof workflowTemplateManifestSchema>;

export type ManifestParseResult =
  | { ok: true; manifest: WorkflowTemplateManifest }
  | { ok: false; errors: string[] };

/**
 * Parse + fully validate a `cinatra.workflow` manifest: schema, the definition
 * must be template-valid, and the trigger-bundling lint must pass (install
 * check). Fail-closed with readable errors.
 */
export function parseWorkflowTemplateManifest(raw: unknown): ManifestParseResult {
  const parsed = workflowTemplateManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }
  const tpl = validateTemplate(parsed.data.definition);
  if (!tpl.ok) {
    return { ok: false, errors: tpl.errors.map((e) => `${e.path ?? ""} ${e.message}`.trim()) };
  }
  const lint = lintWorkflowSpecForTriggerBundling(parsed.data.definition);
  if (lint.length > 0) {
    return { ok: false, errors: lint.map((l) => l.message) };
  }
  return { ok: true, manifest: parsed.data };
}

const WORKFLOW_PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-workflow$/;

/**
 * Validate a `kind:"workflow"` extension package.json's `cinatra` block shape.
 * The workflow DEFINITION does not live inline — it ships as a
 * `cinatra/workflow.bpmn` sidecar parsed by `parseWorkflowBpmnSidecar` at install
 * time (which has the package-root path this function does not). This validator
 * therefore gates the block SHAPE: a valid workflow extension declares
 * `cinatra.kind:"workflow"` + a positive-integer `cinatra.workflowVersion`, carries
 * NO inline `cinatra.workflow`, and no unexpected `cinatra` keys.
 */
export function validateWorkflowExtensionPackage(pkg: {
  name?: unknown;
  cinatra?: Record<string, unknown>;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const cinatra: Record<string, unknown> = pkg.cinatra ?? {};
  if (typeof pkg.name !== "string" || !WORKFLOW_PACKAGE_NAME_RE.test(pkg.name)) {
    errors.push(`package name must match @<scope>/<slug>-workflow (got ${JSON.stringify(pkg.name)})`);
  }
  if (cinatra.kind !== "workflow") {
    errors.push(`package.json must declare cinatra.kind: "workflow" (got ${JSON.stringify(cinatra.kind)})`);
  }
  // Inline JSON workflow definitions are forbidden — ship cinatra/workflow.bpmn.
  if (cinatra.workflow !== undefined) {
    errors.push("inline cinatra.workflow is forbidden; ship a cinatra/workflow.bpmn sidecar (bpmn_inline_definition_forbidden)");
  }
  // Companion integer version — the sidecar manifest's version source.
  if (typeof cinatra.workflowVersion !== "number" || !Number.isInteger(cinatra.workflowVersion) || cinatra.workflowVersion <= 0) {
    errors.push(`cinatra.workflowVersion must be a positive integer (got ${JSON.stringify(cinatra.workflowVersion)}) (manifest_workflow_version_missing)`);
  }
  // `dependencies` is the canonical cross-kind ExtensionDependency[] declaration
  // every extension manifest carries (validated by the extension-deps gate); it
  // is a permitted key on a workflow package, not unexpected drift.
  const allowed = new Set(["kind", "apiVersion", "workflowVersion", "dependencies"]);
  for (const k of Object.keys(cinatra)) {
    if (!allowed.has(k)) errors.push(`unexpected cinatra key "${k}"`);
  }
  return { valid: errors.length === 0, errors };
}
