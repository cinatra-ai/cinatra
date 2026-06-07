// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary
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
  { value: "applied", label: "Applied" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
  { value: "reset", label: "Reset" },
  // Pseudo-filter resolved marketplace-side to rows whose recovery saga is
  // terminally stuck (repair_stuck_at set), regardless of underlying status.
  { value: "stuck", label: "Stuck" },
];

export function VendorApplicationsStatusFilter({ current }: { current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Select
      value={current}
      onValueChange={(value) => {
        router.push(`${pathname}?status=${encodeURIComponent(value)}`);
      }}
    >
      <SelectTrigger className="w-[160px]">
        <SelectValue placeholder="Status" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
