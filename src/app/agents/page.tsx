import type { Metadata } from "next";
import { AgentsDashboardPage } from "@cinatra-ai/dashboards/screens";

export const metadata: Metadata = { title: "Agents" };

// /agents is the dashboard with top-5-recently-used and 5-latest widgets.
//
// The "Installed agents" card (a separate, org-scoped agent-templates list)
// was removed in cinatra#984 — it duplicated the marketplace/creation entry
// points and its canonical-install-status plumbing (resolveInstallStatus,
// injected here from @cinatra-ai/extensions per drift-canonical-gate-reach)
// is now dead with it. Install remains at /configuration/marketplace;
// creation remains on /agents via the "Create agent" action above.
export default function Page() {
  return <AgentsDashboardPage />;
}
