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

export function ExtensionsTabSelect({
  value,
  basePath = "/configuration/extensions",
}: {
  value: "active" | "archived";
  basePath?: string;
}) {
  const router = useRouter();
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const target = next === "archived"
          ? `${basePath}${basePath.includes("?") ? "&" : "?"}tab=archived`
          : basePath;
        router.push(target);
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
