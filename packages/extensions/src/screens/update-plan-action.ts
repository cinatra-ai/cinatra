"use server";

// ---------------------------------------------------------------------------
// §II detail-modal footer DRY-RUN action (cinatra#1041 outcome 2).
//
// Deliberately its OWN "use server" module (NOT ../actions): the dry-run is a
// SCREENS-ONLY server action — only the §VI Installed page and the Marketplace
// browse modal bind it. ../actions is reachable from the MCP / A2A / LLM-bridge
// dispatch surfaces, and homing this action there would grow those locked
// route graphs (route-graph ratchet) for an action they can never invoke.
//
// Computes the concrete update plan — direct update, shared-dep dedupe-upward
// upgrades, new-dependency installs, side-by-side installs, dependents
// rebound — WITHOUT writing anything, so an admin confirms the plan before the
// apply runs through the SAME planner/batch path
// (`updateExtensionPackageFormAction`). Admin-gated like every lifecycle
// action. Failures follow the #685 contract: the client receives ONLY the
// classified category; the raw reason (guard refusals included) stays in the
// operator log.
// ---------------------------------------------------------------------------

import { requireAdminSession } from "@/lib/auth-session";
import {
  classifyMarketplaceFailure,
  type MarketplaceFailureCategory,
} from "./marketplace-failure-copy";
import type { PlanExtensionUpdateResult } from "./update-plan-model";

// Operator-side failure logging (cinatra#685) — same CWE-134-safe
// constant-format-string discipline as ../actions (private sync helpers are
// fine in a "use server" module; only EXPORTS must be async).
function logUpdatePlanFailureForOperator(
  packageName: string,
  category: MarketplaceFailureCategory,
  err: unknown,
): void {
  console.error(
    "[marketplace-install] update-plan failed for %s (category=%s):",
    packageName,
    category,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

export async function planExtensionUpdateFormAction(input: {
  packageName: string;
  /** Explicit target (the marketplace modal's catalog version); absent → the
   *  cached update read model's latest. */
  targetVersion?: string;
}): Promise<PlanExtensionUpdateResult> {
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  try {
    // Dynamic import: @/lib is the host (mirrors the ../actions lifecycle
    // dispatchers' dynamic host imports).
    const { computeExtensionUpdatePlanPreview, UpdatePlanRefusal } = await import(
      "@/lib/extension-update-plan-preview"
    );
    try {
      const plan = await computeExtensionUpdatePlanPreview({
        packageName: input.packageName,
        ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
        orgId,
      });
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof UpdatePlanRefusal) {
        logUpdatePlanFailureForOperator(input.packageName, err.category, err);
        return { ok: false, category: err.category };
      }
      throw err;
    }
  } catch (err) {
    // Classify from the real error object (cinatra#685) — raw detail stays
    // server-side; only the category crosses to the client.
    const category = classifyMarketplaceFailure(err);
    logUpdatePlanFailureForOperator(input.packageName, category, err);
    return { ok: false, category };
  }
}
