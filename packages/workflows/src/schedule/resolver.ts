import { TZDate } from "@date-fns/tz";
import { add, sub, type Duration } from "date-fns";
import type { WorkflowSpec, TaskSpec, ScheduleSpec } from "../spec/schema";
import { TARGET_ANCHOR } from "../spec/types";

// ---------------------------------------------------------------------------
// Server-side schedule resolver. The single source of schedule truth — the
// Gantt emits an edit *intent*; the server returns the resolved instants / a
// cascade diff. Zone-aware calendar math via @date-fns/tz TZDate (UTC instants
// for storage; wall-clock semantics for relative offsets).
//
// Anchor semantics: a relative anchor resolves to the anchor task's canonical
// `dueAtUtc` (AFTER its own anchorPoint/duration are applied), never its raw
// schedule instant. Pinned tasks are frozen at their current due so descendants
// anchored to them do NOT cascade (see computeCascadeDiff).
//
// DST policy: relative offsets are calendar durations applied in the
// task/release tz, then converted to UTC. A nonexistent local time
// (spring-forward gap) rolls FORWARD to the post-transition instant and emits a
// `DST_GAP` warning; an ambiguous repeated time (fall-back) resolves to the
// earlier offset (TZDate normalization). UTC offsets therefore change across a
// DST boundary while the wall-clock time is preserved.
// ---------------------------------------------------------------------------

export type ResolvedTask = {
  plannedStartUtc: string;
  plannedEndUtc: string;
  dueAtUtc: string;
};

export type ResolveWarning = { taskKey: string; code: string; message: string };

export type ResolveResult = {
  tasks: Record<string, ResolvedTask>;
  warnings: ResolveWarning[];
};

export type ResolveOptions = {
  /** Override spec.target.at (used by the cascade to model a moved release). */
  targetAtUtc?: string;
  /** taskKey -> frozen dueAtUtc; a frozen task resolves to this instant and
   *  anchors descendants from it (pinned tasks during a cascade). */
  /** `string` = just the dueAt (the computeCascadeDiff caller).
   *  `{ dueAtUtc, plannedStartUtc, plannedEndUtc }` = full bar tuple so a pinned
   *  task with `durationIso8601` keeps its start/end on rebuild. */
  frozenDueAt?: Record<string, string | { dueAtUtc: string; plannedStartUtc: string; plannedEndUtc: string }>;
};

export type CascadeChange = { targetAtUtc?: string };

export type CascadeDiffEntry = {
  taskKey: string;
  oldDueAtUtc: string;
  newDueAtUtc: string;
};

const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;
const COMPONENTS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;
const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseIsoDuration(value: string): Duration | null {
  const m = DURATION_RE.exec(value);
  if (!m) return null;
  const n = (x?: string) => (x ? Number(x) : 0);
  return {
    years: n(m[1]),
    months: n(m[2]),
    weeks: n(m[3]),
    days: n(m[4]),
    hours: n(m[5]),
    minutes: n(m[6]),
    seconds: n(m[7]),
  };
}

/** Parse an ISO datetime to a UTC-ms instant. A bare (offset-less) datetime is
 *  interpreted as wall-clock in `tz`; an offset/Z datetime is an absolute instant. */
export function parseInstantMs(iso: string, tz: string): number {
  if (OFFSET_RE.test(iso)) return Date.parse(iso);
  const m = COMPONENTS_RE.exec(iso);
  if (!m) return Date.parse(iso);
  const [, y, mo, d, h, mi, s] = m;
  return new TZDate(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    tz,
  ).getTime();
}

function applyLocalTime(
  ms: number,
  h: number,
  mi: number,
  tz: string,
): { ms: number; gap: boolean } {
  const d = new TZDate(ms, tz);
  d.setHours(h, mi, 0, 0);
  // If the requested wall-clock time does not exist (spring-forward gap), TZDate
  // normalizes forward — detect by reading the resulting wall-clock back.
  const gap = d.getHours() !== h || d.getMinutes() !== mi;
  return { ms: d.getTime(), gap };
}

function tzOf(spec: WorkflowSpec, schedule: ScheduleSpec | undefined): string {
  return schedule?.tz ?? spec.target?.tz ?? "UTC";
}

/** Apply anchorPoint + bar duration to an anchor instant → {start,end,due} ms.
 *  The DUE is the canonical point downstream anchors reference. */
function applyBar(
  anchorInstantMs: number,
  schedule: ScheduleSpec | undefined,
  tz: string,
): { startMs: number; endMs: number; dueMs: number } {
  const barDur = schedule?.durationIso8601 ? parseIsoDuration(schedule.durationIso8601) : null;
  const anchorPoint = schedule?.anchorPoint ?? "due";
  if (anchorPoint === "start") {
    const startMs = anchorInstantMs;
    const endMs = barDur ? add(new TZDate(startMs, tz), barDur).getTime() : startMs;
    return { startMs, endMs, dueMs: endMs };
  }
  if (anchorPoint === "end") {
    const endMs = anchorInstantMs;
    const startMs = barDur ? sub(new TZDate(endMs, tz), barDur).getTime() : endMs;
    return { startMs, endMs, dueMs: endMs };
  }
  // "due" (default): the resolved instant IS the due; the bar ends at due.
  const dueMs = anchorInstantMs;
  const startMs = barDur ? sub(new TZDate(dueMs, tz), barDur).getTime() : dueMs;
  return { startMs, endMs: dueMs, dueMs };
}

/**
 * Resolve every task's planned start/end + due-at to UTC ISO strings. Pure: no
 * DB, no mutation.
 */
export function resolveSchedule(spec: WorkflowSpec, opts: ResolveOptions = {}): ResolveResult {
  const warnings: ResolveWarning[] = [];
  const byKey = new Map<string, TaskSpec>(spec.tasks.map((t) => [t.key, t]));
  const fullMemo = new Map<string, { startMs: number; endMs: number; dueMs: number }>();

  const targetTz = spec.target?.tz ?? "UTC";
  const targetIso = opts.targetAtUtc ?? spec.target?.at;
  const targetMs = targetIso ? parseInstantMs(targetIso, targetTz) : Date.now();
  const frozen = opts.frozenDueAt ?? {};

  // Returns a task's canonical dueAt ms (what descendants anchor to).
  const resolveDueMs = (key: string, stack: Set<string>): number => {
    if (fullMemo.has(key)) return fullMemo.get(key)!.dueMs;
    if (Object.prototype.hasOwnProperty.call(frozen, key)) {
      const f = frozen[key];
      if (typeof f === "string") {
        const ms = Date.parse(f);
        fullMemo.set(key, { startMs: ms, endMs: ms, dueMs: ms });
        return ms;
      }
      // Full-tuple freeze preserves duration bars.
      const dueMs = Date.parse(f.dueAtUtc);
      fullMemo.set(key, {
        startMs: Date.parse(f.plannedStartUtc),
        endMs: Date.parse(f.plannedEndUtc),
        dueMs,
      });
      return dueMs;
    }
    if (stack.has(key)) return targetMs; // cycle (rejected by validation) — fail safe
    stack.add(key);

    const task = byKey.get(key);
    const sch = task?.schedule;
    const tz = tzOf(spec, sch);
    let anchorInstantMs: number;

    if (!sch) {
      anchorInstantMs = targetMs;
      warnings.push({
        taskKey: key,
        code: "UNSCHEDULED_DEFAULTED_TO_RELEASE",
        message: `Task "${key}" has no schedule; planned at the release instant.`,
      });
    } else if (sch.mode === "absolute") {
      anchorInstantMs = parseInstantMs(sch.at, tz);
    } else {
      const anchorMs =
        sch.anchor === TARGET_ANCHOR ? targetMs : resolveDueMs(sch.anchor, stack);
      const dur = parseIsoDuration(sch.offsetIso8601) ?? {};
      const base = new TZDate(anchorMs, tz);
      let ms = (sch.direction === "before" ? sub(base, dur) : add(base, dur)).getTime();
      if (sch.localTime) {
        const [h, mi] = sch.localTime.split(":").map(Number);
        const lt = applyLocalTime(ms, h, mi, tz);
        ms = lt.ms;
        if (lt.gap) {
          warnings.push({
            taskKey: key,
            code: "DST_GAP",
            message: `Task "${key}" local time ${sch.localTime} falls in a DST spring-forward gap on its resolved date; rolled forward.`,
          });
        }
      }
      anchorInstantMs = ms;
    }

    const bar = applyBar(anchorInstantMs, sch, tz);
    stack.delete(key);
    fullMemo.set(key, bar);
    return bar.dueMs;
  };

  for (const t of spec.tasks) resolveDueMs(t.key, new Set());

  // Hierarchy parent-window pass: a task referenced as
  // `parent` by any other task has its window DERIVED from its children
  // (start = min(child.start), end = max(child.end), due = max(child.due));
  // validation rejects own-schedule/pinned on parents, so the placeholder dates
  // from the main loop are overwritten here. Recurses bottom-up so a parent-of-
  // parents derives from its descendants' leaves; acyclicity is validated.
  const childrenByParent = new Map<string, string[]>();
  for (const t of spec.tasks) {
    if (!t.parent) continue;
    const arr = childrenByParent.get(t.parent) ?? [];
    arr.push(t.key);
    childrenByParent.set(t.parent, arr);
  }
  const parentDone = new Set<string>();
  const recomputeParent = (key: string): void => {
    if (parentDone.has(key)) return;
    parentDone.add(key);
    const children = childrenByParent.get(key);
    if (!children?.length) return;
    let startMs = Infinity;
    let endMs = -Infinity;
    let dueMs = -Infinity;
    for (const c of children) {
      recomputeParent(c);
      const cb = fullMemo.get(c);
      if (!cb) continue;
      if (cb.startMs < startMs) startMs = cb.startMs;
      if (cb.endMs > endMs) endMs = cb.endMs;
      if (cb.dueMs > dueMs) dueMs = cb.dueMs;
    }
    if (Number.isFinite(startMs)) fullMemo.set(key, { startMs, endMs, dueMs });
  };
  for (const t of spec.tasks) recomputeParent(t.key);

  // Drop the "no schedule" warning for parent tasks — their window is
  // intentionally derived, not missing.
  const filteredWarnings = warnings.filter(
    (w) => !(w.code === "UNSCHEDULED_DEFAULTED_TO_RELEASE" && childrenByParent.has(w.taskKey)),
  );

  const tasks: Record<string, ResolvedTask> = {};
  for (const t of spec.tasks) {
    const bar = fullMemo.get(t.key)!;
    tasks[t.key] = {
      plannedStartUtc: new Date(bar.startMs).toISOString(),
      plannedEndUtc: new Date(bar.endMs).toISOString(),
      dueAtUtc: new Date(bar.dueMs).toISOString(),
    };
  }

  return { tasks, warnings: filteredWarnings };
}

/**
 * Cascade diff: given a change (e.g. a new release date), return
 * the per-task due-at changes for UNPINNED tasks only. Pinned tasks are FROZEN
 * at their current due (so descendants anchored to a pinned task do not cascade
 * from the pinned task's hidden new date). No mutation; the Gantt commits the
 * diff via CAS.
 */
export function computeCascadeDiff(spec: WorkflowSpec, change: CascadeChange): CascadeDiffEntry[] {
  const before = resolveSchedule(spec).tasks;
  const frozenDueAt: Record<string, string> = {};
  for (const t of spec.tasks) {
    if (t.pinned && before[t.key]) frozenDueAt[t.key] = before[t.key].dueAtUtc;
  }
  const after = resolveSchedule(spec, { targetAtUtc: change.targetAtUtc, frozenDueAt }).tasks;

  // Skip parents: their windows are DERIVED from children;
  // the preview shows leaf-task diffs the user can actually action.
  const hasChildren = new Set<string>();
  for (const t of spec.tasks) if (t.parent) hasChildren.add(t.parent);

  const diff: CascadeDiffEntry[] = [];
  for (const t of spec.tasks) {
    if (t.pinned) continue;
    if (hasChildren.has(t.key)) continue;
    const oldDue = before[t.key]?.dueAtUtc;
    const newDue = after[t.key]?.dueAtUtc;
    if (oldDue && newDue && oldDue !== newDue) {
      diff.push({ taskKey: t.key, oldDueAtUtc: oldDue, newDueAtUtc: newDue });
    }
  }
  return diff;
}
