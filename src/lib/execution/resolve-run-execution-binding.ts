import "server-only";

// The A2 run-seam fail-closed decision matrix (exec-plane S3, cinatra#1708 §1.1;
// epic #1705).
//
// Given a run's declared-environment sources + the tri-state execution service,
// resolve exactly one of:
//   - `l0`     — the run declared NO environment → L0 dispatch (byte-identical
//     to the pre-S3 path).
//   - `mount`  — a declared environment resolved to a signed, mountable layer →
//     supply the broker-backed executor + the opaque mount to the run entry.
//   - `refuse` — a declared environment that CANNOT be honored (invalid
//     declaration, OR the service is not `ready`). A declared environment NEVER
//     silently degrades to L0 (Codex findings 2/3/6): only `kind:"none"` runs L0.
//
//                 kind:"none"    kind:"declared"        kind:"invalid"
//   state ready   → l0           → build+mount          → refuse
//   state disabled→ l0           → refuse (audited)      → refuse
//   state unavail → l0           → refuse (audited)      → refuse
//
// This module imports ONLY the pure resolver (`resolveRunExecutionEnvironment`)
// + the lightweight DI slot accessors — never the heavy execution-plane graph.

import { resolveRunExecutionEnvironment } from "@cinatra-ai/agents";
import type { SandboxEnvironmentMount, SandboxExecutor } from "@cinatra-ai/llm";
import {
  getExecutionServiceState,
  getRunExecutionExecutor,
  resolveRunExecutionMount,
  type EnvironmentReferenceHolder,
} from "@/lib/execution/register-execution-environment-service";

export type RunExecutionBinding =
  | { kind: "l0" }
  | { kind: "mount"; executor: SandboxExecutor; environment: SandboxEnvironmentMount }
  | {
      kind: "refuse";
      /** Structured audit reason mirroring the mount contract's refusals. */
      auditReason:
        | "environment_invalid"
        | "environment_unavailable"
        | "environment_agent_disabled";
      detail: string;
    };

export async function resolveRunExecutionBinding(input: {
  /** Pinned run: env comes EXCLUSIVELY from the version snapshot. */
  pinnedSnapshot?: { executionEnvironment?: unknown } | null;
  /** Draft/unpinned run: the live template's declared environment. */
  liveTemplateEnvironment?: unknown;
  /**
   * The agent's per-agent execution posture (cinatra#1708 slice B), three-valued:
   * `null`/absent inherits the instance/org posture, `true` is an explicit opt-in,
   * `false` an explicit opt-out. An agent that is explicitly opted OUT while a
   * declared environment is in force is a contradiction the config surface
   * refuses to author — this is the defence-in-depth arm for a declaration that
   * arrived some other way (a packaged manifest, a pinned snapshot). It REFUSES
   * rather than dropping the declared recipe, because silently running a
   * declared-env agent on L0 is the exact failure the fail-closed matrix exists
   * to prevent.
   */
  executionEnabled?: boolean | null;
  orgId: string;
  visibility?: "shared" | "org-private";
  holder: EnvironmentReferenceHolder;
}): Promise<RunExecutionBinding> {
  const resolved = resolveRunExecutionEnvironment({
    pinnedSnapshot: input.pinnedSnapshot,
    liveTemplateEnvironment: input.liveTemplateEnvironment,
  });

  // An agent with NO declared environment is unaffected by the per-agent
  // posture here: it runs L0 exactly as before (the posture governs the
  // sandbox TOOL's availability, which is the activation slice's seam).
  if (resolved.kind === "none") return { kind: "l0" };

  if (input.executionEnabled === false) {
    return {
      kind: "refuse",
      auditReason: "environment_agent_disabled",
      detail:
        "this agent is explicitly opted out of execution, but a declared environment " +
        "is in force — refusing rather than running it without its declared packages",
    };
  }
  if (resolved.kind === "invalid") {
    return {
      kind: "refuse",
      auditReason: "environment_invalid",
      detail: `declared environment is invalid: ${resolved.errors.join("; ")}`,
    };
  }

  // kind: "declared" — a declared environment NEVER degrades to L0.
  const state = getExecutionServiceState();
  if (state !== "ready") {
    return {
      kind: "refuse",
      auditReason: "environment_unavailable",
      detail: `execution-environment service is ${state} — a declared environment cannot be honored (fail-closed)`,
    };
  }

  const environment = await resolveRunExecutionMount({
    spec: resolved.spec,
    orgId: input.orgId,
    visibility: input.visibility,
    holder: input.holder,
  });
  if (!environment) {
    // IMPOSSIBLE STATE: a declared spec the builder reports as
    // no-environment is an internal inconsistency — refuse, never L0.
    return {
      kind: "refuse",
      auditReason: "environment_unavailable",
      detail: "declared environment could not be resolved to a mountable layer (fail-closed)",
    };
  }
  const executor = getRunExecutionExecutor();
  if (!executor) {
    return {
      kind: "refuse",
      auditReason: "environment_unavailable",
      detail: "no execution executor available for the resolved environment (fail-closed)",
    };
  }
  return { kind: "mount", executor, environment };
}
