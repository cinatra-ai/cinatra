// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ListPickerRenderer } from "../list-picker-renderer";
import { fetchAvailableLists, type AvailableListSummary } from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

vi.mock("../list-picker-actions", () => ({ fetchAvailableLists: vi.fn() }));

const rows: AvailableListSummary[] = [
  { id: "one", name: "First view", memberCount: null, lastUpdated: null, memberType: "contact" },
  { id: "two", name: "Second list", memberCount: 3, lastUpdated: null, memberType: "account" },
];
const params = {
  selection: "multiple", minSelected: 1,
  question: "Which entries should this run use?",
  emptyState: "Create a view in your CRM, then open this step again.",
};
function props(overrides: Partial<FieldRendererProps> = {}): FieldRendererProps {
  return {
    fieldName: "accountScope", schema: { type: "string" }, value: undefined,
    onChange: vi.fn(), context: { connectedApps: [], runId: "run-one" },
    bindingParams: params, ...overrides,
  };
}
beforeEach(() => { vi.mocked(fetchAvailableLists).mockReset().mockResolvedValue(rows); });
afterEach(cleanup);

describe("the declared multiple list picker", () => {
  it("preserves the declared question and awaiting-pick header while drawing checkboxes", async () => {
    render(<ListPickerRenderer {...props()} />);
    await screen.findAllByRole("checkbox");
    expect(screen.getByTestId("list-picker-gate-question").textContent).toBe(params.question);
    expect(screen.getByTestId("list-picker-gate-waiting").textContent).toContain("Awaiting your pick");
  });

  it("keeps an object field's multiple payload as an object", async () => {
    const p = props({ schema: { type: "object" } });
    render(<ListPickerRenderer {...p} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "First view" }));
    expect(p.onChange).toHaveBeenLastCalledWith({ type: "list", listIds: ["one"], listNames: ["First view"] });
  });

  it("ignores a late read for the departed run and never validates it for the new run", async () => {
    let finishOld!: (items: AvailableListSummary[]) => void;
    vi.mocked(fetchAvailableLists).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const onValidityChange = vi.fn();
    const view = render(<ListPickerRenderer {...props({ onValidityChange })} />);
    view.rerender(<ListPickerRenderer {...props({ onValidityChange, context: { connectedApps: [], runId: "run-two" } })} />);
    await screen.findByRole("checkbox", { name: "First view" });
    await act(async () => finishOld([{ ...rows[0], name: "Departed view" }]));
    expect(screen.queryByText("Departed view")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("flushes a saved valid choice only after its live rows are loaded", async () => {
    let flush!: () => Promise<void>;
    let finish!: (items: AvailableListSummary[]) => void;
    vi.mocked(fetchAvailableLists).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const p = props({ value: JSON.stringify({ type: "list", listIds: ["two"] }), registerFlush: (fn) => { flush = fn; } });
    render(<ListPickerRenderer {...p} />);
    await act(async () => flush());
    expect(p.onChange).not.toHaveBeenCalled();
    await act(async () => finish(rows));
    await act(async () => flush());
    expect(p.onChange).toHaveBeenLastCalledWith(JSON.stringify({ type: "list", listIds: ["two"], listNames: ["Second list"] }));
  });
  it("opens with every live name, no ticks and no outgoing value", async () => {
    const p = props();
    render(<ListPickerRenderer {...p} />);
    const controls = await screen.findAllByRole("checkbox");
    expect(controls).toHaveLength(2);
    expect(controls.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(screen.getByText(params.question)).toBeTruthy();
    expect(fetchAvailableLists).toHaveBeenCalledWith("run-one");
    expect(p.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("submits every tick in selection order, keeps hidden picks, and removes an unticked row", async () => {
    const p = props();
    render(<ListPickerRenderer {...p} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Second list" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "First view" }));
    expect(p.onChange).toHaveBeenLastCalledWith(JSON.stringify({
      type: "list", listIds: ["two", "one"], listNames: ["Second list", "First view"],
    }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "First view" }));
    expect(p.onChange).toHaveBeenLastCalledWith(JSON.stringify({
      type: "list", listIds: ["two"], listNames: ["Second list"],
    }));
  });

  it("reports invalid while loading, valid from the first tick and invalid again with none", async () => {
    const onValidityChange = vi.fn();
    render(<ListPickerRenderer {...props({ onValidityChange })} />);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    const first = await screen.findByRole("checkbox", { name: "First view" });
    fireEvent.click(first);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(first);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("honors a higher declared minimum without imposing a maximum", async () => {
    const onValidityChange = vi.fn();
    render(<ListPickerRenderer {...props({ onValidityChange, bindingParams: { ...params, minSelected: 2 } })} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "First view" }));
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Second list" }));
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("shows the declared empty message, no agent road, and re-reads when the step is reopened", async () => {
    vi.mocked(fetchAvailableLists).mockResolvedValueOnce([]);
    const onValidityChange = vi.fn();
    const view = render(<ListPickerRenderer {...props({ onValidityChange })} />);
    expect(await screen.findByText(params.emptyState)).toBeTruthy();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    view.unmount();
    render(<ListPickerRenderer {...props()} />);
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
    expect(fetchAvailableLists).toHaveBeenCalledTimes(2);
  });

  it("a failed load cannot make a saved selection valid", async () => {
    vi.mocked(fetchAvailableLists).mockRejectedValueOnce(new Error("unavailable"));
    const onValidityChange = vi.fn();
    render(<ListPickerRenderer {...props({ onValidityChange, value: JSON.stringify({ type: "list", listIds: ["one"] }) })} />);
    await waitFor(() => expect(screen.queryByText("Loading lists…")).toBeNull());
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("the view mode has no selectable controls", async () => {
    render(<ListPickerRenderer {...props({ mode: "view" })} />);
    const controls = await screen.findAllByRole("checkbox");
    expect(controls.every((c) => c.hasAttribute("disabled"))).toBe(true);
  });

  it("a value from the parent is read back, but stale or duplicate IDs cannot satisfy the minimum", async () => {
    const onValidityChange = vi.fn();
    const view = render(<ListPickerRenderer {...props({ onValidityChange, value: JSON.stringify({ type: "list", listIds: ["gone", "gone"] }) })} />);
    await screen.findAllByRole("checkbox");
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    view.rerender(<ListPickerRenderer {...props({ onValidityChange, value: JSON.stringify({ type: "list", listIds: ["two", "two"] }) })} />);
    expect(screen.getByRole("checkbox", { name: "Second list" }).getAttribute("aria-checked")).toBe("true");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });
});
