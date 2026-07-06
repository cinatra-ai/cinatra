import type { Metadata } from "next";
import { AgentsDashboardPage } from "@cinatra-ai/dashboards/screens";

export const metadata: Metadata = { title: "Agents · Executions" };

// /agents/executions is the "Executions" tab — the dashboard
// (top-5-recently-used + 5-latest-run widgets) that used to live at the bare
// /agents (cinatra#1007). No redirect from the old /agents: that route now
// serves the "All Agents" run-agent picker instead (moved from the former
// /agents/run — see src/app/agents/page.tsx).
//
// The "Installed agents" card (a separate, org-scoped agent-templates list)
// was removed in cinatra#984 — it duplicated the marketplace/creation entry
// points and its canonical-install-status plumbing (resolveInstallStatus,
// previously injected here from @cinatra-ai/extensions per
// drift-canonical-gate-reach) is now dead with it. Install remains at
// /configuration/marketplace; creation remains via the "Create agent" action
// above (and on /agents's own "Create agent" action).
export default function Page() {
  return <AgentsDashboardPage />;
}
