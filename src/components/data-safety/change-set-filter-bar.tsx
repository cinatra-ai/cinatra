"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FieldGroup,
  Field,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Change-set filter bar. Strict shadcn
// composition: FieldGroup/Field + Input + Select. State lives
// in the URL search params; Apply pushes, Clear resets.
export type ChangeSetFilters = {
  objectId?: string;
  actorId?: string;
  runId?: string;
  effectRollup?: string;
  restorable?: string;
  createdAfter?: string;
  createdBefore?: string;
};

const ANY = "__any__";

export function ChangeSetFilterBar({ current }: { current: ChangeSetFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState<ChangeSetFilters>(current);

  function set<K extends keyof ChangeSetFilters>(key: K, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function apply() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value && value !== ANY) params.set(key, value);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function clear() {
    setFilters({});
    router.push(pathname, { scroll: false });
  }

  return (
    <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field>
        <FieldLabel htmlFor="cs-filter-objectId">Object id</FieldLabel>
        <Input
          id="cs-filter-objectId"
          value={filters.objectId ?? ""}
          onChange={(e) => set("objectId", e.target.value)}
          placeholder="obj-…"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-actorId">Actor id</FieldLabel>
        <Input
          id="cs-filter-actorId"
          value={filters.actorId ?? ""}
          onChange={(e) => set("actorId", e.target.value)}
          placeholder="user / agent id"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-runId">Run id</FieldLabel>
        <Input
          id="cs-filter-runId"
          value={filters.runId ?? ""}
          onChange={(e) => set("runId", e.target.value)}
          placeholder="agent run id"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-effect">Effect</FieldLabel>
        <Select
          value={filters.effectRollup || ANY}
          onValueChange={(v) => set("effectRollup", v)}
        >
          <SelectTrigger id="cs-filter-effect">
            <SelectValue placeholder="Any" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="reversible-internal">Reversible</SelectItem>
              <SelectItem value="irreversible-logged">Irreversible</SelectItem>
              <SelectItem value="compensating-action">Compensating</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-restorable">Restorable</FieldLabel>
        <Select
          value={filters.restorable || ANY}
          onValueChange={(v) => set("restorable", v)}
        >
          <SelectTrigger id="cs-filter-restorable">
            <SelectValue placeholder="Any" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="true">Restorable only</SelectItem>
              <SelectItem value="false">Non-restorable only</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-after">Opened after</FieldLabel>
        <Input
          id="cs-filter-after"
          type="date"
          value={filters.createdAfter ?? ""}
          onChange={(e) => set("createdAfter", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="cs-filter-before">Opened before</FieldLabel>
        <Input
          id="cs-filter-before"
          type="date"
          value={filters.createdBefore ?? ""}
          onChange={(e) => set("createdBefore", e.target.value)}
        />
      </Field>
      <div className="flex items-end gap-2 lg:col-span-3">
        <Button size="sm" onClick={apply}>
          <Search data-icon="inline-start" />
          Apply filters
        </Button>
        <Button size="sm" variant="outline" onClick={clear}>
          <X data-icon="inline-start" />
          Clear
        </Button>
      </div>
    </FieldGroup>
  );
}
