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
  readReviewGate,
  ArtifactReviewGateError,
} from "./artifact-review-gate-store";

export type ArtifactReviewGateSeam = {
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
};

/** Boot-time binding (idempotent, last write wins). Binds the run executor's
 * gate seam to the live #2009 store. Call once, early in boot, before any run
 * can reach a marked artifact-review gate. */
export function bindArtifactReviewGateSeam(): void {
  const seam: ArtifactReviewGateSeam = {
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
  };
  (
    globalThis as { __cinatraArtifactReviewGateSeam?: ArtifactReviewGateSeam }
  ).__cinatraArtifactReviewGateSeam = seam;
}
