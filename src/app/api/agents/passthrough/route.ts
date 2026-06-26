import "server-only";
import { NextResponse } from "next/server";

import { readAgentRunById } from "@cinatra-ai/agents";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { shapeBlogPipelineObjectsSave } from "./blog-pipeline-seam";

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
  const input = shaper ? shaper(rawInput, agentRunId) : rawInput;

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

  const handlers = await collectAllPrimitiveHandlers();
  const handler = handlers[tool];
  if (typeof handler !== "function") {
    return NextResponse.json(
      { error: `Tool "${tool}" has no registered handler.` },
      { status: 404 },
    );
  }

  try {
    // Establish the ALS actor-context frame BEFORE the
    // handler call. Some handlers (e.g. `objects_save` which classifies
    // via LLM) internally call `runDeterministicLlmTask`, which throws
    // `requires actorContext (no ALS frame established)` if the AsyncLocal-
    // Storage frame isn't set. Passing the actor as a parameter is NOT
    // enough — the ALS frame is read by `runDeterministicLlmTask` from
    // the surrounding async context.
    const result = await withActorContext(alsActorContext, () =>
      handler({
        primitiveName: tool,
        input,
        actor,
        mode: "agentic",
      }),
    );

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

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
