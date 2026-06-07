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
} from "@/lib/artifacts/context-route-io";

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
  const raw = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const ctx = await deriveContextRouteContext(req, parsed.data);
    // Use the TRUSTED package name (from the run's template), never the body.
    const slot = await loadTrustedSlot(ctx.trustedPackageName, parsed.data.slotId);
    const candidates = resolveCandidates({
      actor: ctx.actor,
      slot,
      projectId: ctx.projectId,
    });
    const slotMeta = buildSlotMeta(slot);
    const selectedRefs = computeRouteSelectedRefs(candidates, slot);
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
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    throw err;
  }
}
