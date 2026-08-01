import "server-only";

// Tri-state DI slot for the A2 execution-environment service (exec-plane S3,
// cinatra#1708; epic #1705).
//
// The run seam (`src/app/api/llm-bridge/route.ts`, HOT) and the teardown wiring
// reach the execution service WITHOUT importing the heavy execution-plane graph
// at their own module load — via this `globalThis`-anchored slot (the
// register-* decouple pattern used ~20× in instrumentation.node.ts). The boot
// phase (`src/lib/boot/phases/environment-execution-service.ts`) instantiates
// the singletons and registers the slot; every reader imports ONLY this
// lightweight module (types-only imports from the packages, erased at compile).
//
// FAIL-CLOSED DEFAULT: the UNREGISTERED slot state is
// `"unavailable"`. A module that reads the slot before the boot phase ran sees
// `unavailable` and fails a DECLARED-environment run closed — never a silent
// pass to L0. The boot phase EXPLICITLY transitions the state to `disabled`
// (instance not opted in) or `ready` (opted in + can instantiate). A declared
// environment that CANNOT be honored NEVER silently degrades to L0; only a run
// that declared NO environment runs L0.

import type { SandboxEnvironmentMount, SandboxExecutor } from "@cinatra-ai/llm";
import type { ReferenceMatch } from "@cinatra-ai/execution-plane";

/**
 *  - `disabled`    — the instance is genuinely not opted into the execution
 *    plane. A declared-env run refuses (it cannot be honored here); a run with
 *    NO declared environment runs L0. Today's instances resolve here → byte-
 *    unchanged.
 *  - `ready`       — opted in, provenance key present, an executor binding
 *    available: declared-env runs build + mount their layer.
 *  - `unavailable` — opted in / required BUT cannot instantiate (missing
 *    provenance key, no broker-executor wiring yet, boot failure). Declared-env
 *    runs FAIL CLOSED (audited) rather than silently drop to L0.
 */
export type ExecutionServiceState = "disabled" | "ready" | "unavailable";

/** WHO needs a layer — a packaged agent or a project agent (for the ref row). */
export type EnvironmentReferenceHolder = {
  packageName?: string;
  templateId?: string;
  versionId?: string;
};

/** Input the run seam supplies to build + project a run's declared mount. */
export type ResolveRunExecutionMountInput = {
  /** The parsed, non-empty declared environment spec (kind: "declared"). */
  spec: unknown;
  orgId: string;
  /** `org-private` partitions the layer to the org (private-package recipes). */
  visibility?: "shared" | "org-private";
  /** The reference holder written lazily-at-use before the mount is projected. */
  holder: EnvironmentReferenceHolder;
};

/** The registered slot the boot phase installs (present only in `ready`). */
export type ExecutionEnvironmentServiceSlot = {
  state: ExecutionServiceState;
  /**
   * Build (or cache-hit) the declared layer, write the at-use reference, and
   * project the opaque mount. Resolves `undefined` on an IMPOSSIBLE state
   * (a declared spec that the builder reports has no environment) so the caller
   * REFUSES the run — never a silent L0 fallback. Present only in
   * `ready`.
   */
  resolveRunExecutionMount?: (
    input: ResolveRunExecutionMountInput,
  ) => Promise<SandboxEnvironmentMount | undefined>;
  /** The memoized broker-backed executor (present only in `ready`). */
  getRunExecutionExecutor?: () => SandboxExecutor | undefined;
  /** Hard-removal participant: drop a package's refs (all orgs). A3 (§2.2). */
  getEnvironmentTeardownParticipant?: () => ((packageName: string) => Promise<unknown>) | undefined;
  /** Org-scoped archive reference drop (A3 §2.2 second seam). */
  dropEnvironmentReferences?: (match: ReferenceMatch) => Promise<number>;
  /** Durable retention-GC reap (A3 §2.1), driven by the scheduled worker. */
  reapEnvironmentLayers?: (opts?: {
    retentionMs?: number;
  }) => Promise<{ reaped: string[] }>;
};

/**
 * The hard-removal RUN-teardown participant (epic #1705 AC9): cancel the
 * package's queued sandbox jobs, terminate its in-flight ones and collect its
 * retained run workspaces.
 *
 * It lives in THIS module rather than a sibling one on purpose. Its only reader
 * is `extension-data-teardown-wiring`, which already imports this module and is
 * loaded on every path that can hard-remove an extension — including UI Server
 * Actions and, transitively, hot routes. A second slot module would add a
 * module to those routes' reachable graphs for nothing (the route-graph ratchet
 * measures exactly that), so the two lightweight execution slots share one
 * lightweight file.
 *
 * Best-effort and idempotent; resolves a small summary that is logged, never
 * depended on.
 */
export type ExecutionRunTeardownParticipant = (input: {
  packageName: string;
  runIds: readonly string[];
  /** True when the caller's id list was capped (there were MORE runs). */
  runIdsTruncated?: boolean;
}) => Promise<{ runs: number; terminatedJobs: number }>;

declare global {
  var __cinatraExecutionEnvironmentService: ExecutionEnvironmentServiceSlot | undefined;
  var __cinatraExecutionRunTeardown: ExecutionRunTeardownParticipant | undefined;
}

/** Install the slot (boot phase). Last write wins (idempotent re-boot). */
export function registerExecutionEnvironmentService(
  slot: ExecutionEnvironmentServiceSlot,
): void {
  globalThis.__cinatraExecutionEnvironmentService = slot;
}

function slot(): ExecutionEnvironmentServiceSlot | undefined {
  return globalThis.__cinatraExecutionEnvironmentService;
}

/** Fail-closed default: an unregistered slot is `unavailable`, never `disabled`. */
export function getExecutionServiceState(): ExecutionServiceState {
  return slot()?.state ?? "unavailable";
}

export async function resolveRunExecutionMount(
  input: ResolveRunExecutionMountInput,
): Promise<SandboxEnvironmentMount | undefined> {
  const s = slot();
  if (!s || s.state !== "ready" || !s.resolveRunExecutionMount) return undefined;
  return s.resolveRunExecutionMount(input);
}

export function getRunExecutionExecutor(): SandboxExecutor | undefined {
  const s = slot();
  if (!s || s.state !== "ready") return undefined;
  return s.getRunExecutionExecutor?.();
}

export function getEnvironmentTeardownParticipant():
  | ((packageName: string) => Promise<unknown>)
  | undefined {
  const s = slot();
  if (!s || s.state !== "ready") return undefined;
  return s.getEnvironmentTeardownParticipant?.();
}

export function getEnvironmentArchiveReferenceDropper():
  | ((match: ReferenceMatch) => Promise<number>)
  | undefined {
  const s = slot();
  if (!s || s.state !== "ready") return undefined;
  return s.dropEnvironmentReferences;
}

/**
 * Install the run-teardown participant (boot phase). Last write wins.
 *
 * FAIL-QUIET DEFAULT: unregistered ⇒ `undefined` ⇒ the teardown half is a
 * no-op. Correct rather than fail-closed, deliberately: an instance with no
 * execution plane has no jobs to cancel and no workspaces to collect, and a
 * hard removal that is ALREADY COMMITTED must never be aborted by a missing
 * best-effort participant.
 */
export function registerExecutionRunTeardown(
  participant: ExecutionRunTeardownParticipant,
): void {
  globalThis.__cinatraExecutionRunTeardown = participant;
}

/** Drop the participant — a re-boot that wires no broker must not leave a stale
 *  one reachable (it would hold a closed remote client). */
export function clearExecutionRunTeardown(): void {
  globalThis.__cinatraExecutionRunTeardown = undefined;
}

export function getExecutionRunTeardownParticipant():
  | ExecutionRunTeardownParticipant
  | undefined {
  return globalThis.__cinatraExecutionRunTeardown;
}

export function getEnvironmentLayerReaper():
  | ((opts?: { retentionMs?: number }) => Promise<{ reaped: string[] }>)
  | undefined {
  const s = slot();
  if (!s || s.state !== "ready") return undefined;
  return s.reapEnvironmentLayers;
}
