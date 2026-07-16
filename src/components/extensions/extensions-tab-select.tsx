"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INSTALLED_TABS,
  resolveInstalledTab,
  type InstalledTabValue,
} from "./installed-tab-model";

// URL-driven status-filter select for /configuration/extensions — the full
// status set All / Active / Locked / Archived (cinatra#1571). Server renders the
// body based on the URL param; this control just pushes the new URL when the
// value changes. The options + their order and the `?tab=` value set are the
// single source of truth in installed-tab-model.ts (INSTALLED_TABS), so the
// control and the server-side partition can never disagree.
//
// `basePath` (default: the real /configuration/extensions route) lets the
// design-conformance seeded harness (cinatra#986) mount this SAME control on
// its own route with its run-id query preserved — the real URL-driven
// server-filter mechanism, not a stand-in. The real screen's behavior is
// byte-identical (default arg).
//
// Optimistic selection hold (cinatra#1645): the Select is controlled by the
// server-rendered `value`, which only becomes the newly-selected tab once the
// `router.push` navigation re-renders the server component. Across that async
// window the controlled value would otherwise lag on the PREVIOUS tab, and the
// controlled Radix Select re-asserting that stale value produced a stray second
// navigation that reverted the URL back to the active tab (the "tab flap"). We
// hold the selection optimistically inside the navigation transition, so the
// controlled value is the just-selected tab for the whole push and can never
// lag back — it converges to `value` the moment the server render lands. The
// optimistic hold is unchanged by cinatra#1571's option-set expansion; it holds
// whichever of the four values was selected, affecting only the transient
// controlled value during navigation, never what the server renders.

export function ExtensionsTabSelect({
  value,
  basePath = "/configuration/extensions",
}: {
  value: InstalledTabValue;
  basePath?: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [optimisticValue, setOptimisticValue] = React.useOptimistic(value);
  return (
    <Select
      value={optimisticValue}
      onValueChange={(next) => {
        // `next` is always one of the rendered INSTALLED_TABS values;
        // resolveInstalledTab is the same canonicalizer the server applies, so a
        // stray value can never desync the pushed URL from the rendered view.
        const tab = resolveInstalledTab(next);
        // The default "active" view carries NO query (clean default URL); every
        // other view is addressed by ?tab=<value>.
        const target =
          tab === "active"
            ? basePath
            : `${basePath}${basePath.includes("?") ? "&" : "?"}tab=${tab}`;
        startTransition(() => {
          setOptimisticValue(tab);
          router.push(target);
        });
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-[34px] w-[120px] border-transparent bg-transparent px-3 text-[12.5px] font-medium shadow-none data-[size=sm]:h-[34px] focus-visible:ring-1"
        aria-label="Filter installed extensions by state"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {INSTALLED_TABS.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
