import "server-only";
import { z } from "zod";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// The detection ladder's MODEL RUNG (cinatra#3029, plan item 0.18 / section 8.6).
//
// "the core's model: the organisation's configured runtime — the one the meaning
//  matcher and the pickup's own type classifier already send content to, so no
//  new class of data leaves the deployment — over at most the first 16 KB, one
//  call per ambiguous text output, a fixed question with a fixed set of answers
//  at zero temperature, cached by content hash, with a strict re-parse, a
//  confidence threshold, the verdict, model and rung recorded on the ledger row,
//  plain text when the runtime is unconfigured or unsure, and a per-organisation
//  switch."
//
// THE SAME runtime seam the artifact matcher resolves (`resolveConfiguredLlmRuntime`
// + `runResolvedDeterministicLlmTask`) — no new client, no new class of data
// leaving the deployment. The clamp, the fixed question, the fixed answer set,
// the strict re-parse, the threshold and the cache all live in the LADDER; this
// module is only the runtime call.
//
// NEVER imported by the ladder's pure rungs: the ladder loads it lazily, so the
// table test (acceptance item 6) never pulls the runtime into its module graph
// and never calls a model.
// ---------------------------------------------------------------------------

/** The rung's strict answer shape. A response that does not re-parse against
 *  this is no answer at all (the ladder then yields plain text). */
const outputFormAnswerSchema = z
  .object({
    mime: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/** The provider-side JSON schema for the same one fixed question. */
const OUTPUT_FORM_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["mime", "confidence"],
  properties: {
    mime: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/**
 * The derivation's own actor frame. The runtime resolution and the deterministic
 * task both run under `requireActorFrame`; the default-road pickup runs on the
 * terminal path with no ambient principal frame of its own, so the rung anchors
 * an ORG-SCOPED System frame (the same shape the unbound derivation and the
 * artifact matcher anchor) — every scope-filtered read stays tenant-correct.
 */
function buildDetectionActorContext(orgId: string): ActorContext {
  return {
    principalType: "System",
    principalId: "output-detection-ladder",
    organizationId: orgId,
    teamIds: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: "v2",
  };
}

/**
 * Ask the organisation's configured runtime the ladder's ONE fixed question.
 * Returns `null` when no runtime is configured for the organisation, or when the
 * call fails — the ladder then yields plain text (never a wrong verdict).
 */
export async function askOrganisationRuntimeForOutputForm(input: {
  text: string;
  question: string;
  candidates: readonly string[];
  temperature: number;
  orgId: string;
}): Promise<{ mime: string; confidence: number; model: string } | null> {
  const { withActorContext } = await import("@cinatra-ai/llm/actor-context");
  const { resolveConfiguredLlmRuntime, runResolvedDeterministicLlmTask } =
    await import("@cinatra-ai/llm");

  // ZERO TEMPERATURE: `runResolvedDeterministicLlmTask` IS the stack's
  // zero-temperature road — the deterministic task fixes sampling for every
  // caller and takes no temperature of its own. The ladder still carries the
  // number in its ask contract (and asserts it in the table test) so the rung's
  // requirement is stated where the rung is defined, not buried in a client.
  void input.temperature;
  return withActorContext(buildDetectionActorContext(input.orgId), async () => {
    const runtime = await resolveConfiguredLlmRuntime();
    if (!runtime) return null;
    const system =
      `${input.question}\n` +
      `The only permitted answers are: ${input.candidates.join(", ")}.\n` +
      `Answer with a JSON object {"mime": one of those, "confidence": a number between 0 and 1}.`;
    const result = await runResolvedDeterministicLlmTask({
      runtime,
      actorContext: buildDetectionActorContext(input.orgId),
      system,
      user: input.text,
      declaredToolboxIds: [],
      outputSchema: OUTPUT_FORM_JSON_SCHEMA,
      logLabel: "output-detection-ladder",
    });
    // A STRICT re-parse (item 0.18): an unreadable response is no answer.
    let raw: unknown;
    try {
      raw = JSON.parse(String(result.text ?? ""));
    } catch {
      return null;
    }
    const parsed = outputFormAnswerSchema.safeParse(raw);
    if (!parsed.success) return null;
    return {
      mime: parsed.data.mime,
      confidence: parsed.data.confidence,
      model: runtime.model ?? "unknown",
    };
  });
}
