"use server";

import { requireAdminSession, requireAuthSession } from "@/lib/auth-session";
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

/**
 * Member-gated variant of {@link getPublicMarketplaceDetailAction} for the
 * §V modal when it is opened from an AGENT CARD on /agents (cinatra#1016,
 * design#25 §VIII — owner ruling 2026-07-06: "the same access rules for the
 * respective agent also apply to the more details link and modal — who can't
 * see the agent, also won't see the card").
 *
 * ACCESS-CONSISTENCY (the owner's core point): /agents is session-gated for
 * ANY signed-in member (it is NOT admin-gated — NewAgentPage calls no
 * requireAdminSession), so a member who can already see an agent card must be
 * able to open its "More details" modal. Gating the loader at
 * requireAdminSession() (as the browse/installed surfaces do) would bounce
 * that member to /not-authorized — a STRICTER gate than the card itself. This
 * action gates at requireAuthSession() — the SAME member floor as /agents — so
 * the modal path never imposes a separate, stricter gate than the card.
 *
 * NOT a weakening of the admin surfaces: this is a DISTINCT action, only wired
 * from the agent card; the marketplace-browse and §VI Installed-extensions
 * modals keep the admin-gated getPublicMarketplaceDetailAction unchanged. The
 * data returned is TRULY PUBLIC storefront listing detail —
 * loadPublicMarketplaceDetail enforces `currentVisibility === "public"` (a
 * non-public listing → not_found), so exposing it to a signed-in member (who
 * already sees the agent's name/description on their /agents card) reveals no
 * tenant/admin/private data. Converged read-only with codex (verdict: AGREE;
 * second explicit action is the top-ranked option; the public-visibility floor
 * satisfies its one caveat).
 */
export async function getAgentMarketplaceDetailAction(
  packageName: string,
): Promise<MarketplaceDetailLoadResult> {
  await requireAuthSession();
  return loadPublicMarketplaceDetail(packageName);
}
