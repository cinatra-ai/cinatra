import "server-only";

import { z } from "zod";
import { NextResponse } from "next/server";
import {
  parseUserResponseEnvelope,
  revalidateSelectedRefs,
  buildSelectionRows,
  ContextRouteError,
} from "@/lib/artifacts/context-route-support";
import {
  deriveContextRouteContext,
  loadTrustedSlot,
  resolveCandidates,
  type DerivedContext,
} from "@/lib/artifacts/context-route-io";
import {
  extractContextRouteLogIds,
  recordContextRouteRejection,
  recordContextRouteSuccess,
} from "@/lib/artifacts/context-route-observability";
import {
  finalizeContextSelectionPinsAtomic,
  MissingRepresentationError,
  SelectionCoherenceError,
} from "@/lib/artifacts/context-selection-finalize";

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
  // #1197 observability: identifiers only (ids + stable codes) — never
  // payloads/envelopes. The a2a context-id header is the legacy run binding.
  const contextId = req.headers.get("x-cinatra-a2a-context-id");
  const raw = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    const ids = extractContextRouteLogIds(raw);
    recordContextRouteRejection({
      kind: "finalize",
      code: "invalid_body",
      status: 400,
      runId: ids.runId,
      contextId,
      slotId: ids.slotId,
    });
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // Tracked outside the try so the rejection line can carry the SERVER-derived
  // run id once derivation has succeeded (falls back to the body id before).
  let ctx: DerivedContext | undefined;
  try {
    ctx = await deriveContextRouteContext(req, body, "finalize");
    // Load the slot from the VERIFIED owner (the run package, or the composed
    // child that the run package's own OAS binds to this slotId), never the body.
    // Actor + audit-store scoping below stays on the run package (trustedPackageName).
    const slot = await loadTrustedSlot(ctx.trustedSlotPackageName, body.slotId);

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
    const candidates = await resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });
    const trusted = revalidateSelectedRefs({
      submitted: envelope.selectedRefs,
      candidates,
      slot,
    });

    // cinatra#1430 finalization: ONE ATOMIC GC-serialized transaction across
    // ALL selected refs = coherence re-validation + the append-only
    // run_context_selections audit rows + REAL artifact_refs retention pins
    // (referrer = this agent run). All-or-nothing: the append-only audit
    // cannot be compensated after a partial commit, so any incoherent ref
    // aborts the whole selection. Idempotent: each ref's deterministic
    // selection id and the pin's natural key make an exact replay a no-op.
    const rows = buildSelectionRows({
      orgId: ctx.run.orgId!,
      parentRunId: ctx.run.id,
      parentPackageName: ctx.trustedPackageName,
      slotId: body.slotId,
      selectionMode,
      trusted,
    });
    let wroteAny = false;
    try {
      const results = finalizeContextSelectionPinsAtomic(
        rows.map((row) => ({
          selection: row,
          referrerKind: "agent_run" as const,
          referrerId: ctx!.run.id,
          createdBy: ctx!.run.runBy ?? null,
        })),
      );
      wroteAny = results.some((r) => r.selectionWritten);
    } catch (err) {
      if (
        err instanceof SelectionCoherenceError ||
        err instanceof MissingRepresentationError
      ) {
        // A candidate went incoherent between re-resolve and finalize
        // (tombstone / reclassification / GC-reclaimed snapshot resource).
        // NOTHING was committed (atomic batch); stable-code rejection; the
        // caller re-resolves.
        throw new ContextRouteError(409, "selection_incoherent", err.message);
      }
      throw err;
    }
    const writeResult = { wrote: wroteAny };

    // #1197: debug-level lifecycle trace + per-kind ok counter.
    recordContextRouteSuccess({
      kind: "finalize",
      servedBy: ctx.servedBy,
      runId: ctx.run.id,
      contextId,
      slotId: body.slotId,
    });
    return NextResponse.json({
      contextSlotBindings: [{ slotId: body.slotId, refs: trusted }],
      wrote: writeResult.wrote,
    });
  } catch (err) {
    if (err instanceof ContextRouteError) {
      // #1197: EVERY stable-code rejection is counted + logged (ids only).
      recordContextRouteRejection({
        kind: "finalize",
        code: err.code,
        status: err.status,
        runId: ctx?.run.id ?? body.parentRunId,
        contextId,
        slotId: body.slotId,
      });
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    // #1197: an unexpected crash lands in a stable bucket too, then rethrows.
    recordContextRouteRejection({
      kind: "finalize",
      code: "internal_error",
      status: 500,
      runId: ctx?.run.id ?? body.parentRunId,
      contextId,
      slotId: body.slotId,
    });
    throw err;
  }
}
