// @vitest-environment jsdom
//
// READING 3 OF cinatra#3004's live-proof round, second half — AMENDED BY
// cinatra#2934 (lifecycle-b W5c).
//
// WHAT THIS FILE USED TO PIN. The composer did a second job beside the run's
// conversation: it asked the field-assist route to fill the schedule form's
// fields. A **Cancel schedule** landing mid-answer would have left that call in
// flight, answering into a form nobody can change any more, so the window
// aborted it — and these cases pinned the abort and its bound (a re-render that
// does not end the schedule cancels nothing).
//
// WHY IT CHANGED. W5c retires that route and all four of its callers: this
// window now has ONE road, the run's own stored conversation, reached by server
// action. There is no request of its own left to abort, so the two cases about
// the abort are gone with the call they were about.
//
// WHAT SURVIVES, and is what this file now pins: the run's stored turn is NOT
// dropped when the schedule ends — cinatra#3004 said so in as many words ("once
// it is accepted it stands, and a schedule ending afterwards does not reach back
// and unsay it") — and the composer still follows the form, present while the
// schedule can change and withdrawn once it cannot.
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

describe("the composer's one road, when the schedule ends", () => {
  it("keeps no request of its own to drop, and is withdrawn with the form", async () => {
    const anyCall = vi.fn(async () => await new Promise<Response>(() => {}));
    globalThis.fetch = anyCall as unknown as typeof fetch;

    const { rerender } = render(
      <SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />,
    );
    (await screen.findByTestId("prompt-field")).click();
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).toBeTruthy());
    // The retired route is not reached — nor is any other endpoint of this
    // window's own. What was typed travels on the run's road, by server action.
    expect(anyCall).not.toHaveBeenCalled();

    // The schedule ends: the composer goes with the form it sits under…
    rerender(<SchedulePromptWindow templateId={TEMPLATE} readOnly={true} />);
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).toBeNull());
    // …and still nothing of this window's own was ever in flight to cancel.
    expect(anyCall).not.toHaveBeenCalled();
  });

  it("leaves a live schedule's composer alone", async () => {
    const anyCall = vi.fn(async () => await new Promise<Response>(() => {}));
    globalThis.fetch = anyCall as unknown as typeof fetch;

    const { rerender } = render(
      <SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />,
    );
    (await screen.findByTestId("prompt-field")).click();

    // A re-render that does not end the schedule changes nothing.
    rerender(<SchedulePromptWindow templateId={TEMPLATE} readOnly={false} />);
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).toBeTruthy());
    expect(anyCall).not.toHaveBeenCalled();
  });
});
