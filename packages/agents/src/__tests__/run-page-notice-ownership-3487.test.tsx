// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const ports = vi.hoisted(() => ({
  submit: null as null | ((value: string) => Promise<void>),
  send: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  PromptField: ({ onSubmit }: { onSubmit: (value: string) => Promise<void> }) => {
    ports.submit = onSubmit;
    return <div data-testid="notice-test-prompt-field" />;
  },
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: ports.send,
}));

import { RunPageChrome } from "../run-page-chrome";
import { SchedulePromptWindow, SCHEDULE_WINDOW_OVER_NOTICE } from "../schedule-prompt-window";
import {
  createRunWindowScreenStore,
  useRunWindowScreen,
  type RunWindowScreenRegistration,
} from "../run-window-screen-context";

afterEach(cleanup);
beforeEach(() => {
  ports.submit = null;
  ports.send.mockClear();
});
const scheduleProps = { templateId: "template-3487", runId: "run-3487" };
const chrome = '[data-run-window-host="page-chrome"]';
const notice = '[data-conformance-id="schedule-window-over"]';
const panel = '[data-conformance-id="review-prompt-window"]';

function registration(readOnlyNotice?: "schedule-over", runId = "run-3487") {
  return {
    surface: "armed-trigger", runId, stepId: "schedule", canManipulate: false,
    storageKey: "draft-3487", conversation: [], promptPending: false,
    onSubmit: vi.fn(async () => {}), ...(readOnlyNotice ? { readOnlyNotice } : {}),
  } as RunWindowScreenRegistration;
}
function EmptyOuterScreen({ children }: { children: React.ReactNode }) {
  useRunWindowScreen(registration());
  return <>{children}</>;
}

describe("3487 — the page owns the existing disabled schedule notice", () => {
  it("moves the exact notice below the card into page chrome, with no prompt or send control", async () => {
    const { container } = render(<RunPageChrome>
      <section data-lifecycle-card-host="run_card">
        <SchedulePromptWindow {...scheduleProps} readOnly />
      </section>
    </RunPageChrome>);
    await waitFor(() => expect(container.querySelector(notice)).not.toBeNull());
    const answer = container.querySelector(notice)!;
    expect(answer.textContent).toBe(SCHEDULE_WINDOW_OVER_NOTICE);
    expect(answer.closest(chrome)).not.toBeNull();
    expect(answer.closest("[data-lifecycle-card-host]")).toBeNull();
    expect(container.querySelectorAll(notice)).toHaveLength(1);
    expect(answer.closest('[data-run-window-field]')?.getAttribute('aria-disabled')).toBe('true');
    expect(answer.closest('[data-run-window-field]')?.className).toBe('rounded-panel border border-line bg-surface px-3 py-2.5 shadow-lg');
    expect(container.querySelectorAll(panel)).toHaveLength(0);
    expect(container.querySelectorAll('[role="textbox"],button')).toHaveLength(0);
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("a standalone lifecycle screen cannot draw even the disabled window inside a card", () => {
    const { container } = render(<section data-lifecycle-card-host="chat_thread">
      <SchedulePromptWindow {...scheduleProps} readOnly />
    </section>);
    expect(container.querySelector(notice)).toBeNull();
    expect(container.querySelector('[data-run-window-field]')).toBeNull();
    expect(ports.send).not.toHaveBeenCalled();
  });

  it.each([
    { ...scheduleProps, templateId: "" },
    { ...scheduleProps, canRespondInWindow: false },
  ])("missing template or forbidden send does not pretend the schedule ended: %j", (props) => {
    const { container } = render(<RunPageChrome><SchedulePromptWindow {...props} /></RunPageChrome>);
    expect(container.querySelector(notice)).toBeNull();
    expect(container.querySelector(panel)).toBeNull();
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("withdraws the live prompt at read-only transition and a retained submit cannot mutate", async () => {
    const onFill = vi.fn(); const onActed = vi.fn();
    const content = (readOnly: boolean) => <RunPageChrome>
      <SchedulePromptWindow {...scheduleProps} readOnly={readOnly} onFill={onFill} onActed={onActed} />
    </RunPageChrome>;
    const { container, rerender } = render(content(false));
    await waitFor(() => expect(container.querySelector(panel)).not.toBeNull());
    const retainedSubmit = ports.submit!;
    rerender(content(true));
    await waitFor(() => expect(container.querySelector(notice)).not.toBeNull());
    expect(container.querySelector(panel)).toBeNull();
    await act(() => retainedSubmit("change this schedule"));
    expect(ports.send).not.toHaveBeenCalled();
    expect(onFill).not.toHaveBeenCalled(); expect(onActed).not.toHaveBeenCalled();
  });

  it("an outer empty registration does not hide the same run's intentional disabled notice", async () => {
    const { container } = render(<RunPageChrome><EmptyOuterScreen>
      <SchedulePromptWindow {...scheduleProps} readOnly />
    </EmptyOuterScreen></RunPageChrome>);
    await waitFor(() => expect(container.querySelector(`${chrome} ${notice}`)).not.toBeNull());
    expect(container.querySelectorAll(notice)).toHaveLength(1);
  });

  it("notice changes publish a new drawn signature even when manipulation stays false", () => {
    const store = createRunWindowScreenStore(); const token = { id: Symbol("schedule") };
    store.publish(token, registration()); const before = store.version();
    store.publish(token, registration("schedule-over"));
    expect(store.version()).toBeGreaterThan(before);
    expect(store.read()).toHaveProperty("readOnlyNotice", "schedule-over");
  });

  it("keeps the same-run notice when an empty outer record publishes last", () => {
    const store = createRunWindowScreenStore();
    store.publish({ id: Symbol("schedule") }, registration("schedule-over"));
    store.publish({ id: Symbol("outer") }, registration());
    expect(store.read()).toHaveProperty("readOnlyNotice", "schedule-over");
  });

  it("withdrawal removes its own notice and never lends one to a different run", () => {
    const store = createRunWindowScreenStore(); const token = { id: Symbol("schedule") };
    store.publish(token, registration("schedule-over"));
    store.retract(token); expect(store.read()).toBeNull();
    store.publish(token, registration("schedule-over"));
    store.publish({ id: Symbol("another-run") }, registration(undefined, "other-run"));
    expect(store.read()?.runId).toBe("other-run");
    expect(store.read()).not.toHaveProperty("readOnlyNotice");
  });

  it("the real conversation sender still receives the normal active schedule request", async () => {
    const { container } = render(<RunPageChrome><SchedulePromptWindow {...scheduleProps} /></RunPageChrome>);
    await waitFor(() => expect(container.querySelector(panel)).not.toBeNull());
    await act(() => ports.submit!("an ordinary question"));
    expect(ports.send).toHaveBeenCalledExactlyOnceWith({ runId: "run-3487", surface: "armed-trigger", prompt: "an ordinary question" });
    expect(container.querySelector(notice)).toBeNull();
  });
});
