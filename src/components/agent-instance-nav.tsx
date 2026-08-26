"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

export type AgentInstanceNavProps = {
  agentId: string;
  instanceId: string;
  /**
   * cinatra#2487: the "overview" member is gone. `AgentPageLayout` was the only
   * consumer of this component and it always passed `includeSetupTab`, so the
   * Overview trigger could never render and no caller ever passed
   * `activeTab="overview"`. The prop and its dead branch are removed with it —
   * the agent workspace is Setup / Trigger / Permissions.
   */
  activeTab: "setup" | "run" | "trigger" | "permissions";
  /**
   * When true, renders the Trigger tab.
   * Only shown when agent_run_triggers row exists AND triggerType IN ('scheduled','recurring')
   * — `shouldShowPersistentTab` in instance-screens.tsx is the single predicate,
   * and EVERY route that mounts this shell computes it the same way so the strip
   * does not change between tabs (Application Design — Agents §I).
   * Hidden for immediate runs, unstarted runs, and runs with no trigger configured.
   */
  showTriggerTab?: boolean;
};

export function AgentInstanceNav({ agentId, instanceId, activeTab, showTriggerTab = false }: AgentInstanceNavProps) {
  // agentId may be "vendor/packageName" (new package-name routing) — split and
  // encode each segment separately so the slash is preserved as a path separator.
  const agentPath = agentId.includes("/")
    ? agentId.split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(agentId);
  const base = `/agents/${agentPath}/${encodeURIComponent(instanceId)}`;

  // Application Design — Agents §I: the strip is part of the constant frame, so
  // the SAME run must offer the SAME tabs on EVERY route — otherwise the
  // Permissions trigger, and with it the etched rule's start point, move when
  // you switch tabs.
  //
  // The strip is therefore a pure function of `showTriggerTab` and NOTHING
  // else. In particular it must never fall back to `activeTab` to force a tab
  // into view: that would make /trigger show a tab /setup and /permissions hide
  // for the same run, which is exactly the shift this component is fixing.
  // Callers MUST pass the same predicate (`shouldShowPersistentTab`) on every
  // route.
  return (
    <Tabs value={activeTab}>
      <TabsListRow>
        <TabsTrigger value="setup" asChild>
          <Link href={base}>Setup</Link>
        </TabsTrigger>

        {/* THE TAB IS NAMED FOR WHAT IT SHOWS (cinatra#3004): the schedule
            form, in the state this run's schedule is in. The route keeps its
            path — a person's bookmark still opens the same surface — and only
            the word a reader sees changes, because "trigger" is not a word this
            surface uses any more. */}
        {showTriggerTab && (
          <TabsTrigger value="trigger" asChild>
            <Link href={`${base}/trigger`}>Schedule</Link>
          </TabsTrigger>
        )}
        <TabsTrigger value="permissions" asChild>
          <Link href={`${base}/permissions`}>Permissions</Link>
        </TabsTrigger>
      </TabsListRow>
    </Tabs>
  );
}
