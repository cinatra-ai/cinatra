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
// The DECLARATION SOURCES the caller must supply are all three the epic
// names (#1705, "Environment model"): the packaged agent's manifest claim,
// the run's pinned version snapshot, and the live template config. Supplying
// fewer is a FAIL-OPEN — an unsupplied source resolves `kind:"none"` and the
// run silently executes on L0 against the epic's "a declared environment
// resolves or the run refuses" contract. A fourth outcome covers the case
// where a source cannot be READ at all (`declarationUnreadable`): an UNKNOWN
// declaration is not an absent one, so it refuses too.
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
        | "environment_agent_disabled"
        | "environment_declaration_unreadable";
      detail: string;
    };

export async function resolveRunExecutionBinding(input: {
  /**
   * PACKAGED agent: the RAW `cinatra.execution.environment` claim from the
   * package's normalized extension record. A non-empty manifest declaration
   * owns the recipe (epic #1705 D8 — packaged environments are reviewed and
   * locked through the extension review path, not the agent-config surface).
   * Absent for project agents.
   */
  packagedManifestEnvironment?: unknown;
  /**
   * The run declared an environment SOMEWHERE that could not be READ at all
   * (an unreadable / self-contradicting package manifest). This is not "no
   * declaration" — it is an UNKNOWN one, and running L0 on an unknown recipe
   * is the exact silent downgrade the matrix exists to prevent, so it
   * refuses. Callers set this ONLY on a genuine read failure, never on a
   * package that simply declares nothing.
   */
  declarationUnreadable?: { detail: string } | null;
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
  if (input.declarationUnreadable) {
    return {
      kind: "refuse",
      auditReason: "environment_declaration_unreadable",
      detail: input.declarationUnreadable.detail,
    };
  }
  const resolved = resolveRunExecutionEnvironment({
    packagedManifestEnvironment: input.packagedManifestEnvironment,
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
