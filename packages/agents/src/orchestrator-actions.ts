"use server";

/**
 * Server actions for the orchestrator run screen.
 *
 * cancelOrchestratorAction enforces actor ownership before calling
 * cancelOrchestratorRun. Defense-in-depth: the inner function also
 * checks runBy, so we pass an actor descriptor that lets both layers
 * agree on who the cancelling actor is.
 *
 * revalidateOrchestratorStatusAction returns a lightweight snapshot
 * of the orchestrator run and its children, filtered to the authenticated
 * actor as an information-disclosure guard.
 *
 * IMPORTANT — relative imports only inside this package.
 * Do NOT use "@cinatra/agent-builder" here — that would create a
 * self-import cycle via the package's own index.ts.
 */

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  readAgentRunById,
  readAgentRunsByParent,
  readAgentTemplateById,
  readRunCoOwners,
  transitionRunStatus,
  RunTransitionError,
} from "./store";
import { cancelOrchestratorRun } from "./orchestrator-execution";
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "./wayflow-url";
import { publishAgUiEvent } from "@cinatra-ai/agent-ui-protocol/server";

// ---------------------------------------------------------------------------
// cancelOrchestratorAction
// ---------------------------------------------------------------------------

/**
 * Cancel an orchestrator run on behalf of the currently-authenticated user.
 *
 * Returns { ok: true } on success; { ok: false, error: string } on failure.
 *
 * Ownership rules:
 *  - Actor must be authenticated.
 *  - If run.runBy is non-null, it must match the actor's user id.
 *  - If run.runBy is null (legacy/system-owned run), any authenticated
 *    actor may cancel.
 */
// Owner | co-owner | platform admin can act on the run.
async function canActOnRun(
  run: { id: string; runBy: string | null },
  actorUserId: string | null,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;
  if (!actorUserId) return false;
  if (run.runBy === actorUserId) return true;
  // Orphan run (runBy=null) is only accessible by admin (handled above).
  if (run.runBy === null) return false;
  const coOwnerRows = await readRunCoOwners(run.id);
  return coOwnerRows.some((c) => c.userId === actorUserId);
}

export async function cancelOrchestratorAction(
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  if (!actorUserId) return { ok: false, error: "Unauthenticated" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (!(await canActOnRun(run, actorUserId, isPlatformAdmin(session)))) {
    return { ok: false, error: "Forbidden" };
  }

  // Pass an actor descriptor including the user id as `source` so the inner
  // function logs and audits the cancelling actor.
  await cancelOrchestratorRun(runId, { actorType: "user", source: actorUserId });
  revalidatePath(`/agents/[agentId]/[instanceId]/run`, "page");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// revalidateOrchestratorStatusAction
// ---------------------------------------------------------------------------

type OrchestratorStatusSnapshot = {
  status: string;
  children: Array<{
    id: string;
    templateId: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  }>;
};

/**
 * Returns a fresh status snapshot for the orchestrator run + its children.
 *
 * Returns null when:
 *  - Actor is unauthenticated.
 *  - Run not found.
 *  - run.runBy is non-null and mismatches the actor.
 *
 * Intentionally does NOT call revalidatePath — this action is called
 * by the client polling loop every 3 s and only needs to return fresh
 * data; the React tree re-renders via state updates in OrchestratorRunPanel.
 */
export async function revalidateOrchestratorStatusAction(
  runId: string,
): Promise<OrchestratorStatusSnapshot | null> {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  if (!actorUserId) return null;

  const run = await readAgentRunById(runId);
  if (!run) return null;
  if (!(await canActOnRun(run, actorUserId, isPlatformAdmin(session)))) return null;

  const children = await readAgentRunsByParent(runId);
  return {
    status: run.status,
    children: children.map((c) => ({
      id: c.id,
      templateId: c.templateId,
      status: c.status,
      startedAt: c.startedAt ? c.startedAt.toISOString() : null,
      completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// resumeStoppedOrchestratorAction
// ---------------------------------------------------------------------------

/**
 * Resume a stopped orchestrator run on behalf of the currently-authenticated
 * user. This issues a WayFlow A2A `sendTask` against the run's
 * existing fasta2a `contextId` so the paused conversation continues from its
 * checkpoint. Mirrors `mcp/handlers.ts` `agent_run_resume` lines
 * 639–689 (WayFlow branch).
 *
 * Returns { ok: true } on success; { ok: false, error: string } on failure.
 *
 * Error codes (stable strings — tests and UI copy depend on them):
 *   - "Unauthenticated"
 *   - "Run not found"
 *   - "Forbidden"
 *   - "run is not in stopped state"
 *   - "no-context"          — a2aContextId is null; cannot resume WayFlow conversation
 *   - "template not found"
 *   - "no-package-name"     — template.packageName is null; cannot derive vendor/slug
 *   - "no-wayflow-url"      — WAYFLOW_BASE_URL is unset or resolveWayflowUrl rejected the packageName
 *   - "race condition — run status changed"
 *   - "resume failed"
 */
export async function resumeStoppedOrchestratorAction(
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  if (!actorUserId) return { ok: false, error: "Unauthenticated" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (!(await canActOnRun(run, actorUserId, isPlatformAdmin(session)))) {
    return { ok: false, error: "Forbidden" };
  }
  if (run.status !== "stopped") return { ok: false, error: "run is not in stopped state" };

  // WayFlow runs do not use lgThreadId. The fasta2a contextId is
  // the resume key — without it we cannot route back to the paused task.
  if (!run.a2aContextId) return { ok: false, error: "no-context" };

  const template = await readAgentTemplateById(run.templateId);
  if (!template) return { ok: false, error: "template not found" };

  const packageName = template.packageName;
  if (!packageName) return { ok: false, error: "no-package-name" };

  // Vendor-namespaced routing: resolveWayflowUrl composes
  // ${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/ from the canonical packageName
  // and throws on malformed input or unset WAYFLOW_BASE_URL.
  let wayflowUrl: string;
  try {
    wayflowUrl = resolveWayflowUrl(packageName);
  } catch (err) {
    console.error("[resumeStoppedOrchestratorAction] resolveWayflowUrl failed", err);
    return { ok: false, error: "no-wayflow-url" };
  }

  // Race-safe state transition.
  try {
    await transitionRunStatus(runId, "stopped", "queued");
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      return { ok: false, error: "race condition — run status changed" };
    }
    throw err;
  }

  // Split try/catch so post-sendTask errors never revert to "stopped"
  // when WayFlow has already accepted the resume message.
  const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
  let client: Awaited<ReturnType<typeof createExternalA2AClient>>;
  try {
    // 24h ceiling + custom undici dispatcher aligned with the wayflow
    // ApiNode/blocking/A2A patches in docker/wayflow/agent_loader.py.
    // Without `fetchImpl: createWayflowFetch()`, globalThis.fetch uses
    // undici's 300s `headersTimeout` default and the 24h `timeoutMs`
    // (AbortSignal) becomes moot.
    client = await createExternalA2AClient({
      agentUrl: wayflowUrl,
      timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
      fetchImpl: createWayflowFetch(),
    });
  } catch (err) {
    await transitionRunStatus(runId, "queued", "stopped").catch(() => undefined);
    console.error("[resumeStoppedOrchestratorAction] client creation failed for run", runId, err);
    return { ok: false, error: "resume failed" };
  }

  try {
    // Send into the existing context so fasta2a routes to the paused conversation.
    // Resume MUST reuse run.a2aContextId; a fresh contextId
    // would start a new conversation and the flow would retry from the beginning.
    await client.sendTask({
      message: {
        role: "user",
        kind: "message",
        messageId: randomUUID(),
        contextId: run.a2aContextId,
        parts: [{ kind: "text", text: "[Resumed by operator after stop]" }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    });
  } catch (err) {
    await transitionRunStatus(runId, "queued", "stopped").catch((revertErr) => {
      if (revertErr instanceof RunTransitionError && revertErr.code === "stale_from_status") {
        console.warn(`[resumeStoppedOrchestratorAction] compensation no-op for ${runId}: status already advanced`);
        return;
      }
      console.error("[resumeStoppedOrchestratorAction] compensation revert failed for run", runId, revertErr);
    });
    console.error("[resumeStoppedOrchestratorAction] WayFlow A2A resume failed for run", runId, err);
    return { ok: false, error: "resume failed" };
  }

  // sendTask succeeded — best-effort transition only, never revert.
  await transitionRunStatus(runId, "queued", "running").catch((e) => {
    if (!(e instanceof RunTransitionError && e.code === "stale_from_status")) {
      console.error("[resumeStoppedOrchestratorAction] post-send transition failed", runId, e);
    }
  });

  // Publish RUN_STARTED so SSE-bound UI (useAgUiRunStream) flips status from
  // "stopped" back to "running". Without this the orchestrator-stepper-panel
  // keeps rendering the paused SpinnerCard forever after Resume — DB row
  // changes but the stream never sees a terminal/start frame. Mirrors the
  // RUN_STARTED emit in execution.ts.
  await Promise.resolve(
    publishAgUiEvent(runId, {
      type: "RUN_STARTED",
      threadId: runId,
      runId,
      timestamp: Date.now(),
    } as never),
  ).catch(() => undefined);

  revalidatePath(`/agents/[agentId]/[instanceId]/run`, "page");
  return { ok: true };
}
