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
  createAgentRun,
  type AgentTemplateVersionRecord,
} from "@cinatra-ai/agents";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { filterTemplatesToLiveManifest, readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";
import { getActivationGeneration } from "@/lib/extension-activation-generation";
// cinatra#1392 Gap 2 — the LIVE injection of the tested edge-bound serving
// binding (deferred from #1403 behind the route-graph ratchet; this slice
// carries the annotated absorb records for the growth).
import { resolveEdgeBoundServingDecision } from "@/lib/a2a-edge-bound-serving";
// cinatra#1940 P3 (Decision 2, D2 caller matrix): the `createRunWithAuthority`
// host wiring — a HumanUser principal resolves the delegating member's
// authority; any other principal (Service/Internal/External A2A peer) mints
// the system dispatch authority.
import { getActorContext } from "@cinatra-ai/llm/actor-context";
import { resolveRunCreationAuthority } from "@/lib/org-write/run-creation-authority";
import { mintExternalA2ADispatchAuthority } from "@/lib/org-write/agent-run-authority-mint";

// ---------------------------------------------------------------------------
// A2A server mount singleton builder.
//
// Mirrors `getMcpMount()` (cache + refresh) so the JSON-RPC transport handler
// is built once per process and reused across requests.
//
// cinatra#659 — NO-RESTART install/disable propagation: the mount's AgentCard is
// built from the canonical install/lifecycle gate (`a2a-manifest-gate`:
// `readActiveManifestsFromStore({kind:"agent"})`), but the mount was process-cached
// at RESTART granularity (`refreshA2AMount()` was defined but never called), so an
// install/disable did NOT reflect in the external AgentCard until a restart. The
// cache is now keyed by the extension CONTROL-PLANE (activation) generation — the
// SAME first-class invalidation key the in-process self-MCP cache uses
// (`extension-self-mcp.ts`). Every relevant lifecycle transition (boot / install /
// activate / hot-update / rollback / teardown — archive/uninstall) bumps the
// generation, so the mount lazily REBUILDS on the next request after a transition
// and the external card reflects install/disable WITHOUT a restart. The explicit
// `refreshA2AMount()` is retained for tests + any path wanting an eager clear.
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

// `{ generation, promise }` so a request that started a build for an OLD
// generation is superseded once a later transition bumps the generation (mirrors
// `extension-self-mcp.ts getHandlers`). `null` = never built / explicitly cleared.
let mountCache: { generation: number; promise: Promise<A2AMount> } | null = null;

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
    // cinatra#1940 P3: the creation perimeter is now guarded (run.execute).
    // The executor runs inside the same ALS ActorContext frame the route
    // handler established, so this callback can read it directly — a
    // HumanUser principal resolves the delegating member's authority; any
    // other principal (Service/Internal/External A2A peer — the one
    // genuinely principal-less child-run dispatch surface) mints the system
    // dispatch authority.
    createRunWithAuthority: async (input) => {
      const actorCtx = getActorContext();
      const authority =
        actorCtx?.principalType === "HumanUser"
          ? await resolveRunCreationAuthority(input.orgId, { userId: actorCtx.principalId })
          : mintExternalA2ADispatchAuthority(input.orgId);
      return createAgentRun(input, authority);
    },
    // Retained for the rare legacy code path inside the a2a package that
    // still calls `enqueueJob` directly. Production never hits this branch
    // because the executor prefers `createAndEnqueueAgentRun` when set.
    enqueueJob: async (_jobName, data) => {
      const payload = data as { runId: string };
      await enqueueAgentRun({ runId: payload.runId });
    },
    taskStore: innerTaskStore,
    // cinatra#1392 Gap 2 — edge-bound serving: resolve the TRUSTED dependent
    // identity (the run's signed lineage on the ActorContext) against the
    // target package's dependency edge BEFORE the untrusted client
    // requestedVersion. The executor pins the resolved non-default snapshot,
    // refuses an unreachable pin with evidence, or serves the default.
    resolveEdgeBoundServing: (input) => resolveEdgeBoundServingDecision(input),
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
      mountCache = null;
    },
  };
}

/**
 * Get the process-cached A2A mount, REBUILDING it when the extension
 * control-plane generation has advanced since the cached build (an install /
 * activate / archive / uninstall bumps the generation). A concurrent caller that
 * started a build for an older generation is superseded after the await.
 */
export async function getA2AMount(): Promise<A2AMount> {
  const generation = getActivationGeneration();
  if (!mountCache || mountCache.generation !== generation) {
    mountCache = { generation, promise: buildA2AMount() };
  }
  const startedAt = mountCache.generation;
  const mount = await mountCache.promise;
  // Re-check after the await: a transition during the build may have bumped the
  // generation, so the resolved mount reflects a stale manifest. Rebuild against
  // the current generation rather than returning the stale mount.
  if (getActivationGeneration() !== startedAt) {
    return getA2AMount();
  }
  return mount;
}

/** Eagerly drop the cached mount so the next `getA2AMount()` rebuilds. Production
 *  invalidation now flows through the control-plane generation (a lifecycle
 *  transition bumps it; `getA2AMount` compares + rebuilds), so production call
 *  sites bump the generation instead of calling this. Retained for tests and any
 *  path wanting an explicit local clear. */
export function refreshA2AMount(): void {
  mountCache = null;
}
