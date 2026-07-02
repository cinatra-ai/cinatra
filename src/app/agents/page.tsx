import type { Metadata } from "next";
import { AgentsDashboardPage } from "@cinatra-ai/dashboards/screens";
import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions/canonical-store";

export const metadata: Metadata = { title: "Agents" };

// /agents is the dashboard with top-5-recently-used and 5-latest widgets.
// It is the installed-agents surface.
//
// The dashboards package can't read the canonical install manifest itself:
// that access is reserved to the canonical store in
// @cinatra-ai/extensions (drift-canonical-gate-reach), and importing that
// package from dashboards would close a real dependency cycle
// (extensions -> workflows -> dashboards) the workspace-dep-cycles gate forbids.
// So this route — which already depends on @cinatra-ai/extensions — injects the
// canonical reader into the screen. The screen defaults every agent to "active"
// when no resolver is supplied.
export default function Page() {
  return <AgentsDashboardPage resolveInstallStatus={readEffectiveStatusByPackageNames} />;
}
