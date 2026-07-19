"use client";
/**
 * The Artifacts console's canonical underline tablist (cinatra#1786, spec
 * design@923fa0d8 §IV; Application Design — Components · Tabs — underline only,
 * no pill tabs). Selecting a tab pushes `?tab=` and the server re-renders the
 * active tab's content; the first tab (Type definitions) owns the bare
 * `/configuration/artifacts` URL (no `?tab=`). The etched paired-line rule
 * begins to the right of the last tab via `TabsListRow`; the PageHeader is
 * rendered with `divider={false}` so the rule does not stack.
 */
import { useRouter } from "next/navigation";

import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

const BASE_PATH = "/configuration/artifacts";

export function ArtifactsConsoleTabs({
  tabs,
  activeTab,
}: {
  tabs: ReadonlyArray<{ value: string; label: string }>;
  activeTab: string;
}) {
  const router = useRouter();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        // The first tab owns the clean base URL; others carry `?tab=`.
        const isFirst = v === tabs[0]?.value;
        router.push(isFirst ? BASE_PATH : `${BASE_PATH}?tab=${encodeURIComponent(v)}`);
      }}
    >
      <TabsListRow data-testid="artifacts-console-tablist">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} data-testid={`artifacts-console-tab-${t.value}`}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsListRow>
    </Tabs>
  );
}
