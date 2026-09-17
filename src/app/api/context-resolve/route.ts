import "server-only";

import { z } from "zod";
import { NextResponse } from "next/server";
import {
  buildSlotMeta,
  computeRouteSelectedRefs,
  ContextRouteError,
} from "@/lib/artifacts/context-route-support";
import {
  deriveContextRouteContext,
  loadTrustedSlot,
  resolveCandidates,
  type DerivedContext,
} from "@/lib/artifacts/context-route-io";
import {
  planAllocationForGate,
  type GateAllocation,
} from "@/lib/artifacts/context-allocation-gate";
import { allocationForSlot } from "@/lib/artifacts/context-allocation-planner";
import {
  extractContextRouteLogIds,
  recordContextRouteRejection,
  recordContextRouteSuccess,
} from "@/lib/artifacts/context-route-observability";

// ---------------------------------------------------------------------------
// POST /api/context-resolve
//
// Called by the context-selection-agent subflow's resolve_context ApiNode.
// Derives actor/org/run server-side (reuses the /api/llm-bridge auth pattern),
// loads the slot from the TRUSTED on-disk OAS, resolves eligible candidates,
// and returns { candidates, slotMeta, selectedRefs, selectionMode, resolutionMode }
// — the last two are top-level mirrors of slotMeta required by the context-
// selection-agent OAS (BranchingNode + finalize_* DFE-bind both fields).
// ---------------------------------------------------------------------------

const RequestSchema = z.object({
  parentRunId: z.string().min(1),
  parentPackageName: z.string().min(1),
  slotId: z.string().min(1),
  projectId: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  // #1197 observability: identifiers only (ids + stable codes) — never
  // payloads. The a2a context-id header is the legacy trusted run binding.
  const contextId = req.headers.get("x-cinatra-a2a-context-id");
  const raw = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    const ids = extractContextRouteLogIds(raw);
    recordContextRouteRejection({
      kind: "resolve",
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
  // Tracked outside the try so the rejection line can carry the SERVER-derived
  // run id once derivation has succeeded (falls back to the body id before).
  let ctx: DerivedContext | undefined;
  try {
    ctx = await deriveContextRouteContext(req, parsed.data, "resolve");
    // Load the slot from the VERIFIED owner (the run package, or the composed
    // child that the run package's own OAS binds to this slotId), never the body.
    const slot = await loadTrustedSlot(
      ctx.trustedSlotPackageName,
      parsed.data.slotId,
    );
    const candidates = await resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });
    const slotMeta = buildSlotMeta(slot);
    const selectedRefs = computeRouteSelectedRefs(candidates, slot);
    // cinatra#2815 S3 part (3): the MANIFEST-WIDE allocation this gate is
    // drawn against, content-addressed into a ContextAllocationTokenV1. The
    // renderer carries the token back to /api/context-finalize, which
    // recomputes the same payload and refuses a drifted write.
    //
    // BEST-EFFORT HERE, FAIL-CLOSED THERE. The per-slot contract above is
    // exactly as it landed and does not depend on the planner, so a manifest
    // that cannot be planned (an OAS that went unreadable, a resolver fault on
    // a sibling slot) still serves this slot's gate — it simply serves no
    // token, and a finalize that carries none is the pre-#2815 path unchanged.
    let gate: GateAllocation | null = null;
    try {
      gate = await planAllocationForGate({
        actor: ctx.actor,
        runId: ctx.run.id,
        trustedSlotPackageName: ctx.trustedSlotPackageName,
        projectId: ctx.projectId,
      });
    } catch {
      gate = null;
    }
    const plannedRefs = gate
      ? (allocationForSlot(gate.allocation, parsed.data.slotId)?.refs ?? [])
      : [];
    // #1197: debug-level lifecycle trace + per-kind ok counter.
    recordContextRouteSuccess({
      kind: "resolve",
      servedBy: ctx.servedBy,
      runId: ctx.run.id,
      contextId,
      slotId: parsed.data.slotId,
    });
    // Top-level `selectionMode` + `resolutionMode` are required by the
    // context-selection-agent OAS: select_mode (BranchingNode) routes on
    // `selectionMode`, and finalize_interactive + finalize_autonomous DFE
    // both fields into their data payloads. They are derived from the trusted
    // slot loaded server-side (slotMeta), not from request input.
    return NextResponse.json({
      candidates,
      slotMeta,
      selectedRefs,
      selectionMode: slotMeta.selectionMode,
      resolutionMode: slotMeta.resolutionMode,
      // Additive (cinatra#2815 S3 part 3). `allocationToken` is what finalize
      // compares; `plannedRefs` is what this slot was allocated by the one
      // manifest-wide plan, so a renderer can show the planned set beside the
      // per-slot candidates. Both are absent when the manifest could not be
      // planned — never a guessed value.
      ...(gate
        ? {
            allocationToken: gate.token,
            plannedRefs,
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ContextRouteError) {
      // #1197: EVERY stable-code rejection is counted + logged (ids only).
      recordContextRouteRejection({
        kind: "resolve",
        code: err.code,
        status: err.status,
        runId: ctx?.run.id ?? parsed.data.parentRunId,
        contextId,
        slotId: parsed.data.slotId,
      });
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    // #1197: an unexpected crash lands in a stable bucket too, then rethrows.
    recordContextRouteRejection({
      kind: "resolve",
      code: "internal_error",
      status: 500,
      runId: ctx?.run.id ?? parsed.data.parentRunId,
      contextId,
      slotId: parsed.data.slotId,
    });
    throw err;
  }
}
