"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

type MetricApiNavProps = {
  activeTab: "costs" | "usage" | "traces";
};

export function MetricApiNav({ activeTab }: MetricApiNavProps) {
  return (
    <div className="mx-auto mb-4 w-full max-w-7xl px-5 sm:px-8 lg:px-0">
      <Tabs value={activeTab}>
        <TabsListRow>
          <TabsTrigger value="costs" asChild>
            <Link href="/analytics/llm">Costs</Link>
          </TabsTrigger>
          <TabsTrigger value="usage" asChild>
            <Link href="/analytics/llm-usage">Usage</Link>
          </TabsTrigger>
          <TabsTrigger value="traces" asChild>
            <Link href="/analytics/api">API Requests</Link>
          </TabsTrigger>
        </TabsListRow>
      </Tabs>
    </div>
  );
}
