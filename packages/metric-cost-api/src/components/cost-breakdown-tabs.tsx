"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CostByProviderRow, CostByAgentRow, CostBySkillRow, LegacyCostEntry } from "../store";
import { CostByProviderTable } from "./cost-by-provider-table";
import { CostByAgentTable } from "./cost-by-agent-table";
import { CostBySkillTable } from "./cost-by-skill-table";

type CostBreakdownTabsProps = {
  byProvider: CostByProviderRow[];
  byAgent: CostByAgentRow[];
  bySkill: CostBySkillRow[];
  legacyCosts: LegacyCostEntry[];
};

const TABS = [
  { key: "provider", label: "By Provider" },
  { key: "agent", label: "By Agent" },
  { key: "skill", label: "By Skill" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function CostBreakdownTabs({ byProvider, byAgent, bySkill, legacyCosts }: CostBreakdownTabsProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("provider");

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
        <div className="flex items-center gap-1 border-b border-line pb-2">
          {TABS.map((tab) => (
            <Button
              key={tab.key}
              type="button"
              variant="ghost"
              onClick={() => setActiveTab(tab.key)}
              className={`h-auto rounded-chip px-3 py-1 text-sm font-medium transition ${
                activeTab === tab.key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div className="mt-4">
          {activeTab === "provider" && (
            <CostByProviderTable data={byProvider} legacyCosts={legacyCosts} />
          )}
          {activeTab === "agent" && <CostByAgentTable data={byAgent} />}
          {activeTab === "skill" && <CostBySkillTable data={bySkill} />}
        </div>
      </CardContent>
    </Card>
  );
}
