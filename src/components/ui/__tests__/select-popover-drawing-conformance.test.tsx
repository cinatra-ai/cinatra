// @vitest-environment jsdom
// Select: specs/app-components.html, “Use scrollbar-thin on long lists.”
// Native DOM pins shared ScrollArea composition, timing and real Radix selection.
// Browser pins separately measure its overlay track and thumb; collection alone
// is not a claim that those measurements executed.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

beforeAll(() => {
  // jsdom lacks these platform operations; Radix itself stays unmocked.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function list(onValueChange = vi.fn()) {
  render(<Select defaultOpen onValueChange={onValueChange}>
    <SelectTrigger aria-label="Long list"><SelectValue placeholder="Choose an item" /></SelectTrigger>
    <SelectContent position="popper"><SelectGroup>
      {Array.from({ length: 48 }, (_, i) => <SelectItem key={i} value={`item-${i + 1}`}>List item {String(i + 1).padStart(2, "0")}</SelectItem>)}
      <SelectItem value="disabled" disabled>Unavailable item</SelectItem>
    </SelectGroup></SelectContent>
  </Select>);
  const viewport = document.querySelector("[data-radix-select-viewport]");
  expect(viewport).not.toBeNull();
  return { viewport: viewport as HTMLElement, onValueChange };
}

describe("Select long-list viewport: approved thin-scrollbar clause", () => {
  it("shares the actual Select viewport with ScrollArea rather than nesting scroll containers", () => {
    const { viewport } = list();
    expect(viewport.hasAttribute("data-radix-scroll-area-viewport")).toBe(true);
    expect(document.querySelectorAll("[data-radix-select-viewport]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-radix-scroll-area-viewport]")).toHaveLength(1);
    expect(viewport.querySelector("[data-radix-scroll-area-viewport]")).toBeNull();
    expect(viewport.style.position).toBe("relative");
    expect(viewport.style.flex).toBe("1 1 0%");
  });

  it("hides native chrome instead of overriding Radix's hidden scrollbar", () => {
    const { viewport } = list();
    expect(viewport.className).not.toContain("[scrollbar-width:thin]");
    expect(viewport.className).not.toContain("[&::-webkit-scrollbar]:block");
    const styles = [...document.querySelectorAll("style")].map((el) => el.textContent).join("\n");
    expect(styles).toContain("[data-radix-scroll-area-viewport]{scrollbar-width:none");
    expect(styles).toContain("[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}");
  });

  it("uses the unchanged shared overlay track, thumb token and animations after scrolling", async () => {
    const { viewport } = list();
    render(<ScrollArea data-testid="shared-reference"><div>Reference content</div></ScrollArea>);
    const reference = screen.getByTestId("shared-reference");
    const referenceViewport = reference.querySelector("[data-radix-scroll-area-viewport]")!;
    expect(document.querySelector('[data-slot="select-content"] [data-slot="scroll-area-scrollbar"]')).toBeNull();
    fireEvent.scroll(viewport, { target: { scrollTop: 80 } });
    fireEvent.scroll(referenceViewport, { target: { scrollTop: 80 } });
    const selectBar = await waitFor(() => {
      const el = document.querySelector('[data-slot="select-content"] [data-slot="scroll-area-scrollbar"]');
      expect(el).not.toBeNull(); return el!;
    });
    const referenceBar = reference.querySelector('[data-slot="scroll-area-scrollbar"]')!;
    expect(selectBar.className).toBe(referenceBar.className);
    expect(selectBar.className).toContain("data-[orientation=vertical]:w-1.5");
    expect(selectBar.getAttribute("data-state")).toBe("visible");
    // The shared thumb is conditional on measured overflow; these native tests
    // do not pretend jsdom's zero layout is a browser scrollbar measurement.
    expect(selectBar.getAttribute("data-orientation")).toBe("vertical");
  });

  it("uses the shared scroll trigger and default hide delay without changing timing", async () => {
    const { viewport } = list();
    vi.useFakeTimers();
    const bar = () => document.querySelector('[data-slot="select-content"] [data-slot="scroll-area-scrollbar"]');
    expect(bar()).toBeNull();
    fireEvent.scroll(viewport, { target: { scrollTop: 80 } });
    expect(bar()?.getAttribute("data-state")).toBe("visible");
    await act(async () => { vi.advanceTimersByTime(100); });
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(bar()?.getAttribute("data-state")).toBe("visible");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(bar()).toBeNull();
  });

  it("keeps all 48 options inside the real listbox and groups", () => {
    const { viewport } = list();
    expect(screen.getAllByRole("option")).toHaveLength(49);
    expect(viewport.closest('[role="listbox"]')).not.toBeNull();
    expect(viewport.querySelector('[role="group"]')).not.toBeNull();
    expect(viewport.textContent).toContain("List item 48");
  });
  it("selects the last item once and dismisses the popup", async () => {
    const { onValueChange } = list();
    fireEvent.click(screen.getByRole("option", { name: "List item 48" }));
    await waitFor(() => expect(onValueChange).toHaveBeenCalledExactlyOnceWith("item-48"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toContain("List item 48");
  });
  it("does not select a disabled item", () => {
    const { onValueChange } = list();
    fireEvent.click(screen.getByRole("option", { name: "Unavailable item" }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
  it.each(["popper", "item-aligned"] as const)("preserves content ref, End selection and trigger focus in %s position", async (position) => {
    const ref = React.createRef<HTMLDivElement>();
    const changed = vi.fn();
    render(<Select defaultOpen defaultValue="item-1" onValueChange={changed}>
      <SelectTrigger aria-label="Positioned"><SelectValue /></SelectTrigger>
      <SelectContent position={position} ref={ref} data-testid="positioned-content">
        <SelectItem value="item-1">First</SelectItem>
        <SelectItem value="item-2">Last</SelectItem>
        <SelectItem value="disabled" disabled>Disabled tail</SelectItem>
      </SelectContent>
    </Select>);
    const content = screen.getByRole("listbox");
    expect(ref.current).toBe(content);
    const viewport = content.querySelector("[data-radix-select-viewport]")!;
    expect(viewport.hasAttribute("data-radix-scroll-area-viewport")).toBe(true);
    fireEvent.keyDown(screen.getByRole("option", { name: "First" }), { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Last" })));
    fireEvent.keyDown(screen.getByRole("option", { name: "Last" }), { key: "Enter" });
    expect(changed).toHaveBeenCalledExactlyOnceWith("item-2");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

});
