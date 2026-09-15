"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { AGENTS_NAV, type AgentsTabValue } from "@/lib/agents-nav";

type AgentsTabNavProps = {
  activeTab: AgentsTabValue;
  /**
   * cinatra#3228 — true when the view mounts a Toolbar directly beneath this
   * strip. The drawing (components reference, Toolbar): "The toolbar sits
   * directly below the page header and replaces the section rule for that
   * view — never stack a toolbar and the etched paired rule." So the strip
   * keeps its tabs and stops drawing its trailing rule; the toolbar takes the
   * position directly under it. Both the All Agents list and the Executions
   * dashboard mount a toolbar and pass this; a view with no toolbar (the All
   * Agents empty state, the Reviews tab) keeps the rule.
   */
  toolbarBelow?: boolean;
};

// Route-based tab bar shown on BOTH /agents (All Agents) and
// /agents/executions (Executions) — cinatra#1007. Mirrors the established
// MetricApiNav pattern (src/components/metric-api-nav.tsx): tabs render from
// the shared AGENTS_NAV config, each TabsTrigger wraps a real <Link> (a full
// route navigation, not client-side tab state), and TabsListRow's trailing
// rule replaces the section rule a bare <PageHeader> would otherwise draw —
// pair with `<PageHeader divider={false}>` on both routes (design-system.html
// §Dividers; same pairing MetricApiNav already uses on /analytics/llm*).
export function AgentsTabNav({ activeTab, toolbarBelow = false }: AgentsTabNavProps) {
  return (
    <div data-slot="agents-tab-nav" className="mx-auto mb-4 w-full max-w-7xl px-5 sm:px-8 lg:px-0">
      <Tabs value={activeTab}>
        <TabsListRow trailingRule={!toolbarBelow}>
          {AGENTS_NAV.map((item) => (
            <TabsTrigger key={item.value} value={item.value} asChild>
              <Link href={item.href}>{item.label}</Link>
            </TabsTrigger>
          ))}
        </TabsListRow>
      </Tabs>
    </div>
  );
}
