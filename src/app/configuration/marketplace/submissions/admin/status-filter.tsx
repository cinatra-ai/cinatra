"use client";

import { usePathname, useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const OPTIONS: { value: string; label: string }[] = [
  { value: "pending",    label: "Pending" },
  { value: "approved",   label: "Approved" },
  { value: "rejected",   label: "Rejected" },
  { value: "withdrawn",  label: "Withdrawn" },
  { value: "promoted",   label: "Promoted" },
  { value: "superseded", label: "Superseded" },
];

export function StatusFilter({ current }: { current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Select
      value={current}
      onValueChange={(value) => {
        router.push(`${pathname}?status=${encodeURIComponent(value)}`);
      }}
    >
      <SelectTrigger className="w-[140px]">
        <SelectValue placeholder="Status" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
