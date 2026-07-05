import { redirect } from "next/navigation";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";

export const dynamic = "force-dynamic";

// Redirect shell (cinatra#977, same pattern as ../drupal/page.tsx). The
// resend-connector registers NO setup surface today (no connectors-catalog
// descriptor, manifest `uiSurface: null`), so the manifest-resolved dispatch
// href is `null` and this mount lands on the GENERIC email-provider surface
// (`/connectors/email`), which lists Resend with its live status. The moment
// the connector registers a setup surface (catalog descriptor +
// schema-config/bundled-react page), the dispatch href resolves and this
// shell forwards there instead — no core change needed. The vendor-specific
// config form this mount used to render is connector-owned residue tracked on
// the boundary epic (cinatra#978 / #975); env-based configuration
// (RESEND_API_KEY et al.) is unaffected.
export default function Page() {
  redirect(getConnectorSetupHref("resend-connector") ?? "/connectors/email");
}
