import { redirect } from "next/navigation";

import { requireAdminSession } from "@/lib/auth-session";

/**
 * RETIRED — the in-app extension-detail PAGE (cinatra#2736).
 *
 * Owner ruling (2026-08-14): such a page is not supposed to exist inside the
 * app at all. Inside Cinatra the ONLY extension-detail surface is the §II
 * "More details" modal, which opens from a listing card and never from a URL;
 * the one LINKABLE detail view is the storefront listing on the marketplace
 * itself. So this route no longer renders a detail surface of any kind — it
 * sends old in-app URLs to the in-app marketplace grid, PLAIN: no query and no
 * fragment, because a URL that auto-opened the modal would itself be the
 * linkable in-app detail view the ruling excludes.
 *
 * Everything the route used to do before rendering — the package-name
 * validation, the public storefront detail read, the visibility fail-closed,
 * the per-kind branch — went with the surface it guarded: there is nothing
 * left on this path to read a package for. The route's pre-existing admin gate
 * stays, so the retirement changes who may follow this URL not at all.
 */
export default async function RetiredExtensionMarketplaceEntryPage() {
  await requireAdminSession();
  redirect("/configuration/marketplace");
}
