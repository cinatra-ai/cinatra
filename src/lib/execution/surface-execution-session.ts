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

import { getRegisteredExecutionExecutor } from "@/lib/execution/execution-executor-slot";

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

// ---------------------------------------------------------------------------
// Dispatch observation — the provenance signal for the render-side guard
// (cinatra#2175)
// ---------------------------------------------------------------------------
//
// A surface that OFFERS the capability needs one more fact at the end of a turn
// before it can honestly render the model's prose: did anything actually run?
// The executor call is where that is knowable. It IS the broker round-trip, and
// a round-trip the plane did not refuse is the one the `execution_sandbox`
// audit row is written from — so counting them ties a turn's transcript to the
// audit record without the surface reading the audit table (no DB access on the
// hot chat path, and no window where the row has not been committed yet).
//
// TWO THINGS THE COUNT MUST NOT CONFLATE. The broker executor never throws: a
// refused open (per-org job ceiling, dead run) and a refused command (quota,
// egress) both come back as ORDINARY outputs with a non-zero exit code, because
// the model has to stay usable. "The executor resolved" is therefore NOT "a
// sandbox ran", and a guard built on resolution alone would read a refusal as
// proof of execution — precisely the fabrication it exists to catch. The
// executor marks those outputs `refusedByPlane`, and only a dispatch that
// returned at least one non-refused output counts as EXECUTED here.
//
// The wrapper is transparent by construction: same input object, same returned
// outputs, same rejection. It only counts. A surface with no executor gets its
// binding back UNCHANGED and a zero log, so the flag-off / plane-unwired paths
// stay byte-identical.

/**
 * What a turn's executor did, as observed at the surface. Three counts, not
 * one, because the three outcomes are three different facts a reader is owed:
 * nothing was ever asked of the sandbox, something was asked and the plane said
 * no, or something was asked and ran. `attempted` is NOT the sum of the other
 * two — an invocation that rejected, or that carried no commands, is attempted
 * and neither executed nor refused.
 */
export type SurfaceExecutionDispatchLog = {
  /** Invocations STARTED — the model called `sandbox_execute` this many times. */
  attempted: number;
  /**
   * Invocations that reached a SANDBOX: they resolved AND returned at least one
   * output the plane did not refuse. This is the count that backs a claim —
   * each is the broker round-trip the `execution_sandbox` audit row is written
   * from.
   */
  executed: number;
  /**
   * Invocations the PLANE REFUSED outright: they resolved with at least one
   * output and EVERY output was a refusal (no job could be opened, or every
   * command was refused). Nothing ran, but a `sandbox_execute` result IS in the
   * transcript and the refusal is audited — so this is a materially different
   * thing to tell a reader than "the sandbox was never called".
   */
  refused: number;
};

export type ObservedSurfaceExecutionBinding = {
  /** The binding to spread into the orchestration entry point. */
  binding: SurfaceExecutionBinding;
  /** Snapshot of what the executor did so far on this turn. */
  readLog: () => SurfaceExecutionDispatchLog;
};

export function observeSurfaceExecutionDispatches(
  binding: SurfaceExecutionBinding,
): ObservedSurfaceExecutionBinding {
  const executor = binding.executionExecutor;
  if (!executor) {
    return {
      binding,
      readLog: () => ({ attempted: 0, executed: 0, refused: 0 }),
    };
  }
  let attempted = 0;
  let executed = 0;
  let refused = 0;
  const observed: SandboxExecutor = async (input) => {
    attempted += 1;
    const outputs = await executor(input);
    // A rejected invocation never reaches here, and an EMPTY batch falls
    // through both branches on purpose: it neither ran nor was refused.
    if (Array.isArray(outputs) && outputs.length > 0) {
      if (outputs.some((o) => o && o.refusedByPlane !== true)) executed += 1;
      else refused += 1;
    }
    return outputs;
  };
  return {
    binding: { ...binding, executionExecutor: observed },
    readLog: () => ({ attempted, executed, refused }),
  };
}
