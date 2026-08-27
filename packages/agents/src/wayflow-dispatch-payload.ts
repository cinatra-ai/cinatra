import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";
import {
  PLATFORM_SUPPLIED_RUN_ID_KEY,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data module (allowJs)
} from "../../../scripts/extensions/platform-supplied-flow-inputs.mjs";

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
  /**
   * The RAW dispatch-minted per-run token, carried under the reserved key so
   * the loader can pop it (later wave) / the container's schema filter drops
   * it (until then). Never persisted — only its hash lives in the DB.
   */
  runToken: string;
};

/**
 * Build the WayFlow initial-message payload with spread-then-overwrite: author
 * inputs are spread first, then `cinatra_run_id` and the reserved run-token key
 * are written LAST, so a malicious or compromised agent input can neither
 * smuggle nor override the dispatch-owned run identity.
 *
 * #1193 legacy retirement: the dispatcher-signed `cinatra_run_binding` is GONE.
 * It existed only as a run SELECTOR for /api/llm-bridge, which now resolves run
 * identity exclusively through the run token, so the binding was dead signed
 * material — and unlike the token it was never scrubbed out of the message, so it
 * stayed in the conversation and the persisted task history. Removing the
 * selector without removing the mint would have left that exposure for nothing.
 */
export function buildWayflowInitialMessagePayload(
  input: BuildWayflowInitialMessagePayloadInput,
): Record<string, unknown> {
  return {
    ...(input.inputParams ?? {}),
    // Keyed off the SHARED platform-supplied constant rather than a local
    // literal, so the pre-dispatch check (OAS-RUNTIME-014) and this writer
    // can never disagree about which inputs the platform supplies
    // unprompted (cinatra#3003).
    [PLATFORM_SUPPLIED_RUN_ID_KEY]: input.runId,
    [CINATRA_RUN_TOKEN_MESSAGE_KEY]: input.runToken,
  };
}
