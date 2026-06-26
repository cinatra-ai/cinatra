"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { ANALYTICS_NAV, type AnalyticsTabValue } from "@/lib/section-nav";

type MetricApiNavProps = {
  activeTab: AnalyticsTabValue;
};

// Tabs render from the shared ANALYTICS_NAV config (#493) — the same list drives
// the sidebar sub-items, so their labels and targets stay in lockstep.
export function MetricApiNav({ activeTab }: MetricApiNavProps) {
  return (
    <div className="mx-auto mb-4 w-full max-w-7xl px-5 sm:px-8 lg:px-0">
      <Tabs value={activeTab}>
        <TabsListRow>
          {ANALYTICS_NAV.map((item) => (
            <TabsTrigger key={item.value} value={item.value} asChild>
              <Link href={item.href}>{item.label}</Link>
            </TabsTrigger>
          ))}
        </TabsListRow>
      </Tabs>
    </div>
  );
}
