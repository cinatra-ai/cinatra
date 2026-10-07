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
  type DerivedContext,
} from "@/lib/artifacts/context-route-io";
import {
  extractContextRouteLogIds,
  recordContextRouteRejection,
  recordContextRouteSuccess,
} from "@/lib/artifacts/context-route-observability";
import { planAllocationForGate } from "@/lib/artifacts/context-allocation-gate";
import { allocationForSlot } from "@/lib/artifacts/context-allocation-planner";
import {
  finalizeContextSelectionPinsAtomic,
  MissingRepresentationError,
  SelectionCoherenceError,
} from "@/lib/artifacts/context-selection-finalize";
import { ensureArtifactTypesRegistered } from "@/lib/artifacts/ensure-artifact-registry";

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
  // cinatra#2815 S3 part (3): the ContextAllocationTokenV1 /api/context-resolve
  // returned for THIS gate, carried by the renderer. Optional ON THE WIRE only
  // so a caller that omits it is refused with a reason it can act on rather
  // than a shapeless body error; it is REQUIRED (see the refusal below).
  // An EMPTY string — what a subflow renders when resolve could not plan and
  // returned no token — reads as absent too, so it reaches that same actionable
  // refusal instead of failing here as `invalid_body` (cinatra#3692).
  allocationToken: z.string().optional(),
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

    // cinatra#2815 S3 part (3): THE DRIFT GATE, and the ALLOCATION this
    // finalize is allowed to write.
    //
    // THE TOKEN IS REQUIRED. It was optional while a renderer that had not yet
    // rolled still had to finalize, and that optionality WAS the hole: a caller
    // could skip the whole gate by omitting one field, which is precisely the
    // pre-cutover compatibility this platform does not keep before its first
    // stable release. A finalize with no token is refused, in its own stable
    // code, so an operator reads "this caller is not carrying the token" rather
    // than a shapeless body error.
    if (!body.allocationToken) {
      throw new ContextRouteError(
        422,
        "allocation_token_required",
        "finalize requires the allocationToken /api/context-resolve returned for this gate",
      );
    }

    // Recomputed FRESH, never from the gate memo: the human has answered since
    // the gate was drawn, and an allocation replayed from a cache could not
    // show that the world moved underneath them. A plan that cannot be computed
    // refuses with its own stable code, distinct from the drift itself, so an
    // operator can tell a moved world from a broken read.
    let gate: Awaited<ReturnType<typeof planAllocationForGate>>;
    try {
      gate = await planAllocationForGate(
        {
          actor: ctx.actor,
          runId: ctx.run.id,
          trustedSlotPackageName: ctx.trustedSlotPackageName,
          projectId: ctx.projectId,
        },
        { fresh: true },
      );
    } catch (err) {
      throw new ContextRouteError(
        409,
        "allocation_unavailable",
        `the manifest-wide allocation could not be recomputed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (gate.token !== body.allocationToken) {
      throw new ContextRouteError(
        409,
        "allocation_drift",
        `context allocation drifted: the gate was drawn for ` +
          `${body.allocationToken} and now plans ${gate.token}`,
      );
    }

    // THE SUBMISSION IS VALIDATED AGAINST THE ALLOCATION, NOT THE POOL.
    //
    // This used to re-resolve the slot's candidates and accept any submitted
    // ref that appeared among them. That is a WIDER set than the planner
    // allocated: an override slot resolves several candidates and is allocated
    // exactly one, and a ref the cross-slot dedupe removed is still in the
    // second slot's pool. So a selection the planner never made could be
    // written, with a matching token, because the token proved the allocation
    // and nothing then enforced it.
    //
    // The allocation the token names IS the trusted set. One authority, and the
    // token now means what it says.
    const allocated = allocationForSlot(gate.allocation, body.slotId);
    if (!allocated) {
      throw new ContextRouteError(
        422,
        "slot_not_allocated",
        `slot '${body.slotId}' received no allocation in the manifest this gate planned`,
      );
    }
    const trusted = revalidateSelectedRefs({
      submitted: envelope.selectedRefs,
      candidates: allocated.refs,
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
    // epic #1785 wave A4: warm the object-type registry before finalize. The
    // finalizer is a sync store-leaf (it cannot import the heavy registrar), so
    // its coherence gate reads the in-process artifact-type set as-is; warming
    // HERE guarantees a NON-CLAIMED pack-typed selection is admitted even on a
    // cold process that never ran a resolve first.
    ensureArtifactTypesRegistered();
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
