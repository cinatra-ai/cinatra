import "server-only";

import { z } from "zod";
import { NextResponse } from "next/server";
import {
  parseUserResponseEnvelope,
  revalidateSelectedRefs,
  buildSelectionRows,
  canonicalizeTriples,
  ContextRouteError,
} from "@/lib/artifacts/context-route-support";
import {
  deriveContextRouteContext,
  loadTrustedSlot,
  resolveCandidates,
  type DerivedContext,
} from "@/lib/artifacts/context-route-io";
import {
  effectiveSelectionMode,
  resolveInheritedContextSelection,
} from "@/lib/artifacts/context-repair-inheritance";
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

    // Re-resolve the trusted candidate set FIRST: the mode this run actually
    // ran the slot in is decided from server-read facts, and one of them —
    // whether a repair's inherited answer still resolves — is a reading of
    // that set. Re-ordering a pure read changes nothing else.
    const candidates = await resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });

    // Trusted modes come from the SLOT, not the body/envelope — except that a
    // repair inheriting its own producing run's answered screen runs the slot
    // in the flow's no-person mode (cinatra#3080). `/api/context-resolve`
    // derives that mode from the SAME server-read facts through the SAME
    // helper, so the value the flow carried here can be checked against it
    // exactly as the declared mode always was: a body claiming `autonomous`
    // for an ordinary interactive slot is still refused, because nothing a
    // caller can say makes this run a repair with a stored answer.
    const inherited = resolveInheritedContextSelection({
      run: ctx.run,
      slotId: body.slotId,
      // Same scoping as `/api/context-resolve`, and the same value the audit
      // rows below are written under.
      parentPackageName: ctx.trustedPackageName,
      candidates,
      slotMinItems: typeof slot.minItems === "number" ? slot.minItems : 0,
      // The slot's own declared mode, so an inherited EMPTY answer records the
      // provenance it actually had rather than asserting a person.
      declaredSelectionMode: slot.selectionMode,
    });
    const selectionMode = effectiveSelectionMode(slot.selectionMode, inherited);
    if (body.selectionMode !== selectionMode) {
      throw new ContextRouteError(
        422,
        "selection_mode_mismatch",
        `body selectionMode '${body.selectionMode}' != slot '${selectionMode}'`,
      );
    }

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
    // AN INHERITED SELECTION IS THE INHERITED SELECTION. The child flow's
    // autonomous node builds its envelope out of the very `selectedRefs` the
    // resolve returned, so on the honest road these are equal by construction.
    // Checking it is what stops the `autonomous` branch from being steerable:
    // without this, anything able to reach the route with the repair run's
    // binding could submit ANY other member of the trusted candidate set and
    // have it written as the repair's context under the producing run's
    // provenance. The refs are compared as canonical triples — the same
    // identity the audit row is content-addressed by.
    if (inherited) {
      const submittedKeys = canonicalizeTriples(trusted);
      const inheritedKeys = canonicalizeTriples(inherited.refs);
      if (
        submittedKeys.length !== inheritedKeys.length ||
        submittedKeys.some((key, i) => key !== inheritedKeys[i])
      ) {
        throw new ContextRouteError(
          422,
          "inherited_selection_mismatch",
          `submitted ${submittedKeys.length} refs != the ${inheritedKeys.length} the producing run answered`,
        );
      }
    }
    const rows = buildSelectionRows({
      orgId: ctx.run.orgId!,
      parentRunId: ctx.run.id,
      parentPackageName: ctx.trustedPackageName,
      slotId: body.slotId,
      selectionMode,
      trusted,
      // An inherited pick ran with no person in THIS run, but SOMEONE made it
      // on the producing run — so the audit row repeats VERBATIM what that
      // run's own row said about who chose. A person's pick stays a person's;
      // a resolver's pick is never promoted to a person's.
      ...(inherited ? { selectedBy: inherited.selectedBy } : {}),
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
