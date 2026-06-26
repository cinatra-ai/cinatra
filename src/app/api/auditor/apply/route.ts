import "server-only";

// ---------------------------------------------------------------------------
// POST /api/auditor/apply.
//
// Invokes the deterministic applyAuditorPatches transform against the request
// `data` using the suggestions/acceptedIds from the review gate.
// Replay-validates that every acceptedId is present in the persisted
// suggestion set for this agent_run_id (audit_events
// "auditor_suggestions_emitted" rows from /api/auditor/run-skills) — this
// closes the tampering gap where a malicious resume could inject ids outside
// the originally surfaced set.
//
// Auth: requireAuthSession + run-ownership guard.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { readAgentRunById, readRunCoOwners } from "@cinatra-ai/agents";
import { auditEvents } from "@cinatra-ai/agents/schema";
import { db } from "@cinatra-ai/agents/db";
import {
  applyAuditorPatches,
  AuditorApplyError,
  SuggestionPatchSchema,
} from "@cinatra-ai/agents/auditor-apply";

// Suggestions are NOT accepted from the request body. They are reloaded
// server-side from `audit_events` (event_type "auditor_suggestions_emitted")
// so a malicious resume cannot smuggle a patch payload by pairing a legitimate
// id with attacker-controlled fieldPath/op/value. The request body therefore
// only carries the run id, the data document to mutate, and the set of accepted
// suggestion ids.
//
// Per the OAS 26.1.0 InputMessageNode contract, the review_gate emits a single
// string output (`reviewResult`) carrying a JSON-encoded envelope
// `{ acceptedIds, dismissedIds }`. We JSON.parse on entry; the subset invariant
// downstream is unchanged. See
// https://docs.cinatra.ai/references/platform/wayflow-input-message-node-contract/ for the contract rationale.
const RequestBodySchema = z.object({
  agent_run_id: z.string().min(1),
  data: z.unknown(),
  reviewResult: z.string().min(1),
});

const ReviewResultEnvelopeSchema = z.object({
  acceptedIds: z.array(z.string()),
  // required (non-optional) so the wire schema agrees with the OAS
  // x-envelope-shape and the renderer (which always emits this key).
  dismissedIds: z.array(z.string()),
});

export async function POST(request: Request): Promise<Response> {
  // Dual auth: see /api/auditor/run-skills for rationale.
  // WayFlow injects X-Cinatra-Bridge-Token on the ApiNode call; accept that
  // trusted shared-secret path (no session cookie on the sidecar callback).
  const isBridge = isAuthorizedBridgeRequest(request);
  const session = isBridge ? null : await requireAuthSession().catch(() => null);
  const actorUserId = session?.user?.id ?? null;
  if (!isBridge && !actorUserId) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: z.infer<typeof RequestBodySchema>;
  try {
    parsed = RequestBodySchema.parse(await request.json());
  } catch (error) {
    return Response.json(
      { error: "Invalid request body", detail: String(error) },
      { status: 400 },
    );
  }

  // JSON.parse the single-string reviewResult envelope.
  let acceptedIds: string[];
  try {
    const decoded = ReviewResultEnvelopeSchema.parse(JSON.parse(parsed.reviewResult));
    acceptedIds = decoded.acceptedIds;
  } catch (error) {
    return Response.json(
      { error: "Invalid reviewResult envelope", detail: String(error) },
      { status: 400 },
    );
  }

  // Bind the body-selected agent_run_id to the run actually executing this
  // bridge callback (proven by the auth-injected
  // X-Cinatra-A2A-Context-Id header) before deriving authority from it. The
  // acceptedIds replay-validation below bounds WHICH suggestions can be applied,
  // but NOT which run supplies authority — the binding closes that gap. Session
  // callers keep the full owner / admin / co-owner check below.
  if (isBridge) {
    const binding = await bindBridgeRunId(request, parsed.agent_run_id);
    if (!binding.ok) {
      return Response.json({ error: binding.error }, { status: binding.status });
    }
  }

  // Run-ownership guard. For the trusted WayFlow bridge the run-binding check
  // above has bound agent_run_id to the executing run; the run must still
  // exist. Session callers keep the full check.
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

  // Replay-validate acceptedIds as a subset of the persisted suggestion set.
  const persistedRows = await db
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.reviewTaskId, parsed.agent_run_id),
        eq(auditEvents.eventType, "auditor_suggestions_emitted"),
      ),
    );

  // Reload the authoritative suggestion payloads (id + fieldPath + op + value
  // + message) from audit_events. The full content is required so that the
  // patches we apply are the exact ones surfaced to the user at review time;
  // an attacker resuming the run cannot substitute a different fieldPath or
  // value for a legitimate id.
  const persistedSuggestions: z.infer<typeof SuggestionPatchSchema>[] = [];
  for (const row of persistedRows) {
    if (!row.payload) continue;
    try {
      const decoded = JSON.parse(row.payload) as { suggestions?: unknown };
      const validated = z
        .object({ suggestions: z.array(SuggestionPatchSchema) })
        .safeParse(decoded);
      if (validated.success) {
        persistedSuggestions.push(...validated.data.suggestions);
      }
    } catch {
      // ignore malformed payloads
    }
  }

  const persistedIds = new Set(persistedSuggestions.map((s) => s.id));
  for (const id of acceptedIds) {
    if (!persistedIds.has(id)) {
      return Response.json(
        {
          error: "Accepted id not in persisted suggestion set for this run",
          offendingId: id,
        },
        { status: 400 },
      );
    }
  }

  let mutatedData: unknown;
  try {
    mutatedData = applyAuditorPatches(
      parsed.data,
      persistedSuggestions,
      acceptedIds,
    );
  } catch (error) {
    if (error instanceof AuditorApplyError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  return Response.json({ mutatedData });
}
