import type { WorkflowSpec } from "./schema";

// Spec resource limits. LLM-authored drafts must be bounded with
// actionable, structured errors. Inputs REFERENCE docs/artifacts — they never
// embed large content (hence the modest per-input byte cap).
export const SPEC_LIMITS = {
  maxTasks: 200,
  maxDependencies: 1000,
  maxApprovals: 100,
  maxArtifactsPerTask: 50,
  maxTitleLength: 200,
  maxInputBytes: 32_768,
  maxJsonDepth: 10,
  maxTotalSpecBytes: 262_144,
  maxScheduleHorizonDays: 730,
  maxOffsetDays: 365,
} as const;

export type StructuredSpecError = {
  code: string;
  message: string;
  path?: string;
  limit?: number;
  actual?: number;
};

const ISO_DURATION_PARTS_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Approximate an ISO 8601 duration in days (Y≈365, M≈30). Used only for the
 * coarse offset cap — exact calendar math happens in the schedule resolver.
 * Returns null for a malformed duration (caught separately by the schema).
 */
export function iso8601DurationToApproxDays(duration: string): number | null {
  const m = ISO_DURATION_PARTS_RE.exec(duration);
  if (!m) return null;
  const [, y, mo, w, d, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  return (
    y * 365 + mo * 30 + w * 7 + d + h / 24 + min / (24 * 60) + s / (24 * 60 * 60)
  );
}

export function jsonDepth(value: unknown, current = 1): number {
  if (value === null || typeof value !== "object") return current;
  let max = current;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // a `foreach.template` subtree is treated
    // as opaque by the outer spec's depth walker. The template is a
    // self-contained subspec that already validates independently against
    // `maxJsonDepth`, so counting it into the outer depth makes pathological-
    // looking nests that are actually legitimate fan-out parents.
    // We still recurse into the foreach NODE itself (source/as/itemKey/etc.),
    // but jump straight to depth=1 when entering `template`.
    if (k === "template" && v && typeof v === "object") {
      max = Math.max(max, jsonDepth(v, 1));
      continue;
    }
    max = Math.max(max, jsonDepth(v, current + 1));
  }
  return max;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * Static (no resolution) resource-limit checks over a structurally-valid spec.
 * Returns an empty array when within all limits.
 */
export function checkLimits(spec: WorkflowSpec): StructuredSpecError[] {
  const errors: StructuredSpecError[] = [];
  const tasks = spec.tasks ?? [];

  if (tasks.length > SPEC_LIMITS.maxTasks) {
    errors.push({
      code: "TOO_MANY_TASKS",
      message: `Workflow has ${tasks.length} tasks; the maximum is ${SPEC_LIMITS.maxTasks}.`,
      limit: SPEC_LIMITS.maxTasks,
      actual: tasks.length,
    });
  }

  const depCount = tasks.reduce((n, t) => n + (t.dependsOn?.length ?? 0), 0);
  if (depCount > SPEC_LIMITS.maxDependencies) {
    errors.push({
      code: "TOO_MANY_DEPENDENCIES",
      message: `Workflow has ${depCount} dependencies; the maximum is ${SPEC_LIMITS.maxDependencies}.`,
      limit: SPEC_LIMITS.maxDependencies,
      actual: depCount,
    });
  }

  const approvalCount = tasks.filter((t) => t.type === "approval").length;
  if (approvalCount > SPEC_LIMITS.maxApprovals) {
    errors.push({
      code: "TOO_MANY_APPROVALS",
      message: `Workflow has ${approvalCount} approval tasks; the maximum is ${SPEC_LIMITS.maxApprovals}.`,
      limit: SPEC_LIMITS.maxApprovals,
      actual: approvalCount,
    });
  }

  tasks.forEach((t, i) => {
    if (t.title && t.title.length > SPEC_LIMITS.maxTitleLength) {
      errors.push({
        code: "TITLE_TOO_LONG",
        message: `Task "${t.key}" title is ${t.title.length} chars; the maximum is ${SPEC_LIMITS.maxTitleLength}.`,
        path: `tasks[${i}].title`,
        limit: SPEC_LIMITS.maxTitleLength,
        actual: t.title.length,
      });
    }
    if (t.type === "agent_task" && t.input !== undefined) {
      const size = byteLength(t.input);
      if (size > SPEC_LIMITS.maxInputBytes) {
        errors.push({
          code: "INPUT_TOO_LARGE",
          message: `Task "${t.key}" input is ${size} bytes; the maximum is ${SPEC_LIMITS.maxInputBytes}. Reference documents/artifacts instead of embedding them.`,
          path: `tasks[${i}].input`,
          limit: SPEC_LIMITS.maxInputBytes,
          actual: size,
        });
      }
    }
    if (t.schedule?.mode === "relative") {
      const days = iso8601DurationToApproxDays(t.schedule.offsetIso8601);
      if (days !== null && days > SPEC_LIMITS.maxOffsetDays) {
        errors.push({
          code: "OFFSET_TOO_LARGE",
          message: `Task "${t.key}" schedule offset is ~${Math.round(days)} days; the maximum is ${SPEC_LIMITS.maxOffsetDays}.`,
          path: `tasks[${i}].schedule.offsetIso8601`,
          limit: SPEC_LIMITS.maxOffsetDays,
          actual: Math.round(days),
        });
      }
    }
    if (t.schedule?.durationIso8601) {
      const days = iso8601DurationToApproxDays(t.schedule.durationIso8601);
      if (days !== null && days > SPEC_LIMITS.maxOffsetDays) {
        errors.push({
          code: "DURATION_TOO_LARGE",
          message: `Task "${t.key}" bar duration is ~${Math.round(days)} days; the maximum is ${SPEC_LIMITS.maxOffsetDays}.`,
          path: `tasks[${i}].schedule.durationIso8601`,
          limit: SPEC_LIMITS.maxOffsetDays,
          actual: Math.round(days),
        });
      }
    }
  });

  const depth = jsonDepth(spec);
  if (depth > SPEC_LIMITS.maxJsonDepth) {
    errors.push({
      code: "JSON_TOO_DEEP",
      message: `Spec JSON nests ${depth} levels deep; the maximum is ${SPEC_LIMITS.maxJsonDepth}.`,
      limit: SPEC_LIMITS.maxJsonDepth,
      actual: depth,
    });
  }

  const totalBytes = byteLength(spec);
  if (totalBytes > SPEC_LIMITS.maxTotalSpecBytes) {
    errors.push({
      code: "SPEC_TOO_LARGE",
      message: `Spec is ${totalBytes} bytes; the maximum is ${SPEC_LIMITS.maxTotalSpecBytes}.`,
      limit: SPEC_LIMITS.maxTotalSpecBytes,
      actual: totalBytes,
    });
  }

  return errors;
}
