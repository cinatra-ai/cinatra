import "server-only";

// A2 app-layer execution-environment service — the PURE composition core
// (exec-plane S3, cinatra#1708; epic #1705).
//
// Owns the tri-state readiness resolution + the ready-slot COMPOSITION (the
// declared-env resolver, the durable retention reaper, the teardown participant,
// the org-scoped archive reference drop). Every execution-plane / llm import
// here is TYPE-ONLY (erased at compile) and every runtime dep is INJECTED, so
// this module is fully unit-testable without the heavy execution-plane graph.
// The concrete singleton CONSTRUCTION (which imports the execution-plane VALUES
// + the durable pg store) lives in the boot-only sibling
// `environment-execution-service-construct.ts`.
//
// TRI-STATE READINESS (Codex findings 2/3/6 — fail-closed, no silent L0):
//   - `disabled`    — the instance is not opted into the execution plane. Every
//     current instance resolves here → byte-unchanged.
//   - `ready`       — opted in, provenance key present, AND a broker-executor
//     binding available: declared-env runs build + mount their layer.
//   - `unavailable` — opted in / required BUT cannot instantiate: no provenance
//     key, OR no broker-executor wiring (the `execution-broker` boot phase did
//     not register a factory — flag off, mode disabled/remote, or the handshake
//     did not complete). Rather than fabricate a `ready` posture that cannot
//     mount, the service resolves `unavailable` so declared-env runs FAIL CLOSED
//     — the design's §1.4 posture, generalized. The app-broker wiring itself
//     landed with the S1b activation slice (cinatra#2138).

import type {
  EnvironmentLayerCache,
  ReferenceMatch,
  TrustedEnvironmentBuilder,
} from "@cinatra-ai/execution-plane";
import type { SandboxEnvironmentMount, SandboxExecutor } from "@cinatra-ai/llm";
import {
  evaluateExecutionPlaneReadiness,
  executionPlaneRequired,
} from "@/lib/boot/phases/execution-plane-health";
import type { DurableEnvironmentLayerStore } from "@/lib/execution/environment-layer-store.pg";
import type {
  ExecutionEnvironmentServiceSlot,
  ResolveRunExecutionMountInput,
} from "@/lib/execution/register-execution-environment-service";

/** Host-held HMAC secret for provenance signing/verification (loop-provisioned
 * internal secret; NEVER enters a container). Absent ⇒ the slot is unavailable
 * (declared-env runs fail closed) — never a silent unsigned mount. */
export const PROVENANCE_KEY_ENV = "EXECUTION_ENVIRONMENT_PROVENANCE_KEY";

/** Default retention window for unreferenced layers before the GC reaps them
 * (mirrors the exec-plane `DEFAULT_ENVIRONMENT_LAYER_RETENTION_MS`; inlined so
 * this module takes no runtime execution-plane import). */
export const DEFAULT_ENVIRONMENT_LAYER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The S1 app-broker wiring seam. A `ready` posture needs a broker-backed
 * `SandboxExecutor`. The wiring LANDED with the S1b activation slice
 * (cinatra#2138): the `execution-broker` boot phase registers a factory when
 * (and only when) the default-off ROLLOUT flag is on, the mode is `local-dev`,
 * and a broker↔worker health handshake completed. With the flag off no phase
 * exists, no factory is registered, and an opted-in instance resolves
 * `unavailable`. Tests inject a fake factory to exercise the `ready` path.
 */
export type ExecutionExecutorFactory = () => SandboxExecutor;

declare global {
  var __cinatraExecutionExecutorFactory: ExecutionExecutorFactory | undefined;
}

/**
 * ANCHORED ON `globalThis`, not on a module-local binding (exec-plane S1b,
 * cinatra#2138 — Codex convergence finding 1). The boot phase runs inside the
 * Next instrumentation bundle while the chat runtime and the llm-bridge route
 * run in their own route bundles; a module-local `let` would give each bundle
 * its OWN copy, so boot could register an executor that no request ever sees
 * (readiness `ready`, capability silently `capability_unavailable`). The
 * sibling S3 slot (`register-execution-environment-service.ts`) uses exactly
 * this pattern for exactly this reason.
 */
function executorFactorySlot(): ExecutionExecutorFactory | undefined {
  return globalThis.__cinatraExecutionExecutorFactory;
}

/** Register the broker-executor factory. LANDED as the S1b activation slice
 * (cinatra#2138): the `execution-broker` boot phase calls this — and ONLY past
 * a completed broker↔worker health handshake — so `ready` is reachable exactly
 * when the plane has really run a command on a live worker. With the default-off
 * ROLLOUT flag unset that phase does not exist, nothing registers, and
 * declared-env runs keep failing closed. */
export function registerExecutionExecutorFactory(factory: ExecutionExecutorFactory): void {
  globalThis.__cinatraExecutionExecutorFactory = factory;
}

/**
 * Explicitly CLEAR the registration (Codex convergence finding 4). A re-boot
 * whose handshake fails — or that reads a `disabled` / `remote` mode — must not
 * leave an earlier boot's executor in place, or readiness would keep reporting
 * `ready` against a broker that is no longer proven. Every non-ready boot branch
 * calls this.
 */
export function clearExecutionExecutorFactory(): void {
  globalThis.__cinatraExecutionExecutorFactory = undefined;
}

/**
 * The broker-backed executor for the trusted surface issuers (chat + agent-run),
 * or `undefined` when the plane is not wired (flag off, mode disabled/remote,
 * handshake failed). The injection layer treats an absent executor as
 * `capability_unavailable` and keeps the model usable — it NEVER delivers a tool
 * schema the model could call into a void (exec-plane S1b, cinatra#2138
 * deliverable 2).
 */
export function getRegisteredExecutionExecutor(): SandboxExecutor | undefined {
  return executorFactorySlot()?.();
}

/** Test seam — drop the registered factory between hermetic runs. */
export function _resetExecutionExecutorFactoryForTests(): void {
  clearExecutionExecutorFactory();
}

export type ExecutionEnvironmentReadiness =
  | { state: "disabled" }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; provenanceKey: string; executorFactory: ExecutionExecutorFactory };

/**
 * Pure tri-state readiness resolution (no I/O). `disabled` unless the instance
 * opted into the plane; then `ready` only when BOTH the provenance key AND a
 * broker-executor factory are present — otherwise `unavailable` (fail-closed).
 */
export function resolveExecutionEnvironmentReadiness(
  env: Record<string, string | undefined> = process.env,
  factory: ExecutionExecutorFactory | undefined = executorFactorySlot(),
): ExecutionEnvironmentReadiness {
  const optedIn =
    evaluateExecutionPlaneReadiness(env).state !== "not-configured" ||
    executionPlaneRequired(env);
  if (!optedIn) return { state: "disabled" };
  const provenanceKey = (env[PROVENANCE_KEY_ENV] ?? "").trim();
  if (provenanceKey === "") {
    return { state: "unavailable", reason: `missing ${PROVENANCE_KEY_ENV}` };
  }
  if (!factory) {
    return {
      state: "unavailable",
      reason:
        "no broker-executor wiring — the execution-broker boot phase has not " +
        "registered a factory (rollout flag off, mode disabled/remote, or the " +
        "broker↔worker handshake did not complete)",
    };
  }
  return { state: "ready", provenanceKey, executorFactory: factory };
}

/** The construction seams the ready slot needs — injectable for hermetic tests. */
export type EnvironmentServiceDeps = {
  cache: EnvironmentLayerCache;
  store: DurableEnvironmentLayerStore;
  builder: Pick<TrustedEnvironmentBuilder, "ensureEnvironmentLayer">;
  executor: SandboxExecutor;
  /** docker rmi seam (delete-then-rmi ordering); default = `docker rmi <ref>`
   * via a lazy execution-plane import (only reached in a real reap). */
  removeImage?: (imageDigest: string) => Promise<void>;
  now?: () => number;
};

async function defaultRemoveImage(imageDigest: string): Promise<void> {
  // Lazy import so this module takes no STATIC execution-plane value import
  // (kept type-only for app-vitest hermeticity); reached only in a real reap.
  // Removes by the IMMUTABLE image DIGEST (not the mutable content-addressed
  // tag) so a post-commit rebuild's re-pointed tag is never rmi'd.
  const { runDocker } = await import("@cinatra-ai/execution-plane");
  await runDocker(["rmi", imageDigest]);
}

/**
 * Build the `ready` slot from constructed singletons. Pure composition — every
 * dep is injectable, so the resolver / durable reaper / teardown / archive drop
 * are all unit-testable against the in-memory store + fakes.
 */
export function buildReadyExecutionEnvironmentSlot(
  deps: EnvironmentServiceDeps,
): ExecutionEnvironmentServiceSlot {
  const now = deps.now ?? Date.now;
  const removeImage = deps.removeImage ?? defaultRemoveImage;

  const resolveRunExecutionMount = async (
    input: ResolveRunExecutionMountInput,
  ): Promise<SandboxEnvironmentMount | undefined> => {
    const result = await deps.builder.ensureEnvironmentLayer({
      raw: input.spec,
      orgId: input.orgId,
      visibility: input.visibility,
    });
    // IMPOSSIBLE STATE: we only reach here for kind:"declared" (a
    // non-empty spec), so a "no-environment" build result is an internal
    // inconsistency — return undefined so the caller REFUSES the run; NEVER map
    // it to L0 (a declared run must never silently lose its environment).
    if (result.kind === "no-environment") return undefined;
    const { entry } = result;
    // Write the at-use reference BEFORE projecting the mount (§1.3): a layer a
    // run is actively using is always referenced, so it is never a reap
    // candidate while in use (the primary GC-race defense). Idempotent via the
    // NULLS-NOT-DISTINCT unique.
    await deps.cache.addReference({
      recipeKey: entry.recipeKey,
      orgId: input.orgId,
      holder: input.holder,
    });
    // Narrow the resolved entry to the OPAQUE transport mount (imageRef is a
    // display alias; the worker acts only on the signed provenance).
    return { imageRef: entry.imageRef, provenance: entry.provenance };
  };

  const reapEnvironmentLayers = async (opts?: {
    retentionMs?: number;
  }): Promise<{ reaped: string[] }> => {
    const retentionMs = opts?.retentionMs ?? DEFAULT_ENVIRONMENT_LAYER_RETENTION_MS;
    const cutoff = now() - retentionMs;
    // Pre-filter (unreferenced + old); the per-candidate reap re-checks under
    // the advisory lock (§2.1 — the delete-then-commit is fenced against a
    // concurrent addReference which takes the SAME lock).
    const candidates = await deps.store.listReapableLayers(cutoff);
    const reaped: string[] = [];
    for (const candidate of candidates) {
      const removed = await deps.store.reapCandidateUnderLock(
        candidate.recipeKey,
        candidate.partition,
        cutoff,
      );
      if (!removed) continue; // re-referenced / refreshed after the pre-filter.
      // Row already deleted + committed; the rmi is best-effort and targets the
      // IMMUTABLE image DIGEST (never the mutable tag — Codex convergence: a
      // post-commit rebuild of the same recipe re-points the deterministic tag,
      // so removing by tag could delete the rebuilt in-use image; removing by the
      // old digest never touches it, and if that digest is somehow still
      // referenced docker refuses and it stays — a benign disk orphan swept by
      // `docker image prune`, never a dangling row (delete-then-rmi order).
      try {
        await removeImage(removed.removedImageDigest);
      } catch {
        // benign disk orphan; the row is gone.
      }
      reaped.push(candidate.recipeKey);
    }
    return { reaped };
  };

  return {
    state: "ready",
    resolveRunExecutionMount,
    getRunExecutionExecutor: () => deps.executor,
    // Hard-removal participant: drop a package's refs (all orgs); layers are
    // left to the retention GC (mirrors the exec-plane teardown participant,
    // inlined so this module takes no runtime execution-plane import).
    getEnvironmentTeardownParticipant: () => async (packageName: string) => ({
      droppedReferences: await deps.cache.dropReferences({ packageName }),
    }),
    dropEnvironmentReferences: (match: ReferenceMatch) => deps.cache.dropReferences(match),
    reapEnvironmentLayers,
  };
}
