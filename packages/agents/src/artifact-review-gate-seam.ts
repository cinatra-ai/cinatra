import "server-only";

// ---------------------------------------------------------------------------
// Artifact-review gate SEAM binder (cinatra#1796, epic #1620 S13).
//
// The BOOT-side counterpart of the `globalThis.__cinatraArtifactReviewGateSeam`
// slot that `execution.ts`'s marked-gate interrupt hook reads. execution.ts
// deliberately does NOT import `./artifact-review-gate-store` (that module pulls
// the review pure-cores + db/schema, and importing it into the run executor
// would grow every locked route's reachable graph and trip the route-graph
// ratchet). Instead, execution.ts reads the seam off `globalThis`, and a boot
// phase calls `bindArtifactReviewGateSeam()` HERE — so the store rides only the
// boot graph, never a route. globalThis-backed so a worker/handler dispatching
// from a different bundle's module instance still sees the binding.
//
// The seam's `emit` returns a RESULT (never throws the store's typed
// `ArtifactReviewGateError`) so the run executor needs neither the store nor its
// error type; `readGate` projects the gate row down to the org/status and complete pinned target identity the executor needs to
// distinguish a grandfathered combined gate before any singleton mint.
// ---------------------------------------------------------------------------

import {
  emitArtifactReviewGate,
  emitDeclaredReviewGateFamily,
  hasPendingProducedEventForAttempt,
  listReviewGatesForRun,
  listReviewLineageForRun,
  readReviewGate,
  ArtifactReviewGateError,
  type GateStoreExecutor,
} from "./artifact-review-gate-store";
import { decideDeclaredReviewForGate } from "./lifecycle-declared-review-store";
import type { DeclaredReviewDecision } from "@/lib/lifecycle/lifecycle-review-core";

export type ArtifactReviewGateSeam = {
  /**
   * THE ONE REVIEW CORE, reached from the run executor (cinatra#2929).
   *
   * The declared kind's decision needs the artifact's type and the
   * organization's bound, so it needs a database — which is precisely what this
   * seam exists to keep out of the executor's reachable graph. It rides the slot
   * already bound for the gate, rather than a second one, because it is the same
   * decision the emit below is the consequence of.
   */
  decideDeclaredReview(input: {
    orgId: string;
    templateId: string | null;
    packageVersion: string | null;
    targets: unknown;
  }): Promise<DeclaredReviewDecision>;
  emit(input: {
    runId: string;
    orgId: string;
    reviewTaskId: string;
    targets: unknown;
    /** cinatra#4762 — the reset generation of the attempt raising the gate, as the run record the executor read for
     *  the attempt names it. Required, so every raise names its attempt; null stamps -1, which never counts. */
    runGeneration: number | null;
  }): Promise<
    | { ok: true }
    | { ok: false; code: "invalid-targets" | "pin-conflict"; message: string }
  >;
  emitFamily: ArtifactReviewGateSeam["emit"];
  readGate(
    runId: string,
    reviewTaskId: string,
  ): Promise<{ orgId: string; status: string; targets: Array<{ artifactId: string; representationRevisionId: string }> } | null>;
  /** cinatra#3035 (epic #3023 W11) — every gate this run owns, projected to what
   *  the per-artifact routing needs: a review that opens one gate per artifact
   *  sends the person to the first artifact still waiting to be read, and only
   *  the run's own gate list can say which that is. */
  listGates(runId: string): Promise<Array<{ reviewTaskId: string; status: string }>>;
  /** cinatra#4762 — every review this run owns, projected to what the publish gate needs to see that an approved review
   *  came before it in the attempt that reached it: the gate's id, the status, the settled disposition, when the review
   *  was raised, the run's reset generation at that raise (null: raised before the column existed), the resolving
   *  fingerprint (a person's decision, or the optional review's synthetic expiry; null while pending) and the successor
   *  gate its repair recorded (null: none), the lineage that clears a change request. `executor`: a transaction of
   *  the publish store to read in (its run-row lock), else the pool. */
  listReviews(runId: string, executor?: unknown): Promise<Array<{
    id: string; status: string; disposition: string | null; createdAt: Date; runGeneration: number | null;
    fingerprint: string | null; successorGateId: string | null;
  }>>;
  /** cinatra#4762 — does a produced event of this attempt still wait for the review orchestration (a review it may raise
   *  is not settled yet)? An event with no generation (written before the column existed) counts for every attempt.
   *  `executor`: as for listReviews. */
  hasPendingProducedReview(input: { orgId: string; runId: string; generation: number }, executor?: unknown): Promise<boolean>;
};

/** Boot-time binding (idempotent, last write wins). Binds the run executor's
 * gate seam to the live #2009 store. Call once, early in boot, before any run
 * can reach a marked artifact-review gate. */
export function bindArtifactReviewGateSeam(): void {
  const seam: ArtifactReviewGateSeam = {
    async decideDeclaredReview(input) {
      return decideDeclaredReviewForGate(input);
    },
    async emit(input) {
      try {
        await emitArtifactReviewGate(input);
        return { ok: true };
      } catch (err) {
        if (err instanceof ArtifactReviewGateError) {
          return { ok: false, code: err.code, message: err.message };
        }
        throw err;
      }
    },
    async emitFamily(input) {
      try {
        await emitDeclaredReviewGateFamily(input);
        return { ok: true };
      } catch (err) {
        if (err instanceof ArtifactReviewGateError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    },
    async readGate(runId, reviewTaskId) {
      const gate = await readReviewGate(runId, reviewTaskId);
      return gate ? {
        orgId: gate.orgId,
        status: gate.status,
        targets: gate.pinnedTargets.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId })),
      } : null;
    },
    async listGates(runId) {
      const gates = await listReviewGatesForRun(runId);
      return gates.map((gate) => ({ reviewTaskId: gate.reviewTaskId, status: gate.status }));
    },
    async listReviews(runId, executor) {
      const gates = executor === undefined
        ? await listReviewLineageForRun(runId)
        : await listReviewLineageForRun(runId, executor as GateStoreExecutor);
      return gates.map((gate) => ({
        id: gate.id, status: gate.status, disposition: gate.disposition, createdAt: gate.createdAt,
        runGeneration: gate.runGeneration ?? null, fingerprint: gate.fingerprint ?? null, successorGateId: gate.successorGateId ?? null,
      }));
    },
    async hasPendingProducedReview(input, executor) {
      return executor === undefined
        ? hasPendingProducedEventForAttempt(input)
        : hasPendingProducedEventForAttempt(input, executor as GateStoreExecutor);
    },
  };
  (
    globalThis as { __cinatraArtifactReviewGateSeam?: ArtifactReviewGateSeam }
  ).__cinatraArtifactReviewGateSeam = seam;
}
