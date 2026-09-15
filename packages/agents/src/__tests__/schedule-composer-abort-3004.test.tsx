// @vitest-environment jsdom
//
// READING 3 OF cinatra#3004's live-proof round, second half — A QUESTION IN
// FLIGHT WHEN THE SCHEDULE ENDS.
//
// Withdrawing the composer hides the panel; on its own it does not stop the
// request the reader had already sent. A **Cancel schedule** landing mid-answer
// would leave a live call whose reply is appended to a conversation nobody can
// see any more — a question answered into the dark, on a form that can no
// longer change.
//
// The abort is enough by itself: the request's own path appends nothing once
// its signal has fired, and clears the pending flag in its `finally`.
//
// Its own file because it stubs the prompt field down to one button, which the
// state-following cases beside it must NOT do — those read the real panel.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-composer-abort-3004.test.tsx
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  PromptField: React.forwardRef<unknown, { onSubmit: (s: string) => Promise<void> }>(
    (props, _ref) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => void props.onSubmit("move it to Fridays"),
          "data-testid": "prompt-field",
        },
        "PromptField",
      ),
  ),
  LoadingSpinner: () => null,
}));

import { SchedulePromptWindow } from "../schedule-prompt-window";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEMPLATE = "tpl-3004";

describe("the composer's in-flight question", () => {
  it("is dropped the moment the schedule ends and the window is withdrawn", async () => {
    let captured: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal;
      // Never settles: the point is what happens to the call still in flight.
      return await new Promise<Response>(() => {});
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />,
    );
    (await screen.findByTestId("prompt-field")).click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(captured?.aborted).toBe(false);

    rerender(<SchedulePromptWindow templateId={TEMPLATE} readOnly={true} />);
    await waitFor(() => expect(captured?.aborted).toBe(true));
  });

  it("leaves a live schedule's question alone", async () => {
    let captured: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal;
      return await new Promise<Response>(() => {});
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />,
    );
    (await screen.findByTestId("prompt-field")).click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A re-render that does not end the schedule changes nothing.
    rerender(<SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />);
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).toBeTruthy());
    expect(captured?.aborted).toBe(false);
  });
});
