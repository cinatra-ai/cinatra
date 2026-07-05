import { notFound, redirect } from "next/navigation";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";

export const dynamic = "force-dynamic";

// The WordPress connector settings render through the GENERIC connector
// dispatch route (`/connectors/[vendor]/[slug]/[subroute]`), which builds the
// grant-aware host ctx + applies the connector-policy gate without core naming
// the connector; the connector-owned settings page (Nango connect card +
// instance list + manage-gated delete) carries the vendor specifics. This
// legacy mount redirects there; the target is resolved from the connector's
// manifest identity, not a hardcoded route literal. (Same shell as
// ../drupal/page.tsx — cinatra#977.)
export default function Page() {
  const href = getConnectorSetupHref("wordpress-mcp-connector");
  if (!href) notFound();
  redirect(href);
}
