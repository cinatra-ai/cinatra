import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";

// ---------------------------------------------------------------------------
// WayFlow A2A initial-message payload builder (#1193).
//
// Extracted from execution.ts so the SPREAD-THEN-OVERWRITE invariant — the
// dispatch-owned run-identity keys must always win over author-supplied flow
// inputs — is a pure, unit-tested function instead of an inline object literal
// buried in the dispatch machinery. This is the seam the run-token integration
// test drives on the verify stack to prove a dispatched run CARRIES the
// per-run credential.
// ---------------------------------------------------------------------------

export type BuildWayflowInitialMessagePayloadInput = {
  /**
   * The run's author-supplied flow inputs. Spread FIRST so they can never
   * override the dispatch-owned identity keys written after them.
   */
  inputParams: Record<string, unknown> | null | undefined;
  /** The authoritative `agent_runs.id` — dispatch owns run identity. */
  runId: string;
  /** Optional dispatcher-signed run binding (LLM-bridge run selection). */
  runBinding?: string;
  /**
   * The RAW dispatch-minted per-run token, carried under the reserved key so
   * the loader can pop it (later wave) / the container's schema filter drops
   * it (until then). Never persisted — only its hash lives in the DB.
   */
  runToken: string;
};

/**
 * Build the WayFlow initial-message payload with spread-then-overwrite: author
 * inputs are spread first, then `cinatra_run_id`, the optional
 * `cinatra_run_binding`, and the reserved run-token key are written LAST, so a
 * malicious or compromised agent input can neither smuggle nor override the
 * dispatch-owned run identity.
 */
export function buildWayflowInitialMessagePayload(
  input: BuildWayflowInitialMessagePayloadInput,
): Record<string, unknown> {
  return {
    ...(input.inputParams ?? {}),
    cinatra_run_id: input.runId,
    ...(input.runBinding ? { cinatra_run_binding: input.runBinding } : {}),
    [CINATRA_RUN_TOKEN_MESSAGE_KEY]: input.runToken,
  };
}
