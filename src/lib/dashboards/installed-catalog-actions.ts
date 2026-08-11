"use server";
/**
 * Concept B's ONE server action (cinatra#2474 PR5) — the first and only
 * client-reachable entry point the installed catalog has.
 *
 * A `"use server"` module may export ONLY async functions, so this file is a
 * deliberately empty shell: the surface descriptor type, the result type and the
 * refusal vocabulary live in `installed-catalog-contract.ts`, and every gate and
 * decision lives in `installed-catalog-write.ts`. Keeping the action itself this
 * thin means the client boundary carries no logic that could drift from the
 * logic the tests drive.
 *
 * ── THE SURFACE IS BOUND, NOT SENT ─────────────────────────────────────────
 * `buildScopeCatalogNode` binds `surface` server-side (Next encrypts bound
 * arguments), so the browser never authors a scope, a tenant or a destination —
 * it sends one opaque template handle. The binding is capability MINIMIZATION,
 * never the authorization: the write re-derives the destination from the LIVE
 * session's own principal and refuses a descriptor that names anyone else's
 * collection, so a replayed bound reference gains nothing.
 *
 * The actor is resolved HERE from the live session — never threaded from the
 * render that produced the list.
 */
import { getActorContext } from "@/lib/auth-session";

import type {
  CatalogAddResult,
  CatalogSurface,
} from "./installed-catalog-contract";
import { addInstalledCatalogDashboard } from "./installed-catalog-write";

/**
 * Copy one installed-catalog dashboard template into the acting user's own
 * collection for the bound surface. Returns a typed result; never throws a
 * refusal into the client.
 */
export async function addInstalledCatalogDashboardAction(
  surface: CatalogSurface,
  templateId: string,
): Promise<CatalogAddResult> {
  const actor = await getActorContext();
  if (!actor) return { ok: false, reason: "ineligible" };
  return addInstalledCatalogDashboard({ actor, surface, templateId });
}
