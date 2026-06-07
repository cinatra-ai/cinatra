// BPMN → WorkflowSpec compiler (BPMN-04). PURE + synchronous over an
// already-parsed `bpmn-moddle` definitions object — all XML/file I/O lives in
// `sidecar.ts` and the CI gate. The compiled spec is parsed through
// `workflowSpecSchema` before return (guarantees a valid WorkflowSpec or a
// structured `BpmnCompileException`).
//
// Mapping (per REQ BPMN-04):
//   process.id                          → WorkflowSpec.key
//   cinatra:workflowMeta.name           → WorkflowSpec.name (fallback process.name)
//   cinatra:workflowMeta.product/target → WorkflowSpec.product / .target
//   cinatra:placeholders                → WorkflowSpec.placeholders
//   cinatra:placeholderHint             → WorkflowSpec.metadata.placeholderHints[name].kind
//   userTask + taskKind=approval        → type:"approval" (+ approvalConfig)
//   userTask + taskKind=checkpoint      → type:"checkpoint"
//   serviceTask                         → type:"agent_task" (+ agentRef + taskInput)
//   manualTask                          → type:"manual"
//   sendTask                            → type:"notification" (+ messageBody)
//   parallelGateway                     → transparent fan-out/join → dependsOn edges
//   multiInstanceLoopCharacteristics    → foreach (cinatra:foreachSource)
//   sequenceFlow (+transitionOutcome)   → dependsOn[].outcome

import { workflowSpecSchema, type WorkflowSpec, type TaskSpec, type TaskDependency } from "../spec/schema";
import { BPMN_ERROR_CODES, BpmnCompileException } from "./errors";

type ModdleElement = { $type: string; id?: string; name?: string; [key: string]: unknown };

const TASK_TYPES = new Set<string>(["bpmn:UserTask", "bpmn:ServiceTask", "bpmn:ManualTask", "bpmn:SendTask"]);

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function fail(code: typeof BPMN_ERROR_CODES.structureInvalid | typeof BPMN_ERROR_CODES.taskInputInvalidJson | typeof BPMN_ERROR_CODES.placeholderDuplicate, elementId: string | null, reason: string): never {
  throw new BpmnCompileException({ code, elementId, reason });
}

/** All `cinatra:` extension elements directly under an element's extensionElements. */
function extValues(el: ModdleElement | undefined): ModdleElement[] {
  const ext = el?.extensionElements as { values?: unknown } | undefined;
  return asArray<ModdleElement>(ext?.values);
}

function findExt(el: ModdleElement | undefined, type: string): ModdleElement | undefined {
  return extValues(el).find((v) => v.$type === type);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function processOf(definitions: unknown): ModdleElement {
  const defs = definitions as ModdleElement | null;
  const processes = asArray<ModdleElement>(defs?.rootElements).filter((e) => e.$type === "bpmn:Process");
  if (processes.length !== 1) {
    fail(BPMN_ERROR_CODES.structureInvalid, null, `expected exactly one bpmn:Process, found ${processes.length}`);
  }
  return processes[0];
}

// ---------------------------------------------------------------------------
// placeholders + metadata
// ---------------------------------------------------------------------------

function coerceDefault(raw: string | undefined, type: string, name: string): unknown {
  if (raw == null) return undefined;
  switch (type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        fail(BPMN_ERROR_CODES.structureInvalid, null, `placeholder "${name}" default ${JSON.stringify(raw)} is not a valid number`);
      }
      return n;
    }
    case "boolean": {
      const b = toBool(raw);
      if (b === undefined) {
        fail(BPMN_ERROR_CODES.structureInvalid, null, `placeholder "${name}" default ${JSON.stringify(raw)} is not a valid boolean`);
      }
      return b;
    }
    default:
      return raw; // string | date carried verbatim
  }
}

// `type` stays a loose `string` here; the final `workflowSpecSchema.safeParse` in
// `compileBpmnToWorkflowSpec` enforces the PLACEHOLDER_TYPES enum.
type CompiledPlaceholders = {
  placeholders: Record<string, { type: string; required?: boolean; description?: string; default?: unknown }> | undefined;
  placeholderHints: Record<string, { kind: string }>;
};

function compilePlaceholders(process: ModdleElement): CompiledPlaceholders {
  const block = findExt(process, "cinatra:Placeholders");
  const placeholders: Record<string, { type: string; required?: boolean; description?: string; default?: unknown }> = {};
  const placeholderHints: Record<string, { kind: string }> = {};
  if (!block) return { placeholders: undefined, placeholderHints };

  for (const p of asArray<ModdleElement>(block.placeholders)) {
    const name = str(p.name);
    if (!name) fail(BPMN_ERROR_CODES.structureInvalid, p.id ?? null, "cinatra:placeholder is missing a name");
    if (name in placeholders) fail(BPMN_ERROR_CODES.placeholderDuplicate, null, `duplicate placeholder name "${name}"`);
    const type = str(p.type) ?? "string";
    const decl: { type: string; required?: boolean; description?: string; default?: unknown } = { type };
    const required = toBool(p.required);
    if (required !== undefined) decl.required = required;
    const description = str(p.description);
    if (description) decl.description = description;
    const def = coerceDefault(str(p.default), type, name);
    if (def !== undefined) decl.default = def;
    placeholders[name] = decl;

    const hint = p.hint as ModdleElement | undefined;
    const kind = str(hint?.kind);
    if (kind) placeholderHints[name] = { kind };
  }
  return { placeholders: Object.keys(placeholders).length > 0 ? placeholders : undefined, placeholderHints };
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

function compileSchedule(task: ModdleElement): TaskSpec["schedule"] | undefined {
  const s = findExt(task, "cinatra:TaskSchedule");
  if (!s) return undefined;
  const mode = str(s.mode);
  if (mode === "absolute") {
    const at = str(s.at);
    if (!at) fail(BPMN_ERROR_CODES.structureInvalid, task.id ?? null, "absolute schedule requires `at`");
    const out: Record<string, unknown> = { mode: "absolute", at };
    if (str(s.tz)) out.tz = str(s.tz);
    if (str(s.anchorPoint)) out.anchorPoint = str(s.anchorPoint);
    if (str(s.durationIso8601)) out.durationIso8601 = str(s.durationIso8601);
    return out as TaskSpec["schedule"];
  }
  if (mode === "relative") {
    const anchor = str(s.anchor);
    const offsetIso8601 = str(s.offsetIso8601);
    const direction = str(s.direction);
    if (!anchor || !offsetIso8601 || !direction) {
      fail(BPMN_ERROR_CODES.structureInvalid, task.id ?? null, "relative schedule requires anchor + offsetIso8601 + direction");
    }
    const out: Record<string, unknown> = { mode: "relative", anchor, offsetIso8601, direction };
    if (str(s.localTime)) out.localTime = str(s.localTime);
    if (str(s.tz)) out.tz = str(s.tz);
    if (str(s.anchorPoint)) out.anchorPoint = str(s.anchorPoint);
    if (str(s.durationIso8601)) out.durationIso8601 = str(s.durationIso8601);
    return out as TaskSpec["schedule"];
  }
  if (mode) fail(BPMN_ERROR_CODES.structureInvalid, task.id ?? null, `unknown schedule mode "${mode}"`);
  return undefined;
}

// ---------------------------------------------------------------------------
// dependsOn (sequenceFlow graph, gateways transparent)
// ---------------------------------------------------------------------------

function buildDependsOn(process: ModdleElement): (taskId: string) => TaskDependency[] {
  const flowElements = asArray<ModdleElement>(process.flowElements);
  const byId = new Map<string, ModdleElement>();
  for (const e of flowElements) if (e.id) byId.set(e.id, e);

  const incoming = new Map<string, ModdleElement[]>(); // targetId → sequenceFlows
  for (const e of flowElements) {
    if (e.$type !== "bpmn:SequenceFlow") continue;
    const target = (e.targetRef as ModdleElement | undefined)?.id;
    if (!target) continue;
    const arr = incoming.get(target) ?? [];
    arr.push(e);
    incoming.set(target, arr);
  }

  function resolve(targetId: string, seenGateways: Set<string>): TaskDependency[] {
    const result: TaskDependency[] = [];
    for (const flow of incoming.get(targetId) ?? []) {
      const srcId = (flow.sourceRef as ModdleElement | undefined)?.id;
      if (!srcId) continue;
      const src = byId.get(srcId);
      if (!src) continue;
      if (src.$type === "bpmn:StartEvent") continue; // workflow entry: no dependency
      if (TASK_TYPES.has(src.$type)) {
        const outcome = str(findExt(flow, "cinatra:TransitionOutcome")?.outcome);
        const dep: TaskDependency = { taskKey: srcId };
        if (outcome) (dep as { outcome?: string }).outcome = outcome;
        result.push(dep);
      } else if (src.$type === "bpmn:ParallelGateway") {
        if (seenGateways.has(srcId)) continue; // cycle guard
        // A gateway-outbound flow may not carry a transitionOutcome — the outcome
        // belongs on the upstream task's outbound edge, not the routing node's;
        // dropping it would silently lose semantics, so reject instead.
        if (findExt(flow, "cinatra:TransitionOutcome")) {
          fail(
            BPMN_ERROR_CODES.structureInvalid,
            srcId,
            "cinatra:transitionOutcome on a parallelGateway-outbound sequenceFlow is not supported; place it on the upstream task's outbound flow",
          );
        }
        result.push(...resolve(srcId, new Set([...seenGateways, srcId])));
      }
    }
    // Collapse by taskKey. The WorkflowSpec dependency model has at most ONE
    // edge per (task → upstream task); two edges to the same upstream task with
    // DIFFERENT outcomes are unrepresentable, so fail closed rather than emit a
    // dependency set the template validator / DB cannot store.
    const byKey = new Map<string, TaskDependency>();
    for (const d of result) {
      const existing = byKey.get(d.taskKey);
      if (!existing) {
        byKey.set(d.taskKey, d);
        continue;
      }
      const eo = (existing as { outcome?: string }).outcome;
      const no = (d as { outcome?: string }).outcome;
      if (eo !== no) {
        fail(
          BPMN_ERROR_CODES.structureInvalid,
          targetId,
          `conflicting dependency outcomes on "${d.taskKey}" → "${targetId}" (${eo ?? "any"} vs ${no ?? "any"})`,
        );
      }
    }
    return [...byKey.values()];
  }

  return (taskId: string) => resolve(taskId, new Set());
}

// ---------------------------------------------------------------------------
// foreach
// ---------------------------------------------------------------------------

function compileForeach(task: ModdleElement, core: Record<string, unknown>): Record<string, unknown> | undefined {
  const loop = task.loopCharacteristics as ModdleElement | undefined;
  if (!loop || loop.$type !== "bpmn:MultiInstanceLoopCharacteristics") return undefined;
  const fs = findExt(loop, "cinatra:ForeachSource");
  if (!fs) return undefined;
  const source = str(fs.source);
  const as = str(fs.as);
  if (!source || !as) fail(BPMN_ERROR_CODES.structureInvalid, task.id ?? null, "cinatra:foreachSource requires source + as");
  // The multiInstance task fans out over itself per item: the template mirrors
  // the task's core spec (`foreach.template` is a full TaskSpec). No Profile 1.0
  // consumer uses foreach today; covered by a dedicated unit fixture.
  const template = { ...core };
  const out: Record<string, unknown> = { source, as, template };
  if (str(fs.itemKey)) out.itemKey = str(fs.itemKey);
  if (str(fs.rollupPolicy)) out.rollupPolicy = str(fs.rollupPolicy);
  const maxFanout = toInt(fs.maxFanout);
  if (maxFanout !== undefined) out.maxFanout = maxFanout;
  return out;
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

function compileTask(task: ModdleElement, depsFor: (id: string) => TaskDependency[]): TaskSpec {
  const key = str(task.id);
  const title = str(task.name);
  if (!key) fail(BPMN_ERROR_CODES.structureInvalid, null, `task ${task.$type} is missing an id`);
  if (!title) fail(BPMN_ERROR_CODES.structureInvalid, key, `task "${key}" is missing a name (BPMN name → WorkflowSpec title)`);

  const common: Record<string, unknown> = { key, title };
  const schedule = compileSchedule(task);
  if (schedule) common.schedule = schedule;
  const deps = depsFor(key);
  if (deps.length > 0) common.dependsOn = deps;
  const policy = findExt(task, "cinatra:TaskPolicy");
  if (policy) {
    if (str(policy.failurePolicy)) common.failurePolicy = str(policy.failurePolicy);
    const maxAttempts = toInt(policy.maxAttempts);
    if (maxAttempts !== undefined) common.maxAttempts = maxAttempts;
  }

  // type-specific core (everything except dependsOn/schedule, used as foreach template too)
  let core: Record<string, unknown>;
  switch (task.$type) {
    case "bpmn:ServiceTask": {
      const agent = findExt(task, "cinatra:AgentRef");
      if (!agent || !str(agent.package)) fail(BPMN_ERROR_CODES.structureInvalid, key, `serviceTask "${key}" requires cinatra:agentRef with a package`);
      const agentRef: Record<string, unknown> = { package: str(agent.package) };
      if (str(agent.name)) agentRef.name = str(agent.name);
      if (str(agent.version)) agentRef.version = str(agent.version);
      if (str(agent.templateId)) agentRef.templateId = str(agent.templateId);
      core = { key, title, type: "agent_task", agentRef };
      const input = findExt(task, "cinatra:TaskInput");
      const body = str(input?.value);
      if (body) {
        try {
          core.input = JSON.parse(body);
        } catch {
          fail(BPMN_ERROR_CODES.taskInputInvalidJson, key, `cinatra:taskInput on "${key}" is not valid JSON`);
        }
      }
      break;
    }
    case "bpmn:UserTask": {
      const kind = str(findExt(task, "cinatra:TaskKind")?.value);
      if (kind === "approval") {
        const cfg = findExt(task, "cinatra:ApprovalConfig");
        const level = str(cfg?.level);
        if (!level) fail(BPMN_ERROR_CODES.structureInvalid, key, `approval userTask "${key}" requires cinatra:approvalConfig.level`);
        const requiredScope: Record<string, unknown> = { level };
        if (str(cfg?.id)) requiredScope.id = str(cfg?.id);
        core = { key, title, type: "approval", requiredScope };
        if (str(cfg?.rejectionPolicy)) core.rejectionPolicy = str(cfg?.rejectionPolicy);
      } else if (kind === "checkpoint") {
        core = { key, title, type: "checkpoint" };
      } else {
        fail(BPMN_ERROR_CODES.structureInvalid, key, `userTask "${key}" requires cinatra:taskKind value "approval" | "checkpoint" (got ${JSON.stringify(kind)})`);
      }
      break;
    }
    case "bpmn:ManualTask":
      core = { key, title, type: "manual" };
      break;
    case "bpmn:SendTask": {
      core = { key, title, type: "notification" };
      const msg = str(findExt(task, "cinatra:MessageBody")?.value);
      if (msg) core.message = msg;
      break;
    }
    default:
      fail(BPMN_ERROR_CODES.structureInvalid, key, `unexpected task type ${task.$type} reached compiler (should be rejected by the profile validator)`);
  }

  const foreach = compileForeach(task, core);
  return { ...core, ...common, ...(foreach ? { foreach } : {}) } as TaskSpec;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Compile a parsed Profile-1.0 BPMN `definitions` object into a WorkflowSpec.
 * Pure + synchronous. Throws `BpmnCompileException` (structured) on a malformed
 * graph that slipped past the validator.
 */
export function compileBpmnToWorkflowSpec(definitions: unknown): WorkflowSpec {
  const process = processOf(definitions);
  const meta = findExt(process, "cinatra:WorkflowMeta");
  const { placeholders, placeholderHints } = compilePlaceholders(process);
  const depsFor = buildDependsOn(process);

  const flowElements = asArray<ModdleElement>(process.flowElements);
  const tasks = flowElements.filter((e) => TASK_TYPES.has(e.$type)).map((t) => compileTask(t, depsFor));

  const spec: Record<string, unknown> = {
    key: str(process.id),
    name: str(meta?.name) ?? str(process.name) ?? str(process.id) ?? "Workflow",
    tasks,
  };
  if (str(meta?.product)) spec.product = str(meta?.product);
  const target = meta?.target as ModdleElement | undefined;
  if (target && str(target.tz)) {
    const t: Record<string, unknown> = { tz: str(target.tz) };
    if (str(target.at)) t.at = str(target.at);
    spec.target = t;
  }
  if (placeholders) spec.placeholders = placeholders;
  if (Object.keys(placeholderHints).length > 0) {
    spec.metadata = { placeholderHints };
  }

  const parsed = workflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    fail(
      BPMN_ERROR_CODES.structureInvalid,
      str(process.id) ?? null,
      `compiled WorkflowSpec failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}
