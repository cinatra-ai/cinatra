import "server-only";

import { z } from "zod";
import { NextResponse } from "next/server";
import {
  parseUserResponseEnvelope,
  revalidateSelectedRefs,
  buildSelectionRows,
  computeSelectionKey,
  ContextRouteError,
} from "@/lib/artifacts/context-route-support";
import {
  deriveContextRouteContext,
  loadTrustedSlot,
  resolveCandidates,
} from "@/lib/artifacts/context-route-io";
import { writeRunContextSelectionsBatchIdempotent } from "@/lib/artifacts/run-context-selections-store";

// ---------------------------------------------------------------------------
// POST /api/context-finalize
//
// Called by the context-selection-agent subflow's finalize_context ApiNode.
// Revalidates the submitted selection against the TRUSTED candidate set
// (re-resolved server-side), writes the append-only audit rows idempotently
// (content-addressed selectionKey), and returns the consumer envelope
// { contextSlotBindings: [{ slotId, refs }] }.
// ---------------------------------------------------------------------------

const RequestSchema = z.object({
  parentRunId: z.string().min(1),
  parentPackageName: z.string().min(1),
  slotId: z.string().min(1),
  projectId: z.string().optional(),
  selectionMode: z.enum(["interactive", "autonomous"]),
  userResponse: z.string(),
});

export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  try {
    const ctx = await deriveContextRouteContext(req, body);
    // Use the TRUSTED package name (from the run's template), never the body.
    const slot = await loadTrustedSlot(ctx.trustedPackageName, body.slotId);

    // Trusted modes come from the SLOT, not the body/envelope. Validate the
    // caller-supplied values match (defends against OAS/renderer drift), then
    // use the slot's values for all provenance + the selection key.
    if (body.selectionMode !== slot.selectionMode) {
      throw new ContextRouteError(
        422,
        "selection_mode_mismatch",
        `body selectionMode '${body.selectionMode}' != slot '${slot.selectionMode}'`,
      );
    }
    const selectionMode = slot.selectionMode;

    // Parse the selection envelope; reject a slotId / resolutionMode that
    // disagrees with the trusted slot.
    const envelope = parseUserResponseEnvelope(body.userResponse);
    if (envelope.slotId !== body.slotId) {
      throw new ContextRouteError(
        422,
        "slot_mismatch",
        `envelope slotId '${envelope.slotId}' != request slotId '${body.slotId}'`,
      );
    }
    if (envelope.resolutionMode !== slot.resolutionMode) {
      throw new ContextRouteError(
        422,
        "resolution_mode_mismatch",
        `envelope resolutionMode '${envelope.resolutionMode}' != slot '${slot.resolutionMode}'`,
      );
    }

    // Re-resolve the trusted candidate set and revalidate the submission.
    const candidates = resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });
    const trusted = revalidateSelectedRefs({
      submitted: envelope.selectedRefs,
      candidates,
      slot,
    });

    // Content-addressed idempotent write (trusted package + slot mode).
    const rows = buildSelectionRows({
      orgId: ctx.run.orgId!,
      parentRunId: ctx.run.id,
      parentPackageName: ctx.trustedPackageName,
      slotId: body.slotId,
      selectionMode,
      trusted,
    });
    const selectionKey = computeSelectionKey({
      parentRunId: ctx.run.id,
      parentPackageName: ctx.trustedPackageName,
      slotId: body.slotId,
      selectionMode,
      refs: trusted,
    });
    const writeResult = writeRunContextSelectionsBatchIdempotent(rows, selectionKey);

    return NextResponse.json({
      contextSlotBindings: [{ slotId: body.slotId, refs: trusted }],
      wrote: writeResult.wrote,
    });
  } catch (err) {
    if (err instanceof ContextRouteError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    throw err;
  }
}
