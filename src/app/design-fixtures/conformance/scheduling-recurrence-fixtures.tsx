"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the recurrence selectors of the scheduling
// step (conformance/app-components.json, design#212):
//
//   scheduling-step-quarterly, scheduling-step-yearly,
//   scheduling-step-configured-monthly, scheduling-step-configured-quarterly
//
// Each mount renders the SHIPPED `RecurrenceFrequencySelectors`, the component
// that both the in-flow scheduling step (packages/agents/src/
// trigger-screen-client.tsx) and the schedule card draw. The harness holds the
// selection, as a host does, and applies the patch the component hands back.
// It draws no control of its own, so the `data-field` attributes the drivers
// read are the product's. The selections and the words the drivers expect are
// in scheduling-recurrence-fixture-data.ts.
//
// The surfaces declare fields only (no action, no state variant), so there is
// no error or loading mount. Kept OFF the pixel-diffed /design-fixtures index,
// like the other conformance fixtures; driven by
// tests/e2e/design/conformance/contract.ts.
// ---------------------------------------------------------------------------

import { useState, type ReactElement } from "react";

import { RecurrenceFrequencySelectors } from "@cinatra-ai/agents/schedule-proposal-card";
import { Card, CardContent } from "@/components/ui/card";

import {
  schedulingRecurrenceReading,
  type SchedulingRecurrenceSurfaceId,
} from "./scheduling-recurrence-fixture-data";

function RecurrenceReading({
  surfaceId,
}: {
  surfaceId: SchedulingRecurrenceSurfaceId;
}): ReactElement {
  const [selection, setSelection] = useState(() => schedulingRecurrenceReading(surfaceId).selection);
  return (
    <div className="flex flex-col gap-3">
      <RecurrenceFrequencySelectors
        selection={selection}
        onChange={(patch) => setSelection((current) => ({ ...current, ...patch }))}
        disabled={false}
        readOnly={false}
      />
    </div>
  );
}

/** The four recurrence readings, mounted by the base conformance harness page. */
export function SchedulingRecurrenceConformanceFixtures(): ReactElement {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="flex flex-col gap-6 p-4">
        <p className="text-sm font-medium text-muted-foreground">
          Scheduling — recurrence selectors (surfaces: scheduling-step-quarterly,
          scheduling-step-yearly, scheduling-step-configured-monthly,
          scheduling-step-configured-quarterly)
        </p>
        <div data-surface-id="scheduling-step-quarterly" data-variant="populated">
          <RecurrenceReading surfaceId="scheduling-step-quarterly" />
        </div>
        <div data-surface-id="scheduling-step-yearly" data-variant="populated">
          <RecurrenceReading surfaceId="scheduling-step-yearly" />
        </div>
        <div data-surface-id="scheduling-step-configured-monthly" data-variant="populated">
          <RecurrenceReading surfaceId="scheduling-step-configured-monthly" />
        </div>
        <div data-surface-id="scheduling-step-configured-quarterly" data-variant="populated">
          <RecurrenceReading surfaceId="scheduling-step-configured-quarterly" />
        </div>
      </CardContent>
    </Card>
  );
}
