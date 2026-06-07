import "server-only";

import {
  buildAgentCard,
  MultiAgentExecutor,
  createA2ATaskStoreWithDbFallback,
  CinatraResubscribeHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type SdkAgentCard,
} from "@cinatra-ai/a2a";
import {
  readPublishedAgentTemplates,
  isAgentPubliclyDiscoverable,
  readAgentTemplateVersions,
  type AgentTemplateVersionRecord,
} from "@cinatra-ai/agents";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { filterTemplatesToLiveManifest, readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";

// ---------------------------------------------------------------------------
// A2A server mount singleton builder.
//
// Mirrors `getMcpMount()` (cache + refresh) so the JSON-RPC transport handler
// is built once per process and reused across requests. `refreshA2AMount()`
// invalidates the cache when new templates are published.
//
// The mount composes:
//   - AgentCard  <- buildAgentCard() over readPublishedAgentTemplates()
//   - TaskStore  <- createA2ATaskStoreWithDbFallback(InMemoryTaskStore)
//                  so tasks/get can recover after the in-memory cache is
//                  evicted by a restart (reads agent_runs by id).
//   - Executor   <- MultiAgentExecutor dispatching by skillId.
// ---------------------------------------------------------------------------

export type A2AMount = {
  handle: JsonRpcTransportHandler["handle"];
  refresh: () => void;
};

let mountPromise: Promise<A2AMount> | null = null;

async function buildA2AMount(): Promise<A2AMount> {
  // Canonical install/lifecycle gate, shared with the public
  // `/.well-known/agent.json` card via @/lib/a2a-manifest-gate so both A2A
  // surfaces gate identically. The mount is process-cached at restart-granularity
  // (refreshA2AMount is defined but uncalled today), so the gate applies at mount
  // build — the same granularity as the existing publish-visibility.
  // Visibility policy: the A2A AgentCard is externally exposed, so PRIVATE
  // agents are excluded from discovery (public + grandfathered-null only), then
  // gated by the canonical lifecycle manifest.
  const published = (await readPublishedAgentTemplates()).filter(isAgentPubliclyDiscoverable);
  const templates = filterTemplatesToLiveManifest(published, await readLiveAgentPackageNames());
  const versionsByTemplateId: Record<string, AgentTemplateVersionRecord[]> = {};
  for (const t of templates) {
    const page = await readAgentTemplateVersions(t.id, { limit: 100 });
    versionsByTemplateId[t.id] = page.items;
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const tokenEndpoint = `${baseUrl}/api/auth/oauth2/token`;
  const agentCard = buildAgentCard({
    baseUrl,
    templates,
    versionsByTemplateId,
    tokenEndpoint,
  });

  // innerTaskStore is the raw InMemoryTaskStore passed to MultiAgentExecutor so
  // InProcessAgentExecutor's background poller can update it after execute()
  // closes the eventBus early. The wrapped taskStore adds DB fallback for
  // tasks/get after process restart. Both share the same underlying Map.
  const innerTaskStore = new InMemoryTaskStore();
  const executor = new MultiAgentExecutor({
    templates,
    // Preferred chokepoint. Runs connector preflight before the BullMQ enqueue.
    createAndEnqueueAgentRun: async (record, options) => {
      await enqueueAgentRun(record, options);
    },
    // Retained for the rare legacy code path inside the a2a package that
    // still calls `enqueueJob` directly. Production never hits this branch
    // because the executor prefers `createAndEnqueueAgentRun` when set.
    enqueueJob: async (_jobName, data) => {
      const payload = data as { runId: string };
      await enqueueAgentRun({ runId: payload.runId });
    },
    taskStore: innerTaskStore,
  });
  const taskStore = createA2ATaskStoreWithDbFallback(innerTaskStore);
  // Use CinatraResubscribeHandler instead of DefaultRequestHandler so
  // tasks/resubscribe replays from the durable Redis Streams event log rather
  // than the ephemeral in-memory ExecutionEventBus.
  const requestHandler = new CinatraResubscribeHandler(
    agentCard as unknown as SdkAgentCard,
    taskStore,
    executor,
  );
  const handler = new JsonRpcTransportHandler(requestHandler);

  return {
    handle: (body, ctx) => handler.handle(body, ctx),
    refresh: () => {
      mountPromise = null;
    },
  };
}

export function getA2AMount(): Promise<A2AMount> {
  if (!mountPromise) {
    mountPromise = buildA2AMount();
  }
  return mountPromise;
}

export function refreshA2AMount(): void {
  mountPromise = null;
}
