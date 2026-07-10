// Typed PROJECT-TEMPLATE contract — the authoritative task graph a "project
// agent" (EPIC #1030) materializes into a PM store. Types + PURE derivations
// only; NO runtime code, NO I/O (mirrors pm-work-store-contract.ts /
// pm-connector-contract.ts). Lives in the SDK so the author-facing kind gate,
// the host, and a project-manager agent share ONE contract without importing
// each other by name.
//
// EPIC #1030 replaces install-compiled BPMN workflow extensions with ordinary
// agent-kind extensions whose orchestration value lives in a typed template +
// skills, with tasks/status/dates in a PM tool (Plane, GitHub). A "specific
// project agent" ships a `cinatra/project-template.json` conforming to this
// contract; a generic project-MANAGER agent (cinatra#1032, plane first) reads it
// to instantiate work items, pick ready ones, dispatch worker agents, and
// escalate approvals.
//
// RELATION TO W1 (merged, cinatra#1031): `PmWorkStore` (pm-work-store-contract.ts)
// is the typed work-item CRUD store. This contract is the SOURCE the store is
// materialized FROM: `materializeProjectTemplate` emits `PmWorkItemDraft`-shaped
// items (this file's only structural coupling to W1).
//
// SCOPE OF THIS MODULE (cinatra#1032 slice a — OBO-independent, migration-free):
// the typed template + the DETERMINISTIC, outside-the-LLM derivations from it —
// schema validation, the worker-ref "one truth source" rule, the worker
// allowlist, deterministic date materialization, and the deterministic
// ready-item PICK validator (the "ready = deps done + due + unclaimed" predicate,
// resolved once here so the host and the agent share ONE truth). The RUNTIME
// pieces that consume these — the dynamic dispatch primitive (reuses the
// workflow-agent executor gates + `createAgentRun` idempotency + the OBO
// ceiling-chain composition), the dispatch-attempt ledger + project lease, and
// the `plane-project-manager-agent` extension — are SEPARATE follow-on slices.
// This module deliberately holds NO ceiling/dispatch RUNTIME state: dispatch
// context (parent-run id, composed OBO ceiling chain) is attached by the
// dispatch primitive at tick time, never authored into a template.
//
// ENFORCEMENT CALL SITE (deferred, documented so the seam is unambiguous): the
// exact-match "one truth source" rule (`checkTemplateWorkerRefsAgainstDependencies`)
// and `validateProjectTemplate` are meant to REJECT at install. The canonical
// author-facing kind gate lives in the separate `cinatra-cli` repo (build/publish
// time); an in-repo install-path hook — `packages/agents/src/install-from-package.ts`,
// beside the existing `parseManifestDependencyEdges` handling — is the host-side
// fallback seam. Both are follow-on wiring; this slice ships the pure predicates
// they call, not the wiring.

import type { ExtensionDependency, VersionConstraint } from "./dependencies";
import type { PmWorkItem, PmWorkItemDraft } from "./pm-work-store-contract";

/** Format tag stamped on a template's `formatVersion`. A conforming template
 *  MUST carry this exact value; the gate/host rejects anything else. */
export const PROJECT_TEMPLATE_FORMAT_VERSION = "cinatra.ai/project-template@1";

/** The natural-key path separator. A `taskId` MUST NOT contain it, so the
 *  composed `<projectRef>/<taskId>` key round-trips unambiguously. */
export const PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR = "/";

/**
 * Allowed shape for a stable id (`taskId`, worker `role`, approval/acceptance
 * ids): a compact token — letters, digits, `-`, `_`, `.` — with no path
 * separator (so it is safe inside the natural key) and no whitespace. Anchored.
 */
export const PROJECT_TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Template shape
// ---------------------------------------------------------------------------

/**
 * A versioned worker-agent reference — the agent a task dispatches. Carries a
 * stable logical `role` (dispatch policy + the dispatch ledger reference the
 * ROLE, never a parsed package string) plus the package identity that MUST
 * exact-match a manifest `cinatra.dependencies` edge (the "one truth source"
 * rule — see `checkTemplateWorkerRefsAgainstDependencies`). The version travels
 * as the SAME `VersionConstraint` union the dependency edge uses, so equality is
 * structural, not string-shaped.
 */
export type WorkerAgentRef = {
  /** Stable logical id for what this worker does (e.g. "draft-writer"). Unique
   *  per DISTINCT package binding within a template (two refs sharing a role
   *  MUST share packageName + versionConstraint — enforced by validation). */
  role: string;
  /** The depended-on agent's package (e.g. "@cinatra-ai/blog-draft-writer-agent"). */
  packageName: string;
  /** Version constraint — MUST equal the manifest dependency edge's constraint. */
  versionConstraint: VersionConstraint;
};

/** A human approval gate on a task — escalated to a human-assigned work item;
 *  the task cannot complete until a human resolves it. */
export type ApprovalGate = {
  /** Stable id for this gate (referenced by escalation records). */
  id: string;
  /** Optional human role/assignee hint (provider-agnostic; resolved at runtime). */
  assigneeRole?: string | null;
};

/** A machine- or human-checkable acceptance criterion carried on a task. The
 *  contract only CARRIES these; execution is a runtime (dispatch-slice) concern. */
export type AcceptanceCheck = {
  /** Stable id, unique within the task. */
  id: string;
  /** Human-facing description of what "accepted" means. */
  description: string;
};

/** Relative schedule for a task, expressed as integer DAY offsets from the
 *  template's named anchor. Absolute dates are computed at materialization from
 *  a concrete anchor date; changing that date recomputes dates WITHOUT changing
 *  task identity (the natural key is anchor-independent). */
export type TaskSchedule = {
  /** Planned start = anchorDate + startOffsetDays. Omitted/null = no start date. */
  startOffsetDays?: number | null;
  /** Due = anchorDate + dueOffsetDays. Omitted/null = no due date. When both are
   *  present, `dueOffsetDays` MUST be >= `startOffsetDays`. */
  dueOffsetDays?: number | null;
};

/** One task in the template's graph. */
export type ProjectTemplateTask = {
  /** Stable id, unique within the template, no path separator (natural-key safe). */
  id: string;
  /** Human-facing title (materialized verbatim into the work item). */
  title: string;
  /** Human-facing description/body, or null. */
  body?: string | null;
  /** Task ids this task is BLOCKED BY (its dependency edges). Every entry MUST
   *  reference another task in the same template; the graph MUST be acyclic. */
  dependsOn?: string[];
  /** Relative schedule vs the template anchor. */
  schedule?: TaskSchedule;
  /** The worker agent that performs this task, or null for a human/manual task. */
  worker?: WorkerAgentRef | null;
  /** Human approval gate on this task, if any. */
  approval?: ApprovalGate | null;
  /** Acceptance criteria for this task. */
  acceptance?: AcceptanceCheck[];
};

/** The named anchor a template's relative dates are measured from (e.g. a
 *  launch/target date). A concrete date for it is supplied at materialization. */
export type ProjectTemplateAnchor = {
  /** Stable id (e.g. "launch"). */
  id: string;
  /** Optional human label. */
  label?: string | null;
};

/** A typed `cinatra/project-template.json` — the authoritative task graph. */
export type ProjectTemplate = {
  /** MUST equal `PROJECT_TEMPLATE_FORMAT_VERSION`. */
  formatVersion: string;
  /** Stable template id (provenance; distinct from the runtime project ref). */
  id: string;
  /** Human-facing template name. */
  name: string;
  /** The named date anchor all relative schedules resolve against. */
  anchor: ProjectTemplateAnchor;
  /** The tasks. Non-empty. */
  tasks: ProjectTemplateTask[];
};

// ---------------------------------------------------------------------------
// Validation (structural — collect ALL violations, deterministic order)
// ---------------------------------------------------------------------------

/** A single structured validation violation. `path` is a dotted/bracketed
 *  pointer into the template (e.g. `tasks[2].dependsOn[0]`). */
export type ProjectTemplateViolation = {
  code: string;
  path: string;
  message: string;
};

export type ProjectTemplateValidation =
  | { valid: true; template: ProjectTemplate }
  | { valid: false; violations: ProjectTemplateViolation[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidStableId(v: unknown): v is string {
  return typeof v === "string" && PROJECT_TEMPLATE_ID_PATTERN.test(v);
}

/** True iff two `VersionConstraint`s are structurally equal (the exact-match
 *  operand). Pure; discriminates on `kind` then the single value field. */
export function versionConstraintsEqual(a: VersionConstraint, b: VersionConstraint): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "semver-range":
      return a.range === (b as { range: string }).range;
    case "exact":
      return a.version === (b as { version: string }).version;
    case "git-ref":
      return a.ref === (b as { ref: string }).ref;
    default:
      return false;
  }
}

/**
 * Validate a candidate value as a `ProjectTemplate`. PURE, total (never throws),
 * and COLLECTS every violation (so the gate can report all at once) in a
 * deterministic order. Checks: format tag; template/anchor ids; non-empty tasks;
 * unique + pattern-valid task ids; dependency edges reference existing tasks with
 * no self-edge; the dependency graph is ACYCLIC; integer schedule offsets with
 * due >= start; worker-ref shape + role→package consistency; unique approval and
 * acceptance ids. The worker-ref-vs-manifest "one truth source" rule is a
 * SEPARATE check (`checkTemplateWorkerRefsAgainstDependencies`) because it needs
 * the manifest as a second operand.
 */
export function validateProjectTemplate(input: unknown): ProjectTemplateValidation {
  const violations: ProjectTemplateViolation[] = [];
  const push = (code: string, path: string, message: string) =>
    violations.push({ code, path, message });

  if (!isPlainObject(input)) {
    return { valid: false, violations: [{ code: "not_object", path: "", message: "template must be an object" }] };
  }

  if (input.formatVersion !== PROJECT_TEMPLATE_FORMAT_VERSION) {
    push(
      "bad_format_version",
      "formatVersion",
      `formatVersion must be "${PROJECT_TEMPLATE_FORMAT_VERSION}"`,
    );
  }
  if (!isValidStableId(input.id)) push("bad_template_id", "id", "id must be a stable token");
  if (typeof input.name !== "string" || input.name.trim() === "") {
    push("bad_template_name", "name", "name must be a non-empty string");
  }
  if (!isPlainObject(input.anchor) || !isValidStableId(input.anchor.id)) {
    push("bad_anchor", "anchor.id", "anchor.id must be a stable token");
  }

  const tasks = input.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    push("no_tasks", "tasks", "tasks must be a non-empty array");
    return { valid: false, violations };
  }

  // Pass 1: ids (needed for edge + role checks).
  const taskIds = new Set<string>();
  const roleToBinding = new Map<string, { packageName: string; versionConstraint: VersionConstraint }>();
  tasks.forEach((task, i) => {
    if (!isPlainObject(task)) {
      push("bad_task", `tasks[${i}]`, "task must be an object");
      return;
    }
    if (!isValidStableId(task.id)) {
      push("bad_task_id", `tasks[${i}].id`, "task id must be a stable token (no path separator)");
    } else if (taskIds.has(task.id)) {
      push("duplicate_task_id", `tasks[${i}].id`, `duplicate task id "${task.id}"`);
    } else {
      taskIds.add(task.id);
    }
    if (typeof task.title !== "string" || task.title.trim() === "") {
      push("bad_task_title", `tasks[${i}].title`, "task title must be a non-empty string");
    }
  });

  // Pass 2: edges, schedule, worker, approval, acceptance.
  tasks.forEach((task, i) => {
    if (!isPlainObject(task)) return;
    const at = `tasks[${i}]`;

    if (task.dependsOn !== undefined) {
      if (!Array.isArray(task.dependsOn)) {
        push("bad_depends_on", `${at}.dependsOn`, "dependsOn must be an array of task ids");
      } else {
        const seen = new Set<string>();
        task.dependsOn.forEach((dep, j) => {
          if (typeof dep !== "string" || !taskIds.has(dep)) {
            push("unknown_dependency", `${at}.dependsOn[${j}]`, `dependsOn "${String(dep)}" is not a task id`);
          } else if (dep === task.id) {
            push("self_dependency", `${at}.dependsOn[${j}]`, "a task cannot depend on itself");
          } else if (seen.has(dep)) {
            push("duplicate_dependency", `${at}.dependsOn[${j}]`, `duplicate dependency "${dep}"`);
          } else {
            seen.add(dep);
          }
        });
      }
    }

    if (task.schedule !== undefined && task.schedule !== null) {
      if (!isPlainObject(task.schedule)) {
        push("bad_schedule", `${at}.schedule`, "schedule must be an object");
      } else {
        const { startOffsetDays: s, dueOffsetDays: d } = task.schedule as TaskSchedule;
        if (s !== undefined && s !== null && !Number.isInteger(s)) {
          push("bad_offset", `${at}.schedule.startOffsetDays`, "startOffsetDays must be an integer");
        }
        if (d !== undefined && d !== null && !Number.isInteger(d)) {
          push("bad_offset", `${at}.schedule.dueOffsetDays`, "dueOffsetDays must be an integer");
        }
        // Compare due<start whenever BOTH are finite numbers — independent of the
        // integer check above — so a malformed offset (e.g. 1.5) does NOT suppress
        // an also-present ordering violation (the module's collect-ALL contract).
        if (
          typeof s === "number" && Number.isFinite(s) &&
          typeof d === "number" && Number.isFinite(d) &&
          d < s
        ) {
          push("due_before_start", `${at}.schedule.dueOffsetDays`, "dueOffsetDays must be >= startOffsetDays");
        }
      }
    }

    if (task.worker !== undefined && task.worker !== null) {
      const w = task.worker as Partial<WorkerAgentRef>;
      const wAt = `${at}.worker`;
      const roleOk = isValidStableId(w.role);
      if (!roleOk) push("bad_worker_role", `${wAt}.role`, "worker.role must be a stable token");
      if (typeof w.packageName !== "string" || w.packageName.trim() === "") {
        push("bad_worker_package", `${wAt}.packageName`, "worker.packageName must be a non-empty string");
      }
      if (!isValidVersionConstraint(w.versionConstraint)) {
        push("bad_worker_version", `${wAt}.versionConstraint`, "worker.versionConstraint is malformed");
      }
      // role -> package binding must be a function (no ambiguous dispatch target).
      if (roleOk && typeof w.packageName === "string" && isValidVersionConstraint(w.versionConstraint)) {
        const prev = roleToBinding.get(w.role as string);
        const binding = { packageName: w.packageName, versionConstraint: w.versionConstraint };
        if (!prev) {
          roleToBinding.set(w.role as string, binding);
        } else if (
          prev.packageName !== binding.packageName ||
          !versionConstraintsEqual(prev.versionConstraint, binding.versionConstraint)
        ) {
          push(
            "inconsistent_worker_role",
            `${wAt}.role`,
            `role "${w.role}" is bound to more than one package/version`,
          );
        }
      }
    }

    if (task.approval !== undefined && task.approval !== null) {
      if (!isPlainObject(task.approval) || !isValidStableId(task.approval.id)) {
        push("bad_approval", `${at}.approval.id`, "approval.id must be a stable token");
      }
    }

    if (task.acceptance !== undefined) {
      if (!Array.isArray(task.acceptance)) {
        push("bad_acceptance", `${at}.acceptance`, "acceptance must be an array");
      } else {
        const seen = new Set<string>();
        task.acceptance.forEach((c, j) => {
          const cAt = `${at}.acceptance[${j}]`;
          if (!isPlainObject(c) || !isValidStableId(c.id)) {
            push("bad_acceptance_id", `${cAt}.id`, "acceptance.id must be a stable token");
          } else if (seen.has(c.id)) {
            push("duplicate_acceptance_id", `${cAt}.id`, `duplicate acceptance id "${c.id}"`);
          } else {
            seen.add(c.id);
          }
          if (isPlainObject(c) && (typeof c.description !== "string" || c.description.trim() === "")) {
            push("bad_acceptance_desc", `${cAt}.description`, "acceptance.description must be non-empty");
          }
        });
      }
    }
  });

  // Pass 3: acyclic dependency graph (only over well-formed edges).
  const cycle = findDependencyCycle(tasks as ProjectTemplateTask[], taskIds);
  if (cycle) {
    push("cyclic_dependencies", "tasks", `dependency cycle: ${cycle.join(" -> ")}`);
  }

  if (violations.length > 0) return { valid: false, violations };
  return { valid: true, template: input as unknown as ProjectTemplate };
}

function isValidVersionConstraint(v: unknown): v is VersionConstraint {
  if (!isPlainObject(v)) return false;
  if (v.kind === "semver-range") return typeof v.range === "string";
  if (v.kind === "exact") return typeof v.version === "string";
  if (v.kind === "git-ref") return typeof v.ref === "string";
  return false;
}

/** DFS cycle detection over the task dependency edges. Returns one offending
 *  cycle (task-id path) or null. Only follows edges to known task ids so a
 *  malformed edge (already flagged) never masks or fabricates a cycle. */
function findDependencyCycle(tasks: ProjectTemplateTask[], knownIds: Set<string>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t || typeof t.id !== "string") continue;
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === "string" && knownIds.has(d) && d !== t.id) : [];
    edges.set(t.id, deps);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const id of edges.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker-ref "one truth source" rule + allowlist
// ---------------------------------------------------------------------------

/**
 * The exact-match rule (EPIC #1030 / #1032): every template worker ref MUST
 * exact-match a manifest `cinatra.dependencies` edge by BOTH `packageName` AND
 * `versionConstraint`. This dissolves the two-truths problem (template worker
 * ref vs manifest dependency edge) — the manifest edge is authoritative and the
 * template references it identically, so a template can never name an executable
 * dependency the manifest does not declare. PURE; returns structured violations
 * (empty = passes). The kind gate (cinatra-cli canonical gate, a follow-on
 * slice) calls this to REJECT at install.
 */
export function checkTemplateWorkerRefsAgainstDependencies(
  template: ProjectTemplate,
  dependencies: ExtensionDependency[],
): ProjectTemplateViolation[] {
  const violations: ProjectTemplateViolation[] = [];
  const byPackage = new Map<string, ExtensionDependency>();
  for (const dep of dependencies) byPackage.set(dep.packageName, dep);

  template.tasks.forEach((task, i) => {
    const w = task.worker;
    if (!w) return;
    const at = `tasks[${i}].worker`;
    const edge = byPackage.get(w.packageName);
    if (!edge) {
      violations.push({
        code: "worker_not_in_dependencies",
        path: `${at}.packageName`,
        message: `worker "${w.packageName}" is not declared in cinatra.dependencies`,
      });
      return;
    }
    if (!versionConstraintsEqual(w.versionConstraint, edge.versionConstraint)) {
      violations.push({
        code: "worker_version_mismatch",
        path: `${at}.versionConstraint`,
        message: `worker "${w.packageName}" version does not exact-match its cinatra.dependencies edge`,
      });
    }
  });
  return violations;
}

/** The template's worker ALLOWLIST — the distinct `{ role, packageName,
 *  versionConstraint }` bindings any task may dispatch. The dispatch primitive
 *  (follow-on slice) validates a proposed dispatch target against this set
 *  deterministically BEFORE it ever reaches `createAgentRun`. PURE; deduped by
 *  role (validation guarantees role -> package is a function). */
export function templateWorkerAllowlist(template: ProjectTemplate): WorkerAgentRef[] {
  const byRole = new Map<string, WorkerAgentRef>();
  for (const task of template.tasks) {
    if (task.worker && !byRole.has(task.worker.role)) byRole.set(task.worker.role, task.worker);
  }
  return [...byRole.values()].sort((a, b) => a.role.localeCompare(b.role));
}

// ---------------------------------------------------------------------------
// Deterministic materialization (template -> PmWorkStore drafts)
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Compose the immutable work-item natural key `<projectRef>/<taskId>`. The key
 *  is ANCHOR-INDEPENDENT — it never encodes a date — so re-materializing after
 *  an anchor-date change lands on the SAME item (find-or-create), which is the
 *  explicit repair rule (see `materializeProjectTemplate`). */
export function composeWorkItemNaturalKey(projectRef: string, taskId: string): string {
  return `${projectRef}${PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR}${taskId}`;
}

/** Add an integer number of days to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`.
 *  UTC-based so there is no timezone/DST drift; deterministic. Throws on a
 *  malformed anchor date (a caller-supplied contract, validated up front). */
export function computeAbsoluteDate(anchorDate: string, offsetDays: number): string {
  if (!YMD.test(anchorDate)) throw new Error(`anchorDate must be YYYY-MM-DD, got "${anchorDate}"`);
  const base = Date.parse(`${anchorDate}T00:00:00Z`);
  if (Number.isNaN(base)) throw new Error(`anchorDate is not a real date: "${anchorDate}"`);
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** A materialized item = the `PmWorkStore` draft PLUS template provenance the
 *  dispatch slice needs (taskId, worker) WITHOUT re-parsing the natural key. */
export type MaterializedWorkItem = {
  /** Source task id. */
  taskId: string;
  /** The worker binding to dispatch for this item, or null (human/manual/approval). */
  worker: WorkerAgentRef | null;
  /** Whether this item carries a human approval gate. */
  requiresApproval: boolean;
  /** The draft to hand to `PmWorkStore.createWorkItem` (find-or-create by key). */
  draft: PmWorkItemDraft;
};

export type MaterializeOptions = {
  /** The runtime PM project reference used as the natural-key prefix. */
  projectRef: string;
  /** The concrete `YYYY-MM-DD` date for the template's anchor. */
  anchorDate: string;
};

/**
 * Deterministically materialize a template into work-item drafts. PURE and
 * total over a VALID template (validate first): identical `(template, options)`
 * always yields byte-identical output, so it is safe to re-run.
 *
 * REPAIR RULE (Acceptance #1 — anchor-date change): the natural key is
 * anchor-independent, so changing `anchorDate` recomputes each item's
 * start/dueDate while re-materializing onto the SAME item. The consumer (the
 * project-manager agent, a follow-on slice) reconciles by find-or-create per
 * `naturalKey` and PATCHES only the template-derived fields (title, body,
 * startDate, dueDate, dependsOn); runtime-owned fields (status, assignees,
 * comments) are NOT clobbered. No item is orphaned or duplicated.
 *
 * Initial `status` is `"backlog"` for every item (a pure snapshot); promotion
 * through the status vocabulary is the runtime tick's job, never this function's.
 */
export function materializeProjectTemplate(
  template: ProjectTemplate,
  options: MaterializeOptions,
): MaterializedWorkItem[] {
  const { projectRef, anchorDate } = options;
  return template.tasks.map((task) => {
    const s = task.schedule?.startOffsetDays;
    const d = task.schedule?.dueOffsetDays;
    const draft: PmWorkItemDraft = {
      naturalKey: composeWorkItemNaturalKey(projectRef, task.id),
      title: task.title,
      body: task.body ?? null,
      status: "backlog",
      startDate: s === undefined || s === null ? null : computeAbsoluteDate(anchorDate, s),
      dueDate: d === undefined || d === null ? null : computeAbsoluteDate(anchorDate, d),
      dependsOn: (task.dependsOn ?? []).map((depId) => composeWorkItemNaturalKey(projectRef, depId)),
    };
    return {
      taskId: task.id,
      worker: task.worker ?? null,
      requiresApproval: task.approval != null,
      draft,
    };
  });
}

// ---------------------------------------------------------------------------
// Deterministic READY-ITEM validator — the outside-the-LLM pick predicate
// ---------------------------------------------------------------------------

/**
 * The fields the ready predicate reads off a materialized/live work item.
 * STRUCTURAL (a subset of W1 `PmWorkItem`) so a caller can pass a live
 * `PmWorkItem` read from the `PmWorkStore` directly. `assigneeIds`/`dependsOn`
 * absent are treated as empty; `startDate` absent means no start gate.
 */
export type ReadyItemView = Pick<PmWorkItem, "naturalKey" | "status"> &
  Partial<Pick<PmWorkItem, "assigneeIds" | "dependsOn" | "startDate">>;

/**
 * Why an item is NOT ready to be picked, checked in a FIXED priority (the first
 * failing gate wins, so the reason is deterministic). `itemNotReadyReason`
 * returns `null` when the item IS ready.
 *   - "not_pickable_status" — status is not `backlog`/`todo` (already running,
 *                             blocked, or terminal).
 *   - "claimed"             — a worker already holds it (`assigneeIds` non-empty).
 *   - "deps_unmet"          — a `dependsOn` blocker is not `done` (a `cancelled`
 *                             blocker, or one absent from the index, does NOT
 *                             satisfy the edge — never silently satisfied).
 *   - "not_yet_started"     — the planned `startDate` is after `asOf`.
 */
export type NotReadyReason =
  | "not_pickable_status"
  | "claimed"
  | "deps_unmet"
  | "not_yet_started";

/** Statuses an item may be picked FROM (a worker may begin it). */
const PICKABLE_STATUSES: ReadonlySet<PmWorkItem["status"]> = new Set<PmWorkItem["status"]>([
  "backlog",
  "todo",
]);

/** Inputs the ready predicate resolves an item against. */
export type ReadyContext = {
  /** The tick day, `YYYY-MM-DD`. A `startDate` strictly after this is
   *  `not_yet_started`. Validated up front (throws on a malformed value). */
  asOf: string;
  /** Status of every cinatra-managed item in the project scope, keyed by
   *  `naturalKey`, so a dependency's completion resolves deterministically. A
   *  blocker ABSENT from this index is treated as UNMET. */
  statusByKey: ReadonlyMap<string, PmWorkItem["status"]>;
};

/**
 * The deterministic ready-item validator — the SINGLE source of truth for
 * "ready", shared by the host dynamic-dispatch primitive (which validates an
 * LLM-proposed pick BEFORE `createAgentRun`, so the LLM can never act on a
 * not-ready item — cinatra#1032 Acceptance 3) and the project-manager agent's
 * pick-next skill. PURE and total over a valid `asOf`.
 *
 * Ready := status ∈ {backlog, todo} AND unclaimed (no assignees) AND every
 * `dependsOn` blocker resolves to `done` AND the planned `startDate` is not
 * after `asOf`. START-gates readiness: the `dueDate` is a DEADLINE that drives
 * urgency/escalation, NOT pickability — future-due work is ready, and past-due
 * work stays ready (just more urgent). Dates are day-granularity `YYYY-MM-DD`
 * (W1 `PmWorkItem`), compared as calendar days with no timezone (ISO
 * `YYYY-MM-DD` sorts chronologically); a `startDate` carrying a time suffix is
 * truncated to its day.
 */
export function itemNotReadyReason(item: ReadyItemView, ctx: ReadyContext): NotReadyReason | null {
  if (!YMD.test(ctx.asOf)) throw new Error(`asOf must be YYYY-MM-DD, got "${ctx.asOf}"`);
  if (!PICKABLE_STATUSES.has(item.status)) return "not_pickable_status";
  if ((item.assigneeIds?.length ?? 0) > 0) return "claimed";
  for (const dep of item.dependsOn ?? []) {
    if (ctx.statusByKey.get(dep) !== "done") return "deps_unmet";
  }
  if (item.startDate != null && item.startDate.slice(0, 10) > ctx.asOf) return "not_yet_started";
  return null;
}

/** `itemNotReadyReason(item, ctx) === null`. */
export function isItemReady(item: ReadyItemView, ctx: ReadyContext): boolean {
  return itemNotReadyReason(item, ctx) === null;
}

/** Index a set of items by `naturalKey` -> `status` for the ready predicate. A
 *  later duplicate key overwrites an earlier one (the store's find-or-create by
 *  natural key guarantees one item per key in practice). */
export function indexItemStatusByKey(items: readonly ReadyItemView[]): Map<string, PmWorkItem["status"]> {
  const m = new Map<string, PmWorkItem["status"]>();
  for (const it of items) m.set(it.naturalKey, it.status);
  return m;
}

/**
 * The deterministic ready SET: every item that passes `isItemReady` against the
 * whole `items` set at `asOf`, INPUT ORDER preserved (stable, so a tick's
 * candidate list is reproducible). Builds the status index from `items` itself.
 */
export function readyItems<T extends ReadyItemView>(items: readonly T[], asOf: string): T[] {
  const ctx: ReadyContext = { asOf, statusByKey: indexItemStatusByKey(items) };
  return items.filter((it) => isItemReady(it, ctx));
}
