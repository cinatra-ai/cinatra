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
    const candidates = resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });
    const slotMeta = buildSlotMeta(slot);
    const selectedRefs = computeRouteSelectedRefs(candidates, slot);
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
