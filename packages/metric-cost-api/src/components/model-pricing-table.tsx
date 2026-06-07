"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { upsertModelPricingAction, triggerLiteLlmSyncAction } from "../actions";
import type { ModelPricingRow } from "../store";
import type { LiteLlmSyncResult } from "../litellm-sync";

function formatPrice(raw: string): string {
  const v = parseFloat(raw);
  if (v === 0) return "$0.00";
  if (v >= 0.1) return "$" + v.toFixed(2);
  if (v >= 0.001) return "$" + v.toFixed(4);
  return "$" + v.toFixed(6);
}

type ModelPricingTableProps = {
  rows: ModelPricingRow[];
};

export function ModelPricingTable({ rows }: ModelPricingTableProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<LiteLlmSyncResult | null>(null);
  const [isSyncing, startTransition] = useTransition();

  const filtered = query.trim() === ""
    ? rows
    : (() => {
        const tokens = query.trim().toLowerCase().split(/\s+/);
        return rows.filter((row) => {
          const haystack = row.provider.toLowerCase() + " " + row.modelName.toLowerCase();
          return tokens.every((t) => haystack.includes(t));
        });
      })();

  function handleSync() {
    setSyncResult(null);
    startTransition(async () => {
      try {
        const result = await triggerLiteLlmSyncAction();
        setSyncResult(result);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        setSyncResult({ inserted: 0, updated: 0, skipped: 0, errors: 1, errorMessage });
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search + sync */}
      <div className="flex items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models, providers…"
          className="w-72 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20"
        />
        <div className="ml-auto flex items-center gap-3">
        {syncResult && (
          <span className={`shrink-0 text-xs ${syncResult.errors > 0 ? "text-destructive" : "text-muted-foreground"}`}>
            {syncResult.errors > 0 && syncResult.errorMessage
              ? `Error: ${syncResult.errorMessage}`
              : `Synced: ${syncResult.inserted} inserted, ${syncResult.updated} updated, ${syncResult.skipped} skipped`}
          </span>
        )}
        <Button
          type="button"
          onClick={handleSync}
          disabled={isSyncing}
          className="shrink-0 rounded-control bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {isSyncing ? "Refreshing..." : "Refresh price list"}
        </Button>
        </div>
      </div>

      {/* Pricing table */}
      <Card className="border-line bg-surface backdrop-blur-none gap-0 py-0 overflow-hidden">
          <div className="sticky top-16 z-10 bg-surface border-b border-line">
            <div className="grid grid-cols-[1fr_1.5fr_0.8fr_0.8fr_0.8fr_0.6fr_0.8fr_auto] gap-3 px-5 py-2 text-xs font-medium text-muted-foreground">
              <span>Provider</span>
              <span>Model</span>
              <span>Input/M</span>
              <span>Output/M</span>
              <span>Cache/M</span>
              <span>Source</span>
              <span>Updated</span>
              <span />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 px-5 pb-4 pt-2">
            {filtered.map((row) => (
              <div key={row.id} className="rounded-panel border border-line px-4 py-3">
                {editingId === row.id ? (
                  <form
                    action={async (formData) => {
                      await upsertModelPricingAction(formData);
                      setEditingId(null);
                    }}
                    className="flex flex-wrap items-end gap-3"
                  >
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="provider" value={row.provider} />
                    <input type="hidden" name="modelName" value={row.modelName} />
                    <span className="self-center text-sm font-medium text-foreground">{row.provider}</span>
                    <span className="self-center text-sm text-foreground truncate max-w-[12rem]">{row.modelName}</span>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Input ($/M)</Label>
                      <Input
                        name="inputCostPerMillion"
                        type="number"
                        step="0.00000001"
                        min="0"
                        required
                        defaultValue={parseFloat(row.inputCostPerMillion).toFixed(8)}
                        className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground"
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Output ($/M)</Label>
                      <Input
                        name="outputCostPerMillion"
                        type="number"
                        step="0.00000001"
                        min="0"
                        required
                        defaultValue={parseFloat(row.outputCostPerMillion).toFixed(8)}
                        className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground"
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Cache ($/M)</Label>
                      <Input
                        name="cacheReadPerMillion"
                        type="number"
                        step="0.00000001"
                        min="0"
                        defaultValue={row.cacheReadPerMillion ? parseFloat(row.cacheReadPerMillion).toFixed(8) : ""}
                        className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground"
                      />
                    </div>
                    <Button
                      type="submit"
                      className="rounded-control bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90"
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                      className="rounded-control px-4 py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="grid grid-cols-[1fr_1.5fr_0.8fr_0.8fr_0.8fr_0.6fr_0.8fr_auto] gap-3 items-center text-sm">
                    <span className="font-medium text-foreground truncate">{row.provider}</span>
                    <span className="text-foreground truncate">{row.modelName}</span>
                    <span className="text-foreground">{formatPrice(row.inputCostPerMillion)}</span>
                    <span className="text-foreground">{formatPrice(row.outputCostPerMillion)}</span>
                    <span className="text-foreground">
                      {row.cacheReadPerMillion ? formatPrice(row.cacheReadPerMillion) : "—"}
                    </span>
                    <span>
                      <span className="inline-flex items-center rounded-chip border border-line px-2 py-0.5 text-xs text-muted-foreground">
                        {row.source}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">{new Date(row.updatedAt).toLocaleDateString("en-US")}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingId(row.id)}
                      className="text-xs text-muted-foreground transition hover:text-foreground"
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {query ? `No models matching "${query}"` : "No pricing data yet. Click Refresh price list to load."}
              </p>
            )}
          </div>
      </Card>

    </div>
  );
}
