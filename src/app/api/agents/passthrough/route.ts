import "server-only";
import { NextResponse } from "next/server";

import { readAgentRunById } from "@cinatra-ai/agents";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { shapeBlogPipelineObjectsSave } from "./blog-pipeline-seam";
import {
  shapeArtifactMaterializeInput,
  type ShapedArtifactMaterializeInput,
} from "./artifact-materialize-shaper";
import {
  shapeTestDeliverySendInput,
  shapeTestDeliverySendResult,
} from "./test-delivery-seam";
import {
  shapeDraftsReviewResumeInput,
  isDraftsReviewFailureResult,
} from "./drafts-review-seam";
import {
  shapeRecipientsReviewResumeInput,
  isRecipientsReviewFailureResult,
} from "./recipients-review-seam";
import {
  isRunScopedPersistTool,
  enforceAnsweredGateProvenance,
} from "./answered-gate-provenance";

/**
 * Deterministic MCP-call passthrough for WayFlow.
 *
 * For agent flows whose ApiNode is a deterministic-dispatch tax wrapper
 * (system prompt: "parse this JSON and call this ONE MCP tool exactly
 * once"), route the call directly to the cinatra MCP primitive handler
 * IN-PROCESS, bypassing the LLM-bridge entirely.
 *
 * Eliminates the ~15k-token cost + 5-30s latency tax of dispatching
 * through `/api/llm-bridge` for tasks the LLM provides no value on.
 * Canonical example: trigger-agent's `persist` node "parses userResponse
 * JSON and calls trigger_config_set EXACTLY ONCE."
 *
 * Auth:
 *   1. `X-Cinatra-Bridge-Token` shared-secret (same as /api/llm-bridge).
 *   2. `agent_run_id` resolves to a real `agent_runs` row whose
 *      `runBy` + `orgId` build a proper HumanUser ActorContext via
 *      `buildActorContextFromRun`. This grants the primitive handler
 *      the same authority the originating run had — critical for tools
 *      like `trigger_config_set` that authorize on run ownership.
 *
 * Request shape:
 *   POST { tool: string, input: object, agent_run_id: string }
 *
 * Allowlist: only deterministic-dispatch primitives are exposed. Anything
 * not on the list returns 403 (defense-in-depth even though the bridge
 * token is required).
 */

const ALLOWED_TOOLS = new Set([
  "trigger_config_set",
  "objects_save",
  "objects_classify",
  "objects_update",
  // Deterministic mid-flow artifact materialization (cinatra#925) — NOT an
  // MCP primitive: dispatched to the run-completion materializer core
  // (`@/lib/artifacts/run-artifact-materializer#materializeToolArtifact`)
  // under the bound run's own authority, sharing the #923 idempotency
  // ledger (`path:'materialize_tool'`). HITL gating stays the existing
  // per-node OAS metadata mechanism (riskClass/sideEffects) — nothing
  // route-side.
  "artifact_materialize",
  // Run-scoped HITL prompt primitives (#1794) — the deterministic pre-interrupt
  // seam. An extension workflow's prep ApiNode calls these to assemble / shape
  // its own HITL payload before the interrupt; the primitive derives the run +
  // declaring agent package from the run-bound frame we establish below.
  "agent_run_hitl_prompts_list",
  "agent_run_hitl_prompts_exclude",
  // Run-scoped test-delivery send + parse primitives (#1625). The
  // email-test-delivery agent's own workflow dispatches these as deterministic
  // run-bound nodes; run + declaring package + submission id are derived from the
  // run-bound frame established below (never the request body).
  "email_test_delivery_run_send",
  "email_test_delivery_parse_action",
  // Run-scoped drafts-review PERSIST primitive (cinatra#1959) — the re-entrant
  // drafts / follow-ups gate's post-resume `apply` node dispatches this to write
  // the operator's reviewed per-recipient edits onto the run's own draft-bundle
  // object. Run + declaring package + actor are derived from the run-bound frame
  // established below; a runId/campaign in the resume payload is IGNORED.
  "email_outreach_initial_drafts_update",
  // Run-scoped campaign-recipients-review PERSIST primitive (cinatra#1960) — the
  // re-entrant recipients gate's post-resume `apply` node dispatches this to write
  // the operator's reviewed (kept) recipient set onto the run's own recipients
  // bundle object. Same run-bound-frame trust model as the drafts primitive.
  "email_outreach_recipients_update",
]);

// Tools that must execute inside an mcpRequestContextStorage frame carrying the
// VERIFIED run id (from bindBridgeRunId), so the primitive derives its run scope
// from the invocation context — never from the request body. The generic path
// (objects_save, trigger_config_set, …) resolves identity from the actor alone
// and does not need (or want) an ambient run id, so we scope this to the
// run-scoped primitives only.
const RUN_SCOPED_CONTEXT_TOOLS = new Set<string>([
  "agent_run_hitl_prompts_list",
  "agent_run_hitl_prompts_exclude",
  // #1625 — both derive their run scope from the verified frame; the send
  // primitive additionally reads verifiedSubmissionId (stamped below from the
  // context-id-bound run row's a2aTaskId) as its ledger dedupe identity.
  "email_test_delivery_run_send",
  "email_test_delivery_parse_action",
  // #1959 — persists the reviewed drafts onto the run's own draft-bundle object;
  // reads verifiedRunScopeId from the frame (never the caller-supplied runId).
  "email_outreach_initial_drafts_update",
  // #1960 — persists the reviewed recipient set onto the run's own recipients
  // bundle object; reads verifiedRunScopeId from the frame (never the caller runId).
  "email_outreach_recipients_update",
]);

type RequestBody = {
  tool?: unknown;
  input?: unknown;
  agent_run_id?: unknown;
  /** Optional: when the OAS declares output fields that include the input
   *  payload (e.g. a watcher orchestrator's save_watcher echoes back url/title/
   *  plus a savedWatcherRef pointing at the created object), set
   *  `result_input_passthrough: true` so the route's response is
   *  `{...input.rawData, [result_id_field]: result.id}` — matching the
   *  shape the LLM-based persist node returned. */
  result_input_passthrough?: unknown;
  result_id_field?: unknown;
  /** Optional: opt-in response reshaping for a node whose OAS-declared outputs
   *  do NOT match the primitive's flat return shape and cannot be bridged by
   *  the by-key ApiNode output extraction (wayflowcore maps each declared
   *  output `X` to the jq query `.X`, so a nested object output or a renamed
   *  field is unreachable from a flat result). #1625: the
   *  email_test_delivery_run_send primitive returns
   *  `{ok, sentTo, message, seq, ...}` but perform_test_send declares
   *  `[lastSendResult (object), gateCycle (int), ...]` for its re-entrant gate
   *  renderer. `result_shape: "test_delivery_send"` reshapes the flat result to
   *  the declared output contract at this seam (the established shaping layer —
   *  the certified primitive handler stays untouched). */
  result_shape?: unknown;
};

/**
 * Per-tool input shaping. The OAS ApiNode passes the upstream HITL fields
 * straight through (no Jinja JSON-parse trickery needed); the route reshapes
 * server-side. Each entry: a list of fields to JSON.parse and spread into
 * the top-level input, optionally with literal extras.
 *
 * `agentRunId` is the body-level `agent_run_id` (sibling of `input`),
 * threaded in so shapers can use it as a fallback identity source. The
 * trigger_config_set shaper keeps it as a defensive fallback because
 * the persist node's `input.runId` is wired from `cinatra_run_id`;
 * the orphaned `start.parentRunId` is not a valid source.
 */
type InputShaper = (
  raw: Record<string, unknown>,
  agentRunId: string,
) => Record<string, unknown>;

const TOOL_INPUT_SHAPERS: Record<string, InputShaper> = {
  // trigger-agent.persist passes `runId` + `userResponse` (JSON string).
  // Parse userResponse and merge so trigger_config_set sees its expected
  // {runId, triggerType, scheduledAt?, cronExpression?, timezone, enabled}.
  trigger_config_set(raw, agentRunId) {
    // Run ID fallback chain. The trigger-agent OAS wires the persist
    // node's `input.runId` from `cinatra_run_id`. The orphaned
    // `start.parentRunId` input + its DFE are not valid sources because
    // they break the WayFlow ApiNode mount. The dispatcher
    // (execution.ts RUN-INJECT) injects `cinatra_run_id`, so `input.runId`
    // arrives populated. The body's sibling `agent_run_id` is ALSO
    // injected (= the run's own id); keep it as a defensive fallback so a
    // future re-introduction of an un-injected source can't regress
    // trigger_config_set's Zod `runId: z.string().min(1)` to `too_small`.
    const rawRunId = typeof raw.runId === "string" ? raw.runId.trim() : "";
    const runId = rawRunId.length > 0 ? rawRunId : agentRunId.trim();
    const userResponse = typeof raw.userResponse === "string" ? raw.userResponse : "";
    let parsed: Record<string, unknown> = {};
    if (userResponse) {
      try {
        parsed = JSON.parse(userResponse) as Record<string, unknown>;
      } catch {
        // fall through — handler will reject with a schema error
      }
    }
    // The LLM-based persist node defaulted enabled=true; preserve that.
    return { runId, enabled: true, ...parsed };
  },
  // email-outreach.context_setup deterministic dispatch. The ApiNode
  // parses `setupJson` (a JSON string from the campaign setup HITL
  // gate) and calls `objects_save` with a `@cinatra-ai/campaigns:context`
  // shape. Deterministic-dispatch (parse JSON + assemble + save) so we eliminate
  // the 30s+ LLM tax. Only fires when the ApiNode opts-in via the synthetic
  // input field `_shape: "email_outreach_context_setup"` so other objects_save
  // call sites are untouched.
  objects_save(raw) {
    if (raw._shape !== "email_outreach_context_setup") return raw;
    const setupJson = typeof raw.setupJson === "string" ? raw.setupJson : "";
    const cinatra_agent_run_id =
      typeof raw.cinatra_agent_run_id === "string"
        ? raw.cinatra_agent_run_id
        : typeof raw.cinatra_run_id === "string"
          ? raw.cinatra_run_id
          : "";
    let parsedSetup: Record<string, unknown> = {};
    if (setupJson) {
      try {
        parsedSetup = JSON.parse(setupJson) as Record<string, unknown>;
      } catch {
        // Fall through — objects_save will reject with a schema error;
        // surface in the response.
      }
    }
    const offeringCompanyWebsite =
      typeof parsedSetup.offeringCompanyWebsite === "string"
        ? parsedSetup.offeringCompanyWebsite
        : "";
    const callToAction =
      typeof parsedSetup.callToAction === "string" ? parsedSetup.callToAction : "";
    const senderName =
      typeof parsedSetup.senderName === "string" ? parsedSetup.senderName : "";
    // Derive `name` from offeringCompanyWebsite — mirrors the prompt's
    // "Outreach — <company name derived from offeringCompanyWebsite>" pattern.
    // Heuristic: strip scheme/path, take the registrable domain root.
    const derivedCompany = (() => {
      const url = offeringCompanyWebsite.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
      const host = url.split(":")[0] ?? "";
      const labels = host.split(".").filter(Boolean);
      if (labels.length === 0) return "Campaign";
      // Drop www. + take the SLD (second-to-last label).
      const cleaned = labels[0] === "www" ? labels.slice(1) : labels;
      const sld = cleaned.length >= 2 ? cleaned[cleaned.length - 2] : cleaned[0];
      return (sld ?? "Campaign").replace(/^[a-z]/, (c) => c.toUpperCase());
    })();
    return {
      typeHint: "@cinatra-ai/campaigns:context",
      rawData: {
        cinatra_agent_run_id,
        name: `Outreach — ${derivedCompany}`,
        senderName,
        callToAction,
        // Both names — `offeringCompanyWebsite` matches the OAS downstream
        // output port; `website` preserves the legacy LLM-stored
        // field for any consumer that reads from the persisted object by
        // that name. Schema is `z.record(z.string(), z.unknown())` so
        // both fields coexist.
        offeringCompanyWebsite,
        website: offeringCompanyWebsite,
      },
    };
  },
};

// Generic artifact_materialize seam shaper (cinatra#925) — pure module in
// ./artifact-materialize-shaper (zero-dep, unit-tested). Unlike the
// per-agent `_shape` opt-ins the contract is generic: flow variables wire
// straight to {extension, content, declaredMime, title, node_id}
// (+ optional contentJsonField parse-then-project). A shaper throw
// surfaces as a 400 via the existing shaper-throw contract.
TOOL_INPUT_SHAPERS.artifact_materialize = (raw) =>
  shapeArtifactMaterializeInput(raw);

// blog-pipeline-agent deterministic seam dispatch.
// The pure shaper lives in ./blog-pipeline-seam (zero-dep, unit-tested).
// Chained AHEAD of the base objects_save shaper; the `_shape` opt-in
// keeps every other objects_save call site untouched.
const baseObjectsSaveShaper = TOOL_INPUT_SHAPERS.objects_save;
TOOL_INPUT_SHAPERS.objects_save = (raw, agentRunId) => {
  const blog = shapeBlogPipelineObjectsSave(raw, agentRunId);
  if (blog) return blog;
  return baseObjectsSaveShaper ? baseObjectsSaveShaper(raw, agentRunId) : raw;
};

// email-test-delivery run_send input shaping (#1625) — the pure shaper
// lives in ./test-delivery-seam (zero-dep, unit-tested). It JSON-parses the
// gate's `envelopeJson` (the ApiNode cannot pass native id arrays — wayflowcore
// stringifies json_body templates) and projects the send fields the handler reads.
TOOL_INPUT_SHAPERS.email_test_delivery_run_send = (raw) => shapeTestDeliverySendInput(raw);

// email-outreach drafts-review persist input shaping (cinatra#1959) — the pure
// shaper lives in ./drafts-review-seam (zero-dep, unit-tested). It parses the
// apply ApiNode's `resumePayloadJson`, unwraps the canonical attachment envelope,
// and projects ONLY the per-recipient `drafts[]` the persist primitive consumes.
// FAIL-CLOSED: a present-but-unparseable / unrecognized / wrong-typed payload
// THROWS (the shaper-throw contract → HTTP 400, the ApiNode fails visibly) rather
// than degrading to `{ drafts: [] }` and silently discarding approved edits.
TOOL_INPUT_SHAPERS.email_outreach_initial_drafts_update = (raw) =>
  shapeDraftsReviewResumeInput(raw);

// email-outreach campaign-recipients-review persist input shaping (cinatra#1960)
// — the pure shaper lives in ./recipients-review-seam (zero-dep, unit-tested). It
// parses the apply ApiNode's `resumePayloadJson`, unwraps the canonical attachment
// envelope, and projects ONLY the operator's kept `recipients[]` the persist
// primitive consumes. FAIL-CLOSED: a present-but-unparseable / unrecognized /
// wrong-typed payload THROWS (→ HTTP 400, the ApiNode fails visibly) rather than
// degrading to `{ recipients: [] }` and silently deleting every recipient.
TOOL_INPUT_SHAPERS.email_outreach_recipients_update = (raw) =>
  shapeRecipientsReviewResumeInput(raw);

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedBridgeRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!tool) {
    return NextResponse.json({ error: "`tool` is required" }, { status: 400 });
  }
  if (!ALLOWED_TOOLS.has(tool)) {
    return NextResponse.json(
      {
        error: `Tool "${tool}" is not on the deterministic-passthrough allowlist. ` +
          `Allowed: ${[...ALLOWED_TOOLS].join(", ")}.`,
      },
      { status: 403 },
    );
  }

  const rawInput =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
  // agent_run_id is resolved BEFORE shaping so shapers can use it as a
  // fallback identity source for trigger_config_set.
  const agentRunId = typeof body.agent_run_id === "string" ? body.agent_run_id : "";
  if (!agentRunId) {
    return NextResponse.json(
      { error: "`agent_run_id` is required (used to resolve the actor context)" },
      { status: 400 },
    );
  }

  // The bridge token authenticates the caller CLASS only. Bind the body-selected
  // agent_run_id to the run actually executing this callback
  // (proven by the auth-injected X-Cinatra-A2A-Context-Id header) BEFORE we
  // derive ANY actor authority from it. Fail closed on absent / unresolvable
  // header or mismatch — otherwise a bridge-token holder could select another
  // run's id and borrow its authority for the allowlisted primitive.
  const binding = await bindBridgeRunId(req, agentRunId);
  if (!binding.ok) {
    return NextResponse.json({ error: binding.error }, { status: binding.status });
  }

  const shaper = TOOL_INPUT_SHAPERS[tool];
  let input: Record<string, unknown>;
  try {
    input = shaper ? shaper(rawInput, agentRunId) : rawInput;
  } catch (err) {
    // A shaper that fails closed (e.g. blog-pipeline `selectedIdeaJson` that
    // is not a parseable/matching BlogIdea) surfaces a clear 400 instead of
    // continuing into a wrong/empty downstream artifact.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Resolve actor from the agent_run row — same authority the originating
  // run had. This is critical for tools that authorize on run ownership
  // (trigger_config_set checks the run's owner via setRunTriggerForActor).
  const run = await readAgentRunById(agentRunId).catch(() => null);
  if (!run) {
    return NextResponse.json(
      { error: `agent_run ${agentRunId} not found` },
      { status: 404 },
    );
  }
  let actor: PrimitiveActorContext;
  let alsActorContext: ActorContext;
  try {
    const actorContext = await buildActorContextFromRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
    });
    alsActorContext = actorContext;
    // Build a proper PrimitiveActorContext for
    // the handler rather than blindly casting the ActorContext. The two
    // shapes have different field names:
    //   ActorContext.organizationId  vs  PrimitiveActorContext.orgId
    // The handler reads `actor.orgId` and falls back to null when absent,
    // which fails the upsertObjectAndEnqueue cross-tenant guard
    // (`orgId scope required for non-admin actor`).
    actor = {
      actorType: actorContext.principalType === "HumanUser" ? "human" : "system",
      userId:
        actorContext.principalType === "HumanUser" ? actorContext.principalId : undefined,
      source: "a2a",
      orgId: actorContext.organizationId,
      platformRole: actorContext.platformRole,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `failed to build actor context: ${message}` },
      { status: 500 },
    );
  }

  try {
    let result: unknown;
    if (tool === "artifact_materialize") {
      // Deterministic artifact materialization (cinatra#925) — NOT an MCP
      // primitive. Dispatches to the SAME materializer core + idempotency
      // ledger as the #923 run-completion path (`path:'materialize_tool'`,
      // ledger output identity = the calling node's id) under the authority
      // of the run PROVEN by bindBridgeRunId above. The core re-validates
      // extension ∈ the run package's `cinatra.produces` FAIL-CLOSED even
      // though the compiler also checks. Dynamic import keeps the host
      // artifact stack out of this route's static module graph (same
      // posture as execution.ts).
      const { materializeToolArtifact } = await import(
        "@/lib/artifacts/run-artifact-materializer"
      );
      const shaped = input as unknown as ShapedArtifactMaterializeInput;
      const outcome = await materializeToolArtifact({
        runId: run.id,
        orgId: run.orgId,
        templateId: run.templateId,
        packageVersion: run.packageVersion,
        createdBy: run.runBy,
        nodeId: shaped.nodeId,
        extension: shaped.extension,
        objectTypeId: shaped.objectTypeId,
        title: shaped.title,
        mime: shaped.declaredMime,
        content: shaped.content,
      });
      if (!outcome.ok) {
        // Fail the calling node visibly (validation OR infra) — the flow
        // author decides whether the node failure gates the run.
        return NextResponse.json({ error: outcome.error }, { status: 400 });
      }
      result = {
        artifactId: outcome.artifactId,
        representationRevisionId: outcome.representationRevisionId,
        deduped: outcome.deduped,
      };
    } else {
      const handlers = await collectAllPrimitiveHandlers();
      const handler = handlers[tool];
      if (typeof handler !== "function") {
        return NextResponse.json(
          { error: `Tool "${tool}" has no registered handler.` },
          { status: 404 },
        );
      }
      // Establish the ALS actor-context frame BEFORE the
      // handler call. Some handlers (e.g. `objects_save` which classifies
      // via LLM) internally call `runDeterministicLlmTask`, which throws
      // `requires actorContext (no ALS frame established)` if the AsyncLocal-
      // Storage frame isn't set. Passing the actor as a parameter is NOT
      // enough — the ALS frame is read by `runDeterministicLlmTask` from
      // the surrounding async context.
      const invokeHandler = () =>
        withActorContext(alsActorContext, () =>
          handler({
            primitiveName: tool,
            input,
            actor,
            mode: "agentic",
          }),
        );
      // Run-scoped primitives (#1794) additionally execute inside an
      // mcpRequestContextStorage frame carrying the VERIFIED run id as
      // `verifiedRunScopeId` (binding.runId, proven by bindBridgeRunId above).
      // The primitive reads THAT — never the ambient `runId`, which the MCP
      // transport also fills from the caller-controlled `x-cinatra-run-id`
      // header. `verifiedRunScopeId` is written ONLY here (and equivalent
      // server-side seams), never from request input, so it is non-forgeable.
      // Nesting the two ALS frames is safe — they are distinct AsyncLocalStorage
      // instances. Carry the run's org + owner so the frame is a coherent
      // identity tuple with the run id.
      // #1625 (F1) — the trusted per-gate-resume submission id, resolved
      // from the AUTHORITATIVE Redis latest-task map (written UNCONDITIONALLY at
      // each interrupt in execution.ts, BEFORE the interrupt is published), NOT
      // from the racy `agent_runs.a2a_task_id` column which a lost "tuple
      // concurrently updated" race can leave pointing at a PREVIOUS visit's id.
      // Fresh-guaranteed: a plain Redis SET, never a Postgres CAS. Fails CLOSED —
      // a null/absent value OR a Redis read error OMITS verifiedSubmissionId and
      // the send handler then denies (resolveRunScopedSubmissionId). NEVER falls
      // back to run.a2aTaskId (a surviving stale value would reintroduce the
      // false-dedup hole that suppresses a legitimate distinct send).
      let verifiedSubmissionId: string | undefined;
      if (RUN_SCOPED_CONTEXT_TOOLS.has(tool)) {
        try {
          const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
          verifiedSubmissionId = (await resolveLatestWayflowGateTaskId(run.id)) ?? undefined;
        } catch {
          verifiedSubmissionId = undefined; // fail closed on a Redis read error
        }
      }
      // #1987 — ANSWERED-gate-submission provenance binding (the shared-seam
      // invariant). A run-scoped PERSIST primitive must originate from the
      // operator's ANSWERED gate submission for its OWN gate + payload: consume
      // the single-use answered-gate record keyed by the exact gate task id
      // (`verifiedSubmissionId`, from the trusted frame — never caller input) and
      // bound to the operator's canonical resume payload (`rawInput.resume-
      // PayloadJson`, verbatim-forwarded from the answer). A persist that cannot
      // present valid, unconsumed provenance FAILS CLOSED — this rejects an
      // in-run OBO synthesized write, a replay, a mutated payload, and a
      // substrate-error decision, so no member ships an unbound write. The
      // read/shape run-scoped primitives (list/exclude) are not persists and are
      // not bound. Runs BEFORE the handler; a deny is a non-2xx so the apply
      // ApiNode fails the run rather than completing it with an unauthorized write.
      // Consuming BEFORE the handler is deliberate: it is the atomic single-use
      // point (two concurrent applies cannot both pass), per AC3. A subsequent
      // handler failure fails the run anyway (its own error → non-2xx), so the
      // burned record changes no outcome; a lost-response transport retry then
      // fails closed (safe — no unauthorized write; the operator re-answers).
      if (isRunScopedPersistTool(tool)) {
        const provenance = await enforceAnsweredGateProvenance({
          tool,
          runId: binding.runId,
          verifiedSubmissionId,
          resumePayloadJson: rawInput.resumePayloadJson,
        });
        if (!provenance.ok) {
          return NextResponse.json({ error: provenance.error }, { status: provenance.status });
        }
      }
      result = RUN_SCOPED_CONTEXT_TOOLS.has(tool)
        ? await mcpRequestContextStorage.run(
            {
              runId: binding.runId,
              verifiedRunScopeId: binding.runId,
              ...(verifiedSubmissionId ? { verifiedSubmissionId } : {}),
              userId: run.runBy ?? undefined,
              orgId: run.orgId,
              ...(run.oboCeiling ? { oboCeiling: run.oboCeiling } : {}),
            },
            invokeHandler,
          )
        : await invokeHandler();
    }

    // Optional response shaping for nodes whose OAS-declared
    // outputs include the input payload (e.g. a watcher orchestrator's
    // save_watcher echoes back the inputs + a savedWatcherRef pointing
    // at the created object). When `result_input_passthrough: true`, the
    // route merges `input.rawData` (objects_save case) or `input` (other
    // tools) with `{[result_id_field]: result.id}`. The OAS declares the
    // exact field name expected downstream.
    if (body.result_input_passthrough === true) {
      const idField =
        typeof body.result_id_field === "string" ? body.result_id_field : "id";
      const resultObj =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : {};
      const echoFields =
        tool === "objects_save"
          ? (input.rawData && typeof input.rawData === "object"
              ? (input.rawData as Record<string, unknown>)
              : {})
          : input;
      const shaped = {
        ...echoFields,
        [idField]: resultObj.id ?? resultObj[idField] ?? null,
      };
      return NextResponse.json(shaped);
    }

    // trigger_config_set output shaping.
    // The persist ApiNode in trigger-agent (and any watcher
    // orchestrator that hosts it as a child) declares OAS outputs
    // [triggerType, scheduledAt, cronExpression, timezone, enabled].
    // WayFlow's flow executor sanitizes step outputs against declared
    // output_descriptors and throws
    //   `Field <X> of current step <Y> is required but has no default value`
    // when a declared output is missing from the step response AND has no
    // default in the OAS source. The handler currently returns
    // {ok:true, runId, jobSchedulerId} which lacks all 5 declared fields.
    //
    // Echo the (already-validated) input fields back as the response so
    // WayFlow sees every declared output. Empty strings/false defaults
    // cover the immediate/scheduled/recurring branches uniformly. Fixing
    // it here (vs. editing the source OAS to add defaults) avoids
    // editing a published source marker.
    if (
      tool === "trigger_config_set" &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (result as { ok?: boolean }).ok === true
    ) {
      const triggerType = typeof input.triggerType === "string" ? input.triggerType : "";
      const scheduledAt = typeof input.scheduledAt === "string" ? input.scheduledAt : "";
      const cronExpression =
        typeof input.cronExpression === "string" ? input.cronExpression : "";
      const timezone = typeof input.timezone === "string" ? input.timezone : "";
      const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
      return NextResponse.json({
        triggerType,
        scheduledAt,
        cronExpression,
        timezone,
        enabled,
      });
    }

    // email-test-delivery run_send output shaping (#1625) — the pure
    // shaper lives in ./test-delivery-seam (zero-dep, unit-tested). wayflowcore
    // extracts each ApiNode output `X` via the fixed jq query `.X`, so the gate
    // renderer's nested `{lastSendResult(object), gateCycle(int)}` contract is
    // UNREACHABLE from the primitive's flat `{ok, sentTo, message, seq, ...}`
    // return. Reshape at this seam (same layer as trigger_config_set /
    // result_input_passthrough) so the CERTIFIED handler stays byte-identical.
    // Opt-in via the OAS `result_shape` flag AND scoped to the send tool; a
    // malformed / `{error}` result returns null and passes through UNSHAPED so
    // the node fails visibly.
    if (
      body.result_shape === "test_delivery_send" &&
      tool === "email_test_delivery_run_send"
    ) {
      const shaped = shapeTestDeliverySendResult(input, result);
      if (shaped) return NextResponse.json(shaped);
    }

    // Fail-closed output extraction for the drafts-review apply node
    // (cinatra#1959 gate #2). The apply ApiNode has an UNCONDITIONAL edge to the
    // EndNode, so a handler error/`ok:false` envelope returned at HTTP 200 would
    // let the run COMPLETE after a KNOWN persist failure (e.g. a missing pre-gate
    // bundle, or a partial-match drop of the operator's approved edits). Convert
    // it to a non-2xx here — before WayFlow extracts the node's declared outputs
    // — so the apply node FAILS the run instead. Scoped to this tool; every other
    // tool's error semantics are untouched.
    if (
      tool === "email_outreach_initial_drafts_update" &&
      isDraftsReviewFailureResult(result)
    ) {
      return NextResponse.json(result, { status: 422 });
    }

    // Same fail-closed output extraction for the recipients-review apply node
    // (cinatra#1960): a handler error / ok:false at HTTP 200 would let the
    // unconditional apply->End edge complete the run after a KNOWN persist failure
    // (missing bundle, or a partial-match drop of the operator's kept set). Convert
    // it to a non-2xx so the apply node FAILS the run. Scoped to this tool.
    if (
      tool === "email_outreach_recipients_update" &&
      isRecipientsReviewFailureResult(result)
    ) {
      return NextResponse.json(result, { status: 422 });
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
