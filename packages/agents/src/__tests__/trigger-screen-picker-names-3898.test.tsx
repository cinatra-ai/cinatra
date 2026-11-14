// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import { DEFAULT_RECURRING_CONFIG, type RecurringConfig } from "../trigger-recurrence";

// Only navigation and the server action are doubled. The screen and its actual
// Radix Select render the roles, accessible names, options and selected values.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../run-actions", () => ({ setRunTrigger: vi.fn() }));
import { TriggerScreenClient } from "../trigger-screen-client";

const original = {
  resizeObserver: globalThis.ResizeObserver,
  hasPointerCapture: Element.prototype.hasPointerCapture,
  releasePointerCapture: Element.prototype.releasePointerCapture,
  scrollIntoView: Element.prototype.scrollIntoView,
};
beforeEach(() => {
  // jsdom lacks these browser methods used by the unchanged Radix controls.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = original.resizeObserver;
  Element.prototype.hasPointerCapture = original.hasPointerCapture;
  Element.prototype.releasePointerCapture = original.releasePointerCapture;
  Element.prototype.scrollIntoView = original.scrollIntoView;
});

function renderSchedule(selection: Partial<RecurringConfig>, readOnly = false) {
  const statedSchedule: ProposedSchedule = {
    kind: "recurring",
    timezone: "Europe/Berlin",
    selection: { ...DEFAULT_RECURRING_CONFIG, hour: 5, minute: 12, ...selection },
  };
  return render(<TriggerScreenClient
    agentId="test-agent" instanceId="test-run" templateId="test-template"
    setupComplete inputParams={{}} requiredFields={[]} properties={{}}
    statedSchedule={statedSchedule} readOnly={readOnly}
  />);
}

const cases: { title: string; selection: Partial<RecurringConfig>; values: Record<string, string> }[] = [
  { title: "daily", selection: { frequency: "daily" }, values: { "Repeat every": "1", "Repeat unit": "day(s)" } },
  { title: "weekly", selection: { frequency: "weekly" }, values: { "Repeat every": "1", "Repeat unit": "week(s)" } },
  { title: "monthly date", selection: { frequency: "monthly", monthlyMode: "date" }, values: { "Repeat every": "1", "Repeat unit": "month(s)", "Day of month": "1" } },
  { title: "monthly weekday", selection: { frequency: "monthly", monthlyMode: "weekday" }, values: { "Repeat every": "1", "Repeat unit": "month(s)", "Week of month": "1st", "Weekday": "Sun" } },
  { title: "quarterly date", selection: { frequency: "quarterly", monthlyMode: "date" }, values: { "Repeat unit": "quarter", "Day of month": "1" } },
  { title: "quarterly weekday", selection: { frequency: "quarterly", monthlyMode: "weekday" }, values: { "Repeat unit": "quarter", "Week of month": "1st", "Weekday": "Sun" } },
  { title: "yearly date", selection: { frequency: "yearly", monthlyMode: "date" }, values: { "Repeat unit": "year", "Month": "Jan", "Day of month": "1" } },
  { title: "yearly weekday", selection: { frequency: "yearly", monthlyMode: "weekday" }, values: { "Repeat unit": "year", "Month": "Jan", "Week of month": "1st", "Weekday": "Sun" } },
];

for (const readOnly of [false, true]) {
  describe(readOnly ? "read-only recurring names" : "editable recurring names", () => {
    for (const { title, selection, values } of cases) {
      it(`names every ${title} picker by purpose without losing its selected value`, async () => {
        renderSchedule(selection, readOnly);
        const expected = { ...values, "At hour": "05", "At minute": "12", "Timezone": "Europe/Berlin" };
        await waitFor(() => {
          // Count + unique role/name queries prevent an unnamed or ambiguously
          // named picker from hiding behind the checks for its neighbours.
          expect(screen.getAllByRole("combobox")).toHaveLength(Object.keys(expected).length);
          for (const [name, value] of Object.entries(expected)) {
            expect(screen.getByRole("combobox", { name }).textContent).toBe(value);
          }
        });
      });
    }
  });
}

it("selects another minute by the named control and preserves the cron update", async () => {
  const { container } = renderSchedule({ frequency: "daily" });
  const minute = screen.getByRole("combobox", { name: "At minute" });
  fireEvent.pointerDown(minute, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: "47" }));
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "At minute" }).textContent).toBe("47");
    expect((container.querySelector('input[name="cronExpression"]') as HTMLInputElement).value).toBe("47 5 * * *");
  });
});

it("keeps the one-time hour and minute names unchanged", () => {
  render(<TriggerScreenClient
    agentId="test-agent" instanceId="test-run" templateId="test-template"
    setupComplete inputParams={{}} requiredFields={[]} properties={{}}
    statedSchedule={{ kind: "scheduled", runAt: "2027-01-02T05:12:00.000Z", timezone: "Europe/Berlin" }}
  />);
  expect(screen.getByRole("combobox", { name: "Hour" })).toBeDefined();
  expect(screen.getByRole("combobox", { name: "Minute" })).toBeDefined();
});
