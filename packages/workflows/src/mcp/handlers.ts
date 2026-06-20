import {
  validateTemplate,
  validateDraft,
  validateStart,
  type WorkflowSpec,
  type StructuredSpecError,
} from "../spec";
import { PLACEHOLDER_TOKEN_RE } from "../spec/types";
import { resolveSchedule, computeCascadeDiff } from "../schedule/resolver";
import { lintWorkflowSpecForTriggerBundling } from "../lint/trigger-bundling";
import {
  isReadable,
  filterReadable,
  canManage,
  buildWorkflowResourceRef,
  type WorkflowActor,
  type ScopedRow,
} from "../scope/resource-ref";
import {
  createWorkflowFromSpec,
  updateWorkflowDraftSpec,
  readWorkflow,
  listWorkflows,
  reconstructSpec,
  createWorkflowTemplate,
  readWorkflowTemplate,
  listWorkflowTemplates,
  listWorkflowArtifacts,
} from "../store";

// Pure MCP handlers — proposal-only. No mcp-server import (kept unit-testable);
// the registry builds the actor + wraps results. Host authz/agent-existence/
// project-archive are INJECTED via deps so the package stays a leaf.

type LooseActor = Record<string, unknown>;
export type PrimitiveRequest<T = Record<string, unknown>> = {
  primitiveName: string;
  input: T;
  actor: LooseActor;
  mode: string;
};

export type WorkflowHandlerDeps = {
  /** Project EXISTENCE + not-archived gate (host: SELECT on projects). Used by the
   *  draft-update path. NOTE: this is NOT a write-grant check — see
   *  `assertProjectWriteAccess` for the actor-grant gate. */
  assertProjectWritable?: (projectId: string) => void | Promise<void>;
  /** Actor WRITE-GRANT gate on a Cinatra project. Host resolves the actor's
   *  projectGrants app-side and calls the live `assertProjectWritable`
   *  (which reads actor.projectGrants). Throws/rejects fail-closed on deny BEFORE
   *  any DB write. Used by workflow_template_instantiate's top-level projectId. */
  assertProjectWriteAccess?: (
    actor: { userId: string | null; orgId: string | null; teamIds?: readonly string[]; orgRole?: string | null },
    projectId: string,
    mode: "write" | "admin",
  ) => Promise<void>;
  /** Agent existence + authz in the org (host: agents catalog). Re-auth at instantiate. */
  agentExists?: (agentRef: unknown, orgId: string) => boolean | Promise<boolean>;
  /** Approver scope resolvable in the org (host). */
  approverResolvable?: (scope: unknown, orgId: string) => boolean | Promise<boolean>;
  /**
   * Uniform extension-access gate for EXTENSION-ORIGIN workflow templates
   * (templates whose `origin.package` names an installed workflow
   * extension). The host resolves the canonical `installed_extension` for the
   * package and delegates to `enforceExtensionAccess` (kept here as a
   * host-injected dep so `packages/workflows` does NOT import
   * `@cinatra-ai/extensions` — the dependency runs the other way). Throws /
   * rejects fail-closed on deny. Operator-authored templates (no
   * `origin.package`) are NOT gated here — they keep their existing row-scope
   * checks (`isReadable`). When the dep is absent (e.g. tests / non-host
   * callers) extension-origin templates are NOT additionally gated.
   */
  assertExtensionAccess?: (
    actor: { userId: string | null; orgId: string | null; teamIds?: readonly string[]; orgRole?: string | null; platformRole?: string | null },
    sourcePackage: string,
    op: "list" | "read" | "use" | "execute",
  ) => Promise<void>;
  /**
   * Extension dependency-closure gate on the INSTANTIATE boundary for
   * EXTENSION-ORIGIN templates. The host resolves the governing canonical
   * `installed_extension` row for the package (actor-org row first, then the
   * platform row — the same row-selection order as `assertExtensionAccess`)
   * and evaluates its dependency closure: a broken REQUIRED closure, or a
   * missing OPTIONAL dep under the workflow kind's declared
   * "fail-instantiate" behavior (`optionalMissingBehaviorForKind`), throws /
   * rejects fail-closed. Host-injected so `packages/workflows` does NOT
   * import `@cinatra-ai/extensions`. Operator-authored templates (no
   * `origin.package`) are not gated; when the dep is absent (tests /
   * non-host callers) extension-origin templates are NOT additionally gated.
   */
  assertTemplateSourceDependencyClosure?: (
    actor: { userId: string | null; orgId: string | null },
    sourcePackage: string,
  ) => Promise<void>;
};

/** Extract an extension-origin package name from a template row's origin jsonb. */
function templateSourcePackage(tmpl: { origin?: Record<string, unknown> | null }): string | null {
  const pkg = (tmpl.origin as { package?: unknown } | null)?.package;
  return typeof pkg === "string" && pkg.length > 0 ? pkg : null;
}

const DEEP_LINK = (id: string) => `/workflows/${id}`;
const handoff = (workflowId: string, extra: Record<string, unknown> = {}) => ({
  workflowId,
  deepLink: DEEP_LINK(workflowId),
  // The chat handoff renders as a workflow deep-link card. (Was "gantt" before
  // the built-in GANTT was removed in cinatra#321; the deep link targets the
  // workflow detail page — task list + lifecycle controls — not a chart.)
  renderHint: "workflow" as const,
  ...extra,
});

function getActor(actor: LooseActor): WorkflowActor & { orgId: string | null; userId: string | null } {
  const s = (k: string) => (typeof actor[k] === "string" ? (actor[k] as string) : null);
  const arr = (k: string) => (Array.isArray(actor[k]) ? (actor[k] as string[]) : undefined);
  return {
    organizationId: s("orgId"),
    orgId: s("orgId"),
    userId: s("userId"),
    teamIds: arr("teamIds"),
    projectIds: arr("projectIds"),
    orgRole: s("orgRole"),
    platformRole: s("platformRole"),
  };
}

type MaterializeResult =
  | { ok: true; spec: WorkflowSpec; draft: ReturnType<typeof validateDraft> }
  | { ok: false; errors: StructuredSpecError[] };

/** Shared gate for EVERY spec-accepting tool: structural validation + resource
 *  limits (inside validateTemplate) + trigger-bundling lint, fail-closed. */
function materializeSpec(rawSpec: unknown): MaterializeResult {
  const tpl = validateTemplate(rawSpec);
  if (!tpl.ok || !tpl.spec) return { ok: false, errors: tpl.errors };
  const lint = lintWorkflowSpecForTriggerBundling(tpl.spec);
  if (lint.length > 0) {
    return { ok: false, errors: lint.map((l) => ({ code: l.code, message: l.message, path: l.path })) };
  }
  return { ok: true, spec: tpl.spec, draft: validateDraft(tpl.spec) };
}

function fillPlaceholders<T>(value: T, inputs: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_TOKEN_RE, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(inputs, name) ? String(inputs[name]) : m,
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, inputs)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fillPlaceholders(v, inputs);
    }
    return out as unknown as T;
  }
  return value;
}

function rowScope(row: {
  ownerLevel: string | null;
  ownerId: string | null;
  orgId: string;
  projectId: string | null;
}): ScopedRow {
  return { orgId: row.orgId, ownerLevel: row.ownerLevel, ownerId: row.ownerId, projectId: row.projectId };
}

async function reauthorizeReferences(
  deps: WorkflowHandlerDeps,
  spec: WorkflowSpec,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  if (deps.agentExists) {
    for (const t of spec.tasks) {
      if (t.type === "agent_task" && !(await deps.agentExists(t.agentRef, orgId))) {
        return { ok: false, code: "AGENT_NOT_FOUND", error: `Agent for task "${t.key}" is not available in this organization.` };
      }
    }
  }
  if (deps.approverResolvable) {
    for (const t of spec.tasks) {
      if (t.type === "approval" && !(await deps.approverResolvable(t.requiredScope, orgId))) {
        return { ok: false, code: "APPROVER_UNRESOLVABLE", error: `Approver scope for task "${t.key}" cannot be resolved.` };
      }
    }
  }
  return { ok: true };
}

// filter the workflow_task row for MCP DTOs. INCLUDES the
// foreach-specific metadata sentinel + rollup booleans (clients want
// telemetry of materialization errors + best_effort/any_fails settles);
// OMITS foreach_config (internal authoring shape) and every other metadata
// key (engine-internal state, never exposed).
export const ALLOWED_METADATA_KEYS = [
  "foreach_materialization_error",
  "foreach_has_failure",
  "foreach_has_success",
] as const;

export function pickPublicMetadata(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED_METADATA_KEYS) {
    if (k in meta) out[k] = meta[k as string];
  }
  return out;
}

export function toPublicTaskDto<T extends {
  id: string;
  key: string;
  type: string;
  title: string;
  status: string;
  parentTaskId?: string | null;
  plannedStartUtc?: Date | string | null;
  plannedEndUtc?: Date | string | null;
  actualStartUtc?: Date | string | null;
  actualEndUtc?: Date | string | null;
  dueAtUtc?: Date | string | null;
  required?: boolean;
  failurePolicy?: string | null;
  missedWindowPolicy?: string | null;
  pinned?: boolean;
  risk?: string | null;
  agentPackage?: string | null;
  agentRef?: Record<string, unknown> | null;
  input?: Record<string, unknown> | null;
  schedule?: Record<string, unknown> | null;
  anchor?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}>(t: T) {
  return {
    id: t.id,
    key: t.key,
    type: t.type,
    title: t.title,
    status: t.status,
    parentTaskId: t.parentTaskId ?? null,
    plannedStartUtc: t.plannedStartUtc ?? null,
    plannedEndUtc: t.plannedEndUtc ?? null,
    actualStartUtc: t.actualStartUtc ?? null,
    actualEndUtc: t.actualEndUtc ?? null,
    dueAtUtc: t.dueAtUtc ?? null,
    required: t.required ?? true,
    failurePolicy: t.failurePolicy ?? null,
    missedWindowPolicy: t.missedWindowPolicy ?? null,
    pinned: t.pinned ?? false,
    risk: t.risk ?? null,
    agentPackage: t.agentPackage ?? null,
    agentRef: t.agentRef ?? null,
    input: t.input ?? null,
    schedule: t.schedule ?? null,
    anchor: t.anchor ?? null,
    metadata: pickPublicMetadata(t.metadata ?? null),
    // foreach_config is intentionally NOT exposed.
  };
}

function statusSummary(result: NonNullable<Awaited<ReturnType<typeof readWorkflow>>>) {
  const { workflow: wf, tasks } = result;
  return {
    id: wf.id,
    name: wf.name,
    status: wf.status,
    targetAtUtc: wf.targetAtUtc,
    lockVersion: wf.lockVersion,
    tasks: tasks.map((t) => ({
      key: t.key,
      type: t.type,
      title: t.title,
      status: t.status,
      plannedStartUtc: t.plannedStartUtc,
      plannedEndUtc: t.plannedEndUtc,
      dueAtUtc: t.dueAtUtc,
      // expose foreach rollup + materialization-error sentinels.
      metadata: pickPublicMetadata(t.metadata ?? null),
    })),
  };
}

export function createWorkflowPrimitiveHandlers(deps: WorkflowHandlerDeps = {}) {
  return {
    workflow_template_list: async (req: PrimitiveRequest) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      const rows = await listWorkflowTemplates({ orgId: actor.orgId });
      const visible = filterReadable(rows, actor);
      // Drop extension-origin templates the actor cannot list.
      // Operator-authored templates (no origin.package) pass through. No dep →
      // no extension gating (non-host caller).
      let listable = visible;
      if (deps.assertExtensionAccess) {
        const gate = deps.assertExtensionAccess;
        const checks = await Promise.all(
          visible.map(async (t) => {
            const sourcePackage = templateSourcePackage(t);
            if (!sourcePackage) return true;
            try {
              await gate(actor, sourcePackage, "list");
              return true;
            } catch {
              return false;
            }
          }),
        );
        listable = visible.filter((_, i) => checks[i]);
      }
      return { templates: listable.map((t) => ({ id: t.id, key: t.key, version: t.version, name: t.name })) };
    },

    // Fetch one template's placeholders + metadata so a launcher can render
    // typed pickers. Mirrors workflow_template_instantiate's visibility: an
    // unreadable OR missing template returns the SAME hidden NOT_FOUND envelope
    // (no payload leak).
    workflow_template_get: async (req: PrimitiveRequest<{ templateId?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      if (!req.input.templateId) return { error: "templateId is required." };
      const tmpl = await readWorkflowTemplate(req.input.templateId);
      if (!tmpl || !isReadable(rowScope(tmpl), actor)) return { error: "Template not found.", code: "NOT_FOUND" };
      // Extension-origin template read gate. Hidden NOT_FOUND on deny (no
      // payload leak), matching the row-scope visibility above.
      {
        const sourcePackage = templateSourcePackage(tmpl);
        if (sourcePackage && deps.assertExtensionAccess) {
          try {
            await deps.assertExtensionAccess(actor, sourcePackage, "read");
          } catch {
            return { error: "Template not found.", code: "NOT_FOUND" };
          }
        }
      }
      const def = tmpl.definition as unknown as WorkflowSpec;
      return {
        id: tmpl.id,
        key: tmpl.key,
        version: tmpl.version,
        name: tmpl.name,
        placeholders: def.placeholders ?? {},
        metadata: def.metadata ?? {},
      };
    },

    workflow_draft_create: async (req: PrimitiveRequest<{ spec?: unknown }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId || !actor.userId) return { error: "Active organization + user required." };
      const mat = materializeSpec(req.input.spec);
      if (!mat.ok) return { error: "Spec is invalid.", validation: { errors: mat.errors } };
      const { workflowId } = await createWorkflowFromSpec({
        spec: mat.spec,
        name: mat.spec.name,
        product: mat.spec.product ?? null,
        status: "draft",
        orgId: actor.orgId,
        ownerLevel: "user",
        ownerId: actor.userId,
        createdBy: actor.userId,
      });
      return handoff(workflowId, { validation: { draftValid: mat.draft.ok, errors: mat.draft.errors } });
    },

    workflow_draft_update: async (
      req: PrimitiveRequest<{ workflowId?: string; spec?: unknown; expectedLockVersion?: number; name?: string }>,
    ) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      const { workflowId, expectedLockVersion } = req.input;
      if (!workflowId || typeof expectedLockVersion !== "number") {
        return { error: "workflowId and expectedLockVersion are required." };
      }
      const existing = await readWorkflow(workflowId);
      if (!existing || !isReadable(rowScope(existing.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
      if (!canManage(rowScope(existing.workflow), actor)) return { error: "You cannot edit this workflow.", code: "FORBIDDEN" };
      if (existing.workflow.status !== "draft") {
        return { error: "Only draft workflows can be edited from chat. Manage active workflows on the workflow page.", code: "DRAFT_ONLY" };
      }
      const mat = materializeSpec(req.input.spec);
      if (!mat.ok) return { error: "Spec is invalid.", validation: { errors: mat.errors } };
      if (existing.workflow.projectId && deps.assertProjectWritable) {
        await deps.assertProjectWritable(existing.workflow.projectId);
      }
      const res = await updateWorkflowDraftSpec({
        workflowId,
        spec: mat.spec,
        name: req.input.name,
        expectedLockVersion,
      });
      if (!res.ok) return { error: `Update failed (${res.reason}).`, code: res.reason };
      return handoff(workflowId, { lockVersion: res.lockVersion, validation: { draftValid: mat.draft.ok, errors: mat.draft.errors } });
    },

    workflow_draft_get: async (req: PrimitiveRequest<{ workflowId?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      if (!req.input.workflowId) return { error: "workflowId is required." };
      const result = await readWorkflow(req.input.workflowId);
      if (!result || !isReadable(rowScope(result.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
      const spec = await reconstructSpec(req.input.workflowId);
      const timeline = spec ? resolveSchedule(spec).tasks : {};
      return { ...handoff(result.workflow.id), workflow: result.workflow, tasks: result.tasks.map(toPublicTaskDto), dependencies: result.dependencies, timeline };
    },

    workflow_draft_list: async (req: PrimitiveRequest<{ status?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      const rows = await listWorkflows({ orgId: actor.orgId, status: req.input.status });
      return { workflows: filterReadable(rows, actor).map((w) => ({ id: w.id, name: w.name, status: w.status, targetAtUtc: w.targetAtUtc })) };
    },

    workflow_validate: async (req: PrimitiveRequest<{ spec?: unknown }>) => {
      const tpl = validateTemplate(req.input.spec);
      const lint = tpl.ok && tpl.spec ? lintWorkflowSpecForTriggerBundling(tpl.spec) : [];
      const draft = validateDraft(req.input.spec);
      const start = validateStart(req.input.spec);
      return {
        template: { ok: tpl.ok, errors: tpl.errors },
        draft: { ok: draft.ok, errors: draft.errors },
        start: { ok: start.ok, errors: start.errors },
        triggerLint: lint,
      };
    },

    workflow_preview: async (req: PrimitiveRequest<{ spec?: unknown; workflowId?: string }>) => {
      const actor = getActor(req.actor);
      let rawSpec: unknown = req.input.spec;
      let workflowId: string | undefined = req.input.workflowId;
      if (workflowId) {
        if (!actor.orgId) return { error: "Active organization required." };
        const existing = await readWorkflow(workflowId);
        if (!existing || !isReadable(rowScope(existing.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
        rawSpec = await reconstructSpec(workflowId);
      }
      const mat = materializeSpec(rawSpec);
      if (!mat.ok) return { error: "Spec is invalid.", validation: { errors: mat.errors } };
      const resolved = resolveSchedule(mat.spec);
      return {
        ...(workflowId ? handoff(workflowId) : {}),
        validation: { draftValid: mat.draft.ok, errors: mat.draft.errors },
        timeline: resolved.tasks,
        warnings: resolved.warnings,
      };
    },

    workflow_status_get: async (req: PrimitiveRequest<{ workflowId?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      if (!req.input.workflowId) return { error: "workflowId is required." };
      const result = await readWorkflow(req.input.workflowId);
      if (!result || !isReadable(rowScope(result.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
      return statusSummary(result);
    },

    workflow_artifacts_list: async (req: PrimitiveRequest<{ workflowId?: string; taskId?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      if (!req.input.workflowId) return { error: "workflowId is required." };
      const result = await readWorkflow(req.input.workflowId);
      if (!result || !isReadable(rowScope(result.workflow), actor)) {
        return { error: "Workflow not found.", code: "NOT_FOUND" };
      }
      const rows = await listWorkflowArtifacts(req.input.workflowId, req.input.taskId);
      return {
        artifacts: rows.map((r) => ({
          id: r.id,
          workflowId: r.workflowId,
          taskId: r.taskId,
          kind: r.kind,
          ref: r.ref,
          version: r.version,
          pinned: r.pinned,
          authoringStepId: r.authoringStepId ?? null,
          createdAt: r.createdAt,
        })),
      };
    },

    workflow_status_list: async (req: PrimitiveRequest<{ status?: string; projectId?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      // Optional projectId filter for the workflow-status portlet's project-scope
      // mode (workflow.project_id). Visibility filtering is unchanged.
      const rows = filterReadable(
        await listWorkflows({ orgId: actor.orgId, status: req.input.status, projectId: req.input.projectId }),
        actor,
      );
      return { workflows: rows.map((w) => ({ id: w.id, name: w.name, status: w.status, targetAtUtc: w.targetAtUtc })) };
    },

    workflow_template_instantiate: async (
      req: PrimitiveRequest<{ templateId?: string; name?: string; inputs?: Record<string, unknown>; targetAt?: string; targetTz?: string; projectId?: string }>,
    ) => {
      const actor = getActor(req.actor);
      if (!actor.orgId || !actor.userId) return { error: "Active organization + user required." };
      if (!req.input.templateId) return { error: "templateId is required." };
      const tmpl = await readWorkflowTemplate(req.input.templateId);
      if (!tmpl || !isReadable(rowScope(tmpl), actor)) return { error: "Template not found.", code: "NOT_FOUND" };

      // Extension-origin templates are gated by the uniform extension-access
      // model on the instantiate (execute) boundary. Fail closed BEFORE any DB
      // write. Operator-authored templates (no origin.package) keep only their
      // row-scope check above.
      {
        const sourcePackage = templateSourcePackage(tmpl);
        if (sourcePackage && deps.assertExtensionAccess) {
          try {
            await deps.assertExtensionAccess(actor, sourcePackage, "execute");
          } catch (e) {
            return {
              error: e instanceof Error ? e.message : "You cannot use this workflow extension.",
              code: "FORBIDDEN",
            };
          }
        }
        // Dependency-closure gate (after access): the workflow kind declares
        // optional-missing as "fail-instantiate", so a source extension with a
        // broken required closure OR missing optional deps refuses to
        // instantiate. Fail closed BEFORE any DB write.
        if (sourcePackage && deps.assertTemplateSourceDependencyClosure) {
          try {
            await deps.assertTemplateSourceDependencyClosure(actor, sourcePackage);
          } catch (e) {
            return {
              error:
                e instanceof Error
                  ? e.message
                  : "This workflow extension's dependencies are not satisfied.",
              code: "DEPENDENCY_CLOSURE",
            };
          }
        }
      }

      // The optional top-level projectId tags the new workflow row's scope
      // (workflow.project_id). When supplied, the actor MUST hold write access
      // on that Cinatra project; fail closed BEFORE any DB write.
      if (req.input.projectId) {
        if (!deps.assertProjectWriteAccess) {
          return { error: "Project scoping is not available.", code: "PROJECT_SCOPE_UNAVAILABLE" };
        }
        try {
          await deps.assertProjectWriteAccess(actor, req.input.projectId, "write");
        } catch (e) {
          return { error: e instanceof Error ? e.message : "You cannot write to this project.", code: "FORBIDDEN" };
        }
      }

      // Required-placeholder enforcement BEFORE any materialization or DB
      // write. The template's placeholders Record declares `required:true` per
      // name; reject early with a structured error naming every missing key
      // (UI gating alone is insufficient — direct callers can omit fields, and
      // partial fills would land a draft with literal "{{x}}" text in tasks).
      // Empty-string values count as missing.
      const placeholders = (tmpl.definition as unknown as WorkflowSpec).placeholders ?? {};
      const supplied = req.input.inputs ?? {};
      const missing: string[] = [];
      for (const [name, decl] of Object.entries(placeholders)) {
        if (!decl?.required) continue;
        const v = supplied[name];
        if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
          missing.push(name);
        }
      }
      if (missing.length > 0) {
        return {
          error: `Required placeholder${missing.length > 1 ? "s" : ""} missing: ${missing.join(", ")}.`,
          code: "placeholder_required",
          missing,
        };
      }

      // Fill placeholders + set release; re-validate the materialized spec.
      let raw = fillPlaceholders(tmpl.definition as unknown as WorkflowSpec, req.input.inputs ?? {});
      if (req.input.targetAt || req.input.targetTz) {
        raw = {
          ...raw,
          target: { at: req.input.targetAt ?? raw.target?.at, tz: req.input.targetTz ?? raw.target?.tz ?? "UTC" },
        } as WorkflowSpec;
      }
      const mat = materializeSpec(raw);
      if (!mat.ok) return { error: "Instantiated spec is invalid.", validation: { errors: mat.errors } };

      const reauth = await reauthorizeReferences(deps, mat.spec, actor.orgId);
      if (!reauth.ok) return { error: reauth.error, code: reauth.code };

      const { workflowId } = await createWorkflowFromSpec({
        spec: mat.spec,
        name: req.input.name ?? mat.spec.name,
        product: mat.spec.product ?? null,
        status: "draft",
        sourceTemplateId: tmpl.id,
        sourceTemplateVersion: tmpl.version,
        orgId: actor.orgId,
        ownerLevel: "user",
        ownerId: actor.userId,
        createdBy: actor.userId,
        projectId: req.input.projectId ?? null,
      });
      return handoff(workflowId, { sourceTemplateId: tmpl.id, sourceTemplateVersion: tmpl.version, validation: { draftValid: mat.draft.ok, errors: mat.draft.errors } });
    },

    workflow_cascade_preview: async (req: PrimitiveRequest<{ workflowId?: string; targetAt?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId) return { error: "Active organization required." };
      if (!req.input.workflowId || !req.input.targetAt) return { error: "workflowId and targetAt are required." };
      const existing = await readWorkflow(req.input.workflowId);
      if (!existing || !isReadable(rowScope(existing.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
      const spec = await reconstructSpec(req.input.workflowId);
      if (!spec) return { error: "Workflow not found.", code: "NOT_FOUND" };
      const cascade = computeCascadeDiff(spec, { targetAtUtc: req.input.targetAt });
      // Return the workflow's current `lockVersion` with the preview so the target-date control's Apply
      // uses the exact version the preview was computed against. On stale at Apply time, the
      // UI refetches + recomputes the preview rather than committing a stale diff.
      return {
        ...handoff(req.input.workflowId),
        targetAt: req.input.targetAt,
        cascade,
        lockVersion: existing.workflow.lockVersion,
      };
    },

    workflow_copy: async (req: PrimitiveRequest<{ sourceWorkflowId?: string; name?: string; targetAt?: string }>) => {
      const actor = getActor(req.actor);
      if (!actor.orgId || !actor.userId) return { error: "Active organization + user required." };
      if (!req.input.sourceWorkflowId) return { error: "sourceWorkflowId is required." };
      const source = await readWorkflow(req.input.sourceWorkflowId);
      if (!source || !isReadable(rowScope(source.workflow), actor)) return { error: "Source workflow not found.", code: "NOT_FOUND" };
      let spec = await reconstructSpec(req.input.sourceWorkflowId);
      if (!spec) return { error: "Source workflow not found.", code: "NOT_FOUND" };
      if (req.input.targetAt) {
        spec = { ...spec, target: { at: req.input.targetAt, tz: spec.target?.tz ?? "UTC" } } as WorkflowSpec;
      }
      const mat = materializeSpec(spec);
      if (!mat.ok) return { error: "Copied spec is invalid.", validation: { errors: mat.errors } };
      const { workflowId } = await createWorkflowFromSpec({
        spec: mat.spec,
        name: req.input.name ?? `${source.workflow.name} (copy)`,
        product: mat.spec.product ?? null,
        status: "draft",
        orgId: actor.orgId,
        ownerLevel: "user",
        ownerId: actor.userId,
        createdBy: actor.userId,
      });
      return handoff(workflowId, { copiedFrom: source.workflow.id });
    },

    workflow_save_as_template: async (
      req: PrimitiveRequest<{ workflowId?: string; key?: string; name?: string; version?: number }>,
    ) => {
      const actor = getActor(req.actor);
      if (!actor.orgId || !actor.userId) return { error: "Active organization + user required." };
      if (!req.input.workflowId || !req.input.key) return { error: "workflowId and key are required." };
      const source = await readWorkflow(req.input.workflowId);
      if (!source || !isReadable(rowScope(source.workflow), actor)) return { error: "Workflow not found.", code: "NOT_FOUND" };
      if (!canManage(rowScope(source.workflow), actor)) return { error: "You cannot save this workflow as a template.", code: "FORBIDDEN" };
      const reconstructed = await reconstructSpec(req.input.workflowId);
      if (!reconstructed) return { error: "Workflow not found.", code: "NOT_FOUND" };
      // Re-validate, limit-check, and lint the materialized definition before persisting;
      // a template must not store an invalid or over-limit DAG.
      const mat = materializeSpec(reconstructed);
      if (!mat.ok) return { error: "Cannot save an invalid workflow as a template.", validation: { errors: mat.errors } };
      // Next version for this key.
      const existing = (await listWorkflowTemplates({ orgId: actor.orgId })).filter((t) => t.key === req.input.key);
      const version = req.input.version ?? (existing.reduce((m, t) => Math.max(m, t.version), 0) + 1);
      const tmpl = await createWorkflowTemplate({
        key: req.input.key,
        version,
        name: req.input.name ?? source.workflow.name,
        definition: mat.spec,
        // Scope is derived from the actor, not the source row: the saver owns
        // the template in their own org, with no cross-scope ownership.
        orgId: actor.orgId,
        ownerLevel: "user",
        ownerId: actor.userId,
        createdBy: actor.userId,
      });
      return { templateId: tmpl.id, key: tmpl.key, version: tmpl.version };
    },
  };
}
