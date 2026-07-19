import "server-only";

// ---------------------------------------------------------------------------
// POST /api/auditor/run-skills
//
// Two modes driven by the `phase` field:
//   "resolve" — hybrid skill resolution. If input.skillIds is a
//               non-empty array (the skill-recommendation HITL's confirmed
//               selection), returns it verbatim. Otherwise calls
//               skills_installed_resolve_for_agent with parentPackageName
//               (the agent's own installed + matched skills).
//   "run"     — runs the resolved skills via @cinatra-ai/llm skill-aware
//               deterministic LLM task and GENERATES the review material from
//               the audit inputs (the resolved skills + the artifact + the
//               user's applied changes): a personal-skill `preview`
//               (name/description/content) AND the per-item SuggestionPatch[]
//               { id, fieldPath, op, value, message } (owner ruled flow entry
//               109, 2026-07-19 — the audit run itself generates the preview,
//               no separate prompts wiring). The run derives `edited` — whether
//               the user applied changes to the offered artifact — from the
//               run's captured HITL amendment context; the auditor OAS
//               `edited_gate` BranchingNode surfaces the review HITL ONLY when
//               edited="edited".
//
// Persistence: run phase writes EXACTLY ONE immutable proposal snapshot per run
// (auditor_proposal_snapshots, keyed UNIQUE by agent_run_id) so /api/auditor/
// apply can replay-validate acceptedPatchIds ⊆ the surfaced set WITHOUT unioning
// retry rows. Replaces the legacy audit_events "auditor_suggestions_emitted"
// insert (which unioned on retry AND failed to insert on a fresh-bootstrap DB
// whose audit_events carries only the structured authz shape).
//
// Auth: bridge shared-secret OR requireAuthSession + run-ownership guard.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import {
  readAgentRunById,
  readRunCoOwners,
  readAllHitlPromptsForRun,
} from "@cinatra-ai/agents";
import {
  writeProposalSnapshot,
  type AuditSkillPreview,
} from "@cinatra-ai/agents/auditor-snapshot-store";
import { AuditorSnapshotError } from "@cinatra-ai/agents/auditor-snapshot-errors";
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

// The LLM emits BOTH the per-item suggestions AND the personal-skill preview
// (name/description/content) generated from the audit material — the single
// review payload the renderer consumes (owner ruled flow, 2026-07-19). OpenAI
// strict structured-output requires every object to declare
// additionalProperties:false and list every property in `required`.
const RUN_OUTPUT_SCHEMA = {
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
          // `value` restricted to a JSON-primitive string (the LLM
          // JSON-stringifies non-primitives); empty string for missing fields.
          value: { type: "string" },
          message: { type: "string" },
        },
        required: ["id", "fieldPath", "op", "value", "message"],
      },
    },
    preview: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        content: { type: "string" },
      },
      required: ["name", "description", "content"],
    },
  },
  required: ["suggestions", "preview"],
} as const;

type GeneratedPreview = { name: string; description: string; content: string };

export async function POST(request: Request): Promise<Response> {
  // Dual auth: WayFlow dispatches the auditor as an agent;
  // agent_loader.py:_patch_api_call_step_bridge_token injects
  // X-Cinatra-Bridge-Token on every ApiNode call. Accept that shared-secret
  // path — same trust model as /api/llm-bridge + /api/agents/passthrough
  // (principalId "wayflow-bridge"). Direct UI/MCP callers still require a session.
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

  // Bind the body-selected agent_run_id to the run actually executing this
  // callback (proven by the auth-injected X-Cinatra-A2A-Context-Id header)
  // before deriving authority from it. Session callers keep the full owner /
  // platform-admin / co-owner check below.
  if (isBridge) {
    const binding = await bindBridgeRunId(request, parsed.agent_run_id);
    if (!binding.ok) {
      return Response.json({ error: binding.error }, { status: binding.status });
    }
  }

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

  // Derive `edited` — whether the user applied changes to the artifact the
  // parent agent offered for review. The run's captured HITL amendment prompts
  // (scoped to the parent agent) are the host-side record of user-applied
  // changes / guidance; a non-empty set means the user acted on the offered
  // artifact. The auditor OAS `edited_gate` BranchingNode surfaces the review
  // HITL ONLY when this is "edited" (owner ruling 2026-07-19: no user changes →
  // no audit HITL).
  let editedSignal: "edited" | "clean" = "clean";
  try {
    const amendmentPrompts = await readAllHitlPromptsForRun(
      parsed.agent_run_id,
      parsed.parentPackageName,
    );
    if (amendmentPrompts.length > 0) editedSignal = "edited";
  } catch (err) {
    console.warn("[auditor.run-skills] amendment-prompt read failed", err);
  }

  let suggestions: z.infer<typeof SuggestionPatchSchema>[] = [];
  let generatedPreview: GeneratedPreview = { name: "", description: "", content: "" };

  if (skillIds.length > 0) {
    const provider = "openai" as const;
    const system =
      "You are an auditor running installed skills against a parent agent's data payload " +
      "and the changes the user applied to it. Read each skill's SKILL.md (via the " +
      "read_skill / shell tool) and apply its rules to the input data. " +
      "Emit zero or more structured suggestions in the SuggestionPatch shape. " +
      "Each suggestion MUST have a stable id, an RFC 6901 fieldPath into the data, " +
      "an op of 'replace' | 'add' | 'remove', and (for replace/add) a value. " +
      "The `value` field MUST be a string; JSON-stringify non-primitive values. " +
      "ALSO generate a concise personal-skill `preview` summarizing what these " +
      "proposed changes would teach for future runs: a short `name`, a one-line " +
      "`description`, and a `content` body (the skill guidance). " +
      "Do NOT rewrite skill output as prose. Do NOT invent suggestions when skills produce none.";
    const user =
      "parentPackageName: " + parsed.parentPackageName + "\n\n" +
      "data:\n" + JSON.stringify(parsed.data, null, 2);

    // Establish ALS actor-context BEFORE the LLM call. Same pattern as
    // src/app/api/agents/passthrough/route.ts.
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
        outputSchema: RUN_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        logLabel: "auditor.run-skills",
      }),
    );

    if (response.text) {
      try {
        const parsedText = JSON.parse(response.text) as {
          suggestions?: unknown;
          preview?: unknown;
        };
        const validated = z
          .object({
            suggestions: z.array(SuggestionPatchSchema),
            preview: z.object({
              name: z.string(),
              description: z.string(),
              content: z.string(),
            }),
          })
          .parse(parsedText);
        suggestions = validated.suggestions;
        generatedPreview = validated.preview;
      } catch (err) {
        // Structured-output failure → empty; never fabricate.
        console.warn("[auditor.run-skills] structured-output parse failed", err);
        suggestions = [];
        generatedPreview = { name: "", description: "", content: "" };
      }
    }
  }

  // Build the single review payload the renderer consumes. `patches` is the
  // per-item { id, fieldPath, op, message } view (value is NOT surfaced — apply
  // sources value from the snapshot, not the wire).
  const preview: AuditSkillPreview = {
    name: generatedPreview.name,
    description: generatedPreview.description,
    content: generatedPreview.content,
    basedOnSkillIds: skillIds,
    patches: suggestions.map((s) => ({
      id: s.id,
      fieldPath: s.fieldPath,
      op: s.op,
      message: s.message ?? "",
    })),
  };

  // Persist EXACTLY ONE immutable snapshot per run (idempotent on retry;
  // fail-closed on malformed patches or a differing input digest).
  try {
    await writeProposalSnapshot({
      agentRunId: parsed.agent_run_id,
      preview,
      patches: suggestions,
      inputData: parsed.data,
      edited: editedSignal,
    });
  } catch (error) {
    if (error instanceof AuditorSnapshotError) {
      const status = error.code === "malformed_snapshot" ? 400 : 409;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }

  return Response.json({ preview, edited: editedSignal });
}
