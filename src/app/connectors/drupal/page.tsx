import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The Drupal connector settings now render through the GENERIC connector
// dispatch route (`/connectors/[vendor]/[slug]/[subroute]`), which builds the
// grant-aware host ctx + applies the connector-policy gate without core naming
// the connector. This legacy mount redirects there so cinatra core no longer
// statically imports/names the connector (IoC — core-extension instance-coupling
// gate). The redirect target is a public route URL (slug), not a package import.
export default function Page() {
  redirect("/connectors/cinatra-ai/drupal-mcp-connector/setup");
}
