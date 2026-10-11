// @vitest-environment jsdom
// Select: specs/app-components.html, “Use scrollbar-thin on long lists.”
// Native DOM pins the viewport recipe and real Radix selection; computed paint
// and the 6px WebKit track are checked by the separately authored browser pin.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

beforeAll(() => {
  // jsdom lacks these platform operations; Radix itself stays unmocked.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

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
function classes(el: Element) { return (el.getAttribute("class") ?? "").split(/\s+/); }

describe("Select long-list viewport: approved thin-scrollbar clause", () => {
  it("overrides Radix's viewport-only scrollbar-width:none", () => {
    expect(classes(list().viewport)).toContain("[scrollbar-width:thin]!");
  });
  it("unhides Radix's WebKit scrollbar on the actual viewport", () => {
    expect(classes(list().viewport)).toContain("[&::-webkit-scrollbar]:block!");
  });
  it("pins the WebKit thin track to 6px on both axes", () => {
    const cls = classes(list().viewport);
    expect(cls).toContain("[&::-webkit-scrollbar]:w-[6px]!");
    expect(cls).toContain("[&::-webkit-scrollbar]:h-[6px]!");
  });
  it("uses the live border token with a transparent track", () => {
    const cls = classes(list().viewport);
    expect(cls).toContain("[scrollbar-color:var(--border)_transparent]");
    expect(cls).toContain("[&::-webkit-scrollbar-thumb]:bg-border");
    expect(cls).toContain("[&::-webkit-scrollbar-track]:bg-transparent");
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
});
