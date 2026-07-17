/**
 * `injectExecutionCapability` — the single injection site for the execution
 * plane (exec-plane S1, cinatra#1706).
 *
 * Applied EXACTLY ONCE alongside `injectMcpTools` in the four orchestration
 * entry points (`generate`, `stream`, `runDeterministicLlmTask`,
 * `runSkillAwareDeterministicLlmTask`) and independent of MCP injection — it
 * neither reads nor mutates MCP tools, and MCP injection neither reads nor
 * mutates the sandbox tool (the sandbox tool is not `type:"function"`, so the
 * injectMcpTools function-tool strip leaves it intact; it is not `type:"mcp"`,
 * so it is never treated as an already-present MCP dedup hit).
 *
 * The result is a discriminated union so the caller can:
 *  - `injected`    → append the centrally-composed `systemCue` and (non-stream)
 *                    widen the step budget;
 *  - `passthrough` → do nothing (rollout dark, task carve-out, or already
 *                    injected — idempotency);
 *  - `unavailable` → surface a STRUCTURED capability error, keep the model
 *                    usable (tools unchanged, no throw). `no_session` (no
 *                    attributable caller) is distinguishable from
 *                    `capability_unavailable` (identified caller, but the plane
 *                    is opted-out or cannot seal).
 *
 * The tool and its cue are produced together here so they can never diverge.
 */

import type { LlmTool } from "../types";
import {
  ExecutionBrokerSecretMissingError,
  mintExecutionSession,
  normalizeExecutionSession,
  sealExecutionSession,
  UnidentifiableExecutionCallerError,
  type ExecutionSession,
  type MintExecutionSessionInput,
} from "./session";
import {
  composeExecutionCue,
  isExecutionPlaneRolloutEnabled,
  shouldSuppressExecutionForTask,
  type ExecutionAvailability,
} from "./policy";
import {
  buildSandboxExecutionTool,
  hasSandboxExecutionTool,
} from "./tool";

/** Structured, model-safe capability error. Never thrown from injection. */
export type ExecutionCapabilityError =
  | { kind: "no_session"; message: string }
  | { kind: "capability_unavailable"; message: string };

export type ExecutionInjectionResult =
  | { status: "injected"; tools: LlmTool[]; systemCue: string }
  | {
      status: "passthrough";
      tools: LlmTool[] | undefined;
      reason: "rollout_disabled" | "task_suppressed" | "already_injected";
    }
  | {
      status: "unavailable";
      tools: LlmTool[] | undefined;
      error: ExecutionCapabilityError;
    };

/**
 * How the caller supplies session identity. Exactly one of:
 *  - `session`:    a pre-minted `ExecutionSession` (e.g. the assistant runtime
 *                  mints it and passes the session object down — it supplies
 *                  session metadata only, never a second injection).
 *  - `mint`:       raw trusted identity to mint here (the entry point holds a
 *                  verified actor). A mint that throws
 *                  `UnidentifiableExecutionCallerError` ⇒ `no_session`.
 *  - neither:      no attributable caller ⇒ `no_session` (fail-closed).
 */
export type ExecutionInjectionParams = {
  /** Current tool array (post- or pre-MCP; order-independent). */
  tools: LlmTool[] | undefined;
  /** A pre-minted session, when the surface layer already minted one. */
  session?: ExecutionSession;
  /** Raw identity to mint here, when the entry point holds a verified actor. */
  mint?: MintExecutionSessionInput;
  /** D4 per-org / per-agent availability posture. Defaults to `"enabled"`. */
  availability?: ExecutionAvailability;
  /** Structured-output / single-step carve-out inputs (D4 technical carve-out). */
  task?: { outputSchema?: unknown; maxSteps?: number };
  /** Test override for the rollout merge gate. */
  rolloutOverride?: string;
  /** Test override for the broker signing secret. */
  brokerSecret?: string;
};

/**
 * Inject the execution capability exactly once. Pure with respect to its inputs
 * except for reading env (rollout flag, broker secret) — both overridable for
 * hermetic tests. Idempotent: a tools array that already carries a
 * `sandbox_execution` member is returned unchanged as `already_injected`, and
 * NO second cue is composed (the exactly-once-cue invariant).
 */
export function injectExecutionCapability(
  params: ExecutionInjectionParams,
): ExecutionInjectionResult {
  // 1. Rollout merge gate (default-off). Dark ⇒ pure passthrough.
  if (!isExecutionPlaneRolloutEnabled(params.rolloutOverride)) {
    return { status: "passthrough", tools: params.tools, reason: "rollout_disabled" };
  }

  // 2. Idempotency — never inject twice, never re-compose the cue.
  if (hasSandboxExecutionTool(params.tools)) {
    return { status: "passthrough", tools: params.tools, reason: "already_injected" };
  }

  // 3. Technical carve-out: single-step / structured-output tasks have no
  //    post-tool turn. Suppress silently (not an error — the capability was
  //    never applicable to this task shape).
  if (params.task && shouldSuppressExecutionForTask(params.task)) {
    return { status: "passthrough", tools: params.tools, reason: "task_suppressed" };
  }

  // 4. Resolve the session (fail-closed on an unidentifiable caller).
  let session: ExecutionSession;
  try {
    session = resolveSession(params);
  } catch (err) {
    if (err instanceof UnidentifiableExecutionCallerError) {
      return {
        status: "unavailable",
        tools: params.tools,
        error: {
          kind: "no_session",
          message:
            "No attributable execution session; the execution capability is " +
            "withheld (fail-closed). The model may continue without it.",
        },
      };
    }
    throw err;
  }

  // 5. D4 availability posture: an identified caller that opted out gets a
  //    DISTINGUISHABLE `capability_unavailable` error, not `no_session`.
  const availability: ExecutionAvailability = params.availability ?? "enabled";
  if (availability === "disabled") {
    return {
      status: "unavailable",
      tools: params.tools,
      error: {
        kind: "capability_unavailable",
        message:
          "The execution capability is disabled for this org/agent. The model " +
          "may continue without it.",
      },
    };
  }

  // 6. Seal + build the tool and its cue together (they cannot diverge). A
  //    missing broker secret is a plane-unavailable condition, distinct from a
  //    caller-identity failure.
  let carrier: string;
  try {
    carrier = sealExecutionSession(session, { secret: params.brokerSecret });
  } catch (err) {
    if (err instanceof ExecutionBrokerSecretMissingError) {
      return {
        status: "unavailable",
        tools: params.tools,
        error: {
          kind: "capability_unavailable",
          message:
            "The execution plane cannot seal a session (broker secret " +
            "unavailable); the capability is unavailable. The model may " +
            "continue without it.",
        },
      };
    }
    throw err;
  }

  const tool = buildSandboxExecutionTool(carrier);
  const systemCue = composeExecutionCue(session);
  return {
    status: "injected",
    tools: [...(params.tools ?? []), tool],
    systemCue,
  };
}

function resolveSession(params: ExecutionInjectionParams): ExecutionSession {
  // A pre-minted session is validated + normalized too (not trusted by type):
  // an unidentifiable pre-minted session throws here ⇒ caught as `no_session`,
  // so a bad `session` can never reach the seal step and throw into the LLM
  // call. Whitelisting also strips any smuggled host/secret fields.
  if (params.session) return normalizeExecutionSession(params.session);
  if (params.mint) return mintExecutionSession(params.mint);
  // No session material at all ⇒ unidentifiable caller.
  throw new UnidentifiableExecutionCallerError("userId");
}
