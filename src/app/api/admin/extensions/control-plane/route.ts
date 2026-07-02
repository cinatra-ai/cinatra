/**
 * Operator-visible diagnostic endpoint for the extension activation CONTROL PLANE
 * (engineering #310).
 *
 * GET /api/admin/extensions/control-plane
 *   -> {
 *        scope: "process-local",
 *        generation: number,
 *        lastTransitions: [{ generation, reason, packageName?, at }],
 *        mcpTools: [{ name, packageName }],
 *        capabilityProviders: [{ capability, packageName }],
 *        uiSurfaces: [{ packageName, setupSurfaces, settingsSurfaces, actionIds }],
 *        objectTypes: [{ type, category? }],
 *      }
 *
 * Lets an operator inspect the live extension activation/capability state of THIS
 * process: the control-plane generation (the invalidation key the in-process
 * caches consult), the recent lifecycle transitions, and what is currently
 * registered.
 *
 * ISOLATION + SAFETY:
 *  - Admin-gated (`requireAdminSession()` — Better-Auth `admin` role; redirects a
 *    non-admin). Platform-admin only.
 *  - Read-only: aggregates in-memory registries only — no DB, no secrets, no
 *    handlers/impls/payloads/descriptors/source paths. Names / ids / counts only.
 *  - PROCESS-LOCAL: reflects THIS node's in-memory state, not a cluster-wide truth
 *    (`scope: "process-local"` makes that explicit to the reader).
 *  - `force-dynamic` + `no-store`: the state is live and per-process; never cache it.
 */

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-session";
import { getExtensionControlPlaneState } from "@/lib/extension-control-plane";

// Live, per-process diagnostic state — never statically rendered or cached.
export const dynamic = "force-dynamic";

export async function GET() {
  await requireAdminSession();
  const state = getExtensionControlPlaneState();
  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  });
}
