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
// error type; `readGate` projects the gate row down to the minimal {orgId,
// status} the executor's re-read decision needs.
// ---------------------------------------------------------------------------

import {
  emitArtifactReviewGate,
  listReviewGatesForRun,
  readReviewGate,
  ArtifactReviewGateError,
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
  }): Promise<
    | { ok: true }
    | { ok: false; code: "invalid-targets" | "pin-conflict"; message: string }
  >;
  readGate(
    runId: string,
    reviewTaskId: string,
  ): Promise<{ orgId: string; status: string } | null>;
  /** cinatra#3035 (epic #3023 W11) — every gate this run owns, projected to what
   *  the per-artifact routing needs: a review that opens one gate per artifact
   *  sends the person to the first artifact still waiting to be read, and only
   *  the run's own gate list can say which that is. */
  listGates(runId: string): Promise<Array<{ reviewTaskId: string; status: string }>>;
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
    async readGate(runId, reviewTaskId) {
      const gate = await readReviewGate(runId, reviewTaskId);
      return gate ? { orgId: gate.orgId, status: gate.status } : null;
    },
    async listGates(runId) {
      const gates = await listReviewGatesForRun(runId);
      return gates.map((gate) => ({ reviewTaskId: gate.reviewTaskId, status: gate.status }));
    },
  };
  (
    globalThis as { __cinatraArtifactReviewGateSeam?: ArtifactReviewGateSeam }
  ).__cinatraArtifactReviewGateSeam = seam;
}
