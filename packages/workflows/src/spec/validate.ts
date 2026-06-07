import { workflowSpecSchema, type WorkflowSpec } from "./schema";
import { checkLimits, SPEC_LIMITS, type StructuredSpecError } from "./limits";
import { resolveSchedule, parseInstantMs } from "../schedule/resolver";
import { PLACEHOLDER_TOKEN_RE, TARGET_ANCHOR, type ValidationTier } from "./types";

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ValidationResult = {
  ok: boolean;
  tier: ValidationTier;
  errors: StructuredSpecError[];
  /** The parsed spec when schema parsing succeeded (even if higher-tier checks fail). */
  spec?: WorkflowSpec;
};

/** Optional injected resolvers for start-valid (deferred; scaffold here). */
export type StartContext = {
  agentExists?: (ref: unknown) => boolean;
  approverResolvable?: (scope: unknown) => boolean;
};

function zodErrorsToStructured(error: import("zod").ZodError): StructuredSpecError[] {
  return error.issues.map((issue) => ({
    code: `SCHEMA_${issue.code}`.toUpperCase(),
    message: issue.message,
    path: issue.path.join("."),
  }));
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

// Walk the spec and collect placeholder tokens with the FOREACH-SCOPED variable
// names for any subtree that lives inside a `foreach.template`. The set of
// scoped names (foreach.as) is dynamic — different foreach blocks declare
// different `as` names — so the walker accumulates the active scope at each
// template entry.
//
// Returns: a list of `{ token, scopedVars }` where `scopedVars` is the set of
// foreach-scoped names + the universal reserved-vars ($index/$position/$total)
// that are in scope at the point the token appeared. The caller filters out
// tokens whose name is in `scopedVars` before treating them as unresolved
// workflow placeholders.
function collectPlaceholderUsages(
  value: unknown,
  out: Array<{ token: string; scopedVars: Set<string> }>,
  activeScope: Set<string>,
): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER_TOKEN_RE)) {
      out.push({ token: m[1], scopedVars: activeScope });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPlaceholderUsages(v, out, activeScope);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "foreach" && v && typeof v === "object") {
        const fe = v as Record<string, unknown>;
        // Walk NON-template fields under the OUTER scope (they aren't template-
        // scoped).
        for (const [fk, fv] of Object.entries(fe)) {
          if (fk === "template") continue;
          collectPlaceholderUsages(fv, out, activeScope);
        }
        // Walk template under an EXTENDED scope: outer scope + this foreach's
        // declared `as` name + reserved-vars. Nested foreach is banned so we
        // don't need to layer more.
        if (fe.template) {
          const as = typeof fe.as === "string" ? fe.as : null;
          const extended = new Set(activeScope);
          if (as) extended.add(as);
          extended.add("$index");
          extended.add("$position");
          extended.add("$total");
          collectPlaceholderUsages(fe.template, out, extended);
        }
        continue;
      }
      collectPlaceholderUsages(v, out, activeScope);
    }
  }
}

function findUnresolvedPlaceholders(spec: WorkflowSpec): string[] {
  // scan the FULL spec including
  // foreach.template subtrees, but filter out tokens that match the
  // foreach-scoped variable name (the foreach's declared `as`) or the
  // reserved-vars ($index/$position/$total). This catches genuine workflow
  // placeholders inside templates while letting foreach-scoped bindings pass.
  const usages: Array<{ token: string; scopedVars: Set<string> }> = [];
  collectPlaceholderUsages(spec, usages, new Set());
  const unresolved = new Set<string>();
  for (const { token, scopedVars } of usages) {
    if (scopedVars.has(token)) continue;
    unresolved.add(token);
  }
  return [...unresolved];
}

/** Detect a cycle in a directed graph (adjacency map). Returns true if cyclic. */
function hasCycle(adjacency: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adjacency.keys()) color.set(k, WHITE);
  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };
  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) return true;
  }
  return false;
}

/**
 * template-valid: structurally a well-formed DAG. Placeholders allowed; concrete
 * inputs/release date NOT required.
 */
export function validateTemplate(input: unknown): ValidationResult {
  const parsed = workflowSpecSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, tier: "template", errors: zodErrorsToStructured(parsed.error) };
  }
  const spec = parsed.data;
  const errors: StructuredSpecError[] = [...checkLimits(spec)];

  if (spec.tasks.length === 0) {
    errors.push({ code: "EMPTY_SPEC", message: "A workflow must have at least one task." });
  }

  // Unique task keys.
  const keys = new Set<string>();
  const dupes = new Set<string>();
  for (const t of spec.tasks) {
    if (keys.has(t.key)) dupes.add(t.key);
    keys.add(t.key);
  }
  for (const k of dupes) {
    errors.push({ code: "DUPLICATE_TASK_KEY", message: `Duplicate task key "${k}".` });
  }

  // Dependency references + cycle.
  const depAdjacency = new Map<string, string[]>();
  for (const t of spec.tasks) depAdjacency.set(t.key, []);
  spec.tasks.forEach((t, i) => {
    (t.dependsOn ?? []).forEach((dep, j) => {
      if (!keys.has(dep.taskKey)) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY",
          message: `Task "${t.key}" depends on unknown task "${dep.taskKey}".`,
          path: `tasks[${i}].dependsOn[${j}].taskKey`,
        });
      } else {
        depAdjacency.get(t.key)!.push(dep.taskKey);
      }
      if (dep.taskKey === t.key) {
        errors.push({
          code: "SELF_DEPENDENCY",
          message: `Task "${t.key}" cannot depend on itself.`,
          path: `tasks[${i}].dependsOn[${j}].taskKey`,
        });
      }
    });
  });
  if (hasCycle(depAdjacency)) {
    errors.push({ code: "DEPENDENCY_CYCLE", message: "The dependency graph contains a cycle." });
  }

  // Schedule anchor references + cycle (relative anchors may chain through tasks).
  const anchorAdjacency = new Map<string, string[]>();
  for (const t of spec.tasks) anchorAdjacency.set(t.key, []);
  spec.tasks.forEach((t, i) => {
    if (t.schedule?.mode === "relative") {
      const anchor = t.schedule.anchor;
      if (anchor === TARGET_ANCHOR) {
        // ok — terminal anchor
      } else if (!keys.has(anchor)) {
        errors.push({
          code: "UNKNOWN_ANCHOR",
          message: `Task "${t.key}" schedule anchors to unknown task "${anchor}".`,
          path: `tasks[${i}].schedule.anchor`,
        });
      } else if (anchor === t.key) {
        errors.push({
          code: "SELF_ANCHOR",
          message: `Task "${t.key}" cannot anchor its schedule to itself.`,
          path: `tasks[${i}].schedule.anchor`,
        });
      } else {
        anchorAdjacency.get(t.key)!.push(anchor);
      }
    }
  });
  if (hasCycle(anchorAdjacency)) {
    errors.push({ code: "ANCHOR_CYCLE", message: "The schedule-anchor graph contains a cycle." });
  }

  // Hierarchy parent references + cycle. `parent` is a task key
  // in the same workflow; reject unknown/self parents and cycles up the tree.
  const parentAdjacency = new Map<string, string[]>();
  for (const t of spec.tasks) parentAdjacency.set(t.key, []);
  spec.tasks.forEach((t, i) => {
    if (t.parent === undefined) return;
    if (!keys.has(t.parent)) {
      errors.push({
        code: "UNKNOWN_PARENT",
        message: `Task "${t.key}" has unknown parent "${t.parent}".`,
        path: `tasks[${i}].parent`,
      });
    } else if (t.parent === t.key) {
      errors.push({
        code: "SELF_PARENT",
        message: `Task "${t.key}" cannot be its own parent.`,
        path: `tasks[${i}].parent`,
      });
    } else {
      parentAdjacency.get(t.key)!.push(t.parent);
    }
  });
  if (hasCycle(parentAdjacency)) {
    errors.push({ code: "PARENT_CYCLE", message: "The task hierarchy contains a cycle." });
  }

  // Summary-parent constraints: a task that IS a parent
  // (referenced as `parent` by any other task) has its window derived from its
  // children — own `schedule` or `pinned` would be ambiguous, so reject them
  // fail-loud. Children (with `parent` set) keep full schedule/pin capability.
  const hasChildren = new Set<string>();
  for (const t of spec.tasks) if (t.parent && keys.has(t.parent)) hasChildren.add(t.parent);
  spec.tasks.forEach((t, i) => {
    if (!hasChildren.has(t.key)) return;
    if (t.schedule) {
      errors.push({
        code: "PARENT_HAS_SCHEDULE",
        message: `Task "${t.key}" is a parent (has children) and cannot carry its own schedule; its window derives from its children.`,
        path: `tasks[${i}].schedule`,
      });
    }
    if (t.pinned) {
      errors.push({
        code: "PINNED_PARENT_INVALID",
        message: `Task "${t.key}" is a parent (has children) and cannot be pinned; its window derives from its children.`,
        path: `tasks[${i}].pinned`,
      });
    }
  });

  // Hierarchy ↔ schedule cross-cycle: a child whose
  // schedule anchors to one of its OWN ancestors would form a hidden cycle —
  // the parent-window derives from the child while the child's date derives
  // from the parent. Walk the parent chain via a key→parent map and reject if
  // any anchor lands on an ancestor.
  const parentByKey = new Map<string, string | undefined>();
  for (const t of spec.tasks) parentByKey.set(t.key, t.parent);
  const ancestorsOf = (key: string): Set<string> => {
    const acc = new Set<string>();
    let cur = parentByKey.get(key);
    let hops = 0;
    while (cur && !acc.has(cur) && hops < SPEC_LIMITS.maxTasks) {
      acc.add(cur);
      cur = parentByKey.get(cur);
      hops++;
    }
    return acc;
  };
  spec.tasks.forEach((t, i) => {
    if (t.schedule?.mode !== "relative") return;
    const anchor = t.schedule.anchor;
    if (anchor === TARGET_ANCHOR) return;
    if (ancestorsOf(t.key).has(anchor)) {
      errors.push({
        code: "HIERARCHY_SCHEDULE_CYCLE",
        message: `Task "${t.key}" anchors its schedule to ancestor "${anchor}"; the parent's window already derives from this child.`,
        path: `tasks[${i}].schedule.anchor`,
      });
    }
  });

  // foreach validation. Single-level only — nested foreach
  // is rejected outright.
  // Index-by-declaration-order map so we can enforce "source appears BEFORE
  // foreach parent in spec.tasks[]".
  const taskOrderByKey = new Map<string, number>();
  spec.tasks.forEach((t, idx) => taskOrderByKey.set(t.key, idx));

  spec.tasks.forEach((t, i) => {
    // Type widen — `foreach` is optional on every task type but the discriminated
    // union doesn't surface it at the union-narrow level.
    const fe = (t as { foreach?: {
      source: string;
      as: string;
      itemKey?: string | null;
      template: { dependsOn?: Array<{ taskKey: string; outcome?: string }> } & Record<string, unknown>;
      rollupPolicy?: string;
      maxFanout?: number;
    } }).foreach;
    if (!fe) return;

    // Source must reference a prior, distinct, known task key.
    if (!keys.has(fe.source)) {
      errors.push({
        code: "FOREACH_UNKNOWN_SOURCE",
        message: `Task "${t.key}" foreach.source references unknown task "${fe.source}".`,
        path: `tasks[${i}].foreach.source`,
      });
    } else if (fe.source === t.key) {
      errors.push({
        code: "FOREACH_SOURCE_SELF",
        message: `Task "${t.key}" foreach.source cannot reference itself.`,
        path: `tasks[${i}].foreach.source`,
      });
    } else {
      // enforce prior-ordering. A foreach can only
      // materialize after its source has terminalized, so the source MUST be
      // declared BEFORE the foreach parent in `spec.tasks[]`. Without this,
      // a workflow could declare them out of order and the engine would never
      // make progress (reconciler walks tasks in order).
      const sourceIdx = taskOrderByKey.get(fe.source) ?? Infinity;
      if (sourceIdx >= i) {
        errors.push({
          code: "FOREACH_SOURCE_NOT_PRIOR",
          message: `Task "${t.key}" foreach.source "${fe.source}" must be declared BEFORE the foreach parent in spec.tasks[] (foreach can only materialize after its source terminalizes).`,
          path: `tasks[${i}].foreach.source`,
        });
      }
    }

    // a foreach.template MAY NOT depend on the
    // foreach parent's own key (would deadlock — parent waits for children;
    // children wait for parent). Walk dependsOn at any nest depth inside the
    // template and reject if it transitively references the parent's key.
    const visitTemplateDeps = (node: unknown, p: string): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      const deps = (n.dependsOn as Array<{ taskKey?: string }> | undefined) ?? [];
      for (const dep of deps) {
        if (dep.taskKey === t.key) {
          errors.push({
            code: "FOREACH_TEMPLATE_DEPENDS_ON_PARENT",
            message: `Task "${t.key}" foreach.template (or nested template) declares dependsOn["${t.key}"] — that would deadlock (parent waits for children; children wait for parent).`,
            path: `tasks[${i}].foreach.${p}.dependsOn`,
          });
        }
      }
      // Recurse via known structural keys.
      if (n.foreach && typeof n.foreach === "object" && (n.foreach as Record<string, unknown>).template) {
        visitTemplateDeps((n.foreach as Record<string, unknown>).template, `${p}.foreach.template`);
      }
    };
    visitTemplateDeps(fe.template, "template");

    // Nested foreach banned — the template (and any of its own nested
    // templates) must not itself declare a foreach. Walk the template tree.
    const visitTemplate = (node: unknown, pathPrefix: string): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.foreach && typeof n.foreach === "object") {
        errors.push({
          code: "FOREACH_NESTED_NOT_SUPPORTED",
          message: `Task "${t.key}" foreach.template declares a nested foreach at ${pathPrefix}.foreach; nested foreach is not supported (single-level fan-out only).`,
          path: `tasks[${i}].foreach.${pathPrefix}.foreach`,
        });
        // Recurse into the nested template too to surface the deepest case.
        if ((n.foreach as Record<string, unknown>).template) {
          visitTemplate((n.foreach as Record<string, unknown>).template, `${pathPrefix}.foreach.template`);
        }
      }
    };
    visitTemplate(fe.template, "template");

    // Variable-binding sanity: `{{var.path}}` references where `var` doesn't
    // match `as` (and isn't a reserved special like $index/$position/$total).
    // We only catch the obvious literal-string case; deep nested values pass
    // through to runtime substitution.
    const reservedVars = new Set(["$index", "$position", "$total"]);
    const tokenRe = /\{\{\s*([a-zA-Z$][a-zA-Z0-9_$]*)(?:\.[^}\s]+)?\s*\}\}/g;
    const scanForBadVars = (node: unknown, p: string): void => {
      if (typeof node === "string") {
        let m: RegExpExecArray | null;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(node)) !== null) {
          const v = m[1];
          if (v === fe.as || reservedVars.has(v)) continue;
          // Allow placeholder-style {{name}} that resolve from the workflow's
          // `placeholders` map — those don't appear in foreach scope; only
          // unscoped-but-also-not-a-placeholder tokens are problematic.
          if (spec.placeholders && spec.placeholders[v]) continue;
          errors.push({
            code: "FOREACH_INVALID_VARIABLE_BINDING",
            message: `Task "${t.key}" foreach.template uses {{${v}}} but the declared variable is "${fe.as}"; valid: "${fe.as}", "$index", "$position", "$total", or a declared placeholder.`,
            path: `tasks[${i}].foreach.${p}`,
          });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, idx) => scanForBadVars(v, `${p}[${idx}]`));
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) scanForBadVars(v, `${p}.${k}`);
      }
    };
    scanForBadVars(fe.template, "template");
  });

  // Duplicate dependency edges (the DB has UNIQUE(task_id, depends_on_task_id);
  // catch it early with an actionable error).
  spec.tasks.forEach((t, i) => {
    const seenDeps = new Set<string>();
    (t.dependsOn ?? []).forEach((dep, j) => {
      if (seenDeps.has(dep.taskKey)) {
        errors.push({
          code: "DUPLICATE_DEPENDENCY",
          message: `Task "${t.key}" lists "${dep.taskKey}" as a dependency more than once.`,
          path: `tasks[${i}].dependsOn[${j}]`,
        });
      }
      seenDeps.add(dep.taskKey);
    });
  });

  // Timezone validity (a bad IANA name would otherwise false-pass here and fail
  // later at resolution).
  const tzChecks: { tz: string; path: string }[] = [];
  if (spec.target?.tz) tzChecks.push({ tz: spec.target.tz, path: "target.tz" });
  spec.tasks.forEach((t, i) => {
    if (t.schedule?.tz) tzChecks.push({ tz: t.schedule.tz, path: `tasks[${i}].schedule.tz` });
  });
  for (const c of tzChecks) {
    if (!isValidTimeZone(c.tz)) {
      errors.push({ code: "INVALID_TIMEZONE", message: `Unknown timezone "${c.tz}".`, path: c.path });
    }
  }

  return { ok: errors.length === 0, tier: "template", errors, spec };
}

/**
 * draft-valid: template-valid AND concrete — release date present, no unresolved
 * placeholders, every relative schedule chain terminates at the release or an
 * absolute schedule.
 */
export function validateDraft(input: unknown): ValidationResult {
  const base = validateTemplate(input);
  if (!base.ok || !base.spec) return { ...base, tier: "draft" };
  const spec = base.spec;
  const errors: StructuredSpecError[] = [];

  if (!spec.target?.at || !spec.target?.tz) {
    errors.push({
      code: "MISSING_TARGET_DATE",
      message: "A draft workflow must have a concrete target date and timezone (target.at + target.tz).",
      path: "target",
    });
  }

  const unresolved = findUnresolvedPlaceholders(spec);
  for (const name of unresolved) {
    errors.push({
      code: "UNRESOLVED_PLACEHOLDER",
      message: `Unresolved placeholder "{{${name}}}" — a draft must have all placeholders filled.`,
    });
  }

  // Resolvability: every relative chain must bottom out at the release or an
  // absolute schedule. (References/cycles already validated at template tier.)
  const byKey = new Map(spec.tasks.map((t) => [t.key, t]));
  const resolvable = (startKey: string): boolean => {
    let cursor: string | undefined = startKey;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const task = byKey.get(cursor);
      if (!task?.schedule) return false; // unscheduled task can't anchor a chain
      if (task.schedule.mode === "absolute") return true;
      if (task.schedule.anchor === TARGET_ANCHOR) return Boolean(spec.target?.at);
      cursor = task.schedule.anchor;
    }
    return false;
  };
  spec.tasks.forEach((t, i) => {
    if (t.schedule?.mode === "relative" && !resolvable(t.key)) {
      errors.push({
        code: "UNRESOLVABLE_SCHEDULE",
        message: `Task "${t.key}" schedule cannot be resolved (its anchor chain never reaches the release or an absolute date).`,
        path: `tasks[${i}].schedule`,
      });
    }
  });

  // Schedule horizon: once the spec is otherwise
  // resolvable, no task may resolve more than maxScheduleHorizonDays from the
  // release date.
  if (errors.length === 0 && spec.target?.at && spec.target?.tz) {
    const targetMs = parseInstantMs(spec.target.at, spec.target.tz);
    const resolved = resolveSchedule(spec).tasks;
    spec.tasks.forEach((t, i) => {
      const r = resolved[t.key];
      if (!r) return;
      const days = Math.abs(Date.parse(r.dueAtUtc) - targetMs) / 86_400_000;
      if (days > SPEC_LIMITS.maxScheduleHorizonDays) {
        errors.push({
          code: "SCHEDULE_HORIZON_EXCEEDED",
          message: `Task "${t.key}" resolves ~${Math.round(days)} days from the release; the maximum horizon is ${SPEC_LIMITS.maxScheduleHorizonDays}.`,
          path: `tasks[${i}].schedule`,
          limit: SPEC_LIMITS.maxScheduleHorizonDays,
          actual: Math.round(days),
        });
      }
    });
  }

  return { ok: errors.length === 0, tier: "draft", errors: [...base.errors, ...errors], spec };
}

/**
 * start-valid: draft-valid AND startable now. Approval-gated workflows ARE
 * startable: the approval gate holds the task pending until a human
 * grants it, and the `approval` executor completes it on grant. Injected
 * agent/approver existence checks are validated via ctx when supplied.
 */
export function validateStart(input: unknown, ctx?: StartContext): ValidationResult {
  const base = validateDraft(input);
  if (!base.ok || !base.spec) return { ...base, tier: "start" };
  const spec = base.spec;
  const errors: StructuredSpecError[] = [];

  // Hierarchical specs are render-only (the reconciler would dispatch
  // summary parents like any other workflow_task). DRAFT is fine — only START
  // is gated. Execution support is future scope (reconciler parent-skip path).
  const taskKeys = new Set(spec.tasks.map((t) => t.key));
  const hasAnyChildren = spec.tasks.some((t) => t.parent && taskKeys.has(t.parent));
  if (hasAnyChildren) {
    errors.push({
      code: "HIERARCHY_NOT_RUNNABLE",
      message:
        "Hierarchical workflows (tasks with `parent`) are not yet runnable — executing summary-parent rows is future scope. Edit the spec to flatten the tree before starting.",
      path: "tasks",
    });
  }

  if (ctx?.agentExists) {
    spec.tasks.forEach((t, i) => {
      if (t.type === "agent_task" && !ctx.agentExists!(t.agentRef)) {
        errors.push({
          code: "AGENT_NOT_FOUND",
          message: `Task "${t.key}" references an agent that does not exist or is not authorized.`,
          path: `tasks[${i}].agentRef`,
        });
      }
    });
  }

  return { ok: errors.length === 0, tier: "start", errors: [...base.errors, ...errors], spec };
}
