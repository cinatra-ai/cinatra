"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

export type AgentInstanceNavProps = {
  agentId: string;
  instanceId: string;
  activeTab: "setup" | "overview" | "run" | "trigger" | "permissions";
  /**
   * When true, renders the Setup tab as the first trigger.
   * Classic static agents leave this unset, preserving the existing
   * Overview-at-root URL structure. When includeSetupTab=true, the Overview
   * trigger is omitted entirely — the builder workspace uses Setup/Trigger/Permissions.
   */
  includeSetupTab?: boolean;
  /**
   * When true, renders the Trigger tab.
   * Only shown when agent_run_triggers row exists AND triggerType IN ('scheduled','recurring').
   * Hidden for immediate runs, unstarted runs, and runs with no trigger configured.
   */
  showTriggerTab?: boolean;
};

export function AgentInstanceNav({ agentId, instanceId, activeTab, includeSetupTab = false, showTriggerTab = false }: AgentInstanceNavProps) {
  // agentId may be "vendor/packageName" (new package-name routing) — split and
  // encode each segment separately so the slash is preserved as a path separator.
  const agentPath = agentId.includes("/")
    ? agentId.split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(agentId);
  const base = `/agents/${agentPath}/${encodeURIComponent(instanceId)}`;

  return (
    <Tabs value={activeTab}>
      <TabsListRow>
        {includeSetupTab ? (
          <TabsTrigger value="setup" asChild>
            <Link href={base}>Setup</Link>
          </TabsTrigger>
        ) : (
          <TabsTrigger value="overview" asChild>
            <Link href={base}>Overview</Link>
          </TabsTrigger>
        )}

        {showTriggerTab && (
          <TabsTrigger value="trigger" asChild>
            <Link href={`${base}/trigger`}>Trigger</Link>
          </TabsTrigger>
        )}
        <TabsTrigger value="permissions" asChild>
          <Link href={`${base}/permissions`}>Permissions</Link>
        </TabsTrigger>
      </TabsListRow>
    </Tabs>
  );
}
