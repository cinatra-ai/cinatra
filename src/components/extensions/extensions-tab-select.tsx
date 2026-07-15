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

// URL-driven Active/Archived select for /configuration/extensions. Server
// renders the body based on the URL param; this control just pushes the new URL
// when the value changes.
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
// lag back — it converges to `value` the moment the server render lands. No
// change to what renders or to the four-kind filtering; only the transient
// controlled value during navigation.

export function ExtensionsTabSelect({
  value,
  basePath = "/configuration/extensions",
}: {
  value: "active" | "archived";
  basePath?: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [optimisticValue, setOptimisticValue] = React.useOptimistic(value);
  return (
    <Select
      value={optimisticValue}
      onValueChange={(next) => {
        const tab = next === "archived" ? "archived" : "active";
        const target =
          tab === "archived"
            ? `${basePath}${basePath.includes("?") ? "&" : "?"}tab=archived`
            : basePath;
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
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="archived">Archived</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
