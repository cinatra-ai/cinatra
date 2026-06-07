"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveBudgetConfig } from "../actions";
import type { BudgetConfig } from "../store";

type BudgetConfigFormProps = {
  budgetConfig: BudgetConfig;
};

export function BudgetConfigForm({ budgetConfig }: BudgetConfigFormProps) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">Monthly Budget</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Set a monthly budget threshold. A progress bar and warning banners will appear on the dashboard when spend approaches or exceeds this amount.
        </p>
        <form ref={formRef} action={saveBudgetConfig} className="mt-3 flex items-end gap-3">
          <div>
            <Label htmlFor="monthlyBudgetUsd" className="text-xs font-medium text-muted-foreground">
              Monthly budget (USD)
            </Label>
            <Input
              id="monthlyBudgetUsd"
              name="monthlyBudgetUsd"
              type="number"
              step="0.01"
              min="0"
              defaultValue={budgetConfig.monthlyBudgetUsd ?? ""}
              placeholder="e.g. 500.00"
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
