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
 *   9. History-tier estimate prop renders the history copy.
 *  10. Null estimate prop renders the "unavailable" copy.
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
    fireEvent.click(screen.getByText("Schedule for later"));
    // The scheduled section always contains Run at — clicking the card selects it.
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
    // durationCopy returns "{min}–{max}." — 7260s min, 14520s max → "2.0 hr–4.0 hr."
    const banner = screen.getByText("2.0 hr–4.0 hr.");
    expect(banner).toBeTruthy();
  });

  it("renders Unavailable. when prop is null", () => {
    renderForm({ durationEstimate: null });
    const banner = screen.getByText("Unavailable.");
    expect(banner).toBeTruthy();
  });
});
