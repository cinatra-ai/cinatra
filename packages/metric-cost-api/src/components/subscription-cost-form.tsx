"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSubscriptionCosts } from "../actions";
import type { SubscriptionCosts } from "../store";

type SubscriptionCostFormProps = {
  subscriptionCosts: SubscriptionCosts;
};

export function SubscriptionCostForm({ subscriptionCosts }: SubscriptionCostFormProps) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground">Subscription Costs</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Configure monthly plan costs for subscription-based services. These are prorated and included in the "This Month" total.
      </p>
      <form ref={formRef} action={saveSubscriptionCosts} className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="apolloMonthlyUsd" className="text-xs font-medium text-muted-foreground">
            Apollo monthly plan (USD)
          </Label>
          <Input
            id="apolloMonthlyUsd"
            name="apolloMonthlyUsd"
            type="number"
            step="0.01"
            min="0"
            defaultValue={subscriptionCosts.apolloMonthlyUsd ?? ""}
            placeholder="e.g. 99.00"
            className="mt-1 block w-40 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div>
          <Label htmlFor="apifyMonthlyUsd" className="text-xs font-medium text-muted-foreground">
            Apify monthly plan (USD)
          </Label>
          <Input
            id="apifyMonthlyUsd"
            name="apifyMonthlyUsd"
            type="number"
            step="0.01"
            min="0"
            defaultValue={subscriptionCosts.apifyMonthlyUsd ?? ""}
            placeholder="e.g. 49.00"
            className="mt-1 block w-40 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <Button
          type="submit"
          className="h-auto rounded-control bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90"
        >
          Save
        </Button>
      </form>
      </CardContent>
    </Card>
  );
}
