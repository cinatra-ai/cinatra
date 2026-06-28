"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ProviderOption = { value: string; label: string };

/**
 * Provider picker for the email-routing form. Radix `Select` posts its
 * value through the native hidden `<select>` it renders when given a
 * `name`, so the surrounding server-action form receives `connectorId`
 * exactly as the prior native `<select name="connectorId">` did.
 */
export function ProviderSelect({
  name,
  defaultValue,
  placeholder,
  options,
}: {
  name: string;
  defaultValue: string;
  placeholder: string;
  options: ProviderOption[];
}) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger className="w-full rounded-control border border-line bg-surface-strong px-4 py-3">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="">{placeholder}</SelectItem>
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
