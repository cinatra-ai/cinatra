"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type BlogConnectorOption = { value: string; label: string };

/**
 * Blog-connector picker for the per-instance WordPress form. Radix `Select`
 * posts its value through the native hidden `<select>` it renders when given
 * a `name`, so the surrounding server-action form receives `blogConnectorId`
 * exactly as the prior native `<select name="blogConnectorId">` did.
 */
export function BlogConnectorSelect({
  id,
  name,
  defaultValue,
  options,
}: {
  id: string;
  name: string;
  defaultValue: string;
  options: BlogConnectorOption[];
}) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger
        id={id}
        className="rounded-control border border-line bg-surface-strong px-3 py-2 text-sm text-foreground"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
