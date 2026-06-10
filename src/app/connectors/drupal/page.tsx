import { notFound, redirect } from "next/navigation";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";

export const dynamic = "force-dynamic";

// The Drupal connector settings render through the GENERIC connector
// dispatch route (`/connectors/[vendor]/[slug]/[subroute]`), which builds the
// grant-aware host ctx + applies the connector-policy gate without core naming
// the connector. This legacy mount redirects there; the target is resolved
// from the connector's manifest identity, not a hardcoded route literal.
export default function Page() {
  const href = getConnectorSetupHref("drupal-mcp-connector");
  if (!href) notFound();
  redirect(href);
}
