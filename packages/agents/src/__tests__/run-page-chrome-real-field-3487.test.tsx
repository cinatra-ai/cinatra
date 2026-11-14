// @vitest-environment jsdom
//
// THE CHROME'S WINDOW, DRIVEN THROUGH THE REAL FIELD (cinatra#3487).
//
// The chrome's routing suite stands the field in and calls the captured submit
// directly. This case uses the shared `PromptField` itself: the person focuses
// the window's editable field, types a request and presses Enter, and the
// request reaches the run's own turn, addressed to the run the screen lent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-window-actions", () => actions);

import { RunPageChrome } from "../run-page-chrome";
import { ReviewGatePromptWindow } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the page's one window answers the keyboard (cinatra#3487)", () => {
  it("focus, type a request and press Enter: the request reaches the run's turn", async () => {
    const { container } = render(
      <RunPageChrome>
        <ReviewGatePromptWindow
          storageKey="cinatra_review_window_run-kbd-3487"
          canComment
          runId="run-kbd-3487"
          boundCardRef="gate-ref-kbd-3487"
        />
      </RunPageChrome>,
    );

    const field = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        '[data-run-window-host="page-chrome"] [contenteditable="true"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });

    act(() => field.focus());
    expect(document.activeElement).toBe(field);

    const REQUEST = "Tighten the second paragraph";
    act(() => {
      field.textContent = REQUEST;
      fireEvent.input(field);
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => expect(actions.sendRunWindowTurn).toHaveBeenCalledTimes(1));
    const call = (actions.sendRunWindowTurn.mock.calls[0] as unknown[])[0];
    expect(call).toEqual(expect.objectContaining({ runId: "run-kbd-3487" }));
    expect(JSON.stringify(call)).toContain(REQUEST);
  });
});
