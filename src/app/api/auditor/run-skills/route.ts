import "server-only";

// ---------------------------------------------------------------------------
// POST /api/auditor/run-skills
//
// Two modes driven by the `phase` field:
//   "resolve" — hybrid skill resolution. If input.skillIds is a
//               non-empty array, returns it verbatim. Otherwise calls
//               skills_installed_resolve_for_agent with parentPackageName.
//   "run"     — runs the resolved skills via @cinatra-ai/llm
//               skill-aware deterministic LLM task with a STRUCTURED OUTPUT
//               schema that REQUIRES suggestions in the SuggestionPatch shape
//               { id, fieldPath, op, value, message }. No prose normalization
//               because the LLM must not rewrite skill output.
//
// Skills MUST emit structured suggestions directly. The route's outputSchema
// is the contract — the LLM is configured to return JSON matching it. If a
// skill emits prose only, the LLM's structured-output mode will return an
// empty suggestions array rather than guessing.
//
// Auth: requireAuthSession + run-ownership guard.
// Persistence: suggestions are persisted to audit_events keyed by
// agent_run_id so the apply step can replay-validate acceptedIds.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { readAgentRunById, readRunCoOwners } from "@cinatra-ai/agents";
import { auditEvents } from "@cinatra-ai/agents/schema";
import { db } from "@cinatra-ai/agents/db";
import { runSkillAwareDeterministicLlmTask, withActorContext } from "@cinatra-ai/llm";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";
import { createSkillsPrimitiveHandlers } from "@cinatra-ai/skills/mcp-handlers";
import { SuggestionPatchSchema } from "@cinatra-ai/agents/auditor-apply";

// WayFlow's pyagentspec templates array inputs into the JSON body as a
// Python-list `str()` repr (e.g. `"[]"` for an empty list, `"['a','b']"`
// for non-empty). This is a known templating gap on the WayFlow side
// (no `|tojson` filter is applied). Cover both shapes here: accept a
// real JSON array, OR a stringified form that we JSON.parse back.
const SkillIdsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .default([])
  .transform((value): string[] => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "[]") return [];
    // Try strict JSON first.
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // fall through to Python-repr handling
    }
    // Python-repr fallback: `['a', 'b']` — swap single→double quotes and
    // re-parse. Conservative: must look like a list literal.
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed.replaceAll("'", '"'));
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        // give up
      }
    }
    return [];
  });

const RequestBodySchema = z.object({
  agent_run_id: z.string().min(1),
  parentPackageName: z.string().min(1),
  skillIds: SkillIdsSchema,
  data: z.unknown(),
  phase: z.enum(["resolve", "run"]),
});

const ACTOR: PrimitiveActorContext = { actorType: "human", source: "route" };

async function callSkills<T>(
  primitiveName: string,
  input: Record<string, unknown>,
): Promise<T> {
  const transport = createInProcessPrimitiveTransport(
    createSkillsPrimitiveHandlers(),
  );
  return invokePrimitive<Record<string, unknown>, T>(transport, {
    primitiveName,
    input,
    actor: ACTOR,
    mode: "deterministic",
  });
}

const SUGGESTIONS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          fieldPath: { type: "string" },
          op: { type: "string", enum: ["replace", "add", "remove"] },
          // OpenAI strict structured-output requires every object type
          // in the schema to have `additionalProperties: false` AND
          // every property key in `required`. A type union including
          // `object` violates the first (cannot declare it for an open
          // polymorphic value); making `value`/`message` optional
          // violates the second. Restrict `value` to a JSON-primitive
          // string (LLM JSON-stringifies non-primitives) and require
          // both; the LLM emits empty string for missing fields.
          value: { type: "string" },
          message: { type: "string" },
        },
        required: ["id", "fieldPath", "op", "value", "message"],
      },
    },
  },
  required: ["suggestions"],
} as const;

export async function POST(request: Request): Promise<Response> {
  // Dual auth: WayFlow dispatches the auditor as an agent;
  // agent_loader.py:_patch_api_call_step_bridge_token injects
  // X-Cinatra-Bridge-Token on every ApiNode call. Accept that shared-secret
  // path — same trust model as /api/llm-bridge + /api/agents/passthrough
  // (principalId "wayflow-bridge"). Without it the WayFlow callback has no
  // session cookie and 307-redirects to /sign-in, failing the run before
  // resolve/run. Direct UI/MCP callers still require a session.
  const isBridge = isAuthorizedBridgeRequest(request);
  const session = isBridge ? null : await requireAuthSession().catch(() => null);
  const actorUserId = session?.user?.id ?? null;
  if (!isBridge && !actorUserId) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: z.infer<typeof RequestBodySchema>;
  try {
    const raw = await request.json();
    parsed = RequestBodySchema.parse(raw);
  } catch (error) {
    return Response.json(
      { error: "Invalid request body", detail: String(error) },
      { status: 400 },
    );
  }

  // Run-ownership guard. Skipped for the trusted WayFlow bridge:
  // the bridge only calls back for runs Cinatra itself dispatched (the run
  // must still exist — 404 below). Direct session callers keep the full
  // owner / platform-admin / co-owner check.
  const run = await readAgentRunById(parsed.agent_run_id);
  if (!run) return new Response("Not Found", { status: 404 });
  if (
    !isBridge &&
    run.runBy &&
    run.runBy !== actorUserId &&
    !isPlatformAdmin(session)
  ) {
    const coOwners = await readRunCoOwners(run.id);
    if (!coOwners.some((c) => c.userId === actorUserId)) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  if (parsed.phase === "resolve") {
    let skillIds: string[];
    if (parsed.skillIds && parsed.skillIds.length > 0) {
      skillIds = parsed.skillIds;
    } else {
      const resolved = await callSkills<{ skillIds?: string[] }>(
        "skills_installed_resolve_for_agent",
        { agentId: parsed.parentPackageName },
      );
      skillIds = resolved.skillIds ?? [];
    }
    return Response.json({ skillIds });
  }

  // phase === "run"
  let skillIds: string[] = parsed.skillIds ?? [];
  if (skillIds.length === 0) {
    const resolved = await callSkills<{ skillIds?: string[] }>(
      "skills_installed_resolve_for_agent",
      { agentId: parsed.parentPackageName },
    );
    skillIds = resolved.skillIds ?? [];
  }

  // "No installed skills →
  // empty suggestions → completed" IS the correct auditor/reviewer
  // contract. Without this early return the route runs the OpenAI
  // structured-output task with zero skills, which 500s and terminates
  // the reviewer/auditor agent run as `failed`.
  if (skillIds.length === 0) {
    return Response.json({ suggestions: [] });
  }

  const provider = "openai" as const;
  const system =
    "You are an auditor running installed skills against a parent agent's data payload. " +
    "Read each skill's SKILL.md (via the read_skill / shell tool) and apply its rules to the input data. " +
    "Emit zero or more structured suggestions in the SuggestionPatch shape. " +
    "Each suggestion MUST have a stable id, an RFC 6901 fieldPath into the data, " +
    "an op of 'replace' | 'add' | 'remove', and (for replace/add) a value. " +
    "The `value` field MUST be a string. If the underlying patch value is " +
    "non-primitive (object, array), JSON-stringify it into the string. " +
    "Do NOT rewrite skill output as prose. Do NOT invent suggestions when skills produce none.";
  const user =
    "parentPackageName: " + parsed.parentPackageName + "\n\n" +
    "data:\n" + JSON.stringify(parsed.data, null, 2);

  // Establish ALS actor-context BEFORE the LLM
  // call. `runSkillAwareDeterministicLlmTask` reads the actor from the
  // AsyncLocalStorage frame (for MCP injection + skills resolution).
  // Without this wrapper it throws `ACTOR_CONTEXT_MISSING` and the
  // auditor agent run terminates as failed BEFORE the review_gate fires.
  // Same pattern as `src/app/api/agents/passthrough/route.ts:273`.
  const alsActorContext = await buildActorContextFromRun({
    id: run.id,
    runBy: run.runBy,
    orgId: run.orgId,
  });
  const response = await withActorContext(alsActorContext, () =>
    runSkillAwareDeterministicLlmTask({
      provider,
      system,
      user,
      skillIds,
      outputSchema: SUGGESTIONS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      logLabel: "auditor.run-skills",
    }),
  );

  let suggestions: z.infer<typeof SuggestionPatchSchema>[] = [];
  if (response.text) {
    try {
      const parsedText = JSON.parse(response.text) as { suggestions?: unknown };
      const validated = z
        .object({ suggestions: z.array(SuggestionPatchSchema) })
        .parse(parsedText);
      suggestions = validated.suggestions;
    } catch (err) {
      // Structured-output failure → empty suggestions; never fabricate.
      // Log so a regression in the LLM's structured-output mode is observable
      // (otherwise an empty array and a parse failure are indistinguishable
      // downstream.
      console.warn("[auditor.run-skills] structured-output parse failed", err);
      suggestions = [];
    }
  }

  // Persist suggestions for replay-validation in /api/auditor/apply.
  await db.insert(auditEvents).values({
    id: randomUUID(),
    reviewTaskId: parsed.agent_run_id,
    // Bridge-authed (WayFlow) calls have no session user; record the bridge
    // principal in the audit trail (same sentinel as /api/llm-bridge +
    // /api/agents/passthrough). Direct callers record their real user id.
    actorId: actorUserId ?? "wayflow-bridge",
    eventType: "auditor_suggestions_emitted",
    payload: JSON.stringify({ suggestions }),
  });

  return Response.json({ suggestions });
}
