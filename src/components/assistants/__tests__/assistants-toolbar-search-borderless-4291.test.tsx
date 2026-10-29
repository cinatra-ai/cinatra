// @vitest-environment jsdom
/**
 * The /assistants toolbar search is the toolbar's own borderless search pill
 * (cinatra#4291, under cinatra#3189).
 *
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage src/components/assistants/__tests__/assistants-toolbar-search-borderless-4291.test.tsx
 *
 * The drawing (design specs/app-components.html §Toolbar) says "embedded
 * controls: borderless" and "The search field keeps its white interactive
 * surface", and draws the search as a white 7px pill, 34px tall, with the
 * search glyph leading and no border. The page mounted a standalone bordered
 * <Input> instead. This test mounts the real <AssistantsDirectoryClient>, finds
 * the search field inside its toolbar, and reads the rendered class lists.
 * Tailwind is not compiled under jsdom, so the rendered class list is the
 * reading: it is what survives `cn()`/tailwind-merge and reaches the DOM.
 */
import "../../__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/assistants",
  useSearchParams: () => new URLSearchParams(""),
}));

import { AssistantsDirectoryClient } from "../assistants-directory-client";

afterEach(cleanup);

const BORDER_TOKEN = /^border(-|$)/;

function renderSearch(): { field: HTMLInputElement; toolbar: HTMLElement } {
  render(
    <AssistantsDirectoryClient
      rows={[]}
      scopeValue={[]}
      scopes={{ orgs: [], projects: [], canGrantWorkspace: false }}
      canReachMarketplace={false}
      canUploadExtension={false}
    />,
  );
  const field = screen.getByPlaceholderText("Search assistants") as HTMLInputElement;
  const toolbar = field.closest<HTMLElement>('[role="toolbar"]');
  if (!toolbar) throw new Error("the assistants search field is not inside a toolbar");
  return { field, toolbar };
}

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function pillOf(field: HTMLElement): HTMLElement {
  const pill = field.closest<HTMLElement>("label");
  if (!pill) throw new Error("the search field has no toolbar search pill around it");
  return pill;
}

describe("cinatra#4291 — /assistants: the toolbar search is the borderless toolbar search pill", () => {
  it("sits inside the Assistants filters toolbar", () => {
    const { toolbar } = renderSearch();
    expect(toolbar.getAttribute("aria-label")).toBe("Assistants filters");
  });

  it("mounts the toolbar's own search input, not a standalone Input", () => {
    const { field } = renderSearch();
    expect(field.getAttribute("data-slot")).toBe("toolbar-search-input");
  });

  it("the field carries no border, shadow or dark-mode fill of its own", () => {
    const { field } = renderSearch();
    const c = classes(field);
    expect(c.filter((t) => BORDER_TOKEN.test(t))).toEqual([]);
    expect(c).not.toContain("shadow-xs");
    expect(c).not.toContain("dark:bg-input-fill/30");
    expect(c).toContain("bg-transparent");
  });

  it("the pill is white, 7px round, 34px tall and has no border", () => {
    const { field, toolbar } = renderSearch();
    const pill = pillOf(field);
    expect(toolbar.contains(pill)).toBe(true);
    const c = classes(pill);
    expect(c).toContain("bg-surface-strong");
    expect(c).toContain("rounded-[7px]");
    expect(c).toContain("h-[34px]");
    expect(c.filter((t) => BORDER_TOKEN.test(t))).toEqual([]);
  });

  it("the pill leads with the search glyph, hidden from assistive technology", () => {
    const { field } = renderSearch();
    const glyph = pillOf(field).querySelector('svg[class~="lucide-search"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(pillOf(field).firstElementChild).toBe(glyph);
  });

  it("keeps the field's width (180px, 260px from the lg breakpoint)", () => {
    const { field } = renderSearch();
    const box = pillOf(field).parentElement as HTMLElement;
    expect(classes(box)).toEqual(expect.arrayContaining(["relative", "w-[180px]", "lg:w-[260px]"]));
  });

  it("keeps its own name and stays a text field (no second, native clear glyph)", () => {
    const { field } = renderSearch();
    expect(field.getAttribute("aria-label")).toBe("Search assistants");
    expect(field.type).toBe("text");
  });

  it("the ✕ appears only while the field holds text, sits beside the pill (not in its label) and clears it", () => {
    const { field } = renderSearch();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(field, { target: { value: "writer" } });
    expect(field.value).toBe("writer");
    const clear = screen.getByRole("button", { name: "Clear search" });
    const pill = pillOf(field);
    expect(pill.contains(clear)).toBe(false);
    expect(pill.parentElement?.contains(clear)).toBe(true);
    fireEvent.click(clear);
    expect(field.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });
});
