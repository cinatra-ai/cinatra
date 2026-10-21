// @vitest-environment jsdom
//
// WHAT THE ASSISTANT FILLS CLEARS A REFUSED PRESS (cinatra#3189, review
// finding 3), on the scheduling step's own form.
//
// The person's own change to the Run at clears its error state
// (`trigger-screen-past-time-3189.test.tsx`). The assistant writes the same
// fields through one function on both roads: the parent's `aiSuggestions` on
// the embedded road, and this screen's own window on the standalone road. A
// fill is a change to the fields, so it clears the error state too; a refused
// press is never left drawn, and announced, over the value that replaced it.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-fill-clears-3189.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
  refresh: vi.fn() as ReturnType<typeof vi.fn>,
}));

// What the standalone window's turn comes back with: set per test.
const windowTurn = vi.hoisted(() => ({
  fill: null as null | { values: Record<string, unknown> },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, refresh: routerState.refresh }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

// The run's conversation: a turn that comes back with a fill and pressed
// nothing, which is the road `handlePromptSubmit` writes the fields on.
vi.mock("../use-run-window-conversation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRunWindowConversation: () => ({
    entries: [],
    pending: false,
    loaded: true,
    send: async () => ({ fill: windowTurn.fill, acted: false }),
  }),
}));

// The window itself, reduced to its send control: pressing it hands a prompt
// to the screen's own `onSubmit`, exactly as the real window does.
vi.mock("../hitl-conversation-panel", async (importOriginal) => {
  const { Button } = await import("@/components/ui/button");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    HitlConversationPanel: (props: { visible?: boolean; onSubmit: (prompt: string) => unknown }) =>
      props.visible ? (
        <Button type="button" data-testid="window-send" onClick={() => void props.onSubmit("x")}>
          Send
        </Button>
      ) : null,
  };
});

import { setRunTrigger } from "../run-actions";
import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";

// jsdom ships no ResizeObserver, no pointer capture and no scrollIntoView; the
// app's Select (Radix) and the date picker's popover call them. Test-ENVIRONMENT
// shims only, restored in `afterEach`.
const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const ORIGINAL_ELEMENT_SHIMS = {
  hasPointerCapture: Element.prototype.hasPointerCapture,
  releasePointerCapture: Element.prototype.releasePointerCapture,
  scrollIntoView: Element.prototype.scrollIntoView,
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installShims() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

// 2026-07-14 07:00 UTC = 09:00 in Berlin = 00:00 in Los Angeles.
const NOW = Date.parse("2026-07-14T07:00:00Z");

const oneOff = (runAt: string, timezone = "Europe/Berlin"): ProposedSchedule => ({
  kind: "scheduled",
  runAt,
  timezone,
});

function baseProps(overrides: Partial<TriggerScreenClientProps> = {}): TriggerScreenClientProps {
  return {
    agentId: "demo-agent",
    instanceId: "run-3189",
    templateId: "tpl-3189",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
}

function runAtTrigger(): HTMLElement {
  const el = document.getElementById("scheduledAt");
  if (el === null) throw new Error("no Run at field");
  return el;
}

function expectErrorState(message = "Choose a time in the future.") {
  const id = runAtTrigger().getAttribute("aria-describedby");
  expect(id).toBe("scheduledAt-error");
  expect(runAtTrigger().hasAttribute("data-invalid")).toBe(true);
  expect(document.getElementById(id as string)?.textContent).toBe(message);
  for (const name of ["Hour", "Minute"]) {
    const box = screen.getByRole("combobox", { name });
    expect(box.getAttribute("aria-invalid"), name).toBe("true");
  }
}

function expectNoErrorState() {
  expect(runAtTrigger().hasAttribute("data-invalid")).toBe(false);
  expect(runAtTrigger().hasAttribute("aria-describedby")).toBe(false);
  expect(document.getElementById("scheduledAt-error")).toBeNull();
  for (const name of ["Hour", "Minute"]) {
    const box = screen.getByRole("combobox", { name });
    expect(box.hasAttribute("aria-invalid"), name).toBe(false);
    expect(box.hasAttribute("aria-describedby"), name).toBe(false);
  }
}

async function pressContinue() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  routerState.push.mockReset();
  routerState.refresh.mockReset();
  vi.mocked(setRunTrigger).mockReset();
  vi.mocked(setRunTrigger).mockResolvedValue({ ok: true } as never);
  windowTurn.fill = null;
  installShims();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  Element.prototype.hasPointerCapture = ORIGINAL_ELEMENT_SHIMS.hasPointerCapture;
  Element.prototype.releasePointerCapture = ORIGINAL_ELEMENT_SHIMS.releasePointerCapture;
  Element.prototype.scrollIntoView = ORIGINAL_ELEMENT_SHIMS.scrollIntoView;
});

describe("the embedded road: the parent's aiSuggestions", () => {
  function renderEmbedded(statedSchedule: ProposedSchedule) {
    const onSubmit = vi.fn(async () => {});
    const props = baseProps({ embeddedAsRenderer: true, onSubmit, statedSchedule });
    const view = render(<TriggerScreenClient {...props} />);
    const fill = (aiSuggestions: Record<string, unknown>) =>
      act(async () => {
        view.rerender(<TriggerScreenClient {...props} aiSuggestions={aiSuggestions} />);
      });
    return { onSubmit, fill };
  }

  it("clears the error when a future Run at is filled, and then arms it", async () => {
    const { onSubmit, fill } = renderEmbedded(oneOff("2026-07-14T08:00"));
    await pressContinue();
    await waitFor(() => expectErrorState());
    await fill({ scheduledAt: "2026-07-14T10:00" });
    await waitFor(() => expectNoErrorState());
    await pressContinue();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "scheduled", scheduledAt: "2026-07-14T10:00" }),
    );
    expectNoErrorState();
  });

  it("clears the error when only the zone is filled", async () => {
    // 08:00 is past in Berlin and still ahead in Los Angeles.
    const { onSubmit, fill } = renderEmbedded(oneOff("2026-07-14T08:00"));
    await pressContinue();
    await waitFor(() => expectErrorState());
    await fill({ timezone: "America/Los_Angeles" });
    await waitFor(() => expectNoErrorState());
    await pressContinue();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("draws the error again when the filled time is refused on the next press", async () => {
    const { onSubmit, fill } = renderEmbedded(oneOff("2026-07-14T08:00"));
    await pressContinue();
    await waitFor(() => expectErrorState());
    await fill({ scheduledAt: "2026-07-14T08:30" });
    await waitFor(() => expectNoErrorState());
    await pressContinue();
    await waitFor(() => expectErrorState());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves the error when the fill writes nothing", async () => {
    const { onSubmit, fill } = renderEmbedded(oneOff("2026-07-14T08:00"));
    await pressContinue();
    await waitFor(() => expectErrorState());
    await fill({});
    expectErrorState();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("the standalone road: this screen's own window", () => {
  async function sendInWindow() {
    const send = await waitFor(() => screen.getByTestId("window-send"));
    await act(async () => {
      fireEvent.click(send);
    });
  }

  it("clears the error when the window fills a future Run at, and then arms it", async () => {
    render(<TriggerScreenClient {...baseProps({ statedSchedule: oneOff("2026-07-14T08:00") })} />);
    await pressContinue();
    await waitFor(() => expectErrorState());
    windowTurn.fill = { values: { scheduledAt: "2026-07-14T10:00" } };
    await sendInWindow();
    await waitFor(() => expectNoErrorState());
    await pressContinue();
    await waitFor(() => expect(vi.mocked(setRunTrigger)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setRunTrigger)).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "scheduled",
        scheduledAt: "2026-07-14T10:00",
        timezone: "Europe/Berlin",
      }),
    );
  });

  it("leaves the error when the turn comes back with no fill", async () => {
    render(<TriggerScreenClient {...baseProps({ statedSchedule: oneOff("2026-07-14T08:00") })} />);
    await pressContinue();
    await waitFor(() => expectErrorState());
    windowTurn.fill = null;
    await sendInWindow();
    expectErrorState();
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
  });
});
