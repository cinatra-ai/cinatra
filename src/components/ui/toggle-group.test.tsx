// @vitest-environment jsdom
//
// ToggleGroup — orientation forwarded to the Radix root (cinatra#2436).
//
// `ToggleGroup` already applied `orientation` to its own `data-orientation`
// attribute and to the item-sizing context, but never forwarded it as the
// `orientation` PROP the underlying `ToggleGroupPrimitive.Root` passes down
// to Radix's roving-focus group. That context (not the data attribute) is
// what Radix's `getFocusIntent` reads to decide which arrow keys move focus:
// with no orientation, Radix leaves BOTH axes live — every arrow key moves
// focus regardless of how the group is laid out. So a vertical group would
// look vertical while every arrow key (not just up/down) drove roving focus,
// and nothing pinned the mismatch. These tests render the REAL component
// (real radix-ui under jsdom, mirroring
// entity-search-combobox-interaction.test.tsx's pattern for behavioural
// Radix coverage) and pin, per orientation, that only the axis-matching pair
// of arrow keys moves focus and the cross-axis pair is a no-op.
//
//   pnpm exec vitest run src/components/ui/toggle-group.test.tsx

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

afterEach(() => cleanup());

// Radix's roving-focus arrow-key handler moves focus inside a `setTimeout`
// (see @radix-ui/react-roving-focus's RovingFocusGroupItem), so a keydown
// assertion must yield a macrotask before reading `document.activeElement`.
const flushRovingFocus = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderThreeItemGroup(orientation?: "horizontal" | "vertical") {
  render(
    <ToggleGroup
      type="single"
      defaultValue="a"
      {...(orientation ? { orientation } : {})}
    >
      <ToggleGroupItem value="a">A</ToggleGroupItem>
      <ToggleGroupItem value="b">B</ToggleGroupItem>
      <ToggleGroupItem value="c">C</ToggleGroupItem>
    </ToggleGroup>,
  );
  return screen.getAllByRole("radio");
}

describe("ToggleGroup — vertical orientation forwarded to the Radix root", () => {
  it("ArrowDown/ArrowUp move roving focus; ArrowLeft/ArrowRight are a no-op", async () => {
    const items = renderThreeItemGroup("vertical");
    expect(items.map((item) => item.getAttribute("data-orientation"))).toEqual(
      ["vertical", "vertical", "vertical"],
    );

    items[0].focus();
    expect(document.activeElement).toBe(items[0]);

    // Cross-axis keys never move focus in a vertical group.
    fireEvent.keyDown(items[0], { key: "ArrowRight" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0], { key: "ArrowLeft" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[0]);

    // The orientation's own axis drives roving focus.
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(items[2], { key: "ArrowUp" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[1]);
  });
});

describe("ToggleGroup — horizontal default (the shape both current consumers use)", () => {
  it("defaults to horizontal without an explicit orientation prop (unchanged default)", () => {
    const items = renderThreeItemGroup();
    expect(items.map((item) => item.getAttribute("data-orientation"))).toEqual(
      ["horizontal", "horizontal", "horizontal"],
    );
  });

  it("ArrowLeft/ArrowRight move roving focus; ArrowUp/ArrowDown are a no-op", async () => {
    // No `orientation` prop — the default consumers (/connectors,
    // /notifications) never pass one. Before cinatra#2436, this pair of
    // assertions did NOT hold: with orientation never forwarded to the Radix
    // root, Radix left BOTH axes live, so ArrowUp/ArrowDown also moved focus
    // here. Rendered/visual output is unaffected by the fix — this test pins
    // the roving-focus AXIS, which is the thing that changes.
    const items = renderThreeItemGroup();

    items[0].focus();
    expect(document.activeElement).toBe(items[0]);

    // Cross-axis keys never move focus in a horizontal group.
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[0]);

    // The orientation's own axis drives roving focus.
    fireEvent.keyDown(items[0], { key: "ArrowRight" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1], { key: "ArrowRight" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(items[2], { key: "ArrowLeft" });
    await flushRovingFocus();
    expect(document.activeElement).toBe(items[1]);
  });

  it('explicit orientation="horizontal" renders the same markup as the implicit default', () => {
    const withDefault = renderThreeItemGroup();
    const defaultRoot = withDefault[0].closest('[data-slot="toggle-group"]');
    expect(defaultRoot).not.toBeNull();
    const defaultHtml = defaultRoot!.outerHTML;
    cleanup();

    const withExplicit = renderThreeItemGroup("horizontal");
    const explicitRoot = withExplicit[0].closest('[data-slot="toggle-group"]');
    expect(explicitRoot).not.toBeNull();
    const explicitHtml = explicitRoot!.outerHTML;

    expect(explicitHtml).toBe(defaultHtml);
  });
});
