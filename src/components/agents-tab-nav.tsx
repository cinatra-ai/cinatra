"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { AGENTS_NAV, type AgentsTabValue } from "@/lib/agents-nav";

type AgentsTabNavProps = {
  activeTab: AgentsTabValue;
};

// Route-based tab bar shown on BOTH /agents (All Agents) and
// /agents/executions (Executions) — cinatra#1007. Mirrors the established
// MetricApiNav pattern (src/components/metric-api-nav.tsx): tabs render from
// the shared AGENTS_NAV config, each TabsTrigger wraps a real <Link> (a full
// route navigation, not client-side tab state), and TabsListRow's trailing
// rule replaces the section rule a bare <PageHeader> would otherwise draw —
// pair with `<PageHeader divider={false}>` on both routes (design-system.html
// §Dividers; same pairing MetricApiNav already uses on /analytics/llm*).
export function AgentsTabNav({ activeTab }: AgentsTabNavProps) {
  return (
    <div className="mx-auto mb-4 w-full max-w-7xl px-5 sm:px-8 lg:px-0">
      <Tabs value={activeTab}>
        <TabsListRow>
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
