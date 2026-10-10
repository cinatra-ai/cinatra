import type { AgentAuthPolicy } from "./auth-policy";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

// Type-only store contract. Extracted so new create-time provenance does not
// grow the store bottleneck or add a runtime edge to its locked route graphs.
export type AgentRunRecord = {
  id: string;
  templateId: string;
  versionId: string | null;
  runBy: string | null;
  status: string;
  inputParams: Record<string, unknown>;
  stepResults: unknown[] | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  title: string | null;            // user-given run name
  createdAt: Date;                  // row creation timestamp
  sourceType: string;              // 'agent_builder' | 'scrape' | 'research' | 'enrichment'
  sourceId: string | null;         // reference to config record id for legacy agents
  packageVersion: string | null;   // pinned at request time (A2A version pinning)
  a2aTaskId: string | null;        // A2A task id persisted by InProcessAgentExecutor
  a2aContextId: string | null;     // fasta2a context id for WayFlow resume
  /** Immutable tool-starter provenance; historical deserialization supplies null. */
  startedByRunId?: string | null;
  parentRunId: string | null;      // orchestrator parent run id (federated workspace linkage)
  agUiEnabled: boolean | null;     // true for runs with AG-UI SSE capability; null for legacy runs
  lgThreadId: string | null;       // LangGraph Server thread ID; null for non-LangGraph runs
  traceId: string | null;         // OTel trace ID; null until agentic-execution starts a root span
  timeoutSeconds: number | null;  // server-side timeout; null = no timeout
  // external A2A peer text output persisted on clean RUN_FINISHED.
  // NULL for internal runs and for externals that timed out / errored.
  streamedText: string | null;
  // THE PRODUCED-REVIEW PARK, as the row's own durable word (cinatra#3046, fix
  // leg 12). JSON-as-text: the withheld terminal write this park is holding, or
  // NULL when the run is not parked on a produced review. Read by
  // isParkedOnProducedReview; written and cleared only by the park's own seam.
  producedReviewPark: string | null;
  // per-run override of the template's agentAuthPolicy. null = inherit.
  // Persisted as JSON-as-text in agent_runs.auth_policy.
  authPolicy: AgentAuthPolicy | null;
  // org-scoping column is required and NOT NULL.
  // Every run-creation entry point now resolves an orgId before insert.
  //
  //
  orgId: string;
  // nullable project refinement. The run
  // worker reads this row at the entry of `runAgentBuilderExecutionJob`
  // and wraps execution in a `mcpRequestContextStorage.run({ ...,
  // projectContext: { projectId } }, ...)` frame so every artifact/object
  // write inside the run inherits `objects.project_id = projectId`
  // (substrate-excluded types stay NULL).
  projectId: string | null;
  // idempotent child-run dispatch key. NULL for every run not created via an
  // idempotent dispatch. Surfaced so a dispatcher can verify the child run it
  // polls is the one it spawned.
  idempotencyKey: string | null;
  // Persisted agent-run OBO scope-ceiling chain, derived at run creation from the
  // locked template anchor + org + project launch. NULL for a corrupt anchor
  // (fails closed at mint) or a pre-backfill row. Parsed from the JSON-as-text
  // column; re-derived + containment-checked at mint.
  oboCeiling: OboCeilingChain | null;
  dependentInstallId: string | null; // installed_extension row id this run executes AS (cinatra#1392 Gap 2)
  // The CURRENT execution attempt id (set by the queued→running dispatch CAS,
  // re-minted on every resume). Carried so the llm-bridge can stamp the
  // attempt onto the agent-run MCP OBO token (`att` claim, cinatra#1939 S3) —
  // the org-write run mint refuses a claimed attempt that no longer matches
  // this column (stale-worker refusal). NULL pre-dispatch.
  executionAttemptId: string | null;
  humanPresent: boolean | null; launchScopeAnchor?: unknown; launchProducer?: string | null; assignmentScopeSnapshot?: unknown; // cinatra#3450 — launchProducer is the producer key the launch fence received, surfaced AS STORED so the attestation of a run names what started it; null on a row created before the column. cinatra#2815 S3 — assignmentScopeSnapshot is the RAW immutable payload the run FROZE at creation, surfaced AS STORED so the delivery chain reads the scopes the run was created under rather than a live column; typed `unknown` and parsed by packages/agents/src/assignment-scope-snapshot.ts, for the same reason as launchScopeAnchor beside it. cinatra#2067 run-start presence discriminator; true only for interactive UI/chat runs, null/false headless. cinatra#2809 — launchScopeAnchor is the RAW persisted vantage this run was launched from, which decides its ONE canonical address. Surfaced AS STORED and decoded by src/lib/launch-scope-anchor.ts at the surface that addresses the instance, where an unknown version, an unknown kind, a missing id or a workspace arm carrying one all read as UNANCHORED — the flat bare route. Typed `unknown` deliberately: this module is reachable from four locked route graphs whose module counts may only ever shrink, and a decoder is a surface concern, not a store one. It rides this line for the same reason the fields below do: the module is at its line-count ceiling.
  // The LIFECYCLE MOMENT TRIPLE (cinatra#2928, lifecycle-b W2a). Which moment
  // this run is at, which card that moment mounts, and the card's
  // server-checked reference. All three are NULL together for a run at no
  // moment. Written ONLY by the lifecycle coordinator.
  lifecycleMoment: string | null;
  lifecycleCardKind: string | null;
  lifecycleCardRef: string | null;
};
