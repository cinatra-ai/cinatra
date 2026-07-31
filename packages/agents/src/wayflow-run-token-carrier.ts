import { mintRunToken, CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";
import { setAgentRunTokenHash } from "./store";
import { buildWayflowInitialMessagePayload } from "./wayflow-dispatch-payload";

// ---------------------------------------------------------------------------
// WayFlow A2A RESUME run-token carrier (#1193).
//
// PROBLEM. The dispatch-minted per-run token (the ONE run-identity credential)
// rode only the INITIAL A2A message: `buildWayflowInitialMessagePayload` embeds
// it as a reserved key inside the first text part's JSON, and the loader pops it
// into a per-task ContextVar. Every RESUME (`sendTask` into the run's existing
// `a2aContextId`) sends PLAIN TEXT, so a resumed task attached NO
// `X-Cinatra-Run-Token`.
//
// That is fatal for the legacy-channel retirement, because the compiled context
// subflow is
//     resolve_context (ApiNode) -> context_select_gate (InputMessageNode, a HITL
//     interrupt) -> finalize_interactive (ApiNode)
// so `/api/context-finalize` ALWAYS executes in a RESUMED task. Without a resume
// carrier, retiring the context-id channel 403s every interactive context
// selection and strips OBO from every post-gate llm-bridge step.
//
// SOLUTION (this module). The resume carrier is the A2A message METADATA, under
// the SAME reserved key. Metadata was chosen over the message text because:
//   - The text part is the operator's answer. Wrapping it in JSON would change
//     what the gate's `InputMessageNode` yields to the flow, and the
//     artifact-review resume path delivers its typed decision VERBATIM by
//     contract.
//   - Message metadata is structurally invisible to the model: wayflowcore's
//     `_convert_a2a_messages_to_wayflow_messages` reads ONLY `parts`, `role` and
//     `message_id`, so metadata can never reach the prompt or the conversation.
//
// ROTATION IS ADDITIVE — and it MUST be. Only sha256(token) is ever persisted;
// the raw credential is deliberately unrecoverable, so a resume CANNOT re-send
// the original token and must mint a FRESH one, persisting its hash BEFORE the
// blocking `sendTask` (dispatch's race-free ordering). Per-leg credentials are
// also better hygiene: a token captured from one leg dies with that leg.
//
// The credential is recorded in `agent_run_tokens`, the SET of hashes still
// honored for the run, NOT by overwriting a single column. An overwrite-in-place
// rotation would invalidate a still-executing earlier leg, and the legs are NOT
// reliably serialized:
//   - the artifact-review resume outbox is at-least-once BY DESIGN — a lease can
//     lapse while the first blocking send is still executing;
//   - a send can be ACCEPTED by WayFlow and then lose its HTTP response, so the
//     retry rotates while the accepted task keeps running;
//   - the human and MCP resume paths share no pre-send single-flight CAS, so two
//     callers can both observe `pending_approval`;
//   - `agent_run_stop` documents that the background job may still be mid-step,
//     so a "stopped" run is NOT provably parked at a gate.
// In each case the older task would present a token that no longer resolves — a
// 403 on a LIVE context/LLM callback, and a fail-closed (unattributed) MCP write
// via the #1195 durable binding. Keeping earlier legs valid removes that class
// entirely; credentials are never pruned (see `run-token-store.ts` for why no
// count- or age-based retirement is safe here).
// ---------------------------------------------------------------------------

/**
 * The A2A `message.metadata` object carrying the RAW per-run token on a resume.
 * The key is the same reserved literal the initial message uses, so the loader
 * has ONE grammar to pop and scrub.
 */
export type ResumeRunTokenMetadata = { [key: string]: unknown };

/**
 * Mint a fresh per-run token, record ONLY its hash (ADDITIVELY — the previous
 * leg's credential stays honored), and return the A2A `message.metadata` object
 * that carries the RAW token to the WayFlow loader.
 *
 * MUST be awaited BEFORE the blocking `sendTask` so the hash is durable before
 * the container can call back — the same ordering `execution.ts` uses at
 * dispatch. `setAgentRunTokenHash` throws when it does not update exactly one
 * row, so a failure here fails the resume rather than sending a credential the
 * verifier could never resolve.
 *
 * The returned object is passed straight to `message.metadata`; the raw token is
 * never logged, never persisted, and never placed in the message text.
 */
export async function mintResumeRunTokenMetadata(
  runId: string,
): Promise<ResumeRunTokenMetadata> {
  const runToken = mintRunToken();
  await setAgentRunTokenHash(runId, runToken.tokenHash);
  return { [CINATRA_RUN_TOKEN_MESSAGE_KEY]: runToken.token };
}

/**
 * Mint a fresh per-run token, persist ONLY its hash, and build the INITIAL
 * WayFlow A2A message payload carrying the RAW token under the reserved key.
 *
 * The worker dispatch in `execution.ts` inlines this sequence; this wrapper
 * exists for the OTHER first-party initial dispatcher — the host content-editor
 * A2A dispatch — which creates a real carrier `agent_run` that the WayFlow agent
 * calls back against (llm-bridge / context routes). Before #1193's resume
 * carrier, that dispatcher shipped only `cinatra_run_id`, so once the legacy
 * channels are retired it would have had NO run identity at all.
 *
 * MUST be awaited BEFORE the blocking `sendTask` so the hash is durable before
 * the container can call back.
 */
export async function buildInitialMessagePayloadWithRunToken(
  inputParams: Record<string, unknown> | null | undefined,
  runId: string,
): Promise<Record<string, unknown>> {
  const runToken = mintRunToken();
  await setAgentRunTokenHash(runId, runToken.tokenHash);
  return buildWayflowInitialMessagePayload({
    inputParams,
    runId,
    runToken: runToken.token,
  });
}
