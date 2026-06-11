"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthSession } from "@/lib/auth-session";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { getA2AMount } from "@/lib/a2a-server";
import {
  createInProcessA2AClient,
  createExternalA2AClient,
  startExternalSseProxyFromStream,
  type A2AStreamEventData,
  type ExternalA2AClient,
  type ExternalA2AClientCredentials,
} from "@cinatra-ai/a2a";
import type { TaskState } from "@cinatra-ai/a2a";
import { getNangoConnection } from "@/lib/nango-system";
import {
  readAgentRunById,
  readAgentRunByTaskId,
  readAgentRunMessages,
  readAgentTemplateByPackageName,
  findSavedConnectionForAgentUrl,
  createAgentRun,
  updateAgentRunStreamedText,
  type AgentRunRecord,
  type AgentRunMessageRecord,
} from "./store";
import type { SerializedAgentRunMessage } from "./agentic-run-panel";
import { publishAgUiEvent } from "@cinatra-ai/agent-ui-protocol/server";
import { deriveRunHitlContext, type HitlContext } from "./hitl-context";

// ---------------------------------------------------------------------------
// Nango-to-external-A2A credential adapter.
// Nango "private-api-key" provider stores the token at credentials.apiKey; we
// surface it as a bearer ({ token }). Empty / absent → undefined (no-auth dev
// peers are a legitimate case — createExternalA2AClient handles undefined).
// Security: we NEVER log the NangoConnection or credential object anywhere.
// ---------------------------------------------------------------------------
function mapNangoCredentialsToExternalA2A(
  connection: unknown,
): ExternalA2AClientCredentials | undefined {
  if (!connection || typeof connection !== "object") return undefined;
  const raw = (connection as { credentials?: unknown }).credentials as
    | { apiKey?: unknown }
    | undefined;
  if (raw && typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
    return { token: raw.apiKey };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { HitlContext } from "./hitl-context";

export type TaskSnapshot = {
  taskId: string;
  state: string; // A2A TaskState
  cinatraStatus: string; // authoritative run.status from DB
  runId: string | null;
  messages: SerializedAgentRunMessage[];
  hitlContext: HitlContext | null;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendInputSchema = z.object({
  packageName: z.string().min(1),
  inputParams: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeMessage(m: AgentRunMessageRecord): SerializedAgentRunMessage {
  return {
    id: m.id,
    runId: m.runId,
    sequence: m.sequence,
    role: m.role,
    messageType: m.messageType,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

async function deriveA2AStateForTaskId(
  taskId: string | null,
): Promise<TaskState | "unknown"> {
  if (!taskId) return "unknown";
  try {
    const mount = await getA2AMount();
    const resp = (await mount.handle({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tasks/get",
      params: { id: taskId },
    })) as { error?: unknown; result?: { status?: { state?: TaskState } } };
    if (resp && !("error" in resp && resp.error)) {
      return resp.result?.status?.state ?? "unknown";
    }
  } catch {
    // fall through to unknown
  }
  return "unknown";
}

async function buildSnapshot(run: AgentRunRecord): Promise<TaskSnapshot> {
  // deriveRunHitlContext internally short-circuits (no Redis read) for runs
  // that are not pending_approval.
  const [state, messages, hitlContext] = await Promise.all([
    deriveA2AStateForTaskId(run.a2aTaskId),
    readAgentRunMessages(run.id),
    deriveRunHitlContext(run),
  ]);
  return {
    taskId: run.a2aTaskId ?? run.id,
    state,
    cinatraStatus: run.status,
    runId: run.id,
    messages: messages.map(serializeMessage),
    hitlContext,
    error: run.error,
  };
}

// ---------------------------------------------------------------------------
// sendAgentBuilderMessage
// ---------------------------------------------------------------------------

export async function sendAgentBuilderMessage(input: {
  packageName: string;
  inputParams: Record<string, unknown>;
}): Promise<
  { ok: true; taskId: string; runId: string } | { ok: false; error: string }
> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { ok: false, error: "unauthorized" };

  // Short-circuit BEFORE any external A2A streamTask call: we don't want to
  // incur the remote dispatch when the local agent_runs insert is doomed by a
  // missing orgId. requireAuthSession's ensureDefaultOrganizationMembership
  // normally guarantees presence — this is defense-in-depth.
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) return { ok: false, error: "no active organization" };

  const parsed = sendInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  const { packageName, inputParams } = parsed.data;

  // -------------------------------------------------------------------------
  // External A2A dispatch branch.
  //
  // MUST precede the internal createInProcessA2AClient block:
  // external templates are opaque to Cinatra and their executionProvider
  // column is meaningless; the sourceType is the sole dispatch-routing signal.
  // Dispatch-time flow:
  //   1. Read the template (composite-key lookup would be ideal; packageName
  //      read path is kept as a secondary lookup since the MCP client already
  //      has the packageName in hand).
  //   2. If external, locate the saved Nango connection whose metadata.baseUrl
  //      matches template.agentUrl; fetch fresh credentials each run (no cache).
  //   3. Call createExternalA2AClient + client.sendTask(JSON.stringify(inputParams)).
  //   4. Insert a local agent_runs row with a2aTaskId = externalTask.id BEFORE
  //      returning — the SSE proxy subscribes by runId.
  // -------------------------------------------------------------------------
  const template = await readAgentTemplateByPackageName(packageName);
  if (template?.sourceType === "external") {
    if (!template.agentUrl) {
      return { ok: false, error: "external template missing agentUrl" };
    }
    const saved = findSavedConnectionForAgentUrl(template.agentUrl);
    if (!saved) {
      return { ok: false, error: "no credentials for external A2A server" };
    }

    let credentials: ExternalA2AClientCredentials | undefined;
    try {
      const connection = await getNangoConnection(
        saved.providerConfigKey,
        saved.connectionId,
      );
      // Null connection = no-auth connection (dev peer registered only in local store).
      // Credentials remain undefined; createExternalA2AClient handles unauthenticated servers.
      credentials = connection ? mapNangoCredentialsToExternalA2A(connection) : undefined;
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "nango credentials fetch failed",
      };
    }

    // Use streamTask only — avoids double-task creation.
    // streamTask (sendMessageStream) both creates the remote task AND streams results.
    // We peek at the first event to extract the task ID for the local agent_runs row,
    // then fire-and-forget the rest of the stream through the SSE proxy.
    let client: ExternalA2AClient | null = null;
    let stream: AsyncGenerator<A2AStreamEventData, void, undefined> | null = null;
    let firstEvent: A2AStreamEventData | undefined;
    let externalTaskId: string;
    let initialStatus = "submitted";
    try {
      client = await createExternalA2AClient({
        agentUrl: template.agentUrl,
        credentials,
      });
      stream = client.streamTask(JSON.stringify(inputParams));
      const first = await stream.next();
      if (first.done) {
        return { ok: false, error: "external streamTask returned empty stream" };
      }
      firstEvent = first.value;
      // A2A 'task' events carry the created task id; 'status-update' events also carry id.
      const ev = firstEvent as { kind?: string; id?: string; status?: { state?: string } };
      externalTaskId = ev.id ?? randomUUID();
      if (ev.kind === "status-update" && ev.status?.state) {
        initialStatus = ev.status.state;
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "external streamTask failed",
      };
    }
    if (!client || !stream) {
      return { ok: false, error: "external client not created" };
    }

    // Create the local run row BEFORE returning so useAgUiRunStream can
    // subscribe by runId. The SSE proxy publishes on runId, not taskId.
    const runId = randomUUID();
    try {
      await createAgentRun({
        id: runId,
        templateId: template.id,
        runBy: session.user.id,
        inputParams,
        sourceType: "agent_builder",
        a2aTaskId: externalTaskId,
        orgId,
        // External A2A has no parent run on this branch (it is the entry from
        // an external peer). Resolve from the active MCP request frame if
        // present, else NULL; when no project chat is active, NULL is expected.
        projectId: null,
      });
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "local run record insert failed",
      };
    }

    // Re-inject the already-consumed first event at the head of the stream,
    // then hand the whole iterator to the SSE proxy (fire-and-forget).
    const peeked = firstEvent;
    async function* resumeStream(): AsyncGenerator<A2AStreamEventData, void, undefined> {
      yield peeked!;
      yield* stream!;
    }

    void startExternalSseProxyFromStream(
      resumeStream(),
      initialStatus,
      runId,
      {
        publishAgUiEvent: (event) => publishAgUiEvent(runId, event as never),
        // Persist accumulated streamed text for Results tab replay.
        persistStreamedText: (text) => updateAgentRunStreamedText(runId, text),
      },
    ).catch((err) => {
      console.error("[external-sse-proxy] unexpected failure:", err);
    });

    return { ok: true, taskId: externalTaskId, runId };
  }
  // Internal branch.

  let task;
  try {
    const client = await createInProcessA2AClient({
      packageName,
      enqueueJob: async (_name, data) => {
        const payload = data as { runId: string };
        await enqueueAgentRun({ runId: payload.runId });
      },
    });
    task = await client.sendMessage({ json: inputParams });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "sendMessage failed",
    };
  }

  // Discover runId via the bridge column populated by InProcessAgentExecutor.
  // The write is sync-within-execute(), but poll defensively to absorb any async race.
  for (let i = 0; i < 5; i++) {
    const run = await readAgentRunByTaskId(task.id);
    if (run) return { ok: true, taskId: task.id, runId: run.id };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, error: "run created but bridge missing" };
}

// ---------------------------------------------------------------------------
// getAgentBuilderTask
// ---------------------------------------------------------------------------

export async function getAgentBuilderTask(
  idOrTaskId: string,
  opts: { legacyFallback?: boolean } = {},
): Promise<TaskSnapshot | { error: string }> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { error: "unauthorized" };

  const legacyFallback = opts.legacyFallback !== false;

  let run = await readAgentRunByTaskId(idOrTaskId);
  if (!run && legacyFallback) {
    run = await readAgentRunById(idOrTaskId);
  }
  if (!run) return { error: "not found" };

  // Ownership check returns 'not found' rather than 'forbidden' to avoid an
  // enumeration signal.
  if (run.runBy && run.runBy !== session.user.id) return { error: "not found" };

  return buildSnapshot(run);
}
