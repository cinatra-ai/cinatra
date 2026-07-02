"use server";

import { requireAdminSession } from "@/lib/auth-session";
import { loadPublicMarketplaceDetail } from "@/lib/marketplace-browse";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";

/**
 * Load the public marketplace detail for the in-app extension-detail modal
 * (opened from the browse card's "More details"). Admin-gated (the modal is an
 * admin-only surface), then delegates to the server-only marketplace-browse
 * fetch+project seam. Returns a discriminated result so the client modal renders
 * content / not-found / error without a thrown, production-masked crash. The
 * scoped-name validation lives in the loader; an invalid name → not_found.
 *
 * Lives in app-src (not the reusable @cinatra-ai/extensions package) because it
 * bridges the SERVER-ONLY marketplace-browse seam into the modal; keeping it here
 * means the extensions package carries no app-server dependency.
 */
export async function getPublicMarketplaceDetailAction(
  packageName: string,
): Promise<MarketplaceDetailLoadResult> {
  await requireAdminSession();
  return loadPublicMarketplaceDetail(packageName);
}
