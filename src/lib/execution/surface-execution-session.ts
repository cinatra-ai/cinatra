import "server-only";

// Trusted surface-layer execution-session issuance (exec-plane S1b activation,
// cinatra#2138 deliverable 2; epic #1705).
//
// The epic's architecture: an execution session `{orgId, userId, surface,
// runId?}` is minted by the TRUSTED SURFACE ISSUER and passed explicitly — the
// chat assistant runtime for a chat turn, the llm-bridge run seam for an agent
// run AFTER the #1192 run token has been verified. This module is the one place
// both issuers go through, so the two entry paths cannot drift apart.
//
// REUSES THE EXISTING RUN BINDING — it does not create a second one. The caller
// hands in the run id it already resolved from the verified run token / vetted
// run row; this module only carries it into the session, where the merged
// broker's per-command liveness probe consults the SAME run row.
//
// FAIL-CLOSED, MODEL-STAYS-USABLE. Nothing here throws:
//   - rollout flag off ⇒ `{}` — an empty spread, so every existing call site is
//     byte-identical (the AC1 inertness contract reaches the call sites too);
//   - unattributable caller (no org / no user) ⇒ no session, so the merged
//     injection layer emits the structured `no_session` capability error and the
//     model continues without the tool;
//   - plane not wired (no registered executor) ⇒ session but no executor, which
//     the injection layer reports as the DISTINGUISHABLE `capability_unavailable`.

import {
  isExecutionPlaneRolloutEnabled,
  mintExecutionSession,
  type ExecutionSession,
  type ExecutionSurface,
} from "@cinatra-ai/llm/execution-plane";
import type { SandboxExecutor } from "@cinatra-ai/llm";

import { getRegisteredExecutionExecutor } from "@/lib/execution/environment-execution-service";

/** Exactly the two orchestration-entry fields the surfaces spread. */
export type SurfaceExecutionBinding = {
  executionSession?: ExecutionSession;
  executionExecutor?: SandboxExecutor;
};

export function resolveSurfaceExecutionBinding(input: {
  surface: ExecutionSurface;
  orgId: string | null | undefined;
  userId: string | null | undefined;
  /** Present ONLY for a surface bound to a verified #1192 run. */
  runId?: string | null;
  /** Test override for the rollout merge gate. */
  rolloutOverride?: string;
}): SurfaceExecutionBinding {
  if (!isExecutionPlaneRolloutEnabled(input.rolloutOverride)) return {};

  const binding: SurfaceExecutionBinding = {};
  try {
    binding.executionSession = mintExecutionSession({
      orgId: input.orgId ?? "",
      userId: input.userId ?? "",
      surface: input.surface,
      ...(input.runId ? { runId: input.runId } : {}),
    });
  } catch {
    // Unidentifiable caller — deliberately leave the session absent so the
    // injection layer withholds the capability with its structured error.
  }

  const executor = getRegisteredExecutionExecutor();
  if (executor) binding.executionExecutor = executor;
  return binding;
}
