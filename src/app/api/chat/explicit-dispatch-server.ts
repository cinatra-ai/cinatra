import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";
import {
  createAgentBuilderPrimitiveHandlers,
  readPublishedAgentTemplates,
} from "@cinatra-ai/agents";
import { runDeterministicLlmTask } from "@cinatra-ai/llm";
import type { ActorContext } from "@/lib/authz/actor-context";
// Notification emitters are exposed through the public server barrel; avoid
// direct package-internal import paths here.
import { safeEmitAgentCreationProgress } from "@cinatra-ai/notifications/server";
import { buildAgentInstancePath } from "@/lib/agent-url";

// ---------------------------------------------------------------------------
// Agent-creation flow packages.
//
// When the explicit-dispatch package matches one of these, the dispatch
// boundary runs `preflightAgentCreation()` BEFORE the BullMQ enqueue. On
// preflight failure: NO `agent_run` invocation, NO half-started run, and
// the runner.ts caller treats the dispatch as TERMINAL (no LLM fallthrough).
//
// `@cinatra-ai/lint-policy-agent` is intentionally OMITTED — it is the
// deterministic skill-free scanner. Including it would cause
// a false `anthropic_no_skills_resolved` preflight failure when the
// Anthropic pin is active.
// ---------------------------------------------------------------------------
export const CREATION_FLOW_PACKAGES = new Set<string>([
  "@cinatra-ai/planner-agent",
  "@cinatra-ai/code-reviewer-agent",
  "@cinatra-ai/security-reviewer-agent",
  "@cinatra-ai/author-agent",
]);

/**
 * Bridge: ActorContext (chat kernel) → PrimitiveActorContext (in-process).
 * The chat's actorContext is the kernel-grade Principal; in-process
 * primitives expect the protocol shape (actorType + userId + source).
 */
function chatActorToPrimitive(actor: ActorContext): PrimitiveActorContext {
  return {
    actorType: actor.principalType === "HumanUser" ? "human" : "system",
    userId:
      actor.principalType === "HumanUser" ? actor.principalId : undefined,
    source: "mcp",
    platformRole: actor.platformRole,
    tokenScopes: actor.tokenScopes,
  };
}

// Hard pre-router (server-side dispatch).
//
// The soft pre-router (system-message directive) verified working in unit
// tests but EMPIRICALLY ignored by gpt-5 — Track B FULL first fixture
// failed identically to baseline ("Tool events: empty" after a long
// LLM turn). The hard variant dispatches before the LLM gets a chance
// to skip tools.
//
// This helper invokes `agent_run` SERVER-SIDE (no LLM involvement) when
// the regex pre-router matches, emits synthetic tool_call + tool_result
// SSE events so the chat-mcp e2e harness sees the dispatch, and returns
// the runId. The caller (runner.ts) then early-returns from the chat
// turn — the LLM never gets a chance to skip the tool.

const SYNTHETIC_TOOL_CALL_ID = "explicit_dispatch_pre_router";

export type ServerSideDispatchResult =
  | {
      ok: true;
      runId: string;
      status: string;
    }
  | {
      ok: false;
      error: string;
      /**
       * When true, the caller (runner.ts) MUST early-return BEFORE
       * `stream`. A creation preflight failure has already
       * been surfaced to the user via the synthetic SSE `tool_result` +
       * `text` events; reopening the LLM turn would re-author the run
       * despite the gate.
       */
      terminal?: boolean;
    };

// ---------------------------------------------------------------------------
// Chat-side creation preflight + queued/syncing_skills progress emit.
//
// Mirrors the creation-review and source-write pre-enqueue gates: the
// chat dispatch path MUST refuse to enqueue a creation flow when the
// Anthropic pin is active but the required catalog skills aren't synced,
// governance opt-in is off, sync namespace can't be derived, or skill caps
// are exceeded.
//
// Pin INACTIVE (`isAgentCreationPinActive()` returns false until
// Anthropic governance + sync land): the entire gate is BYPASSED so the
// existing dispatch flow remains byte-for-byte identical for the chat-mcp
// e2e fixtures and the non-creation packages.
//
// Pin ACTIVE + provider !== "anthropic" (OpenAI/Gemini per-purpose
// override): a FIRST-PASS preflight probe with empty `laneSkillSets`
// confirms provider/model config; we then skip catalog resolution + skill
// checks because they apply only to Anthropic.
//
// Pin ACTIVE + provider === "anthropic": we resolve required catalog
// skills for THIS package only via the strict resolver (which throws on
// catalog errors → surfaced as `catalog_unavailable`) and run a
// SECOND-PASS preflight with the populated laneSkillSets.
// ---------------------------------------------------------------------------
async function runCreationPreflightForChatDispatch(
  packageName: string,
): Promise<
  | { ok: true; pinActive: false }
  | { ok: true; pinActive: true; provider: "openai" | "anthropic" | "gemini" }
  | { ok: false; errorLabel: string }
> {
  // (1) Pin-active gate — short-circuits the entire block when inactive.
  const { isAgentCreationPinActive } = await import("@/lib/database");
  if (!isAgentCreationPinActive()) return { ok: true, pinActive: false };

  // (2) First-pass probe with empty lane skill sets — confirms provider/
  // model config without doing any catalog work yet.
  const { preflightAgentCreation, resolveRequiredCreationSkillIds } =
    await import("@cinatra-ai/agents");
  const probe = await preflightAgentCreation({
    requiredCatalogSkillIds: [],
    laneSkillSets: [],
  });
  if (!probe.ok) {
    return {
      ok: false,
      errorLabel: probe.errors
        .map((e) => `${e.code}: ${e.message}`)
        .join(" / "),
    };
  }
  if (!probe.pinActive || probe.provider !== "anthropic") {
    // OpenAI/Gemini pinned (or pin became inactive between calls — defensive).
    // No anthropic-specific skill check required.
    return {
      ok: true,
      pinActive: probe.pinActive,
      provider: probe.pinActive ? probe.provider : "openai",
    } as { ok: true; pinActive: true; provider: "openai" | "anthropic" | "gemini" };
  }

  // (3) Anthropic-only: resolve required catalog skills for THIS package.
  // The strict resolver throws on catalog errors; we catch +
  // surface as `catalog_unavailable`.
  let laneSkillSets: Awaited<ReturnType<typeof resolveRequiredCreationSkillIds>>;
  try {
    laneSkillSets = await resolveRequiredCreationSkillIds([packageName]);
  } catch (err) {
    return {
      ok: false,
      errorLabel: `catalog_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const requiredCatalogSkillIds = Array.from(
    new Set(laneSkillSets.flatMap((l) => l.skillIds)),
  );

  // (4) Second-pass preflight with the populated lane sets.
  const full = await preflightAgentCreation({
    requiredCatalogSkillIds,
    laneSkillSets,
  });
  if (!full.ok) {
    return {
      ok: false,
      errorLabel: full.errors
        .map((e) => `${e.code}: ${e.message}`)
        .join(" / "),
    };
  }
  return { ok: true, pinActive: true, provider: "anthropic" };
}

/**
 * Server-side invoke `agent_run` with the explicit-dispatch packageName.
 * Emits synthetic SSE events matching the stream shape so the
 * e2e harness's `tool_call` listener fires before any LLM turn happens.
 *
 * Returns the dispatch outcome. On success, the caller MUST early-return
 * (skip the LLM call) so the chat turn doesn't double-fire the tool.
 */
/**
 * Extract structured inputs from the chat prompt using the agent's
 * published `inputSchema` as the response-format schema.
 *
 * Without this, the hard pre-router dispatched `agent_run` with empty
 * `inputParams: "{}"`, the agent's StartNode required inputs weren't
 * filled, the setup-loop fired a `schema-field-fallback` HITL gate, and
 * the user had to re-type the URL/topic they already wrote in the chat.
 *
 * Failure modes (extraction fails / no schema / no fields extracted) all
 * gracefully degrade to the prior empty-inputParams behavior — the
 * setup-loop still works as a fallback for operators.
 */
/**
 * Deterministic fast-path. When the user explicitly pastes the exact
 * inputParams JSON (the canonical phrasing is
 * `... inputParams: {<json>}`), parse it verbatim instead of round-tripping
 * through the gpt-5.5 extraction. This is both faithful (no LLM
 * transcription drift on nested object/array fields the StartNode schema
 * types loosely as bare `object`/`array`) and deterministic (the e2e
 * harness no longer depends on extraction-LLM nondeterminism for the
 * structured-input agents). Returns the parsed JSON string, or null when
 * no embedded block is present (caller falls back to LLM extraction).
 */
function tryParseEmbeddedInputParams(userPrompt: string): string | null {
  // Anchor on the canonical marker so we don't mistake an example JSON in
  // prose for the actual inputParams. Tolerant of "inputParams:" /
  // "input params:" / "inputs:" with optional surrounding markup.
  const markerMatch = userPrompt.match(
    /\binput[\s_]?params?\b\s*(?:for\s+inputparams)?\s*[:=]?\s*(\{)/i,
  );
  if (!markerMatch || markerMatch.index === undefined) return null;
  // Brace-match from the first `{` after the marker to extract a balanced
  // JSON object (handles nested objects/arrays; ignores braces in strings).
  const start = userPrompt.indexOf("{", markerMatch.index);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < userPrompt.length; i++) {
    const ch = userPrompt[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = userPrompt.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return JSON.stringify(parsed);
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

async function extractInputsFromPrompt(
  packageName: string,
  userPrompt: string,
  actor: ActorContext,
): Promise<string> {
  try {
    const templates = await readPublishedAgentTemplates();
    const template = templates.find((t) => t.packageName === packageName);
    if (!template) return "{}";

    const schema = template.inputSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    } | null;
    if (!schema?.properties) return "{}";

    // Drop x-hidden fields — operators can't set them in the picker UI,
    // so the LLM shouldn't try to extract them from prose either. The same
    // visibility allowlist is applied to the deterministic fast-path below:
    // keep the "hidden = dispatcher-provided only" contract; an explicit
    // pasted inputParams block must NOT be able to set hidden or unknown
    // StartNode inputs.
    const visible: Record<string, Record<string, unknown>> = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (prop && (prop as Record<string, unknown>)["x-hidden"]) continue;
      visible[name] = prop;
    }
    if (Object.keys(visible).length === 0) return "{}";

    // 2026-05-17 — OpenAI structured-output `response_format` rejects JSON
    // Schema `format` values it doesn't recognize (`uri`, `email` in some
    // versions, etc.) with a 400. Most agent OAS StartNode fields declare
    // `format` purely as a hint to the LLM; the format value is not
    // semantically required for input extraction. Strip the field from a
    // shallow clone before sending. The original OAS schema is unaffected.
    //
    // 2026-05-23 — OpenAI also rejects array-typed properties that are
    // missing `items` (`400 array schema missing items`). Older compiled
    // `inputSchema` rows in the DB sometimes have `{type:"array"}` without
    // `items` because the compiler historically destructured `items` from
    // top-level only, while the OAS source carries it under
    // `json_schema.items` (agentspec 26.1.0 convention). The persisted-
    // compile path is fixed at `packages/agents/src/oas-compiler.ts:~1490`,
    // but freshly-compiled-and-stored rows depend on a version bump or
    // reimport. Defensive normalization here lifts `json_schema.items`
    // and falls back to `{type:"string"}` for arrays missing both, so
    // every stale row still produces an OpenAI-valid response_format
    // schema. Live: Apollo prospecting agent run `162162dd-...` got stuck
    // at pending_approval because this branch returned `"{}"` after
    // OpenAI's 400.
    const sanitizedVisible: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(visible)) {
      const { format: _format, ...rest } = v as Record<string, unknown>;
      void _format;
      const cleaned = rest as Record<string, unknown>;
      if (cleaned.type === "array" && cleaned.items === undefined) {
        const fromJsonSchema = (cleaned.json_schema as { items?: unknown } | undefined)?.items;
        cleaned.items = fromJsonSchema ?? { type: "string" };
      }
      // Drop `json_schema` entirely after lifting — OpenAI doesn't
      // understand the nested wrapper and may reject it as an unknown key.
      if (cleaned.json_schema !== undefined) delete cleaned.json_schema;
      sanitizedVisible[k] = cleaned;
    }

    // Deterministic fast-path: an explicitly pasted `inputParams: { ... }`
    // block is lifted verbatim, but filtered to the visible StartNode
    // properties.
    const embedded = tryParseEmbeddedInputParams(userPrompt);
    if (embedded) {
      try {
        const parsed = JSON.parse(embedded) as Record<string, unknown>;
        // Own-property allowlist Set. `k in visible` would accept inherited
        // Object.prototype names (toString/constructor/__proto__) and leak
        // them into inputParams.
        const visibleKeys = new Set(Object.keys(visible));
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (visibleKeys.has(k)) filtered[k] = v;
        }
        console.info(
          `[chat] explicit-dispatch used embedded inputParams JSON for ${packageName} (deterministic fast-path; kept ${Object.keys(filtered).length}/${Object.keys(parsed).length} keys after visibility filter)`,
        );
        return JSON.stringify(filtered);
      } catch {
        // Parsed by tryParseEmbeddedInputParams but re-parse failed —
        // fall through to the LLM extraction path.
      }
    }

    const responseSchema = {
      type: "object",
      properties: sanitizedVisible,
      required: (schema.required ?? []).filter((k) => k in sanitizedVisible),
      additionalProperties: false,
    };

    const result = await runDeterministicLlmTask({
      provider: "openai",
      system:
        "You extract structured inputs for an agent run from the user's chat prompt. " +
        "Use ONLY values explicitly mentioned in the prompt. " +
        "For fields the prompt doesn't specify, OMIT them — never invent " +
        "URLs, names, IDs, or other identifiers. " +
        "Return JSON matching the response schema. If no fields can be " +
        "extracted, return {}.",
      user: userPrompt,
      outputSchema: responseSchema,
      logLabel: `chat-prerouter-extract:${packageName}`,
      reasoningEffort: "low",
      actorContext: actor,
      // 2026-05-17 — pure structured-output extraction; LLM does NOT need
      // MCP tools. Empty `declaredToolboxIds` opts out of tool injection so
      // the OpenAI Responses API does not try to fetch
      // the cinatra MCP tool list (which fails 424 Failed Dependency
      // whenever the public tunnel is briefly unreachable, killing
      // extraction and falling through to empty-inputs dispatch).
      declaredToolboxIds: [],
    });

    const text = result.text?.trim() ?? "{}";
    // Validate that it parses; if not, fall back.
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        console.info(
          `[chat] explicit-dispatch extracted inputs for ${packageName}: ${Object.keys(parsed).join(", ") || "(none)"}`,
        );
        return JSON.stringify(parsed);
      }
    } catch {
      // fall through
    }
    return "{}";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[chat] explicit-dispatch input-extraction failed for ${packageName}: ${msg}`);
    return "{}";
  }
}

export async function serverSideExplicitDispatch(input: {
  packageName: string;
  actor: ActorContext;
  send: (event: string, data: Record<string, unknown>) => void;
  /**
   * The user's chat message that triggered this dispatch. The pre-router
   * uses this to extract structured inputs for the agent's StartNode
   * and avoids surfacing the setup-loop HITL gate.
   */
  userPrompt?: string;
}): Promise<ServerSideDispatchResult> {
  const { packageName, send } = input;
  const actor = chatActorToPrimitive(input.actor);

  // Emit the tool_call event BEFORE invoking the primitive, so the e2e
  // listener sees the dispatch attempt regardless of the outcome.
  send("tool_call", {
    id: SYNTHETIC_TOOL_CALL_ID,
    name: "agent_run",
    status: "running",
    serverLabel: "cinatra-mcp",
  });

  // Creation-flow preflight BEFORE any LLM call (extractInputsFromPrompt is
  // a real LLM round-trip when userPrompt is set) AND BEFORE the BullMQ
  // enqueue (agent_run primitive). On preflight failure: emit terminal SSE
  // events and return `terminal:true` so runner.ts early-returns without
  // invoking stream.
  const isCreationFlow = CREATION_FLOW_PACKAGES.has(packageName);
  let creationPinProvider:
    | "openai"
    | "anthropic"
    | "gemini"
    | undefined;
  if (isCreationFlow) {
    const pf = await runCreationPreflightForChatDispatch(packageName);
    if (!pf.ok) {
      const msg = `Cannot dispatch ${packageName}: agent-creation preflight failed (${pf.errorLabel}).`;
      send("tool_result", {
        id: SYNTHETIC_TOOL_CALL_ID,
        name: "agent_run",
        status: "completed",
        serverLabel: "cinatra-mcp",
        resultLabel: `preflight_failed: ${pf.errorLabel}`,
        result: JSON.stringify({ error: pf.errorLabel, code: "preflight_failed" }),
      });
      send("text", { content: msg });
      return { ok: false, terminal: true, error: `preflight_failed: ${pf.errorLabel}` };
    }
    if (pf.pinActive) {
      creationPinProvider = pf.provider;
    }
  }

  // Extract inputs from prompt before dispatch.
  const inputParams = input.userPrompt
    ? await extractInputsFromPrompt(packageName, input.userPrompt, input.actor)
    : "{}";

  try {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const transport = createInProcessPrimitiveTransport(handlers);
    // invokePrimitive returns TOutput directly; errors throw.
    const output = await invokePrimitive<
      { packageName: string; inputParams: string },
      { runId: string; status: string }
    >(transport, {
      primitiveName: "agent_run",
      input: { packageName, inputParams },
      actor,
      mode: "deterministic",
    });

    console.info(
      `[chat] explicit-dispatch HARD invokePrimitive returned: ${JSON.stringify(output).slice(0, 500)}`,
    );
    const out = output as { runId?: string; status?: string; error?: string };
    if (!out.runId) {
      send("tool_result", {
        id: SYNTHETIC_TOOL_CALL_ID,
        name: "agent_run",
        status: "completed",
        serverLabel: "cinatra-mcp",
        resultLabel: `agent_run returned no runId: ${out.error ?? "unknown"}`,
        result: JSON.stringify(out),
      });
      send("text", {
        content: `I tried to dispatch \`${packageName}\` but the server returned: ${out.error ?? JSON.stringify(out)}.`,
      });
      return { ok: false, error: out.error ?? "agent_run returned no runId" };
    }
    const runId = out.runId;
    const status = out.status ?? "queued";
    const resultJson = JSON.stringify({ runId, status });
    send("tool_result", {
      id: SYNTHETIC_TOOL_CALL_ID,
      name: "agent_run",
      status: "completed",
      serverLabel: "cinatra-mcp",
      resultLabel: `runId: ${runId}, status: ${status}`,
      result: resultJson,
    });
    send("text", {
      content: `Dispatched \`${packageName}\` (runId: \`${runId}\`, status: \`${status}\`). The agent is running — I'll keep polling for its progress.`,
    });

    // Append-only creation-progress emits, fired fire-and-forget. Recipient
    // is SERVER-DERIVED from the actor's principalId (HumanUser only — never
    // caller-controlled, never an admin/team/org fanout vector). Non-human
    // actors silently skip the emit (chat dispatch from a service account
    // etc.).
    if (
      isCreationFlow &&
      input.actor.principalType === "HumanUser" &&
      input.actor.principalId
    ) {
      const recipient = { kind: "user" as const, userId: input.actor.principalId };
      const href = buildAgentInstancePath(packageName, runId);
      void safeEmitAgentCreationProgress({
        recipient,
        runId,
        packageName,
        milestone: "queued",
        href,
      });
      // syncing_skills only emits when the Anthropic pin is the active
      // creation-path provider — that's when a real skill sync
      // conceptually happens. OpenAI/Gemini pinned creation paths skip
      // it (no Anthropic container.skills upload to sync).
      if (creationPinProvider === "anthropic") {
        void safeEmitAgentCreationProgress({
          recipient,
          runId,
          packageName,
          milestone: "syncing_skills",
          href,
        });
      }
    }

    return { ok: true, runId, status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send("tool_result", {
      id: SYNTHETIC_TOOL_CALL_ID,
      name: "agent_run",
      status: "completed",
      serverLabel: "cinatra-mcp",
      resultLabel: `agent_run threw: ${msg}`,
      result: JSON.stringify({ error: msg }),
    });
    send("text", {
      content: `I tried to dispatch \`${packageName}\` but the call threw: ${msg}.`,
    });
    return { ok: false, error: msg };
  }
}
