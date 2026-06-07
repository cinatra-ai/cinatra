"use client";

import { useRouter, usePathname } from "next/navigation";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

type Tab = { value: string; label: string };

type SettingsTabNavProps = {
  tabs: Tab[];
  activeTab: string;
  basePath?: string;
};

export function SettingsTabNav({ tabs, activeTab, basePath }: SettingsTabNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const targetPath = basePath ?? pathname;

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        const sp = new URLSearchParams();
        if (v !== tabs[0]?.value) sp.set("tab", v);
        router.push(`${targetPath}${sp.size ? `?${sp.toString()}` : ""}`);
      }}
    >
      <TabsListRow>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsListRow>
    </Tabs>
  );
}
