import "server-only";

/**
 * cinatra#1941 S2 — the boot-registered job-system runtime.
 *
 * Owns the globalThis-backed AsyncLocalStorage "job dispatch frame" that
 * carries a dispatched background job's #1941 authority metadata + raw
 * payload for the lifetime of its handler, and mints the audited System
 * `ActorContext` identity for `system-maintenance` jobs with no payload
 * attribution.
 *
 * Deliberately OUTSIDE `src/lib/org-write/`: the boundary gate's R2 rule
 * fail-closes ALL opaque (namespace/dynamic/require) access to that whole
 * surface, so a dynamic `import()` of an org-write module from the boot-only
 * `system-loops.ts` phase would itself be an R2-system-mint-opaque
 * violation. Living here keeps the frame reachable from boot without
 * tripping that net. The ONE org-write module this design adds
 * (`src/lib/org-write/job-system-authority-mint.ts`) imports
 * `getActiveJobFrame`/`readPayloadField` from here — a plain cross-module
 * import, not a boundary-gate concern in that direction.
 *
 * NOT imported by `background-jobs.ts` or `background-jobs-registry.ts` —
 * both sit in the reachable graph of the LOCKED dev-perf routes (route-graph
 * ratchet counts even dynamic `import()` specifiers), so this module is
 * wired ONLY through the boot-registered globalThis slot
 * (`registerJobSystemRuntime`, called from the `register-job-system-runtime`
 * system-loops phase BEFORE any loop seed runs) — mirroring the five
 * existing runner slots in `background-jobs-registry.ts`. The two reader
 * files each declare their OWN locally-typed read of the same globalThis
 * property instead of importing this module (see the "Read-only slot
 * access" note in `background-jobs.ts`), so this file gains zero readers at
 * the import-graph level.
 *
 * Privileged write-side exports (`registerJobSystemRuntime`,
 * `runWithJobFrame`) are fenced by the boundary gate's R5-job-frame rule to
 * their sole sanctioned consumer (`system-loops.ts`) — an unrestricted
 * `runWithJobFrame` could wrap a fabricated fat-capability frame around a
 * future allowlisted minter, or `registerJobSystemRuntime` could re-register
 * the slot to spoof the audited identity. `getActiveJobFrame`,
 * `buildJobSystemIdentity`, and `readPayloadField` are read-only/pure and
 * stay freely importable.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { logAuditEvent } from "@/lib/authz/audit";
import type { JobAuthorityMetadata } from "@/lib/background-jobs-registry";

/** One dispatched job's #1941 authority context, carried for the lifetime of
 *  its handler. `payload` is the job's raw `job.data` — the mint seam's
 *  payload-bound org-hopping check (§5) reads it via `readPayloadField`
 *  rather than re-threading it through every call site. */
export type JobDispatchFrame = {
  readonly jobName: string;
  readonly jobId: string;
  readonly authority: JobAuthorityMetadata;
  readonly payload: unknown;
};

const jobFrameStorage = new AsyncLocalStorage<JobDispatchFrame>();

/**
 * Run `fn` inside an ALS frame carrying `frame`. RESTRICTED to the boot
 * phase that wires the boot-registered slot — see the module docstring
 * (boundary-gate rule R5-job-frame).
 */
export function runWithJobFrame<T>(
  frame: JobDispatchFrame,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return jobFrameStorage.run(frame, fn);
}

/** The active job's dispatch frame, or `undefined` outside a dispatched job
 *  (direct calls, tests, non-job code). Read-only — freely importable. */
export function getActiveJobFrame(): JobDispatchFrame | undefined {
  return jobFrameStorage.getStore();
}

/**
 * Mint the audited System `ActorContext` for a dispatched job. NEVER derived
 * from the (forgeable) job payload — always fresh from the dispatcher's own
 * `job.name`/`job.id`. Read-only — freely importable.
 */
export function buildJobSystemIdentity(jobName: string, jobId: string): ActorContext {
  return {
    principalType: "System",
    principalId: `background-job:${jobName}:${jobId}`,
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Interpret a `JobOrgBinding` `{source:"payload", field}` binding against a
 * job's raw payload. Declarative-metadata interpreter (design doc D1): the
 * ONLY place a `field` string is resolved into a value, so extractor
 * "purity" is a property of this one tested function, not of arbitrary
 * per-job code. Returns `null` when the payload is not an object or the
 * field is absent/non-string (mirrors the org-extractor doc comment: "a
 * runtime null/non-string means the payload cannot bind an org").
 */
export function readPayloadField(payload: unknown, field: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * Fire-and-forget denial audit for an unclassified-job dispatch refusal
 * (D6/§4). Sink is the existing `logAuditEvent` append path — `audit_events`
 * is outside the kernel's org-axis table universe and `logAuditEvent` never
 * routes through `guardOrgMutation`, so this can never itself be refused by
 * archived-org state (D7). `logAuditEvent` already never throws (fire-and-
 * forget + internal `.catch`), so this needs no further error handling.
 */
export function auditUnclassifiedRefusal(jobName: string, jobId: string): void {
  void logAuditEvent({
    decision: "denied",
    operation: "background-job.unclassified",
    resourceType: "background-job",
    resourceId: jobName,
    actorPrincipalId: `background-job:${jobName}:${jobId}`,
    actorPrincipalType: "system",
    authSource: "worker",
    policyVersion: POLICY_VERSION,
    metadata: { jobId },
  });
}

/**
 * Anomaly telemetry (§3.1 rule 2): a `system-maintenance` job dispatched with
 * a payload `__actorContext` whose principalType is NOT HumanUser is still
 * honored exactly as today (no behavior change) — this only records that it
 * happened, as an `allowed` audit row, so the anomaly is visible rather than
 * silent. Ratcheting this to a refusal is wave-3's call.
 */
export function auditFrameAnomaly(jobName: string, jobId: string, principalType: string): void {
  void logAuditEvent({
    decision: "allowed",
    operation: "background-job.frame-anomaly",
    resourceType: "background-job",
    resourceId: jobName,
    actorPrincipalId: `background-job:${jobName}:${jobId}`,
    actorPrincipalType: "system",
    authSource: "worker",
    policyVersion: POLICY_VERSION,
    metadata: { jobId, payloadPrincipalType: principalType },
  });
}

/** The read-only + frame-running surface the dispatcher/registry consult via
 *  the boot-registered globalThis slot. */
export type JobSystemRuntime = {
  runWithJobFrame: typeof runWithJobFrame;
  buildSystemIdentity: typeof buildJobSystemIdentity;
  auditUnclassifiedRefusal: typeof auditUnclassifiedRefusal;
  auditFrameAnomaly: typeof auditFrameAnomaly;
};

declare global {
  // eslint-disable-next-line no-var
  var __cinatraJobSystemRuntime: JobSystemRuntime | undefined;
}

/**
 * Boot-time registration — called from the `register-job-system-runtime`
 * system-loops phase BEFORE any loop seed runs. RESTRICTED — see the module
 * docstring (boundary-gate rule R5-job-frame). Idempotent (last write wins),
 * matching the five existing runner slots in `background-jobs-registry.ts`.
 */
export function registerJobSystemRuntime(runtime: JobSystemRuntime): void {
  globalThis.__cinatraJobSystemRuntime = runtime;
}
