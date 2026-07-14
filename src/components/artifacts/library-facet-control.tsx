"use client";

/**
 * §II Library type-facet control — the shadcn Select wrapper for the toolbar's
 * `Type` filter. A hidden input mirrors the selected value so the enclosing GET
 * form still submits `?facet=` on Apply (the toolbar stays a server-rendered
 * form; this is the one interactive island).
 */
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export function LibraryFacetControl({
  options,
  selected,
}: {
  options: Array<{ value: string; label: string }>;
  selected?: string;
}) {
  const [value, setValue] = useState(selected ?? "__all__");
  return (
    <>
      <Input type="hidden" name="facet" value={value} readOnly />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger
          data-testid="artifacts-facet"
          data-conformance-id="artifacts-facet"
          data-action="filter-facet -> filtered"
          className="h-[34px] w-auto gap-1.5 rounded-md border-line bg-surface-strong px-3 text-xs text-foreground"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">Type: All</SelectItem>
          {options.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
