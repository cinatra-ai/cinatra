import "server-only";

import { randomUUID } from "node:crypto";

import type { AgentCard, MessageSendParams, Task } from "@a2a-js/sdk";

import { getActorContext } from "@cinatra-ai/llm/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

import { resolveAgentByPackageName } from "./agent-resolver";
import { createA2AServerForAgent } from "./server";
import { InProcessTransport } from "./in-process-transport";
import type { EnqueueJobFn, CreateRunWithAuthorityFn } from "./agent-executor";

// ---------------------------------------------------------------------------
// In-process dispatch — the fail-closed actor precondition (cinatra#2202).
//
// `InProcessAgentExecutor.execute()` reads the ActorContext ALS frame
// (`@cinatra-ai/llm/actor-context`) for THREE load-bearing things:
//   - the run's `orgId`             (agent_runs.org_id is NOT NULL);
//   - the run's `runBy` attribution (owner semantics: HITL approval ownership,
//     autosave, run sharing, audit attribution);
//   - the parent OBO ceiling chain  (child-run ceiling composition).
//
// The EXTERNAL A2A surface establishes that frame at
// `src/app/api/a2a/route.ts` — `withActorContext(resolvedActorContext,
// () => mount.handle(body, ctx))`. The IN-PROCESS surface reaches the very same
// executor through `createInProcessA2AClient(...).sendMessage(...)`, so it owes
// the same frame. `sendAgentBuilderMessage`'s internal branch established none
// (cinatra#2202): the executor saw NO principal at all, and its terminal
// `ORG_CONTEXT_REQUIRED` event surfaced to the caller as the misleading
// "run created but bridge missing".
//
// Doctrine (roleless-actor / silent-authz-drop class): a missing actor FAILS
// LOUD. It is never treated as "unconfigured", never degraded to a system
// principal, and never allowed into the executor — a run created with no
// principal is an authority hole AND an attribution orphan.
//
// Lives HERE, in the dispatch entry point, rather than in a module of its own:
// a new first-party module would grow every route that reaches this barrel by
// one, and `scripts/audit/route-graph-ratchet.mjs` locks those dev-perf budgets
// shrink-only (verified: a standalone module put all 5 tracked routes +1 over
// ceiling).
// ---------------------------------------------------------------------------

/** Stable machine code for the refusal (mirrors the ALS accessor's own code). */
export const IN_PROCESS_ACTOR_MISSING_CODE = "ACTOR_CONTEXT_MISSING" as const;

/**
 * Thrown when an in-process A2A dispatch is attempted with no usable
 * ActorContext frame. Carries `code` so a host caller can match structurally
 * across bundle boundaries (same discipline as `OBO_CEILING_DISJOINT_CODE`).
 */
export class InProcessA2AActorMissingError extends Error {
  readonly code = IN_PROCESS_ACTOR_MISSING_CODE;
  readonly reason: "no-frame" | "no-organization";

  constructor(packageName: string, reason: "no-frame" | "no-organization") {
    super(
      reason === "no-frame"
        ? `In-process A2A dispatch to "${packageName}" refused: no ActorContext frame is active. ` +
            `The host must wrap the dispatch in withActorContext(...) — the executor stamps the ` +
            `run's organization, its runBy attribution and its OBO ceiling from that frame.`
        : `In-process A2A dispatch to "${packageName}" refused: the active ActorContext carries no ` +
            `organizationId. The executor cannot create a run without one (agent_runs.org_id is NOT NULL).`,
    );
    this.name = "InProcessA2AActorMissingError";
    this.reason = reason;
  }
}

/**
 * Fail-closed precondition for an in-process A2A dispatch: resolve the ambient
 * ActorContext or THROW. Never returns a synthesized / anonymous principal.
 */
export function requireInProcessDispatchActor(
  packageName: string,
): ActorContext {
  const actor = getActorContext();
  if (!actor) {
    throw new InProcessA2AActorMissingError(packageName, "no-frame");
  }
  if (!actor.organizationId) {
    throw new InProcessA2AActorMissingError(packageName, "no-organization");
  }
  return actor;
}

// ---------------------------------------------------------------------------
// createInProcessA2AClient
//
// Ergonomic factory that wraps the A2A server and in-process transport into a
// single call. Addresses sub-agents by stable `packageName` instead of by module
// factory, so callers can use A2A-as-protocol without touching their resolution
// path.
// ---------------------------------------------------------------------------

export type CreateInProcessA2AClientInput = {
  packageName: string;
  enqueueJob: EnqueueJobFn;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /**
   * cinatra#1940 P3 — REQUIRED in production since the creation perimeter
   * (`createAgentRun`) is now guarded and this package cannot resolve an
   * authority itself. Forwarded verbatim to `createA2AServerForAgent`; see
   * `InProcessAgentExecutorOptions.createRunWithAuthority` for the fail-closed
   * contract when absent.
   */
  createRunWithAuthority?: CreateRunWithAuthorityFn;
};

export type InProcessA2AClient = {
  packageName: string;
  templateId: string;
  agentCard: AgentCard;
  sendMessage(input: { text?: string; json?: unknown }): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
};

export async function createInProcessA2AClient(
  input: CreateInProcessA2AClientInput,
): Promise<InProcessA2AClient> {
  const { templateId, packageName } = await resolveAgentByPackageName(
    input.packageName,
  );
  const bundle = createA2AServerForAgent({
    templateId,
    packageName,
    enqueueJob: input.enqueueJob,
    pollIntervalMs: input.pollIntervalMs,
    pollTimeoutMs: input.pollTimeoutMs,
    createRunWithAuthority: input.createRunWithAuthority,
  });
  const transport = new InProcessTransport(bundle.handler, bundle.agentCard);

  return {
    packageName,
    templateId,
    agentCard: bundle.agentCard,
    async sendMessage({ text, json }) {
      // cinatra#2202 — FAIL-CLOSED actor precondition. `sendMessage` is the
      // ONLY in-process entry point that reaches
      // `InProcessAgentExecutor.execute()`, i.e. the run-CREATION path; it may
      // never run without the ActorContext frame the executor stamps the run's
      // org / runBy / OBO ceiling from. Refuse BEFORE the task is created so the
      // host sees a loud, accurate error instead of a terminal
      // `ORG_CONTEXT_REQUIRED` task it would misread as a missing bridge row.
      // `getTask` / `cancelTask` are deliberately NOT gated here: they create
      // nothing. (They are also NOT covered by `actor-adapter.ts`, which
      // authorizes the EXTERNAL mount's DB-fallback / resubscribe reads — this
      // client owns a private in-memory task store. Gating them would break
      // `cancelOrchestratorRun`, whose cancel fan-out legitimately runs outside
      // any request frame; run-creation is the surface that needs a principal.)
      requireInProcessDispatchActor(packageName);
      const body =
        typeof text === "string" && text.length > 0
          ? text
          : json !== undefined
            ? JSON.stringify(json)
            : "";
      const params: MessageSendParams = {
        message: {
          role: "user",
          kind: "message",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: body }],
        },
      };
      const result = await transport.sendMessage(params);
      // DefaultRequestHandler returns a Task or Message for non-streaming
      // sendMessage. Virtual agents always resolve to a Task — narrow defensively.
      if (!result || (result as { kind?: string }).kind !== "task") {
        throw new Error(
          `createInProcessA2AClient.sendMessage: expected Task result, got ${JSON.stringify(result)}`,
        );
      }
      return result as Task;
    },
    async getTask(taskId) {
      return transport.getTask({ id: taskId });
    },
    async cancelTask(taskId) {
      return transport.cancelTask({ id: taskId });
    },
  };
}
