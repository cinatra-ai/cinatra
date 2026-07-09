// @vitest-environment jsdom
//
// Renderer coverage for the tabbed schema-config setup surface (design spec:
// app-connectors §II — Setup + custom tabs, reserved Help tab LAST). The tab
// grouping is a generic core primitive; no connector is named. Two invariants
// matter most: (1) Help is always the last tab, and (2) EVERY tab panel is
// force-mounted so `collectFormInputs()` (a live-DOM scan) still sees inputs on
// inactive tabs — otherwise a submit from the Setup tab would drop values a user
// entered on another tab.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}
async function renderForm(props: React.ComponentProps<typeof SchemaConfigConnectorForm>) {
  await act(async () => {
    root.render(<SchemaConfigConnectorForm {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const tabbedRaw = {
  fields: [{ kind: "text", key: "apiKey", label: "API key" }],
  tabs: [
    // Declared with Help FIRST on purpose — the parser must normalize it last.
    { id: "help", label: "Help", fields: [{ kind: "text", key: "helpNote", label: "Note" }] },
    { id: "shell", label: "Local shell", fields: [{ kind: "text", key: "shellPath", label: "Path" }] },
  ],
};

describe("SchemaConfigConnectorForm — tabbed surface", () => {
  it("renders a tablist: Setup first, declared tab next, Help LAST", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabLabels).toEqual(["Setup", "Local shell", "Help"]);
  });

  it("force-mounts every panel so inactive-tab inputs stay collectable", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    // Setup is the active tab, yet the inputs from the (inactive) shell + help
    // tabs are still in the DOM — this is what keeps collectFormInputs() whole.
    expect(container.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(container.querySelector('input[name="shellPath"]')).toBeTruthy();
    expect(container.querySelector('input[name="helpNote"]')).toBeTruthy();
  });

  it("defaults to the Setup tab (exactly one active panel; inactive hidden via data-state)", async () => {
    // jsdom applies no Tailwind CSS, so visibility rides on Radix's data-state
    // (the renderer hides inactive panels with `data-[state=inactive]:hidden`).
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const panels = [...container.querySelectorAll('[role="tabpanel"]')];
    expect(panels).toHaveLength(3);
    const active = panels.filter((p) => p.getAttribute("data-state") === "active");
    expect(active).toHaveLength(1);
    expect(active[0].querySelector('input[name="apiKey"]')).toBeTruthy();
    // Every inactive panel carries the hide hook so it is not shown.
    for (const p of panels) {
      if (p.getAttribute("data-state") === "inactive") {
        expect(p.className).toContain("data-[state=inactive]:hidden");
      }
    }
  });
});

describe("SchemaConfigConnectorForm — flat surface (back-compat)", () => {
  it("renders NO tablist when the connector declares no tabs", async () => {
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('input[name="apiKey"]')).toBeTruthy();
  });
});
