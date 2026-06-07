import "server-only";

import { eq, sql } from "drizzle-orm";

import { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import { db } from "./db";
import { agentRuns } from "./schema";
import {
  readAgentRunById,
  readAgentRunByTaskId,
  readAgentTemplateById,
  writeHitlPrompt,
} from "./store";
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "./wayflow-url";

// ---------------------------------------------------------------------------
// Auth-neutral review task approval helper.
//
// `approveReviewTaskInternal` contains the core approval logic extracted from
// the `approveReviewTask` server action in actions.ts. It is intentionally
// free of any session check so it can be called by:
//   - The `approveReviewTask` server action (which layers on admin
//     session auth before calling here).
//   - POST /api/a2a/resume route (which layers on Bearer JWT auth via
//     `verifyA2AAccessToken` before calling here).
//
// The caller is ALWAYS responsible for verifying that the actor is authorized
// to approve the task before invoking this function.
//
// The three DB writes (audit event + two status updates) are wrapped in a
// single Drizzle transaction so a mid-write crash cannot leave the DB in a
// partially-committed state.
// enqueueBackgroundJob (Redis) runs OUTSIDE the transaction — it is a
// separate system and must only fire after the DB commit succeeds.
// ---------------------------------------------------------------------------

/**
 * Core HITL approval logic — no auth checks.
 *
 * LangGraph paths were removed. Only the synthetic `setup-{runId}` prefix is
 * supported; real-UUID review_tasks rows were dropped and the lg-* synthetic
 * resume branch has been retired with LangGraph itself.
 *
 * Caller must authenticate the actor before invoking this.
 *
 * @param reviewTaskId - Synthetic `setup-{runId}` prefix only.
 * @param actorId      - ID of the actor performing the approval (for audit).
 * @param values       - Structured reviewer decisions merged into
 *                       agent_runs.inputParams atomically with the approval.
 * @param fieldName    - Optional. When set, single-field path: only the named
 *                       key from `values` is merged into inputParams.
 */
export async function approveReviewTaskInternal(
  reviewTaskId: string,
  actorId: string,
  values?: unknown,
  fieldName?: string,
  schemaSnapshot?: Record<string, unknown> | null,
): Promise<void> {
  // ---------------------------------------------------------------------------
  // Synthetic setup-{runId} path for setup interrupt loop approvals.
  //
  // The setup interrupt loop (execution.ts) now passes "setup-{runId}" as a
  // synthetic ID instead of relying on planned_action/review_task rows. This
  // branch:
  //   (a) validates run exists and run.status === "pending_approval"
  //   (b) validates fieldName is present in the request values (single-field path)
  //   (c) merges the approved field value(s) into agent_runs.inputParams
  //   (d) transitions the run back to "queued"
  //   (e) re-enqueues AGENT_BUILDER_EXECUTION so the setup loop re-evaluates
  //       pending fields (may emit another INTERRUPT or fall through to dispatch)
  // ---------------------------------------------------------------------------
  if (reviewTaskId.startsWith("setup-")) {
    // setup-* path exits before writeHitlPrompt — schemaSnapshot has no effect here.
    // writeHitlPrompt is not called on this path (schema replay is a WayFlow-gate-only feature).
    const runId = reviewTaskId.slice("setup-".length);
    const run = await readAgentRunById(runId);
    if (!run) {
      throw new Error(`[approveReviewTaskInternal] run ${runId} not found (setup path)`);
    }

    // Guard: run must be pending_approval. Stale or mis-targeted approvals are rejected.
    if (run.status !== "pending_approval") {
      throw new Error(
        `Setup approval rejected: run ${runId} is not pending_approval (current status: ${run.status})`,
      );
    }

    if (values !== undefined) {
      // Guard: single-field path requires fieldName to be present in values.
      if (typeof fieldName === "string" && (values === null || !(fieldName in (values as object)))) {
        throw new Error(
          `Setup approval rejected: fieldName "${fieldName}" is not present in the submitted values`,
        );
      }

      if (typeof fieldName === "string") {
        // Single-field path: merge ONE key's value into inputParams.
        // Avoid serializing the whole `values` object and then wrapping it
        // again with jsonb_build_object(fieldName, ...), which would produce
        // `{url: {url: "..."}}` (double-wrap). The shape the chat-side stepper sends is
        // `{ [fieldName]: <value> }` — we want `inputParams[fieldName] = <value>`,
        // NOT `inputParams[fieldName] = { [fieldName]: <value> }`. Serialize
        // the inner value only.
        const fieldValue = (values as Record<string, unknown>)[fieldName];
        const serializedValue = JSON.stringify(fieldValue);
        if (serializedValue.length > 65_536) {
          throw new Error(
            `[approveReviewTaskInternal] values payload too large (${serializedValue.length} bytes)`,
          );
        }
        await db
          .update(agentRuns)
          .set({
            inputParams: sql`COALESCE(${agentRuns.inputParams}::jsonb, '{}'::jsonb) || jsonb_build_object(${fieldName}::text, ${serializedValue}::jsonb)`,
          })
          .where(eq(agentRuns.id, runId));
      } else if (values !== null && typeof values === "object" && !Array.isArray(values)) {
        // Grouped-form path: merge all keys from values object.
        // Validate submitted keys against inputSchema.properties allowlist.
        const serialized = JSON.stringify(values);
        if (serialized.length > 65_536) {
          throw new Error(
            `[approveReviewTaskInternal] values payload too large (${serialized.length} bytes)`,
          );
        }
        const template = run.templateId ? await readAgentTemplateById(run.templateId) : null;
        const allowedKeys = template?.inputSchema?.properties
          ? Object.keys(template.inputSchema.properties as Record<string, unknown>)
          : null;
        if (allowedKeys !== null) {
          const unknownKeys = Object.keys(values as object).filter((k) => !allowedKeys.includes(k));
          if (unknownKeys.length > 0) {
            throw new Error(
              `Setup approval rejected: values contain keys not declared in inputSchema: ${unknownKeys.join(", ")}`,
            );
          }
        }
        await db
          .update(agentRuns)
          .set({
            inputParams: sql`COALESCE(${agentRuns.inputParams}::jsonb, '{}'::jsonb) || ${serialized}::jsonb`,
          })
          .where(eq(agentRuns.id, runId));
      }
    }

    // Transition back to "queued" so runAgentBuilderExecutionJob won't skip.
    await db
      .update(agentRuns)
      .set({ status: "queued" })
      .where(eq(agentRuns.id, runId));

    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId },
      { jobId: `resume-${reviewTaskId}` },
    );
    console.log(
      `[approveReviewTaskInternal] setup-path resumed run=${runId} fieldName=${fieldName ?? "(grouped)"} actor=${actorId}`,
    );
    return;
  }

  // lg-* synthetic resume branch removed — LangGraph runs are no longer dispatched.
  // Only setup-* and wayflow-* synthetic IDs remain.

  // ---------------------------------------------------------------------------
  // Synthetic wayflow-{taskId} path for WayFlow run-time approval gates.
  //
  // execution.ts (WayFlow input-required branch) emits the synthetic ID
  // `wayflow-${task.id}` to AG-UI's onInterrupt. The approval form posts back
  // to this helper. We:
  //   (a) strip the prefix to recover the bare WayFlow A2A task ID
  //   (b) reverse-lookup the agent_run via agentRuns.a2aTaskId
  //   (c) validate run.status === "pending_approval"
  //   (d) validate run.a2aContextId is set
  //   (e) read template.packageName and derive slug for per-slug WayFlow URL
  //   (f) dispatch sendTask into run.a2aContextId so fasta2a routes to the
  //       paused conversation (NOT a new context — that would restart the flow)
  //   (g) best-effort transition pending_approval -> running after sendTask
  //       succeeds; do not revert on stale_from_status race
  //
  // Mirrors mcp/handlers.ts:598-647 (the agent_run_resume WayFlow
  // resume path). Only difference: that handler reads run.a2aTaskId from the
  // DB-fetched run and approvalNote from the MCP input; here we reverse-lookup
  // by taskId from the synthetic prefix and read approvalNote from the values
  // payload submitted by the approval form.
  // ---------------------------------------------------------------------------
  if (reviewTaskId.startsWith("wayflow-")) {
    const taskId = reviewTaskId.slice("wayflow-".length);
    let run = await readAgentRunByTaskId(taskId);
    if (!run) {
      // `agent_runs.a2a_task_id` is a single column that `handleWayflowTaskState`
      // overwrites per gate; that overwrite races the worker's status transition
      // on the same row and can fail with `tuple concurrently updated` (the error
      // is swallowed by a `.catch(() => undefined)` in execution.ts). When it
      // loses the race the column is stale and this reverse-lookup misses. Fall
      // back to the Redis reverse-map written at INTERRUPT-emit time by
      // `getOrAddWayflowGateIndex` — that mapping is authoritative because it's
      // written when both ids are known for certain. Dynamic import mirrors the
      // `createExternalA2AClient` import below (circular-dep avoidance:
      // review-task-actions ← actions.ts ← index.ts ← @cinatra-ai/a2a).
      const { resolveRunIdByWayflowTaskId } = await import("@cinatra-ai/a2a");
      const fallbackRunId = await resolveRunIdByWayflowTaskId(taskId);
      if (fallbackRunId) {
        run = await readAgentRunById(fallbackRunId);
        if (run) {
          console.log(
            `[approveReviewTaskInternal] wayflow- reverse-lookup recovered run=${run.id} ` +
            `from Redis task-run map (a2a_task_id column was stale for task=${taskId})`,
          );
        }
      }
    }
    if (!run) {
      throw new Error(`[approveReviewTaskInternal] no agent_run found for a2aTaskId=${taskId}`);
    }
    if (run.status !== "pending_approval") {
      throw new Error(
        `WayFlow approval rejected: run ${run.id} is not pending_approval (status: ${run.status})`,
      );
    }
    if (!run.a2aContextId) {
      // Defensive: run must have a2aContextId. execution.ts
      // persists task.contextId immediately after the initial sendTask succeeds.
      throw new Error(`Run ${run.id} has no a2aContextId — cannot resume WayFlow task`);
    }

    const template = await readAgentTemplateById(run.templateId);
    if (!template?.packageName) {
      throw new Error(`template.packageName is null for templateId=${run.templateId}`);
    }
    // sourceType invariant. Mirrors the guard in
    // packages/agents/src/mcp/handlers.ts so the wayflow- branch enforces the
    // same template constraint at every entry point. Defense-in-depth on top
    // of the upstream bridge-token gate at /api/a2a/agents/[...slug].
    if (template.sourceType !== "internal") {
      throw new Error(
        `[approveReviewTaskInternal] WayFlow path requires internal template; got sourceType=${template.sourceType} for run ${run.id}`,
      );
    }
    // Vendor-namespaced routing via resolveWayflowUrl. Throws on malformed
    // packageName or unset WAYFLOW_BASE_URL.
    const wayflowUrl = resolveWayflowUrl(template.packageName);

    // Precedence for the WayFlow resume message:
    //   1. values.userResponse (string, non-empty after trim)  — structured-form path
    //      Renderers wanting structured round-trip MUST set this to JSON.stringify
    //      of the original payload. Passed through UNCHANGED to preserve JSON
    //      formatting; the receiving InputMessageNode has a single string output
    //      per the OAS spec, and downstream nodes parse the JSON.
    //   2. values.approvalNote (string, non-empty after trim)   — legacy bare-approval
    //      Trimmed before sending. Used by approval cards that only carry a free-text
    //      note (no structured form data). Backward-compatible with pre-userResponse
    //      callers.
    //   3. fallback                                              — bare click-to-approve
    //      No values, or both keys absent/empty/whitespace. Sends the canonical
    //      "[Approved by operator]" marker so WayFlow always gets a non-empty message.
    //
    // userResponse wins over approvalNote when both are present — once a renderer
    // opts into structured round-trip, the JSON payload is the canonical message
    // and any free-text note must be embedded INSIDE the JSON.
    //
    // The WayFlow user envelope is the canonical wire format for a
    // structured-form submission that ALSO carries artifact attachments:
    //   userResponse = JSON.stringify({ text: string, attachments?: LlmAttachmentRef[] })
    // The sendTask.parts payload below STAYS text-only by A2A design; the
    // envelope rides as the text content. WayFlow's agent_loader.py is
    // expected to forward this body verbatim to /api/llm-bridge with
    // body.user_envelope=true so the bridge opt-in parser extracts the
    // embedded attachments and the LLM sees only `text`. Without that
    // downstream flag the bridge passes the JSON
    // string through VERBATIM — that is the byte-identical legacy
    // invariant, NOT a bug.
    const valuesObj =
      values && typeof values === "object" && !Array.isArray(values)
        ? (values as { userResponse?: unknown; approvalNote?: unknown })
        : null;
    const userResponseRaw = valuesObj?.userResponse;
    const approvalNoteRaw = valuesObj?.approvalNote;
    const trimmedNote = typeof approvalNoteRaw === "string" ? approvalNoteRaw.trim() : "";

    let resumeText: string;
    if (typeof userResponseRaw === "string" && userResponseRaw.trim().length > 0) {
      resumeText = userResponseRaw;
    } else if (trimmedNote.length > 0) {
      resumeText = trimmedNote;
    } else {
      resumeText = "[Approved by operator]";
    }

    // Extract structured submission payload (parsed userResponse JSON, else
    // values minus userResponse, else null).
    let submittedValues: Record<string, unknown> | null = null;
    if (typeof userResponseRaw === "string" && userResponseRaw.trim().length > 0) {
      try {
        const parsed = JSON.parse(userResponseRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          submittedValues = parsed as Record<string, unknown>;
        }
      } catch {
        if (valuesObj) {
          const { userResponse: _u, ...rest } = valuesObj as Record<string, unknown>;
          if (Object.keys(rest).length > 0) submittedValues = rest;
        }
      }
    } else if (valuesObj) {
      const { userResponse: _u, ...rest } = valuesObj as Record<string, unknown>;
      if (Object.keys(rest).length > 0) submittedValues = rest;
    }

    // UNCONDITIONAL write. Empty `message` is allowed (column NOT NULL accepts
    // ""). Bare-approval flagged excluded=true.
    await writeHitlPrompt({
      runId: run.id,
      agentId: template.packageName,
      stepKey: taskId,
      message: trimmedNote,                          // empty string when bare approval — never null (Pitfall 2)
      submittedValues,                                // null when no structured payload at all
      schemaSnapshot: schemaSnapshot ?? null,
      excluded: trimmedNote.length === 0,             // Pattern 4(b): autosave skips bare-approval rows
    }).catch((e) => {
      console.warn(`[approveReviewTaskInternal] writeHitlPrompt failed run=${run.id}`, e);
    });

    // Dynamic imports mirror mcp/handlers.ts:625-628 — avoids circular dep at
    // module load time (review-task-actions is imported by actions.ts which is
    // re-exported from index.ts; @cinatra-ai/a2a pulls in mcp-server which depends
    // on @cinatra/agent-builder for handler registration).
    const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
    const { randomUUID } = await import("node:crypto");

    const client = await createExternalA2AClient({
      agentUrl: wayflowUrl,
      // 24h ceiling + custom undici dispatcher aligned with wayflow's
      // batch-LLM timeout patches (docker/wayflow/agent_loader.py).
      // `createWayflowFetch()` builds a fetch with long
      // headersTimeout/bodyTimeout — globalThis.fetch's default 300s
      // headersTimeout would kill the connection before the 24h
      // AbortSignal fires.
      timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
      fetchImpl: createWayflowFetch(),
    });

    // Capture the Task returned by sendTask and pass it through the canonical
    // state-machine handler. Discarding the Task and unconditionally
    // transitioning pending_approval -> running would drop multi-gate flows
    // after the first HITL gate.
    const task = await client.sendTask({
      message: {
        role: "user",
        kind: "message",
        messageId: randomUUID(),
        contextId: run.a2aContextId,
        parts: [{ kind: "text", text: resumeText }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    });

    // Lazy import to avoid circular dep (review-task-actions ← actions.ts ←
    // index.ts ← @cinatra-ai/a2a). fromStatus is the literal "pending_approval"
    // because the guard at line 180 already enforced run.status === "pending_approval"
    // before we reached here.
    const { handleWayflowTaskState } = await import("./execution");
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "pending_approval", task });

    console.log(
      `[approveReviewTaskInternal] wayflow-path resumed run=${run.id} task=${taskId} ` +
      `actor=${actorId} resultState=${task.status?.state}`,
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Approval paths use synthetic prefixes ("setup-", "wayflow-"). Real UUID
  // review task rows no longer exist after the table drop. Any real UUID
  // arriving here has no corresponding DB row — return a clear error rather
  // than crashing.
  // ---------------------------------------------------------------------------
  throw new Error(
    `[approveReviewTaskInternal] review task ${reviewTaskId} not found — ` +
    `real UUID paths are not supported after review task row removal. ` +
    `Use synthetic prefix (setup-, wayflow-) for post-migration runs.`,
  );
}
