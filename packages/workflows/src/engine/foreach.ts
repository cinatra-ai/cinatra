// Foreach materializer (pure, side-effect-free).
//
// Inputs: a foreach parent task row + its declared foreach config + the
// source task's captured output. Output: a deterministic batch of `ChildPlan`
// records (task row + dependency rows + approval row) ready for the
// reconciler to bulk-INSERT under advisory lock.
//
// All errors are returned as a structured `ForeachStructuredError` — never
// thrown — so the reconciler can persist + classify them via its error path.
// Determinism: child task IDs are sha256-derived; child task keys are
// `{parentKey}__{stableId}` (stableId from slugified itemKey or zero-padded
// index). Two runs over the same source output produce byte-identical rows.

import { createHash } from "node:crypto";
import {
  FOREACH_MAX_FANOUT_DEFAULT,
  FOREACH_MAX_FANOUT_HARD_CEILING,
  type ForeachRollupPolicy,
} from "../spec/schema";

// ---------- Structured-error shapes ----------

export type ForeachStructuredError =
  | {
      code: "foreach_invalid_source_output";
      sourceTaskKey: string;
      foreachParentKey: string;
      receivedShape: string;
    }
  | {
      code: "foreach_invalid_item_key";
      sourceTaskKey: string;
      foreachParentKey: string;
      itemIndex: number;
      rawValue: unknown;
    }
  | {
      code: "foreach_duplicate_item_key";
      sourceTaskKey: string;
      foreachParentKey: string;
      duplicateStableId: string;
      indices: [number, number];
    }
  | {
      code: "foreach_max_fanout_exceeded";
      sourceTaskKey: string;
      foreachParentKey: string;
      actual: number;
      limit: number;
      hardCeiling: typeof FOREACH_MAX_FANOUT_HARD_CEILING;
    }
  | {
      code: "foreach_unresolved_dependency";
      foreachParentKey: string;
      childStableId: string;
      attemptedDependencyKey: string;
    };

export function isForeachError(value: unknown): value is ForeachStructuredError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    ((value as { code: string }).code).startsWith("foreach_")
  );
}

// ---------- Public shapes consumed by the reconciler ----------

export type ChildTaskRowInsert = {
  id: string;
  workflowId: string;
  key: string;
  type: string;
  title: string;
  parentTaskId: string;
  assigneeLevel: string | null;
  assigneeId: string | null;
  agentPackage: string | null;
  agentRef: Record<string, unknown> | null;
  input: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  anchor: Record<string, unknown> | null;
  status: "idle";
  required: boolean;
  failurePolicy: string | null;
  missedWindowPolicy: string | null;
  retryPolicy: Record<string, unknown> | null;
  maxAttempts: number | null;
  cancelPolicy: Record<string, unknown> | null;
  pinned: boolean;
  risk: string | null;
  foreachConfig: null; // children never carry their own foreach.
  metadata: Record<string, unknown>;
};

export type ChildDependencyInsert = {
  id: string;
  workflowId: string;
  taskKey: string;
  dependsOnTaskKey: string;
  outcome: "success" | "skipped" | "failed";
};

export type ChildApprovalInsert = {
  id: string;
  workflowId: string;
  taskKey: string;
  requiredScope: Record<string, unknown>;
  status: "pending";
};

export type ChildPlan = {
  taskRow: ChildTaskRowInsert;
  dependencies: ChildDependencyInsert[];
  approval: ChildApprovalInsert | null;
};

export type MaterializationResult = {
  plans: ChildPlan[];
  parentTaskId: string;
  parentKey: string;
};

// ---------- Pure helpers ----------

// Slugify: lowercase, strict ASCII [a-zA-Z0-9_-], max 32 chars,
// truncation suffixed with `__<4-char-hash>`.
function slugifyItemKey(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).toLowerCase();
  const cleaned = s.replace(/[^a-z0-9_-]/g, "");
  if (cleaned.length === 0) return "";
  if (cleaned.length <= 32) return cleaned;
  const hashSuffix = createHash("sha256").update(s).digest("hex").slice(0, 4);
  return `${cleaned.slice(0, 26)}__${hashSuffix}`;
}

// Extract a nested value from an object by dot-path; non-object hops or
// missing keys return undefined.
function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// Substitute Mustache-style `{{var}}` / `{{var.path}}` / `{{$index}}` etc.
// Whole-string token (e.g. `"{{var}}"`) returns the raw value; partial tokens
// return the string-coerced value embedded in the surrounding text.
function substituteString(
  s: string,
  asName: string,
  item: unknown,
  ctx: { index: number; position: number; total: number },
): unknown {
  const wholeMatch = s.match(/^\{\{\s*([a-zA-Z$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$.]+)?)\s*\}\}$/);
  const resolveVar = (varExpr: string): unknown => {
    if (varExpr === "$index") return ctx.index;
    if (varExpr === "$position") return ctx.position;
    if (varExpr === "$total") return ctx.total;
    if (varExpr === asName) return item;
    if (varExpr.startsWith(`${asName}.`)) return getByPath(item, varExpr.slice(asName.length + 1));
    return undefined; // unknown variables left as-is below
  };

  if (wholeMatch) {
    const resolved = resolveVar(wholeMatch[1]);
    return resolved === undefined ? s : resolved;
  }

  return s.replace(/\{\{\s*([a-zA-Z$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$.]+)?)\s*\}\}/g, (raw, expr: string) => {
    const v = resolveVar(expr);
    if (v === undefined) return raw;
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

function substituteValue(
  value: unknown,
  asName: string,
  item: unknown,
  ctx: { index: number; position: number; total: number },
): unknown {
  if (typeof value === "string") return substituteString(value, asName, item, ctx);
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, asName, item, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteValue(v, asName, item, ctx);
    }
    return out;
  }
  return value;
}

// Deterministic child task ID: prefixed sha256 of (workflowId, parentKey,
// stableId). 24-char hex prefix → 96 bits of collision space (huge headroom
// vs the 500-child hard ceiling per foreach).
export function deterministicChildTaskId(workflowId: string, parentKey: string, stableId: string): string {
  const hash = createHash("sha256")
    .update(`${workflowId}__${parentKey}__${stableId}`)
    .digest("hex")
    .slice(0, 24);
  return `wtask_${hash}`;
}

// Deterministic sidecar IDs: dependency and
// approval row IDs are derived from the child task ID + a sidecar discriminator
// so two runs of `materializeForeachChildren` over identical input produce
// byte-identical `ChildPlan` records. Required for the materializer's purity
// contract and for ON CONFLICT DO NOTHING idempotency at INSERT time.
function deterministicSidecarId(prefix: "dep" | "wapp", childTaskId: string, discriminator: string): string {
  const hash = createHash("sha256")
    .update(`${childTaskId}__${prefix}__${discriminator}`)
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

// ---------- Materializer entry point ----------

export type ForeachConfig = {
  source: string;
  as: string;
  itemKey?: string | null;
  template: Record<string, unknown>; // already-validated taskSchema instance
  rollupPolicy?: ForeachRollupPolicy;
  maxFanout?: number;
};

export type ParentTaskHandle = {
  id: string;
  key: string;
};

export type MaterializeForeachInput = {
  workflowId: string;
  parent: ParentTaskHandle;
  foreachConfig: ForeachConfig;
  sourceOutput: unknown;
  // workflow-global key→id map (for cross-batch dependsOn resolution).
  workflowTaskIdByKey: ReadonlyMap<string, string>;
};

export function materializeForeachChildren(
  args: MaterializeForeachInput,
): MaterializationResult | ForeachStructuredError {
  const { workflowId, parent, foreachConfig: fe, sourceOutput, workflowTaskIdByKey } = args;

  // Source-output shape check.
  if (
    !sourceOutput ||
    typeof sourceOutput !== "object" ||
    !Array.isArray((sourceOutput as { items?: unknown }).items)
  ) {
    return {
      code: "foreach_invalid_source_output",
      sourceTaskKey: fe.source,
      foreachParentKey: parent.key,
      receivedShape:
        sourceOutput === null
          ? "null"
          : Array.isArray(sourceOutput)
            ? "array"
            : typeof sourceOutput === "object"
              ? `object(keys=${Object.keys(sourceOutput).join(",")})`
              : typeof sourceOutput,
    };
  }

  const items = (sourceOutput as { items: unknown[] }).items;
  const total = items.length;

  // Max-fanout enforcement (declared + hard ceiling).
  const declaredLimit = fe.maxFanout ?? FOREACH_MAX_FANOUT_DEFAULT;
  const effectiveLimit = Math.min(declaredLimit, FOREACH_MAX_FANOUT_HARD_CEILING);
  if (total > effectiveLimit) {
    return {
      code: "foreach_max_fanout_exceeded",
      sourceTaskKey: fe.source,
      foreachParentKey: parent.key,
      actual: total,
      limit: effectiveLimit,
      hardCeiling: FOREACH_MAX_FANOUT_HARD_CEILING,
    };
  }

  // Resolve stableIds for every item.
  const stableIds: string[] = [];
  const seenStable = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    let stable: string;
    let raw: unknown;
    if (fe.itemKey) {
      raw = getByPath(items[i], fe.itemKey);
      if (raw === undefined || raw === null) {
        // Fallback to zero-padded index when itemKey path is empty for THIS item.
        stable = String(i).padStart(4, "0");
      } else {
        stable = slugifyItemKey(raw);
        if (!stable) {
          return {
            code: "foreach_invalid_item_key",
            sourceTaskKey: fe.source,
            foreachParentKey: parent.key,
            itemIndex: i,
            rawValue: raw,
          };
        }
      }
    } else {
      stable = String(i).padStart(4, "0");
    }

    if (seenStable.has(stable)) {
      return {
        code: "foreach_duplicate_item_key",
        sourceTaskKey: fe.source,
        foreachParentKey: parent.key,
        duplicateStableId: stable,
        indices: [seenStable.get(stable) as number, i],
      };
    }
    seenStable.set(stable, i);
    stableIds.push(stable);
  }

  // Pre-compute the batch's key→id map so sibling dependsOn refs resolve.
  // (Currently no nested foreach allowed, so children CAN reference each other
  // via dependsOn inside the same batch — siblings still get distinct rows.)
  const batchKeyToId = new Map<string, string>();
  for (let i = 0; i < items.length; i++) {
    const stable = stableIds[i];
    const childKey = `${parent.key}__${stable}`;
    const childId = deterministicChildTaskId(workflowId, parent.key, stable);
    batchKeyToId.set(childKey, childId);
  }

  // Build ChildPlans.
  const plans: ChildPlan[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stable = stableIds[i];
    const childKey = `${parent.key}__${stable}`;
    const childId = batchKeyToId.get(childKey) as string;
    const ctx = { index: i, position: i + 1, total };

    // Substitute placeholders into the template — produces a concrete task shape.
    const tmpl = substituteValue(fe.template, fe.as, item, ctx) as Record<string, unknown>;

    const taskType = String(tmpl.type ?? "agent_task");
    const title = String(tmpl.title ?? `${parent.key}/${stable}`);

    const taskRow: ChildTaskRowInsert = {
      id: childId,
      workflowId,
      key: childKey,
      type: taskType,
      title,
      parentTaskId: parent.id,
      assigneeLevel:
        ((tmpl.assignee as { level?: string } | undefined)?.level ?? null) as string | null,
      assigneeId:
        ((tmpl.assignee as { id?: string } | undefined)?.id ?? null) as string | null,
      agentPackage:
        taskType === "agent_task"
          ? (((tmpl.agentRef as { package?: string } | undefined)?.package) ?? null)
          : null,
      agentRef:
        taskType === "agent_task"
          ? ((tmpl.agentRef as Record<string, unknown> | undefined) ?? null)
          : null,
      input:
        taskType === "agent_task"
          ? ((tmpl.input as Record<string, unknown> | undefined) ?? null)
          : null,
      schedule: (tmpl.schedule as Record<string, unknown> | undefined) ?? null,
      anchor: null, // anchor is reconstruction-derived, not template-supplied
      status: "idle",
      required: tmpl.required === undefined ? true : Boolean(tmpl.required),
      failurePolicy: (tmpl.failurePolicy as string | undefined) ?? null,
      missedWindowPolicy: (tmpl.missedWindowPolicy as string | undefined) ?? null,
      retryPolicy: (tmpl.retryPolicy as Record<string, unknown> | undefined) ?? null,
      maxAttempts: (tmpl.maxAttempts as number | undefined) ?? null,
      cancelPolicy: (tmpl.cancelPolicy as Record<string, unknown> | undefined) ?? null,
      pinned: Boolean(tmpl.pinned ?? false),
      risk: (tmpl.risk as string | undefined) ?? null,
      foreachConfig: null,
      metadata: {},
    };

    // Resolve dependsOn refs: prefer batch (sibling) first, fall back to global.
    const dependencies: ChildDependencyInsert[] = [];
    const tmplDeps = (tmpl.dependsOn as Array<{ taskKey: string; outcome?: string }> | undefined) ?? [];
    for (const dep of tmplDeps) {
      // A template dependsOn referring to "self-as-parent" via `as.path` makes
      // no sense for child rows — siblings reference workflow-global keys by
      // exact match. The batch's keys are `${parent.key}__${stableId}`, so
      // siblings would need that exact form OR a sibling-stableId resolver.
      // We require workflow-global names ONLY (children-as-source-of-
      // children would couple siblings non-deterministically; same rationale
      // as nested-foreach ban).
      if (workflowTaskIdByKey.has(dep.taskKey) || batchKeyToId.has(dep.taskKey)) {
        dependencies.push({
          id: deterministicSidecarId("dep", childId, dep.taskKey),
          workflowId,
          taskKey: childKey,
          dependsOnTaskKey: dep.taskKey,
          outcome: (dep.outcome as "success" | "skipped" | "failed" | undefined) ?? "success",
        });
      } else {
        return {
          code: "foreach_unresolved_dependency",
          foreachParentKey: parent.key,
          childStableId: stable,
          attemptedDependencyKey: dep.taskKey,
        };
      }
    }

    // Approval sidecar.
    let approval: ChildApprovalInsert | null = null;
    if (taskType === "approval" && tmpl.requiredScope && typeof tmpl.requiredScope === "object") {
      approval = {
        id: deterministicSidecarId("wapp", childId, "approval"),
        workflowId,
        taskKey: childKey,
        requiredScope: tmpl.requiredScope as Record<string, unknown>,
        status: "pending",
      };
    }

    plans.push({ taskRow, dependencies, approval });
  }

  return { plans, parentTaskId: parent.id, parentKey: parent.key };
}
