"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveLegacyCost, updateLegacyCostAction, deleteLegacyCostAction } from "../actions";
import type { LegacyCostEntry } from "../store";

type ProviderOption = { value: string; label: string };

type LegacyCostListProps = {
  legacyCosts: LegacyCostEntry[];
  connectedProviders: ProviderOption[];
};

function costDisplay(costUsd: string, frequency: string): string {
  const amount = `$${parseFloat(costUsd).toFixed(2)}`;
  if (frequency === "monthly") return `${amount}/mo`;
  if (frequency === "yearly") return `${amount}/yr`;
  return amount;
}

function resolveCardHeader(): { title: string; description: string } {
  return {
    title: "Fixed Costs",
    description:
      "Track one-time and recurring subscription costs not captured by API usage telemetry.",
  };
}

export function LegacyCostList({ legacyCosts, connectedProviders }: LegacyCostListProps) {
  const createFormRef = useRef<HTMLFormElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { title, description } = resolveCardHeader();

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>

      {/* Create form */}
      <form
        ref={createFormRef}
        action={async (formData) => {
          await saveLegacyCost(formData);
          createFormRef.current?.reset();
        }}
        className="mt-3 flex flex-wrap items-end gap-3"
      >
        <div>
          <Label htmlFor="lc-costType" className="text-xs font-medium text-muted-foreground">Cost type</Label>
          <select id="lc-costType" name="costType" defaultValue="legacy"
            className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
            <option value="legacy">One-time</option>
            <option value="subscription">Subscription</option>
          </select>
        </div>
        <div>
          <Label htmlFor="lc-provider" className="text-xs font-medium text-muted-foreground">Provider</Label>
          <select id="lc-provider" name="provider" required
            className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
            <option value="">Select...</option>
            {connectedProviders.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="lc-description" className="text-xs font-medium text-muted-foreground">Description</Label>
          <Input id="lc-description" name="description" type="text" required placeholder="e.g. Jan-Mar 2025 usage"
            className="mt-1 block w-48 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground" />
        </div>
        <div>
          <Label htmlFor="lc-costUsd" className="text-xs font-medium text-muted-foreground">Cost (USD)</Label>
          <Input id="lc-costUsd" name="costUsd" type="number" step="0.01" min="0.01" required placeholder="142.00"
            className="mt-1 block w-28 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground" />
        </div>
        <div>
          <Label htmlFor="lc-frequency" className="text-xs font-medium text-muted-foreground">Frequency</Label>
          <select id="lc-frequency" name="frequency" defaultValue="once"
            className="mt-1 block w-28 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
            <option value="once">Once</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <div>
          <Label htmlFor="lc-startDate" className="text-xs font-medium text-muted-foreground">Start date</Label>
          <Input id="lc-startDate" name="startDate" type="date"
            className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground" />
        </div>
        <div>
          <Label htmlFor="lc-endDate" className="text-xs font-medium text-muted-foreground">End date</Label>
          <Input id="lc-endDate" name="endDate" type="date"
            className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground" />
        </div>
        <Button type="submit"
          className="h-auto rounded-control bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90">
          Add
        </Button>
      </form>

      {/* Existing entries list */}
      {legacyCosts.length > 0 && (
        <div className="mt-5">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">Existing entries</h4>
          <div className="flex flex-col gap-2">
            {legacyCosts.map((entry) => (
              <div key={entry.id} className="rounded-panel border border-line px-4 py-3">
                {editingId === entry.id ? (
                  /* Inline edit form */
                  <form
                    action={async (formData) => {
                      await updateLegacyCostAction(formData);
                      setEditingId(null);
                    }}
                    className="flex flex-wrap items-end gap-3"
                  >
                    <input type="hidden" name="id" value={entry.id} />
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Cost type</Label>
                      <select name="costType" defaultValue={entry.costType}
                        className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
                        <option value="legacy">One-time</option>
                        <option value="subscription">Subscription</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Provider</Label>
                      <select name="provider" required defaultValue={entry.provider}
                        className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
                        <option value="">Select...</option>
                        {connectedProviders.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Description</Label>
                      <Input name="description" type="text" required defaultValue={entry.description}
                        className="mt-1 block w-48 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground" />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Cost (USD)</Label>
                      <Input name="costUsd" type="number" step="0.01" min="0.01" required defaultValue={parseFloat(entry.costUsd).toFixed(2)}
                        className="mt-1 block w-28 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground" />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Frequency</Label>
                      <select name="frequency" defaultValue={entry.frequency}
                        className="mt-1 block w-28 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground">
                        <option value="once">Once</option>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Start date</Label>
                      <Input name="startDate" type="date" defaultValue={entry.startDate ?? ""}
                        className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground" />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">End date</Label>
                      <Input name="endDate" type="date" defaultValue={entry.endDate ?? ""}
                        className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground" />
                    </div>
                    <Button type="submit"
                      className="h-auto rounded-control bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90">
                      Save
                    </Button>
                    <Button type="button" onClick={() => setEditingId(null)}
                      className="h-auto rounded-control px-4 py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                      Cancel
                    </Button>
                  </form>
                ) : (
                  /* Display row */
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 text-sm">
                      <span className="font-medium text-foreground">{entry.provider}</span>
                      <span className="rounded-chip bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                        {entry.costType === "subscription" ? "Sub" : "One-time"}
                      </span>
                      <span className="text-muted-foreground">{entry.description}</span>
                      <span className="font-medium text-foreground">{costDisplay(entry.costUsd, entry.frequency)}</span>
                      {entry.startDate && entry.endDate && (
                        <span className="text-xs text-muted-foreground">{entry.startDate} to {entry.endDate}</span>
                      )}
                      {!entry.startDate && !entry.endDate && (
                        <span className="text-xs text-muted-foreground italic">No dates (all-time only)</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="link" onClick={() => setEditingId(entry.id)}
                        className="h-auto p-0 text-xs text-muted-foreground transition hover:text-foreground hover:no-underline">
                        Edit
                      </Button>
                      <form action={deleteLegacyCostAction}>
                        <input type="hidden" name="id" value={entry.id} />
                        <Button variant="link" type="submit"
                          className="h-auto p-0 text-xs text-muted-foreground transition hover:text-foreground hover:no-underline">
                          Delete
                        </Button>
                      </form>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      </CardContent>
    </Card>
  );
}
