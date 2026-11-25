// @vitest-environment jsdom
/**
 * cinatra#3562 — THE HOST'S OWN LIST PICKER DRAWS TRY AGAIN.
 *
 * The shipped `ListPickerRenderer` (the `list-picker` kind's host renderer,
 * which the application mounts for the list step until a pack ships its own)
 * draws the list step's readings as the approved design draws them
 * (specs/app-artifact-review.html I.1):
 *   - a failed read is the host's one alert, "This list could not be read.",
 *     never an empty list, with Try again when the host hands
 *     `onRequestRefresh` and the step may change;
 *   - while a read is pending, the loading skeleton in the rows' place;
 *   - a read that returned no list draws the binding's declared empty-state
 *     message.
 * A press reads again and draws the answer in place of the first load. A
 * second press while a read is pending does nothing. A read that ends after
 * the step was locked or unmounted sets nothing. After a new read, the pick is
 * written once only when it changed (the list dropped or renamed).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn() },
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

const FIRST = [
  { id: "l-1", name: "Q2 Targets", memberCount: null, lastUpdated: null, memberType: "contact" as const },
  { id: "l-2", name: "Beta Prospects", memberCount: null, lastUpdated: null, memberType: "contact" as const },
];

function props(overrides: Partial<FieldRendererProps> = {}): FieldRendererProps {
  return {
    fieldName: "hitl-field",
    schema: {} as Record<string, unknown>,
    value: undefined,
    onChange: () => {},
    mode: "edit",
    context: { connectedApps: [], runId: "run-1" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });

beforeEach(() => {
  vi.clearAllMocks();
  // A queued answer a failed case left behind must not reach the next case.
  vi.mocked(actions.fetchAvailableLists).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ListPickerRenderer — the failed read and Try again (cinatra#3562)", () => {
  // red-first-expect: Unable to find role="alert"
  it("a failed first read draws the alert with Try again; a press draws the loading reading, then the lists", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const read = deferred<unknown>();
    const onRequestRefresh = vi.fn(() => read.promise);
    render(<ListPickerRenderer {...props({ onRequestRefresh })} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This list could not be read.");
    expect(alert.getAttribute("data-conformance-id")).toBe("run-list-step-error");
    expect(screen.queryByText(/search failed/)).toBeNull();
    expect(toastErrorMock).not.toHaveBeenCalled();

    fireEvent.click(tryAgain()!);
    expect(onRequestRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("list-picker-loading").getAttribute("data-conformance-id")).toBe(
      "run-list-step-loading",
    );
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      read.resolve({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    });
    await screen.findByText("Read again");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("list-picker-loading")).toBeNull();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(1);
  });

  it("a failed re-read draws the alert again, with Try again", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onRequestRefresh = vi.fn(async () => ({ lists: [], listsRead: "failed" }));
    render(<ListPickerRenderer {...props({ onRequestRefresh })} />);
    await screen.findByRole("alert");

    fireEvent.click(tryAgain()!);
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("This list could not be read.");
    expect(tryAgain()).not.toBeNull();
  });

  it("a re-read that rejects or answers a malformed value is the failed reading", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onRequestRefresh = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("not a read");
    render(<ListPickerRenderer {...props({ onRequestRefresh })} />);
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(tryAgain()!);
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("draws no Try again in view mode, when disabled, or without the prop", async () => {
    const onRequestRefresh = vi.fn(async () => ({ lists: [], listsRead: "ok" }));
    for (const extra of [
      { mode: "view" as const, onRequestRefresh },
      { disabled: true, onRequestRefresh },
      {},
    ]) {
      vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
      render(<ListPickerRenderer {...props(extra)} />);
      await screen.findByRole("alert");
      expect(tryAgain()).toBeNull();
      cleanup();
    }
    expect(onRequestRefresh).not.toHaveBeenCalled();
  });

  it("a second press while a read is pending does nothing", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const read = deferred<unknown>();
    const onRequestRefresh = vi.fn(() => read.promise);
    render(<ListPickerRenderer {...props({ onRequestRefresh })} />);
    await screen.findByRole("alert");
    const button = tryAgain()!;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRequestRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      read.resolve({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    });
    await screen.findByText("Read again");
  });

  it("a lock arriving while the read is pending drops its result", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const read = deferred<unknown>();
    const onRequestRefresh = vi.fn(() => read.promise);
    const onChange = vi.fn();
    const { rerender } = render(<ListPickerRenderer {...props({ onRequestRefresh, onChange })} />);
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    rerender(<ListPickerRenderer {...props({ onRequestRefresh, onChange, disabled: true })} />);
    await act(async () => {
      read.resolve({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    });
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.queryByText("Read again")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(tryAgain()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a read that ends after the step is gone sets nothing", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const read = deferred<unknown>();
    const onChange = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(
      <ListPickerRenderer {...props({ onRequestRefresh: () => read.promise, onChange })} />,
    );
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    unmount();
    await act(async () => {
      read.resolve({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("ListPickerRenderer — the pick after a new read (cinatra#3562)", () => {
  it("a ticked list a new read no longer offers is dropped and the empty pick is written once", async () => {
    // A restored pick (the step reopened with a value) and a failed first load.
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onChange = vi.fn();
    const onRequestRefresh = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ lists: [{ id: "l-2", name: "Beta Prospects" }], listsRead: "ok" });
    render(
      <ListPickerRenderer
        {...props({
          onRequestRefresh,
          onChange,
          value: { scope: "list", listId: "l-1", listName: "Q2 Targets", memberCount: 0 },
        })}
      />,
    );
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    await screen.findByText("Beta Prospects");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ scope: "list", listId: "", listName: "", memberCount: 0 });
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(1);
  });

  it("a restored pick the new read offers renamed is written once with the new name", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onChange = vi.fn();
    const onRequestRefresh = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ lists: [{ id: "l-1", name: "Q2 Targets (renamed)" }], listsRead: "ok" });
    render(
      <ListPickerRenderer
        {...props({
          onRequestRefresh,
          onChange,
          value: { scope: "list", listId: "l-1", listName: "Q2 Targets", memberCount: 0 },
        })}
      />,
    );
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    await screen.findByText("Q2 Targets (renamed)");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ listId: "l-1", listName: "Q2 Targets (renamed)" }),
    );
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
  });

  it("a restored pick the new read offers unchanged is not written again", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onChange = vi.fn();
    const onRequestRefresh = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ lists: [{ id: "l-1", name: "Q2 Targets" }], listsRead: "ok" });
    render(
      <ListPickerRenderer
        {...props({
          onRequestRefresh,
          onChange,
          value: { scope: "list", listId: "l-1", listName: "Q2 Targets", memberCount: 0 },
        })}
      />,
    );
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    await screen.findByText("Q2 Targets");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ListPickerRenderer — a restored pick and reads that fail or succeed (cinatra#3562)", () => {
  const RESTORED = { scope: "list", listId: "l-1", listName: "Q2 Targets", memberCount: 0 };

  // red-first-expect: Unable to find role="alert"
  it("a failed first load and a failed retry keep the restored pick and write nothing; a later good read keeps it", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    const onRequestRefresh = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ lists: [], listsRead: "failed" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("malformed")
      .mockResolvedValueOnce({ lists: [{ id: "l-1", name: "Q2 Targets" }], listsRead: "ok" });
    render(
      <ListPickerRenderer {...props({ value: RESTORED, onChange, onValidityChange, onRequestRefresh })} />,
    );
    await screen.findByRole("alert");
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(tryAgain()!);
      await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
      expect(screen.getByRole("alert")).toBeTruthy();
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(onValidityChange).not.toHaveBeenCalledWith(true);

    fireEvent.click(tryAgain()!);
    await screen.findByText("Q2 Targets");
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  });

  it("a first load that no longer offers the restored pick drops it and writes once; the same read again writes nothing", async () => {
    vi.mocked(actions.fetchAvailableLists)
      .mockResolvedValueOnce([FIRST[1]])
      .mockResolvedValueOnce([FIRST[1]]);
    const onChange = vi.fn();
    const { rerender } = render(<ListPickerRenderer {...props({ value: RESTORED, onChange })} />);
    await screen.findByText("Beta Prospects");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ scope: "list", listId: "", listName: "", memberCount: 0 });
    // The run identity re-issues the load; the same lists again write nothing.
    rerender(
      <ListPickerRenderer
        {...props({ value: RESTORED, onChange, context: { connectedApps: [], runId: "run-2" } })}
      />,
    );
    await waitFor(() => expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2));
    await screen.findByText("Beta Prospects");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a first load that renames the restored pick writes it once with the new name", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      { ...FIRST[0], name: "Q2 Targets (renamed)" },
    ]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...props({ value: RESTORED, onChange })} />);
    await screen.findByText("Q2 Targets (renamed)");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ listId: "l-1", listName: "Q2 Targets (renamed)" }),
    );
  });

  it("a first load that offers the restored pick unchanged writes nothing", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(FIRST);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...props({ value: RESTORED, onChange })} />);
    await screen.findByText("Q2 Targets");
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ListPickerRenderer — Continue waits for a pick (cinatra#3562)", () => {
  it("reports false while loading, after a failed read and with nothing picked, and true once a row is picked", async () => {
    vi.mocked(actions.fetchAvailableLists).mockRejectedValueOnce(new Error("search failed"));
    const onValidityChange = vi.fn();
    const onRequestRefresh = vi.fn(async () => ({
      lists: [{ id: "l-9", name: "Read again" }],
      listsRead: "ok",
    }));
    render(<ListPickerRenderer {...props({ onRequestRefresh, onValidityChange })} />);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await screen.findByRole("alert");
    fireEvent.click(tryAgain()!);
    fireEvent.click(await screen.findByText("Read again"));
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    expect(onValidityChange.mock.calls.map(([valid]) => valid)).toEqual([false, true]);
  });

  it("reports nothing in view mode or when disabled", async () => {
    for (const extra of [{ mode: "view" as const }, { disabled: true }]) {
      vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(FIRST);
      const onValidityChange = vi.fn();
      render(<ListPickerRenderer {...props({ ...extra, onValidityChange })} />);
      await screen.findByText("Q2 Targets");
      expect(onValidityChange).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("ListPickerRenderer — the empty reading (cinatra#3562)", () => {
  it("a read with no list draws the declared empty-state message and no alert", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...props({
          bindingParams: { emptyState: "There are no views or lists to pick from yet." },
          onRequestRefresh: vi.fn(async () => ({ lists: [], listsRead: "ok" })),
        })}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("There are no views or lists to pick from yet.");
    expect(status.getAttribute("data-conformance-id")).toBe("run-list-step-empty-source");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
