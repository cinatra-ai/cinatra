// @vitest-environment jsdom
/**
 * THE PICKER'S HALF OF THE CTA'S RETURN CONTRACT (cinatra#3369, acceptance
 * item 2).
 *
 * The sentence beside the "Build a list with AI" CTA in the renderer states it:
 * "The operator completes the curator's two HITL gates (scrape-schema-review +
 * final-list-review) there; on completion they return to this picker with the
 * new listId pre-selected via the ?onComplete query param."
 *
 * A proof round on a development boot measured the return never happening: the
 * curator run reached `completed` and the outreach run's list-picker step was
 * unchanged — no list offered, the picker still empty.
 *
 * The curator opens in a SECOND TAB, so the hand-back crosses tabs through the
 * same-origin store, and the browser delivers it here as a `storage` event. The
 * KEY AND THE PAYLOAD ARE SPELLED OUT LITERALLY IN THIS FILE rather than
 * imported: they are the wire between two tabs, and a test that imported the
 * constant would follow the product if it renamed the wire under a running
 * browser that still holds the old one.
 *
 * Run:
 *   npx vitest run --config vitest.config.ts --no-coverage \
 *     packages/agents/src/__tests__/list-picker-return-on-completion.test.tsx
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

/** The wire, verbatim. */
const RETURN_KEY = "cinatra.agents.list-picker-return";

const EXISTING = {
  id: "l-existing",
  name: "Beta Prospects",
  memberCount: 42,
  lastUpdated: null,
  memberType: "contact" as const,
};

/** What the curator run just built. */
const BUILT = {
  id: "l-built-by-the-curator",
  name: "AI Founders in Berlin",
  memberCount: 118,
  lastUpdated: null,
  memberType: "contact" as const,
};

function makeProps(
  overrides: Partial<FieldRendererProps> = {},
): FieldRendererProps {
  return {
    fieldName: "list",
    schema: { "x-renderer": "list-picker" } as Record<string, unknown>,
    value: undefined,
    onChange: () => {},
    disabled: false,
    required: true,
    error: null,
    label: "Pick a list",
    description: undefined,
    context: { connectedApps: [], runId: "outreach-run-1" },
    ...overrides,
  };
}

/** What the finished curator run leaves behind, in the tab this one can see. */
function handBack(at: number) {
  const payload = JSON.stringify({ runId: "curator-run-1", at });
  window.localStorage.setItem(RETURN_KEY, payload);
  return payload;
}

/** What the browser delivers to THIS tab when the other one writes. */
async function deliverStorageEvent(newValue: string) {
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: RETURN_KEY, newValue }),
    );
  });
}

/**
 * The operator clicking "Build a list with AI" in THIS picker.
 *
 * The finish a curator leaves is one same-origin slot that every open picker
 * hears, so only the picker whose own CTA was clicked acts on it.
 */
function launchTheCurator() {
  fireEvent.click(screen.getByTestId("build-list-with-ai-cta"));
}

/** The operator coming back to this tab. */
async function returnToTheTab() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("ListPickerRenderer — the return on the curator run's completion (cinatra#3369)", () => {
  it("offers the built list and pre-selects it when the finished curator run hands back", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists)
      .mockResolvedValueOnce([EXISTING])
      .mockResolvedValueOnce([EXISTING, BUILT]);

    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => screen.getByText(EXISTING.name));
    expect(screen.queryByText(BUILT.name)).toBeNull();
    launchTheCurator();

    const payload = handBack(Date.now() + 1000);
    await deliverStorageEvent(payload);

    // The list the operator just built is OFFERED …
    await waitFor(() => expect(screen.getByText(BUILT.name)).toBeTruthy());
    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2);
    // … loaded with the outreach RUN's access, like every other read here …
    expect(actions.fetchAvailableLists).toHaveBeenNthCalledWith(2, "outreach-run-1");
    // … and PRE-SELECTED, which is the value the outreach step now holds.
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: BUILT.id,
      listName: BUILT.name,
      memberCount: BUILT.memberCount,
    });
    const card = screen.getByText(BUILT.name).closest("[data-selected]");
    expect(card?.getAttribute("data-selected")).toBe("true");
  });

  it("re-reads when the operator returns to the tab with a hand-back waiting", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([BUILT]);

    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());
    launchTheCurator();

    handBack(Date.now() + 1000);
    await returnToTheTab();

    await waitFor(() => expect(screen.getByText(BUILT.name)).toBeTruthy());
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: BUILT.id,
      listName: BUILT.name,
      memberCount: BUILT.memberCount,
    });
  });

  it("takes the hand-back, so one finished curator run moves the picker once", async () => {
    vi.mocked(actions.fetchAvailableLists)
      .mockResolvedValueOnce([EXISTING])
      .mockResolvedValue([EXISTING, BUILT]);

    render(<ListPickerRenderer {...makeProps()} />);
    await waitFor(() => screen.getByText(EXISTING.name));
    launchTheCurator();

    const payload = handBack(Date.now() + 1000);
    await deliverStorageEvent(payload);
    await waitFor(() => expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2));

    expect(window.localStorage.getItem(RETURN_KEY)).toBeNull();

    await returnToTheTab();
    await returnToTheTab();
    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2);
  });

  it("re-reads on the curator run's completion and not on any return to the tab", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([EXISTING]);

    render(<ListPickerRenderer {...makeProps()} />);
    await waitFor(() => screen.getByText(EXISTING.name));

    // No curator run has finished, so coming back to this tab is not news.
    await returnToTheTab();
    await returnToTheTab();
    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);
  });

  it("discards a hand-back stamped before this step was drawn", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([EXISTING, BUILT]);

    // A curator run the operator finished in some earlier sitting.
    handBack(Date.now() - 60_000);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => screen.getByText(EXISTING.name));
    launchTheCurator();

    await returnToTheTab();

    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // Taken all the same, so it stops standing between the operator and the
    // next curator run they actually finish.
    expect(window.localStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it("leaves the CTA's link unchanged — the query it carries is the contract", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([]);
    render(<ListPickerRenderer {...makeProps()} />);
    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByTestId("build-list-with-ai-cta").getAttribute("href"),
    ).toBe("/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker");
  });
});

describe("ListPickerRenderer — what the return must NOT do (cinatra#3369, convergence round)", () => {
  it("leaves a finish alone when this picker never opened a curator", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([EXISTING, BUILT]);

    // A SECOND outreach run's picker, open in another tab, hears the same
    // browser event. It never clicked its own CTA, so the finish is not its
    // news — and it must still be there for the picker that did.
    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => screen.getByText(EXISTING.name));

    const payload = handBack(Date.now() + 1000);
    await deliverStorageEvent(payload);

    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RETURN_KEY)).toBe(payload);
  });

  it("puts the finish back when the re-read fails, and answers it on the next return", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists)
      .mockResolvedValueOnce([EXISTING])
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([EXISTING, BUILT]);

    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => screen.getByText(EXISTING.name));
    launchTheCurator();

    const payload = handBack(Date.now() + 1000);
    await deliverStorageEvent(payload);
    await waitFor(() => expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2));

    // A failed re-read is not an answer about what the operator built, so the
    // finish is still there to be answered.
    await waitFor(() =>
      expect(window.localStorage.getItem(RETURN_KEY)).toBe(payload),
    );
    expect(onChange).not.toHaveBeenCalled();

    await returnToTheTab();
    await waitFor(() => expect(screen.getByText(BUILT.name)).toBeTruthy());
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: BUILT.id,
      listName: BUILT.name,
      memberCount: BUILT.memberCount,
    });
  });

  it("offers but selects nothing when the first load failed, so no baseline exists", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([EXISTING, BUILT]);

    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    await waitFor(() => expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1));
    launchTheCurator();

    await deliverStorageEvent(handBack(Date.now() + 1000));

    // Every list reads as "new" against an empty baseline, so the campaign's
    // audience must not be picked from it.
    await waitFor(() => expect(screen.getByText(BUILT.name)).toBeTruthy());
    expect(screen.getByText(EXISTING.name)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("changes nothing while the step is disabled", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([EXISTING, BUILT]);

    const { rerender } = render(
      <ListPickerRenderer {...makeProps({ onChange, disabled: false })} />,
    );
    await waitFor(() => screen.getByText(EXISTING.name));
    launchTheCurator();
    rerender(<ListPickerRenderer {...makeProps({ onChange, disabled: true })} />);

    await deliverStorageEvent(handBack(Date.now() + 1000));

    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads a finish that arrived while the first load was still in flight", async () => {
    const onChange = vi.fn();
    let settleFirstLoad: (items: typeof EXISTING[]) => void = () => {};
    vi.mocked(actions.fetchAvailableLists)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleFirstLoad = resolve as (items: typeof EXISTING[]) => void;
          }),
      )
      .mockResolvedValueOnce([EXISTING, BUILT]);

    render(<ListPickerRenderer {...makeProps({ onChange })} />);
    launchTheCurator();

    // The curator finishes before this picker's own first read has answered.
    await deliverStorageEvent(handBack(Date.now() + 1000));
    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);

    await act(async () => {
      settleFirstLoad([EXISTING]);
    });

    // No second browser event comes; the settling of the first load is the
    // occasion to read the finish that is already waiting.
    await waitFor(() => expect(screen.getByText(BUILT.name)).toBeTruthy());
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: BUILT.id,
      listName: BUILT.name,
      memberCount: BUILT.memberCount,
    });
  });
});
