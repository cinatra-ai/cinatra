import "server-only";

// ---------------------------------------------------------------------------
// POST /api/auditor/apply.
//
// Invokes the deterministic applyAuditorPatches transform against the request
// `data` using the accepted per-item proposal ids from the review gate.
//
// Security model (cinatra#1625):
//   1. The single-string `reviewResult` envelope
//      { acceptedPatchIds, dismissedPatchIds, excludedPromptIds } is JSON-parsed
//      on entry (the renderer emits per-item accept/dismiss over PROPOSAL ids).
//   2. The authoritative surfaced set is the ONE immutable
//      auditor_proposal_snapshots row for this run (written by
//      /api/auditor/run-skills). acceptedPatchIds MUST be a subset of that
//      row's patch_ids — NOT a union of retry rows. Patch CONTENT (fieldPath,
//      op, value) is sourced ONLY from the snapshot, never the request body, so
//      a malicious resume cannot pair a legitimate id with attacker-controlled
//      content.
//   3. A single-use Separation-of-Duties receipt (minted by the admin-gated
//      approveReviewTask, bound to the snapshot hash + reviewer) is CONSUMED
//      here with a single-shot CAS. A second apply / forged resume replay finds
//      no live receipt → 403.
//   4. Accept persists the accepted per-item skill changes for the parent agent
//      (parentPackageName, carried on the apply body per the OAS follow-up).
//
// Auth: bridge shared-secret OR requireAuthSession + run-ownership guard.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { readAgentRunById, readRunCoOwners } from "@cinatra-ai/agents";
import {
  applyAuditorPatches,
  AuditorApplyError,
} from "@cinatra-ai/agents/auditor-apply";
import {
  readProposalSnapshotForRun,
  consumeApprovalReceipt,
} from "@cinatra-ai/agents/auditor-snapshot-store";
import { persistAcceptedAuditorSkill } from "@/lib/auditor/persist-accepted-skill";

// The body carries the run id, the data document to mutate, the single-string
// reviewResult envelope, and (per the OAS follow-up) the parent package name
// for the per-item skill persist. Suggestions are NOT accepted from the body.
const RequestBodySchema = z.object({
  agent_run_id: z.string().min(1),
  parentPackageName: z.string().min(1).optional(),
  data: z.unknown(),
  reviewResult: z.string().min(1),
});

const ReviewResultEnvelopeSchema = z.object({
  acceptedPatchIds: z.array(z.string()),
  dismissedPatchIds: z.array(z.string()),
  // The exclude companion (/api/auditor/exclude) owns excludedPromptIds; it is
  // accepted here (present in the shared envelope) but not acted on.
  excludedPromptIds: z.array(z.string()).optional().default([]),
});

export async function POST(request: Request): Promise<Response> {
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

  // JSON.parse the single-string reviewResult envelope (NEW per-item shape).
  let acceptedPatchIds: string[];
  try {
    const decoded = ReviewResultEnvelopeSchema.parse(JSON.parse(parsed.reviewResult));
    acceptedPatchIds = decoded.acceptedPatchIds;
  } catch (error) {
    return Response.json(
      { error: "Invalid reviewResult envelope", detail: String(error) },
      { status: 400 },
    );
  }

  // Bind the body-selected agent_run_id to the run actually executing this
  // bridge callback before deriving authority from it.
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

  // Load the SINGLE authoritative snapshot for this run (fail-closed if none).
  const snapshot = await readProposalSnapshotForRun(parsed.agent_run_id);
  if (!snapshot) {
    return Response.json(
      { error: "No proposal snapshot for this run" },
      { status: 409 },
    );
  }

  // Replay-validate acceptedPatchIds ⊆ the snapshot's surfaced set. No union.
  const snapshotIds = new Set(snapshot.patchIds);
  for (const id of acceptedPatchIds) {
    if (!snapshotIds.has(id)) {
      return Response.json(
        {
          error: "Accepted id not in the snapshot suggestion set for this run",
          offendingId: id,
        },
        { status: 400 },
      );
    }
  }

  // Consume the single-use SoD receipt bound to this snapshot hash. A second
  // apply / forged replay finds no live receipt → 403. The receipt is minted by
  // the admin-gated approveReviewTask (bound snapshot-hash + reviewer).
  const receipt = await consumeApprovalReceipt({
    agentRunId: parsed.agent_run_id,
    snapshotHash: snapshot.snapshotHash,
  });
  if (!receipt) {
    return Response.json(
      { error: "No live approval receipt for this snapshot (already consumed, absent, or snapshot drift)" },
      { status: 403 },
    );
  }

  // Deterministic apply — patch content sourced ONLY from the snapshot.
  let mutatedData: unknown;
  try {
    mutatedData = applyAuditorPatches(
      parsed.data,
      snapshot.patches,
      acceptedPatchIds,
    );
  } catch (error) {
    if (error instanceof AuditorApplyError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Per-item skill persist: the accepted proposals become the durable personal
  // skill change for the parent agent. Best-effort — the deterministic mutation
  // + the consumed receipt are the authoritative durable acceptance record; a
  // personal-skill persist failure must not roll back an applied write.
  if (parsed.parentPackageName && acceptedPatchIds.length > 0) {
    try {
      await persistAcceptedAuditorSkill({
        run,
        parentPackageName: parsed.parentPackageName,
        snapshot,
        acceptedPatchIds,
      });
    } catch (err) {
      console.warn("[auditor.apply] accepted-skill persist failed", err);
    }
  }

  return Response.json({ mutatedData });
}
