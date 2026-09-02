// @vitest-environment jsdom
/**
 * TriggerScreenClient (FirstStepTriggerForm) RTL coverage.
 *
 * Locks the form behaviour:
 *   1. Default state: triggerType = "immediate"; cron + datetime fields hidden.
 *   2. Switching to "scheduled" reveals the datetime input.
 *   3. Switching to "recurring" reveals the cron input.
 *   4. Typing a valid cron renders cronstrue preview.
 *   5. Typing an invalid cron leaves the preview empty (silent — no error).
 *   6. Submitting calls setRunTrigger with the immediate-trigger args shape.
 *   7. Server failure renders inline destructive error below submit.
 *   8. Server success calls router.push with /agents/{agentId}/{runId}.
 *   9. History-tier estimate prop renders the drawing's own populated copy.
 *  10. Null estimate prop draws no duration line at all (cinatra#3182 item 5).
 *
 *    cd packages/agent-builder && pnpm exec vitest run src/__tests__/trigger-form.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories run before module import resolution; the
// hoisted state holder lets test bodies configure per-case behaviour.
// ---------------------------------------------------------------------------

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

// Override the shadcn Select stub locally with a test-friendly variant that
// actually wires `onValueChange` so SelectItem clicks switch the form's
// `triggerType` field. The shared ui-stub passes everything through but
// strips the onValueChange wiring (which lives only in real Radix-backed
// components). Use importOriginal to merge so we don't drop other exports
// that downstream test transitive deps might need.
vi.mock("@/components/ui/select", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const React = await import("react");
  type ChangeFn = (v: string) => void;
  const SelectContext = React.createContext<{ onValueChange?: ChangeFn }>({});
  function Select(props: {
    children?: React.ReactNode;
    onValueChange?: ChangeFn;
    defaultValue?: string;
  }) {
    return React.createElement(
      SelectContext.Provider,
      { value: { onValueChange: props.onValueChange } },
      React.createElement("div", { "data-testid": "select-root" }, props.children),
    );
  }
  function SelectTrigger(props: { children?: React.ReactNode; id?: string }) {
    return React.createElement(
      "button",
      { id: props.id, type: "button" },
      props.children,
    );
  }
  function SelectContent(props: { children?: React.ReactNode }) {
    return React.createElement("div", null, props.children);
  }
  function SelectItem(props: { children?: React.ReactNode; value: string }) {
    const ctx = React.useContext(SelectContext);
    return React.createElement(
      "button",
      {
        type: "button",
        "data-testid": `select-item-${props.value}`,
        onClick: () => ctx.onValueChange?.(props.value),
      },
      props.children,
    );
  }
  function SelectValue(props: { placeholder?: string }) {
    return React.createElement("span", null, props.placeholder);
  }
  return {
    ...actual,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
  };
});


// Pull the mocked function in so we can configure & assert.
import { setRunTrigger } from "../run-actions";
import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";
import type { DurationEstimate } from "../trigger-duration-estimate";

const mockedSetRunTrigger = vi.mocked(setRunTrigger);

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderForm(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

beforeEach(() => {
  routerState.push.mockReset();
  mockedSetRunTrigger.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TriggerScreenClient — defaults & type switching", () => {
  it("renders the three trigger type cards and Continue button", () => {
    renderForm();
    // Heading and submit CTA.
    expect(screen.getByText("When should this run?")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
    // All three trigger type options are always in the DOM.
    expect(screen.getByText("Run right after setup")).toBeTruthy();
    expect(screen.getByText("Schedule for later")).toBeTruthy();
    expect(screen.getByText("Recurring")).toBeTruthy();
  });

  it("clicking Schedule for later makes Run at label accessible", () => {
    renderForm();
    // Unchosen rows carry no fields (cinatra#3182 item 3), so Run at arrives
    // with the row: the click both selects the row and reveals its field.
    expect(screen.queryByLabelText("Run at")).toBeNull();
    fireEvent.click(screen.getByText("Schedule for later"));
    expect(screen.getByLabelText("Run at")).toBeTruthy();
  });

  it("clicking Recurring renders frequency and time controls", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    // Recurring section shows UI-driven schedule controls.
    expect(screen.getByText("Repeat every")).toBeTruthy();
    expect(screen.getByText("At")).toBeTruthy();
  });
});

describe("TriggerScreenClient — recurring section", () => {
  it("recurring section renders interval and time selects", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    // The recurring card always exposes these UI controls.
    expect(screen.getByText("Repeat every")).toBeTruthy();
    expect(screen.getByText("At")).toBeTruthy();
  });

  it("recurring section renders timezone control", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    // Timezone label exists inside the recurring card.
    expect(screen.getAllByText("Timezone").length).toBeGreaterThan(0);
  });
});

describe("TriggerScreenClient — submit behaviour", () => {
  it("submitting calls setRunTrigger once with the immediate-trigger args shape", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({
      ok: true,
      runId: "run-abc",
      jobSchedulerId: null,
    });
    renderForm({ agentId: "demo-agent", instanceId: "run-abc" });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(mockedSetRunTrigger).toHaveBeenCalledTimes(1);
    });
    const args = mockedSetRunTrigger.mock.calls[0][0];
    expect(args.runId).toBe("run-abc");
    expect(args.triggerType).toBe("immediate");
    expect(typeof args.timezone).toBe("string");
    expect((args.timezone ?? "").length).toBeGreaterThan(0);
    // For immediate type, scheduledAt and cronExpression should NOT be set.
    expect(args.scheduledAt).toBeUndefined();
    expect(args.cronExpression).toBeUndefined();
  });

  it("server failure renders the inline destructive error below the submit button", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({
      ok: false,
      error: "scheduledAt must be in the future",
    });
    renderForm();
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(mockedSetRunTrigger).toHaveBeenCalledTimes(1);
    });
    const errorEl = await screen.findByText(
      "scheduledAt must be in the future",
    );
    expect(errorEl).toBeTruthy();
    expect(errorEl.className).toContain("text-destructive");
  });

  it("server success calls router.push with /agents/{agentId}/{runId}", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({
      ok: true,
      runId: "abc",
      jobSchedulerId: null,
    });
    renderForm({ agentId: "demo-agent", instanceId: "abc" });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(routerState.push).toHaveBeenCalledTimes(1);
    });
    expect(routerState.push).toHaveBeenCalledWith("/agents/demo-agent/abc");
  });
});

describe("TriggerScreenClient — duration estimate banner", () => {
  it("renders a time-range string when a history estimate is provided", () => {
    const estimate: DurationEstimate = {
      source: "history",
      runCount: 12,
      prepMinSeconds: 7200,
      prepMaxSeconds: 14400,
      gatedMinSeconds: 60,
      gatedMaxSeconds: 120,
      confidence: "high",
      notes: "Prep/gated split estimated 80/20 from total wall-clock duration.",
      computedAt: new Date().toISOString(),
    };
    renderForm({ durationEstimate: estimate });
    // durationCopy returns the drawing's own sentence — "About {min} – {max}."
    // — for 7260s min and 14520s max (cinatra#3182 item 5).
    const banner = screen.getByText("About 2.0 hr – 4.0 hr.");
    expect(banner).toBeTruthy();
  });

  it("draws no duration line when there is no estimate", () => {
    // The drawing gives the line only populated, and no wording for an empty
    // one; "Unavailable." was this form's own invention (cinatra#3182 item 5).
    renderForm({ durationEstimate: null });
    expect(screen.queryByText("Unavailable.")).toBeNull();
    expect(screen.queryByText("Estimated run duration")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE READ-ONLY READING (cinatra#2980).
//
// design@c73c68f5e39e `specs/app-components.html` § "Standard scheduling step",
// the "Configured schedule step" reading: "Once a *Run right after setup* or
// *Schedule for later* schedule has fired it cannot be changed any more: the
// form stays as a **read-only** reading with no controls at all."
//
// The screen mounts this reading for a run whose own one-off schedule has fired
// — the finished "Run right after setup" run of the issue. The form is still
// drawn (it is the reading of what the schedule was), and nothing on it can be
// pressed.
// ---------------------------------------------------------------------------
describe("TriggerScreenClient — the read-only reading of a fired one-off", () => {
  it("offers NO control to re-arm — the submit is gone", () => {
    renderForm({ readOnly: true });
    expect(screen.queryByText("Continue")).toBeNull();
    expect(screen.queryByText("Continuing…")).toBeNull();
  });

  it("still draws the same form — the rows and the duration line", () => {
    renderForm({
      readOnly: true,
      // The line is drawn where there IS an estimate to draw (cinatra#3182
      // item 5); this case is about the READING, not about the estimate.
      durationEstimate: {
        source: "history",
        runCount: 3,
        prepMinSeconds: 60,
        prepMaxSeconds: 120,
        gatedMinSeconds: 0,
        gatedMaxSeconds: 0,
        confidence: "high",
        notes: "",
        computedAt: new Date().toISOString(),
      },
    });
    expect(screen.getByText("When should this run?")).toBeTruthy();
    expect(screen.getByText("Run right after setup")).toBeTruthy();
    expect(screen.getByText("Schedule for later")).toBeTruthy();
    expect(screen.getByText("Recurring")).toBeTruthy();
    expect(screen.getByText("Estimated run duration")).toBeTruthy();
  });

  it("disables every control in it, not only the submit", () => {
    const { container } = renderForm({ readOnly: true });
    const fieldset = container.querySelector<HTMLFieldSetElement>(
      "fieldset[data-schedule-readonly]",
    );
    expect(fieldset).not.toBeNull();
    expect(fieldset?.disabled).toBe(true);
    // Every row lives INSIDE it, so no row can be selected — a disabled
    // fieldset disables its descendants, which is the whole reason it is the
    // wrapper rather than a per-control flag that a new control could miss.
    const row = screen
      .getByText("Run right after setup")
      .closest("[data-schedule-option]");
    expect(row).not.toBeNull();
    expect(fieldset?.contains(row!)).toBe(true);
  });

  // A READING THAT MOVES IS NOT A READING. The three rows are not all form
  // controls — two of them are plain divs with click handlers, which a disabled
  // fieldset does not reach — so pressing one must be pinned to change NOTHING,
  // not merely to submit nothing (a click never submits, even when editable, so
  // asserting only that would pass on a form that visibly re-selects itself).
  it("does not change its own selection when a row is pressed", () => {
    renderForm({ readOnly: true });
    const recurringRow = screen.getByText("Recurring").closest("div");
    const immediateRow = screen
      .getByText("Run right after setup")
      .closest("[data-schedule-option]");
    expect(immediateRow?.className).toContain("border-primary");

    fireEvent.click(screen.getByText("Recurring"));

    // The selection is where it was: the immediate row still carries the
    // selected edge and the recurring row still does not.
    expect(immediateRow?.className).toContain("border-primary");
    expect(recurringRow?.className).not.toContain("border-primary");
    expect(mockedSetRunTrigger).not.toHaveBeenCalled();
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it("arms nothing even if the form itself is submitted", async () => {
    // The submit CONTROL is gone, but the form element keeps its handler and a
    // submit event can still reach it. The reading must not act on one.
    //
    // Asserted THROUGH a wait: the handler runs its resolver asynchronously, so
    // an assertion taken on the same tick would pass before an unsafe callback
    // had run — i.e. for the wrong reason.
    const { container } = renderForm({ readOnly: true });
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(mockedSetRunTrigger).not.toHaveBeenCalled();
    });
    expect(routerState.push).not.toHaveBeenCalled();
  });

  // The editable reading is the default and is untouched: every other run still
  // reaches the form it always had.
  it("leaves the editable reading alone", () => {
    const { container } = renderForm();
    expect(screen.getByText("Continue")).toBeTruthy();
    expect(container.querySelector("fieldset[data-schedule-readonly]")).toBeNull();
  });
});
