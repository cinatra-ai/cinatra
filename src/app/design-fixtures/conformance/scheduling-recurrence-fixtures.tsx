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
// no error or loading mount.
//
// Beside the four drawn readings sit the ANTI-ALIAS PROBES: the same component
// over a selection whose fields all hold their own value, under
// `data-conformance-probe` (never `data-surface-id`, so no surface reads them
// as its own). A drawn reading that holds one value in two fields (the 2nd
// Tuesday) is checked for crossed sources on its probe.
//
// Kept OFF the pixel-diffed /design-fixtures index,
// like the other conformance fixtures; driven by
// tests/e2e/design/conformance/scheduling-recurrence-driver.ts, bound in
// tests/e2e/design/conformance/contract.ts.
// ---------------------------------------------------------------------------

import { useState, type ReactElement } from "react";

import { RecurrenceFrequencySelectors, type RecurrenceFrequencySelection } from "@cinatra-ai/agents/schedule-proposal-card";
import { Card, CardContent } from "@/components/ui/card";

import {
  SCHEDULING_RECURRENCE_PROBES,
  schedulingRecurrenceReading,
  type SchedulingRecurrenceSurfaceId,
} from "./scheduling-recurrence-fixture-data";

function RecurrenceSelectorsMount({ initial }: { initial: RecurrenceFrequencySelection }): ReactElement {
  const [selection, setSelection] = useState(initial);
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

function RecurrenceReading({ surfaceId }: { surfaceId: SchedulingRecurrenceSurfaceId }): ReactElement {
  return <RecurrenceSelectorsMount initial={schedulingRecurrenceReading(surfaceId).selection} />;
}

/** The four recurrence readings and their probes, mounted by the base conformance harness page. */
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
        {SCHEDULING_RECURRENCE_PROBES.map((probe) => (
          <div key={probe.probeId} data-conformance-probe={probe.probeId}>
            <RecurrenceSelectorsMount initial={probe.selection} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
